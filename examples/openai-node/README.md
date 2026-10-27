# OpenAI Node SDK

[`index.ts`](index.ts) uses the official [`openai`](https://www.npmjs.com/package/openai) SDK
(7.45.1) against Switchyard: set `baseURL` to the gateway, use a Switchyard key and put a route
name in `model`.

It covers chat with `usage.cost`, streaming with `stream_options.include_usage` (the cost arrives
in the final chunk), embeddings with the `input_type` extension, a tool-calling round trip,
`response_format: json_schema`, the `x-sy-*` response headers through `.withResponse()`, and
`OpenAI.AuthenticationError` for a bad key.

```bash
npm ci
node index.ts        # Node >= 22.18; also: bun index.ts, deno run -A index.ts
```

Expected output, against `config/gateway.examples.yaml` (see [../README.md](../README.md)):

```text
✔ chat: "hello from the openai node sdk" cost=$0.00000705
✔ stream: "stream me a short answer" final-chunk cost=$0.0000063 (miss)
✔ embeddings: 2 x 256-d (input_type=query)
✔ tools: get_weather({"city":"mock"}) → "Done. Tool results: get_weather: {"city":"mock","temperature_c":18}"
✔ json_schema: {"city":"Paris","country":"France","population_millions":2.1}
✔ headers: x-sy-route=chat x-sy-provider=mock-http x-sy-model=mock-echo x-sy-cache=miss x-sy-cost-usd=0.00000555 (id chatcmpl-…)
✔ errors: 401 invalid_api_key (OpenAI.AuthenticationError)
openai-node: all checks passed
```

`usage.cost` and `usage.sy_cache` are additive fields that the SDK passes through; the example
types them with a small `SwitchyardUsage` intersection.
