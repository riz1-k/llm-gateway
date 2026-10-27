# ADR 0002: Emulate tool calling and JSON mode for the opencode bridge

- **Status:** Accepted
- **Date:** 2026-06

## Context

The main local backend is [opencode](https://opencode.ai) `serve`, which fronts GitHub Copilot
models over a session API (create a session, post a message, read the result or subscribe to
`/event`). That API has no OpenAI-style `tools`, `tool_choice` or `response_format`: the model
only produces text, and opencode's own tools are disabled for the gateway agent. The consumers
(an agent with tool calling, a RAG app with structured output) need those features to behave
exactly like OpenAI's, including streaming.

## Decision

The `opencode` adapter emulates the missing features in the prompt and validates the output.
Details are in [docs/opencode-bridge.md](../opencode-bridge.md).

- **Stateless sessions:** each request creates a session, sends one message and always deletes
  the session, including on abort or timeout.
- **Transcript:** a multi-turn conversation, including earlier tool calls and tool results, is
  rendered into one text part inside `<message>` tags, with closing tags escaped.
- **Tools:** the system prompt lists the tools as JSON and a strict protocol: emit
  `<tool_call>{"name","arguments"}</tool_call>` blocks and nothing after the last block. A
  tolerant scanner extracts the blocks, `name` must be a declared tool, and ajv validates the
  arguments against the tool's schema. One repair round-trip sends the validator errors back.
  If the repair fails too, the reply is returned as plain text and `tool_emulation_failed` is
  logged.
- **JSON mode:** `json_object` and `json_schema` (including `strict`) are instructed, stripped of
  code fences, parsed and validated, with one repair round-trip. If that fails, the gateway
  returns 502 `upstream_invalid_output`.
- **Streaming:** text deltas come from opencode's `/event` SSE. Text is streamed until a
  `<tool_call>` tag starts; the rest is buffered and emitted as OpenAI `tool_calls` deltas.
- **Usage:** usage is mapped from opencode's token counts and priced at a configurable shadow
  price, because Copilot is subscription-billed.

## Consequences

- Clients use plain OpenAI SDKs. The emulation is invisible apart from latency.
- Repairs cost one more model call. That is bounded by `repair_attempts` and visible in metrics.
- Emulated calls are only as reliable as the model's protocol adherence. Validation guarantees
  that a returned `tool_calls` entry is well formed, not that the model chose well.
- Client-supplied JSON-Schema patterns could be ReDoS vectors. Unsafe patterns are treated as
  annotations (SR-02 in [SECURITY_REVIEW.md](../SECURITY_REVIEW.md)).
- The same emulation could serve other text-only backends. Today only the `opencode` adapter
  uses it.

## Alternatives considered

- **Reject tools and JSON mode for opencode routes:** simple, but it breaks the consumers and
  pushes provider differences back into every app.
- **Let opencode run tools itself:** this executes tools inside the gateway host, which is a
  security boundary violation. It also doesn't match OpenAI's client-executes-tools contract.
- **Grammar-constrained decoding:** not available through Copilot.
