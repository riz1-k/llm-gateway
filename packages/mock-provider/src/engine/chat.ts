import { extractiveAnswer } from './extractive.js';
import { lastUserText } from './text.js';
import { toolsAnswer } from './tools.js';
import type { MockChatRequest, MockChatResult, MockEngineOptions, MockMode } from './types.js';

export const DEFAULT_FIXED_TEXT = 'This is a fixed response from the Switchyard mock provider.';

/** Selects the behavior from a model name (`mock-extractive`, `my-tools-model`, …); default echo. */
export function resolveMode(model: string): MockMode {
  const m = model.toLowerCase();
  if (m.includes('extractive')) return 'extractive';
  if (m.includes('tools')) return 'tools';
  if (m.includes('fixed')) return 'fixed';
  return 'echo';
}

/** Runs the deterministic chat behavior selected by `req.model` (or an explicit mode). */
export function runMockChat(
  req: MockChatRequest,
  opts: MockEngineOptions = {},
  mode = resolveMode(req.model),
): MockChatResult {
  switch (mode) {
    case 'fixed':
      return {
        mode,
        content: opts.fixedText ?? DEFAULT_FIXED_TEXT,
        toolCalls: [],
        finishReason: 'stop',
      };
    case 'extractive':
      return {
        mode,
        content: extractiveAnswer(req.messages, opts.extractiveThreshold ?? 0.2),
        toolCalls: [],
        finishReason: 'stop',
      };
    case 'tools':
      return toolsAnswer(req, opts);
    case 'echo':
      return { mode, content: lastUserText(req.messages), toolCalls: [], finishReason: 'stop' };
  }
}

/** Splits text into small word groups (whitespace preserved) for streaming. */
export function wordGroups(text: string, wordsPerChunk = 3): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [];
  const leading = /^\s+/.exec(text)?.[0] ?? '';
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += wordsPerChunk)
    out.push(tokens.slice(i, i + wordsPerChunk).join(''));
  if (leading && out.length > 0) out[0] = leading + out[0]!;
  return out;
}
