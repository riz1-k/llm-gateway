# Architecture decision records

Short records of the decisions that shape Switchyard: the context, the decision and its
consequences. A superseded record stays here, marked as superseded, and points to its
replacement.

| #                                                | Decision                                                   | Status   |
| ------------------------------------------------ | ---------------------------------------------------------- | -------- |
| [0001](0001-hono-http-layer.md)                  | Hono as the HTTP layer, with a Fetch-API core              | Accepted |
| [0002](0002-opencode-emulation.md)               | Emulate tool calling and JSON mode for the opencode bridge | Accepted |
| [0003](0003-lua-sliding-window-limits.md)        | Rate limits as one atomic Lua sliding-window check         | Accepted |
| [0004](0004-redis-streams-usage-pipeline.md)     | Usage events through a Redis Stream into Postgres          | Accepted |
| [0005](0005-semantic-cache-redis-vector-sets.md) | Semantic cache on Redis 8 vector sets                      | Accepted |
| [0006](0006-budgets-preflight-reconciliation.md) | Budgets: pre-flight check plus reconciliation              | Accepted |

New records copy the structure of an existing one: Status, Context, Decision, Consequences, and
Alternatives considered.
