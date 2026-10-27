"""Smoke test of a running Switchyard gateway with the official Python OpenAI SDK.

Usage:
    uv run --with openai python scripts/smoke_openai_sdk.py [--base-url http://localhost:8787/v1]
        [--skip-llm]   # only local/mock checks (no Copilot calls)

Real Copilot calls when not skipped: 3 (one stream on docsqa-chat, two on opsagent-chat for a
tool round trip). Embeddings/rerank use the local llama.cpp servers; the fallback demo uses the
always-503 mock target followed by local Qwen (:8081).
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request

from openai import OpenAI

EMBED_LLAMA = "http://127.0.0.1:8082/v1/embeddings"
QUERY_TEMPLATE = "task: search result | query: {text}"


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def stream_chat(client: OpenAI) -> None:
    section("docsqa-chat streaming (Copilot via opencode /event)")
    started = time.perf_counter()
    first = None
    chunks = 0
    text = ""
    usage = None
    stream = client.chat.completions.create(
        model="docsqa-chat",
        stream=True,
        stream_options={"include_usage": True},
        messages=[{"role": "user", "content": "Name the four seasons, one per line, nothing else."}],
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            first = first or time.perf_counter()
            chunks += 1
            text += chunk.choices[0].delta.content
        if chunk.usage:
            usage = chunk.usage
    total = time.perf_counter() - started
    print(f"content chunks={chunks} ttft={((first or started) - started) * 1000:.0f}ms total={total * 1000:.0f}ms")
    print("text:", json.dumps(text))
    print("usage:", usage.model_dump() if usage else None)
    assert chunks >= 1 and "winter" in text.lower()


def tool_round_trip(client: OpenAI) -> None:
    section("opsagent-chat tool call -> tool result -> final answer")
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_order",
                "description": "Fetch an order by id",
                "parameters": {
                    "type": "object",
                    "properties": {"order_id": {"type": "string"}},
                    "required": ["order_id"],
                    "additionalProperties": False,
                },
            },
        }
    ]
    messages: list = [
        {"role": "system", "content": "You are an e-commerce operations agent. Always look orders up with tools."},
        {"role": "user", "content": "Customer asks whether order ORD-2001 has shipped."},
    ]
    raw = client.chat.completions.with_raw_response.create(model="opsagent-chat", tools=tools, messages=messages)
    first = raw.parse()
    msg = first.choices[0].message
    print("finish_reason:", first.choices[0].finish_reason, "| provider:", raw.headers.get("x-sy-provider"), "| model:", raw.headers.get("x-sy-model"))
    print("tool_calls:", [(c.function.name, c.function.arguments) for c in (msg.tool_calls or [])])
    assert first.choices[0].finish_reason == "tool_calls" and msg.tool_calls
    call = msg.tool_calls[0]
    messages.append(msg.model_dump(exclude_none=True))
    messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"order_id": "ORD-2001", "status": "shipped", "carrier": "UPS", "shipped_at": "2026-10-25"})})
    second = client.chat.completions.create(model="opsagent-chat", tools=tools, messages=messages)
    print("final:", json.dumps(second.choices[0].message.content))
    assert second.choices[0].finish_reason == "stop" and "shipped" in (second.choices[0].message.content or "").lower()


def embeddings(client: OpenAI) -> None:
    section("docsqa-embed (input_type=query template applied by the gateway)")
    q = "How do I add middleware to a Hono app?"
    res = client.embeddings.create(model="docsqa-embed", input=[q], extra_body={"input_type": "query"})
    gw = res.data[0].embedding
    body = json.dumps({"model": "embeddinggemma-300m", "input": [QUERY_TEMPLATE.format(text=q)]}).encode()
    direct = json.loads(urllib.request.urlopen(urllib.request.Request(EMBED_LLAMA, body, {"content-type": "application/json"})).read())["data"][0]["embedding"]
    body_raw = json.dumps({"model": "embeddinggemma-300m", "input": [q]}).encode()
    untemplated = json.loads(urllib.request.urlopen(urllib.request.Request(EMBED_LLAMA, body_raw, {"content-type": "application/json"})).read())["data"][0]["embedding"]
    print(f"dim={len(gw)} identical_to_direct_templated={gw == direct} identical_to_untemplated={gw == untemplated}")
    assert len(gw) == 768 and gw == direct and gw != untemplated


def rerank(base_url: str, key: str) -> None:
    section("docsqa-rerank")
    payload = {
        "model": "docsqa-rerank",
        "query": "How do I register middleware in Hono?",
        "documents": [
            "Bananas are rich in potassium.",
            "Use app.use() to register middleware; it runs before your handlers.",
            "Hono runs on Cloudflare Workers, Deno, Bun and Node.js.",
        ],
        "top_n": 3,
    }
    req = urllib.request.Request(f"{base_url}/rerank", json.dumps(payload).encode(), {"content-type": "application/json", "authorization": f"Bearer {key}"})
    out = json.loads(urllib.request.urlopen(req).read())
    for r in out["results"]:
        print(f"  index={r['index']} score={r['relevance_score']:.4f}  {payload['documents'][r['index']]}")
    assert out["results"][0]["index"] == 1


def fallback_demo(client: OpenAI) -> None:
    section("fallback demo: mock-down (always 503) -> local-qwen")
    raw = client.chat.completions.with_raw_response.create(
        model="demo-fallback", max_tokens=40, messages=[{"role": "user", "content": "Say hello in five words."}]
    )
    res = raw.parse()
    print("x-sy-provider:", raw.headers.get("x-sy-provider"), "| x-sy-model:", raw.headers.get("x-sy-model"), "| x-sy-fallbacks:", raw.headers.get("x-sy-fallbacks"))
    print("content:", json.dumps(res.choices[0].message.content))
    assert raw.headers.get("x-sy-fallbacks") == "1" and raw.headers.get("x-sy-provider") == "local"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8787/v1")
    ap.add_argument("--skip-llm", action="store_true", help="skip Copilot calls")
    ap.add_argument("--skip-fallback", action="store_true", help="skip the demo needing llama.cpp :8081")
    args = ap.parse_args()
    docsqa = OpenAI(base_url=args.base_url, api_key="sk-sy-dev-docsqa", max_retries=0)
    opsagent = OpenAI(base_url=args.base_url, api_key="sk-sy-dev-opsagent", max_retries=0)
    evals = OpenAI(base_url=args.base_url, api_key="sk-sy-dev-evals", max_retries=0)

    section("models visible to the docsqa key")
    print([m.id for m in docsqa.models.list().data])
    if not args.skip_llm:
        stream_chat(docsqa)
        tool_round_trip(opsagent)
    embeddings(docsqa)
    rerank(args.base_url, "sk-sy-dev-docsqa")
    if not args.skip_fallback:
        fallback_demo(evals)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
