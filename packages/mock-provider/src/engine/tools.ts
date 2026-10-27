import { messageText } from './text.js';
import type {
  MockChatRequest,
  MockChatResult,
  MockEngineOptions,
  MockMessage,
  MockTool,
  MockToolCallResult,
} from './types.js';

/**
 * `mock-tools`: scripted (or schema-synthesized) tool calling.
 *
 * Script source: `metadata.mock_script` (inline array) or `scripts[metadata.mock_script_id]`.
 * The step index is the number of assistant messages already in the conversation, so a script
 * naturally advances as the client appends tool results and calls again. Each step is either
 * `{ tool_calls: [{ name, arguments }] }` or `{ content: "…" }`.
 */

const MAX_RESULT_PREVIEW = 200;

export function resolveScript(
  req: MockChatRequest,
  opts: MockEngineOptions,
): readonly unknown[] | undefined {
  const inline = req.metadata?.mock_script;
  if (Array.isArray(inline)) return inline as unknown[];
  const id = req.metadata?.mock_script_id;
  if (typeof id === 'string' && opts.scripts?.[id]) return opts.scripts[id];
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return {};
}

/** Interprets one script step; unknown shapes become a plain content reply. */
export function stepToResult(step: unknown): MockChatResult {
  if (isRecord(step) && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    const toolCalls: MockToolCallResult[] = step.tool_calls.filter(isRecord).map((tc) => {
      const fn = isRecord(tc.function) ? tc.function : tc;
      return {
        name: typeof fn.name === 'string' ? fn.name : 'unknown',
        arguments: parseArgs(fn.arguments),
      };
    });
    const content = typeof step.content === 'string' ? step.content : null;
    return { mode: 'tools', content, toolCalls, finishReason: 'tool_calls' };
  }
  if (isRecord(step) && typeof step.content === 'string') {
    return { mode: 'tools', content: step.content, toolCalls: [], finishReason: 'stop' };
  }
  return {
    mode: 'tools',
    content: typeof step === 'string' ? step : 'Done.',
    toolCalls: [],
    finishReason: 'stop',
  };
}

/** Builds placeholder arguments that satisfy a JSON schema's required properties. */
export function synthesizeFromSchema(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 8) return {};
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0)
    return synthesizeFromSchema(variants[0], depth + 1);
  const type = Array.isArray(schema.type)
    ? (schema.type as unknown[]).find((t) => t !== 'null')
    : schema.type;
  switch (type) {
    case 'string':
      return 'mock';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'null':
      return null;
    default: {
      const props = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((r): r is string => typeof r === 'string')
        : [];
      const out: Record<string, unknown> = {};
      for (const key of required) out[key] = synthesizeFromSchema(props[key], depth + 1);
      return out;
    }
  }
}

function forcedToolName(toolChoice: unknown): string | undefined {
  if (
    isRecord(toolChoice) &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === 'string'
  ) {
    return toolChoice.function.name;
  }
  return undefined;
}

function toolNameFor(messages: readonly MockMessage[], toolMsg: MockMessage): string {
  if (toolMsg.name) return toolMsg.name;
  for (const m of messages) {
    for (const tc of m.tool_calls ?? [])
      if (tc.id && tc.id === toolMsg.tool_call_id) return tc.function.name;
  }
  return 'tool';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function toolsAnswer(req: MockChatRequest, opts: MockEngineOptions): MockChatResult {
  const script = resolveScript(req, opts);
  if (script) {
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    if (step < script.length) return stepToResult(script[step]);
    const last = script[script.length - 1];
    const lastResult = last === undefined ? undefined : stepToResult(last);
    return lastResult && lastResult.finishReason === 'stop'
      ? lastResult
      : { mode: 'tools', content: 'Done.', toolCalls: [], finishReason: 'stop' };
  }

  const messages = req.messages;
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') {
    const trailing: MockMessage[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role === 'tool'; i--)
      trailing.unshift(messages[i]!);
    const summary = trailing
      .map((m) => `${toolNameFor(messages, m)}: ${truncate(messageText(m), MAX_RESULT_PREVIEW)}`)
      .join('; ');
    return {
      mode: 'tools',
      content: `Done. Tool results: ${summary}`,
      toolCalls: [],
      finishReason: 'stop',
    };
  }

  const tools: readonly MockTool[] = req.tools ?? [];
  if (tools.length > 0 && req.tool_choice !== 'none') {
    const forced = forcedToolName(req.tool_choice);
    const tool = (forced ? tools.find((t) => t.function.name === forced) : undefined) ?? tools[0]!;
    const args = synthesizeFromSchema(tool.function.parameters ?? { type: 'object' });
    return {
      mode: 'tools',
      content: null,
      toolCalls: [{ name: tool.function.name, arguments: isRecord(args) ? args : {} }],
      finishReason: 'tool_calls',
    };
  }
  return { mode: 'tools', content: 'No tools available.', toolCalls: [], finishReason: 'stop' };
}
