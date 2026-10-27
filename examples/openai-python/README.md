# OpenAI Python SDK

[`main.py`](main.py) uses the official [`openai`](https://pypi.org/project/openai/) package
(3.40.0) against Switchyard. Dependencies are declared inline (PEP 723), so `uv` runs it in an
ephemeral environment.

It covers chat with `usage.cost` (read from the pydantic `model_extra`), streaming with the final
usage chunk, embeddings with `input_type` through `extra_body`, a tool-calling round trip, the
`x-sy-*` headers through `with_raw_response`, and `openai.AuthenticationError` for a bad key.

```bash
uv run --script main.py
```

Expected output, when it runs right after the Node example (the stream is then a cache hit, so
its cost is 0):

```text
✔ chat: "hello from the openai python sdk" cost=$0.00000705
✔ stream: "stream me a short answer" final-chunk cost=$0.00000000 (hit)
✔ embeddings: 2 x 256-d (input_type=query)
✔ tools: get_weather({"city":"mock"}) → "Done. Tool results: get_weather: {"city": "mock", "temperature_c": 18}"
✔ headers: x-sy-route=chat x-sy-provider=mock-http x-sy-model=mock-echo x-sy-cache=hit x-sy-cost-usd=0 (id chatcmpl-…)
✔ errors: 401 invalid_api_key (openai.AuthenticationError)
openai-python: all checks passed
```
