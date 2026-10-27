# HTTP API reference

Switchyard speaks the OpenAI API. Point any OpenAI client at `http://<gateway>/v1` and use a
Switchyard key (`sk-sy-…`) as the API key. The `model` field names a **route** (a virtual model
from `routes:`), not an upstream model id. The admin API is documented in [ADMIN.md](ADMIN.md).

## Endpoints

| Method and path             | What                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | Chat. Includes SSE streaming, `stream_options.include_usage`, tools, `tool_choice`, `response_format` (`json_object`, `json_schema`) and `reasoning_effort` |
| `POST /v1/embeddings`       | Embeddings, with the `input_type` / `input_titles` extensions (below)                                                                                       |
| `POST /v1/rerank`           | Rerank, Cohere/Jina shape: `{ model, query, documents[], top_n?, return_documents? }` → `{ results: [{ index, relevance_score, document? }] }`              |
| `GET /v1/models`            | Routes visible to the key (`hidden: true` routes are omitted), with descriptions                                                                            |
| `GET /healthz`              | Liveness (always 200 while the process runs)                                                                                                                |
| `GET /readyz`               | Readiness: Redis and Postgres reachable, and not draining. `?probe=1` also probes every upstream and requires the admin token                               |
| `GET /metrics`              | Prometheus metrics (path and port configurable; see [METRICS.md](METRICS.md))                                                                               |
| `/admin/*`                  | Teams, keys, budgets, usage, cache, config. Requires `Authorization: Bearer <admin_token>`                                                                  |

Errors use the OpenAI envelope: `{"error":{"message","type","code","param"}}`.

## Request headers

| Header                                           | Meaning                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer sk-sy-…` (or `x-api-key`) | Virtual key bound to a team                                                                             |
| `x-request-id`                                   | Propagated (generated if absent or unsafe); see the note below                                          |
| `x-sy-user`, `x-sy-tags`                         | End-user attribution and comma-separated tags, stored in usage events (the body field `user` works too) |
| `x-sy-cache: default \| bypass \| refresh`       | Cache control for this request. `refresh` skips the lookup but stores the new response                  |
| `traceparent`, `tracestate`, `baggage`           | W3C trace context. With tracing on, the gateway joins the caller's trace and follows its sampling flag  |

## Response headers

| Header                                                      | Meaning                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `x-request-id`, `x-sy-route`, `x-sy-provider`, `x-sy-model` | Where the request went (`x-sy-model` is the upstream model)                                     |
| `x-sy-cache`                                                | `miss`, `bypass`, `hit` or `semantic-hit`                                                       |
| `x-sy-cost-usd`                                             | USD cost of this request (non-streaming responses and cache hits; for streams use `usage.cost`) |
| `x-sy-saved-usd`, `x-sy-semantic-similarity`                | On cache hits: the original cost that was saved; cosine similarity for semantic hits            |
| `x-sy-cache-items`                                          | Embeddings: `<cached>/<total>` input items served from the cache                                |
| `x-sy-fallbacks`, `x-sy-latency-ms`                         | Targets skipped or failed before success; gateway latency                                       |
| `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`     | The tightest rate-limit scope (key or team)                                                     |
| `retry-after`, `retry-after-ms`                             | On 429 (gateway limits) and on 503 when the upstream is unavailable                             |
| `x-sy-trace-id`                                             | Trace id of this request when tracing is on and the request is sampled (also on errors)         |

A client-supplied `x-request-id` is echoed back unchanged and used in logs. Usage rows in
Postgres store `<client-id>:req_<24 chars>` instead, because client ids are not guaranteed to be
unique and the usage ledger is idempotent on `(ts, request_id)`. Search usage by prefix:
`request_id LIKE '<client-id>:%'`.

With tracing on (see [OBSERVABILITY.md § Tracing](OBSERVABILITY.md#tracing)), every upstream
request carries a `traceparent` (naming the gateway's attempt span when the request is sampled),
plus the caller's `tracestate` and `baggage`. A request with `traceparent: …-00` (not sampled) is not recorded and gets no
`x-sy-trace-id`; its context is still forwarded upstream. With tracing off, trace headers are
neither read nor forwarded.

## Cost in the response body: `usage.cost`

Chat responses carry the request's cost in the `usage` object. This follows the convention used
by OpenRouter and others, so clients that already read `usage.cost` work unchanged:

| Field                 | Type                                                  | Meaning                                                                                                             |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `usage.cost`          | number (USD)                                          | Cost of this request, priced from usage and the pricing table. The same value as `x-sy-cost-usd`. `0` on cache hits |
| `usage.sy_cache`      | `"miss"` \| `"bypass"` \| `"hit"` \| `"semantic-hit"` | Cache result, the same as `x-sy-cache`                                                                              |
| `usage.sy_saved_cost` | number (USD), only on cache hits                      | The original cost of the cached response, which this request did not pay                                            |

Where the fields appear:

- **Non-streaming** `POST /v1/chat/completions`: in `usage`, for misses and cache hits alike.
- **Streaming with `stream_options: { "include_usage": true }`:** in the final usage chunk
  (empty `choices`, then `[DONE]`), including streamed replays of cache hits. Headers are sent
  before the cost is known, so this chunk is the only place a streaming client gets the cost.
- **Streaming without `include_usage`:** no usage chunk is sent, as with OpenAI. The cost is
  still recorded in the usage ledger.

The fields are additive. The standard fields (`prompt_tokens`, `completion_tokens`,
`total_tokens` and the `*_details`) are unchanged, and OpenAI SDKs pass unknown usage fields
through. Embeddings and rerank report the cost in `x-sy-cost-usd` only.

Example: the final chunk of a streamed request, then the same request served from the cache:

```json
{"id":"chatcmpl-…","object":"chat.completion.chunk","created":1793000000,"model":"chat","choices":[],
 "usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"cost":0.00007,"sy_cache":"miss"}}

{"id":"chatcmpl-…","object":"chat.completion.chunk","created":1793000001,"model":"chat","choices":[],
 "usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"cost":0,"sy_cache":"hit","sy_saved_cost":0.00007}}
```

With the official `openai` SDK (TypeScript):

```ts
const stream = await client.chat.completions.create({
  model: 'chat',
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'hello' }],
});
for await (const chunk of stream) {
  if (chunk.usage) {
    const { cost, sy_cache } = chunk.usage as typeof chunk.usage & {
      cost: number;
      sy_cache: string;
    };
    console.log(`cost $${cost} (${sy_cache})`);
  }
}
```

## Embedding extensions

Some embedding models need task prefixes. For example, embeddinggemma expects
`task: search result | query: …`. Clients send `input_type: "query" | "document"`, and
optionally `input_titles: string[]`. The gateway then applies the target model's
`input_templates`:

```yaml
input_templates:
  query: 'task: search result | query: {text}'
  document: 'title: {title} | text: {text}' # {title} ← input_titles[i] or "none"
```

String inputs are cached per item. Only the misses go upstream, and the merged response looks
exactly like an uncached one.

## Error codes

| Status | Codes                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`, `unsupported_content`                                                                      |
| 401    | `invalid_api_key`                                                                                             |
| 402    | `budget_exceeded`                                                                                             |
| 403    | `model_not_allowed`                                                                                           |
| 404    | `model_not_found`                                                                                             |
| 409    | `conflict` (admin API)                                                                                        |
| 429    | `rate_limit_exceeded`                                                                                         |
| 502    | `upstream_error`, `upstream_invalid_output`, `upstream_auth`                                                  |
| 503    | `upstream_unavailable` (+ `retry-after`), `service_unavailable` (Redis or Postgres down in fail-closed paths) |
| 504    | `upstream_timeout`                                                                                            |

Upstream client errors (400 and 422) are passed through with the upstream's message.
Unexpected errors return `Internal server error`; details are only logged.
