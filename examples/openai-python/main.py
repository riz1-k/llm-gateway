# /// script
# requires-python = ">=3.10"
# dependencies = ["openai==3.40.0"]
# ///
"""Switchyard with the official OpenAI Python SDK.

Point `base_url` at the gateway, use a Switchyard key and name a route as the model.
Run: uv run --script main.py
"""

import json
import os
import sys

import openai
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("SWITCHYARD_BASE_URL", "http://127.0.0.1:8787/v1"),
    api_key=os.environ.get("SWITCHYARD_API_KEY", "sk-sy-examples-local"),
    max_retries=0,
)


def check(condition: object, message: str) -> None:
    if not condition:
        raise SystemExit(f"check failed: {message}")


def sy_usage(usage: object) -> dict:
    """Switchyard's additive usage fields (cost, sy_cache, sy_saved_cost) arrive as pydantic extras."""
    extra = getattr(usage, "model_extra", None) or {}
    return {k: extra[k] for k in ("cost", "sy_cache", "sy_saved_cost") if k in extra}


# 1. Chat. The cost of the request is in usage.cost (USD).
res = client.chat.completions.create(
    model="chat", messages=[{"role": "user", "content": "hello from the openai python sdk"}]
)
extra = sy_usage(res.usage)
check(res.choices[0].message.content == "hello from the openai python sdk", "echoed content")
check(isinstance(extra.get("cost"), (int, float)), "usage.cost")
print(f'✔ chat: "{res.choices[0].message.content}" cost=${extra["cost"]:.8f}')

# 2. Streaming. With include_usage, the final chunk (empty choices) carries usage.cost.
stream = client.chat.completions.create(
    model="chat",
    stream=True,
    stream_options={"include_usage": True},
    messages=[{"role": "user", "content": "stream me a short answer"}],
)
text, final = "", {}
for chunk in stream:
    if chunk.choices:
        text += chunk.choices[0].delta.content or ""
    if chunk.usage:
        final = sy_usage(chunk.usage)
check(text == "stream me a short answer", "streamed text")
check(isinstance(final.get("cost"), (int, float)), "usage.cost in the final chunk")
print(f'✔ stream: "{text}" final-chunk cost=${final["cost"]:.8f} ({final.get("sy_cache")})')

# 3. Embeddings with the `input_type` extension (sent through extra_body).
emb = client.embeddings.create(
    model="embed",
    input=["how do budgets work?", "what is a virtual key?"],
    extra_body={"input_type": "query"},
)
check(len(emb.data) == 2, "two vectors")
print(f"✔ embeddings: {len(emb.data)} x {len(emb.data[0].embedding)}-d (input_type=query)")

# 4. Tool calling: the model asks for a tool, we run it and send the result back.
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]
messages: list = [{"role": "user", "content": "What is the weather in Paris?"}]
first = client.chat.completions.create(model="tools", messages=messages, tools=tools)
call = first.choices[0].message.tool_calls[0]
check(call.function.name == "get_weather", "tool call")
args = json.loads(call.function.arguments)
messages.append(first.choices[0].message.model_dump(exclude_none=True))
messages.append(
    {
        "role": "tool",
        "tool_call_id": call.id,
        "content": json.dumps({"city": args["city"], "temperature_c": 18}),
    }
)
second = client.chat.completions.create(model="tools", messages=messages, tools=tools)
answer = second.choices[0].message.content or ""
check("temperature_c" in answer, "final answer uses the tool result")
print(f'✔ tools: get_weather({call.function.arguments}) → "{answer}"')

# 5. Response headers: with_raw_response gives the HTTP response; .parse() gives the object.
raw = client.chat.completions.with_raw_response.create(
    model="chat", messages=[{"role": "user", "content": "which route served me?"}]
)
completion = raw.parse()
h = raw.headers
check(h.get("x-sy-route") == "chat" and h.get("x-sy-cost-usd") is not None, "x-sy-* headers")
print(
    f"✔ headers: x-sy-route={h.get('x-sy-route')} x-sy-provider={h.get('x-sy-provider')} "
    f"x-sy-model={h.get('x-sy-model')} x-sy-cache={h.get('x-sy-cache')} "
    f"x-sy-cost-usd={h.get('x-sy-cost-usd')} (id {completion.id})"
)

# 6. Errors use the OpenAI envelope, so the SDK raises its usual typed errors.
bad = OpenAI(base_url=str(client.base_url), api_key="sk-sy-test-wrong-key", max_retries=0)
try:
    bad.chat.completions.create(model="chat", messages=[{"role": "user", "content": "hi"}])
    check(False, "expected a 401")
except openai.AuthenticationError as err:
    print(f"✔ errors: {err.status_code} {err.code} (openai.AuthenticationError)")

print("openai-python: all checks passed")
sys.exit(0)
