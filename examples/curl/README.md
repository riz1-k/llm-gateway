# curl

[`run.sh`](run.sh) talks to Switchyard over plain HTTP (curl and jq):

- `POST /v1/rerank` in the Cohere/Jina shape;
- cache controls: a repeated request is a `hit` (with `x-sy-saved-usd`), `x-sy-cache: bypass`
  skips the cache, `x-sy-cache: refresh` skips the lookup and stores the new answer;
- attribution: `x-sy-user` and `x-sy-tags` are stored with the request's usage event
  (`run-all.sh` checks that they reach the usage sink);
- the OpenAI error envelope: 401 `invalid_api_key`, 404 `model_not_found`, 400 `invalid_request`;
- with `SWITCHYARD_ADMIN_TOKEN` set and a gateway running with Redis and Postgres: a team with a
  $0.000001 monthly budget gets 402 `budget_exceeded`, and a key with `rpm_limit: 2` gets 429
  `rate_limit_exceeded` with `retry-after` and `x-ratelimit-*` headers on its third request. The
  two teams are created through the admin API and deleted at the end.

```bash
./run.sh                                  # platform off
../run-all.sh --platform --only curl      # with Redis + Postgres (402 / 429)
```

Expected output with `--platform`:

```text
✔ rerank: top document #1 ([{"index":1,"relevance_score":0.500436},{"index":0,"relevance_score":0.000156}])
✔ cache: first=miss, repeat=hit (saved $0.00000405), x-sy-cache:bypass → bypass, x-sy-cache:refresh → miss (re-stored)
✔ attribution: x-sy-user=curl-example-user x-sy-tags=app:examples,sdk:curl (request req_…)
✔ error invalid key: 401 invalid_api_key — Incorrect API key provided.
✔ error unknown model: 404 model_not_found — The model `no-such-route` does not exist or you do not have access to it.
✔ error invalid body: 400 invalid_request — Invalid request: messages: messages must contain at least one message
✔ error budget: 402 budget_exceeded — Budget exceeded for team ex-budget-… (monthly).
✔ error rate limit: 429 rate_limit_exceeded — Rate limit exceeded (key:rpm).
  retry-after=38s x-ratelimit-limit-requests=2 x-ratelimit-remaining-requests=0
curl: all checks passed
```

Without the platform, the last two checks print `• 402/429 skipped` (rate limits and budgets
need Redis and Postgres).
