# LangChain (Python)

[`main.py`](main.py) uses `ChatOpenAI` and `OpenAIEmbeddings` from
[`langchain-openai`](https://pypi.org/project/langchain-openai/) 1.7.3 with `base_url` pointed at
the gateway. This is how [OpsAgent](https://github.com/riz1-k/opsagent) talks to Switchyard.

It covers `invoke` with `include_response_headers=True` (the `x-sy-*` headers land in
`response_metadata["headers"]`, and Switchyard's `cost` in `response_metadata["token_usage"]`),
`stream(..., stream_usage=True)`, a `bind_tools` round trip with a `ToolMessage`, and embeddings
(`check_embedding_ctx_length=False`, so plain strings are sent). `default_headers` adds
`x-sy-user` / `x-sy-tags` attribution to every request.

```bash
uv run --script main.py
```

Expected output:

```text
✔ chat: "hello from langchain" tokens=15 cost=$0.00000405 x-sy-route=chat x-sy-cache=miss
✔ stream: "stream me a short answer" total_tokens=21
✔ tools: get_weather({'city': 'mock'}) → "Done. Tool results: get_weather: {"city": "mock", "temperature_c": 18}"
✔ embeddings: 2 x 256-d
langchain-python: all checks passed
```

Streaming chunks expose token usage but not `usage.cost`. OpsAgent subclasses `ChatOpenAI` to
keep the streamed cost (`opsagent/agent/src/opsagent/gateway.py`).
