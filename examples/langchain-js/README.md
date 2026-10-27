# LangChain.js

[`index.ts`](index.ts) uses `ChatOpenAI` from
[`@langchain/openai`](https://www.npmjs.com/package/@langchain/openai) 1.7.1. The gateway URL
goes in `configuration.baseURL` (the options of the underlying `openai` client), and so do
`defaultHeaders` such as `x-sy-user` / `x-sy-tags`.

It covers `invoke`, a `bindTools` round trip with a `ToolMessage`, and
`withStructuredOutput(zodSchema, { method: 'jsonSchema' })`, which sends
`response_format: json_schema` and parses the answer.

```bash
npm ci
node index.ts        # Node >= 22.18; also: bun index.ts, deno run -A index.ts
```

Expected output:

```text
✔ chat: "hello from langchain.js" tokens=15
✔ tools: get_weather({"city":"mock"}) → "Done. Tool results: get_weather: {"city":"mock","temperature_c":18}"
✔ withStructuredOutput: {"city":"Paris","country":"France","population_millions":2.1}
langchain-js: all checks passed
```
