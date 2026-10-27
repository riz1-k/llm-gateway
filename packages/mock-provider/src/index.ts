/**
 * @switchyard/mock-provider — deterministic, fault-injectable fake LLM upstream.
 *
 * - Engine: pure behaviors (echo, fixed, RAG-aware extractive, scripted tools, hashed embeddings,
 *   lexical rerank, fault resolution) shared with the gateway's in-process `mock` provider.
 * - Server: OpenAI-, Anthropic- and rerank-style HTTP endpoints over the same engine.
 */
export * from './engine/index.js';
export {
  anthropicToChatRequest,
  createMockApp,
  startMockServer,
  type MockApp,
  type MockServerOptions,
  type MockStats,
  type RecordedRequest,
  type RunningMockServer,
  type StartMockServerOptions,
} from './server.js';
