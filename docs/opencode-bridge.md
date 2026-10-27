# The opencode bridge provider

Switchyard's `opencode` provider turns an [`opencode serve`](https://opencode.ai) instance into an
OpenAI-compatible upstream. On this machine that is the only path to a frontier model: GitHub
Copilot's `claude-sonnet-5.5` (plus `claude-haiku-4.5`, `gpt-5.6-terra`, …) behind
`opencode serve --pure` on `127.0.0.1:4096` with HTTP basic auth and a lean agent called `gateway`
(all built-in tools disabled; see `devenv/opencode/opencode.json`).

opencode is **not** OpenAI-compatible, and its native structured output (`format: json_schema`)
does **not** work with Copilot Claude (it forces `tool_choice`, which Copilot rejects). The adapter
therefore emulates the OpenAI features that clients rely on.

Source: `packages/gateway/src/providers/opencode/` (`index.ts` adapter, `client.ts` HTTP client,
`events.ts` event hub, `transcript.ts`, `tools.ts`, `json-mode.ts`).

## Request lifecycle

```
POST /session {"title":"switchyard <requestId>","agent":"gateway"}        → {id: "ses_…"}
(stream only) subscribe to the shared GET /event SSE connection, filter by sessionID
POST /session/{id}/message {agent, model:{providerID,modelID}, system, variant?, parts}
      → {info:{tokens, error?, finish}, parts:[step-start, reasoning?, text, step-finish]}
(repair only) a second POST /session/{id}/message in the same session
finally: POST /session/{id}/abort (if unfinished) → DELETE /session/{id}
```

- **Stateless sessions.** Every request (every attempt) gets a fresh session, and it is always
  deleted in a `finally` block, including on errors, timeouts, client disconnects and early stream
  cancellation. The live suite and verification checked this: 0 `switchyard*` sessions remained
  afterwards. Cleanup uses its own 5 s timeout, so an aborted request signal cannot skip it.
- **Concurrency.** The router enforces `max_concurrency` (default 4) per provider through a FIFO
  semaphore. Waiting longer than `queue_timeout_ms` fails with retryable `upstream_busy`.
- **Timeouts.** The per-attempt timeout (`timeout_ms`, default 180 s) aborts the fetch. The
  adapter then calls `/abort` so opencode stops generating, and deletes the session.

## Transcript rendering

- `system` and `developer` messages are joined and go into opencode's per-message `system`
  field. Protocol instructions (tools, JSON) are appended after them.
- A conversation that is a single user message is sent verbatim, which is the common RAG case.
- Anything longer is rendered into one text part:

```
<conversation>
<message role="user">Where is ORD-1?</message>
<message role="assistant">Checking.
<tool_call id="call_1">{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call></message>
<message role="tool" tool_call_id="call_1" name="get_order">{"status":"shipped"}</message>
<message role="user">Thanks</message>
</conversation>
Reply with the assistant's next message only.
```

Closing tags inside content (`</message>`, `</conversation>`) are escaped so user text cannot
break the frame. Images given as `data:` URLs become opencode `file` parts. Remote image URLs
fail with `unsupported_content`, which is fallback-eligible so a native provider can take over.

## Tool-calling emulation

This applies when `tools` is non-empty and `tool_choice != "none"`.

1. A `# Tools` section is appended to `system`: the protocol rules plus one JSON spec per tool
   inside `<tools>…</tools>`. `tool_choice: "required"` or a named function adds a MUST rule, and
   `parallel_tool_calls: false` adds "at most one tool".
2. The model answers with an optional short sentence followed by
   `<tool_call>{"name": …, "arguments": {…}}</tool_call>` blocks.
3. A tolerant parser handles:
   - code fences around the blocks
   - attributes on the tag
   - a missing closing tag at the end
   - stringified arguments
   - `parameters`/`input` aliases
   - prose around the blocks

   Each call is checked: the name must exist, and the arguments must validate against the tool's
   JSON Schema with **ajv** (`strict: true` tools forbid extra properties).

4. If blocks were found but are invalid, or a required call is missing, the adapter makes **one
   repair round-trip** in the same session. It lists the validator errors and asks the model to
   re-emit the blocks only.
5. If the output is still invalid, the reply is returned as plain text with `finish_reason: stop`
   and `tool_emulation_failed` is logged.
6. On success the response carries `message.tool_calls[{id:"call_…", type:"function",
function:{name, arguments}}]`, `content` holds the preamble or `null`, and
   `finish_reason` is `"tool_calls"`.

Live result: the OpsAgent-style round trip `get_order` → tool result → final answer worked on the
first try with `claude-sonnet-5.5`, with no repair needed.

## JSON mode emulation

`response_format: json_object | json_schema` adds an output-format section to `system` (including
the schema and a strict-mode note). The reply is extracted from fences or prose, parsed, and
validated with ajv. If it fails, there is one repair round-trip. If it still fails, the request
gets `502 upstream_invalid_output`, which is fallback-eligible. The content returned is canonical
`JSON.stringify` of the parsed value.

## Reasoning, sampling and limits

- `reasoning_effort` maps to opencode `variant` as follows:
  - `low | medium | high | xhigh | max` pass through unchanged.
  - `minimal | none | null` send no variant.
  - Route `defaults.reasoning_effort` applies when the client omits the field. The judges use
    `medium`.
- Reasoning text is never put in `content`. It is returned as `message.reasoning_content` only
  when `metadata.include_reasoning: true` is set.
- The bridge does not accept `temperature`/`top_p` for these models, nor `max_tokens` or `seed`.
  They are dropped and logged once at debug level. `temperature_models` re-enables sampling
  parameters for specific models.
- `stop` is emulated by truncating at the first stop sequence.
- `n > 1` is rejected with `400 invalid_request`.

## Usage, cost and errors

- **Usage**:
  - `prompt_tokens = input + cache.read + cache.write`
  - `completion_tokens = output + reasoning`
  - `prompt_tokens_details.cached_tokens = cache.read`
  - `completion_tokens_details.reasoning_tokens = reasoning`
  - Repair round-trips are added in.
- **Cost** is a _shadow price_ from `config/pricing.json` (Copilot is subscription-billed), so
  per-team attribution and budgets still work.
- **Errors** (taken from `info.error` in the reply):

| opencode error                                              | Switchyard classification                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `APIError` 429 (+`responseHeaders.retry-after`)             | `rate_limited`, retryable, Retry-After honored (cap 20 s)  |
| `APIError` 5xx, network errors, `UnknownError`, empty reply | retryable                                                  |
| `APIError` 400, `ContextOverflowError`                      | `invalid_request` (returned to client, no fallback)        |
| `APIError` 401/403, `ProviderAuthError`, bridge HTTP 401    | `upstream_auth` → 502, fallback, counts toward the breaker |
| `MessageAbortedError`                                       | `upstream_timeout`, retryable                              |
| `MessageOutputLengthError`                                  | not an error: `finish_reason: "length"`                    |
| `ContentFilterError`                                        | not an error: `finish_reason: "content_filter"`            |

## Streaming: real token streaming via `GET /event`

**Finding:** real streaming works. opencode 1.18.35 exposes one SSE feed per instance at
`GET /event` (basic auth). The first event is `server.connected`. Everything else is a JSON
envelope `{"id":"evt_…","type":…,"properties":{…}}`. I probed it with one live call
(`variant: low`, "count from 1 to 12"). The relevant sequence for one prompt was:

```
session.status            {sessionID, status:{type:"busy"}}
message.updated           {sessionID, info:{id:"msg_U", role:"user", …}}
message.part.updated      {sessionID, part:{id:"prt_u", messageID:"msg_U", type:"text", text:"<the prompt>"}}
message.updated           {sessionID, info:{id:"msg_A", role:"assistant", tokens:{…0}, …}}
message.part.updated      {part:{id:"prt_s", messageID:"msg_A", type:"step-start"}}
message.part.updated      {part:{id:"prt_t", messageID:"msg_A", type:"text", text:"", time:{start}}}
message.part.delta        {sessionID, messageID:"msg_A", partID:"prt_t", field:"text", delta:"one, two, three, four,"}
message.part.delta        {… delta:" five, six, seven, e"}
message.part.delta        {… delta:"ight, nine, ten,"}
message.part.delta        {… delta:" eleven, twelve"}
message.part.updated      {part:{id:"prt_t", type:"text", text:"<full text>", time:{start,end}}}
message.part.updated      {part:{type:"step-finish", reason:"stop", tokens:{input,output,reasoning,cache}, cost}}
message.updated           {info:{id:"msg_A", role:"assistant", tokens:{…final}, finish:"stop", time:{completed}}}
session.status            {status:{type:"idle"}}
session.idle              {sessionID}
```

Other noise on the same connection (`plugin.added` ×45 at connect, `session.diff`,
`catalog.updated`, …) is ignored. The newer `session.next.*` event family
(`session.next.text.delta` and others) is present in the OpenAPI schema but was not emitted for
these prompts.

**Implementation** (`events.ts`, `SessionStreamTracker` in `index.ts`):

- **Shared connection.** One `/event` connection per provider is multiplexed by `sessionID`. It
  opens lazily, `subscribe()` resolves only after `server.connected` (so no event of the new
  session is missed), and it closes after 30 s with no subscribers.
- **Ordering.** The adapter creates the session, subscribes, then sends the message on the
  synchronous endpoint. The synchronous reply stays authoritative for final text, usage and
  errors.
- **Mapping deltas.** Only `message.part.delta` with `field:"text"` on parts whose type is
  `text` and that belong to a non-user message become `delta.content`. The user message's echoed
  part is filtered out by tracking `role:"user"` message ids. Reasoning parts are emitted as
  `reasoning_content` only when requested. Deltas that arrive before their part type is known are
  buffered.
- **Diff fallback.** Parts that never received deltas (older or newer opencode builds) are
  streamed by diffing the full text in `message.part.updated`.
- **Robustness.** If the event stream is unavailable or drops, the adapter emits whatever was
  not yet streamed from the final reply. Clients still get a correct stream; it just arrives late.
- **With tools.** Text streams until a `<tool_call` or code-fence marker starts. Partial markers
  such as `<tool_ca` are held back. The remainder is buffered, parsed (with repair if needed) and
  emitted as `tool_calls` deltas. Code fences in tool-enabled answers are therefore delivered at
  the end.
- **Synthetic chunking** (await, then about 48-char chunks) is used for JSON mode (output must be
  validated before sending), for `stop` sequences (cannot be un-sent), and when
  `streaming: synthetic` is configured.
- **Gateway behavior.** The gateway commits a stream only on the first meaningful chunk, so a
  bridge failure before any text still falls back to the next target.

Observed live:

- Short answers often arrive as a single delta. Copilot bursts small completions.
- The probe's 12-word answer came in 4 deltas.
- The live test that counts to thirty asserted more than one content chunk and passed.
- Time to first byte for the docsqa-chat streaming check was about 0.9 s.

## Configuration reference

```yaml
providers:
  copilot:
    type: opencode
    base_url: http://127.0.0.1:4096
    username: ${OPENCODE_SERVER_USERNAME:-opencode}
    password: ${OPENCODE_SERVER_PASSWORD:-}
    agent: gateway # opencode agent (tools disabled)
    upstream_provider: github-copilot
    session_title: switchyard # sessions are titled "switchyard <requestId>"
    max_concurrency: 4
    queue_timeout_ms: 60000
    timeout_ms: 180000
    streaming: events # or synthetic
    repair_attempts: 1 # 0–3
    temperature_models: [] # models that accept temperature/top_p
```

## Testing

- `test/unit/providers/opencode.test.ts` runs 24 tests against an in-memory fake opencode
  (`test/fixtures/fake-opencode.ts`) that reproduces the event shapes above. It covers:
  - session create/delete on every path, including abort and timeout
  - repair round-trips, JSON mode, error mapping
  - event streaming, tool streaming, and event-stream outage
- `test/unit/opencode-emulation.test.ts` covers transcript rendering, the tool parser, the stream
  filter and JSON parsing.
- `pnpm test:live` (opt-in, `SWITCHYARD_LIVE=1`) makes 5 real calls: plain, stream, json_schema,
  and a tool call followed by a tool-result follow-up.
