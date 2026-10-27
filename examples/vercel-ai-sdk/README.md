# Vercel AI SDK

[`index.ts`](index.ts) uses [`ai`](https://www.npmjs.com/package/ai) 7.0.154 with
[`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) 3.0.79:
`createOpenAICompatible({ baseURL, apiKey, includeUsage: true })`, then route names as model
ids.

It covers `generateText` (with `response.headers['x-sy-route']`), `streamText`, a tool with
`execute` run over two steps (`stopWhen: isStepCount(2)`) and `embedMany`. A small
`metadataExtractor` copies Switchyard's `usage.cost` into `providerMetadata.switchyard.cost`, for
streams too. Every request carries `x-sy-user` / `x-sy-tags` headers for attribution.

```bash
npm ci
node index.ts        # Node >= 22.18; also: bun index.ts, deno run -A index.ts
```

Expected output:

```text
✔ generateText: "hello from the vercel ai sdk" tokens=23 cost=$0.00000705 x-sy-route=chat
✔ streamText: "stream from the vercel ai sdk" tokens=23 cost=$0.00000705
✔ tools: 2 steps, get_weather({"city":"mock"}) → "Done. Tool results: get_weather: {"city":"mock","temperature_c":18}"
✔ embedMany: 2 x 256-d
vercel-ai-sdk: all checks passed
```
