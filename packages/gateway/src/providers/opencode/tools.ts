import { newToolCallId } from '../../core/ids.js';
import type { ToolCall, ToolChoice, ToolDefinition } from '../../core/types.js';
import { sharedValidator, type SchemaValidator } from '../../util/json-schema.js';

/**
 * Tool-calling emulation for upstreams without native tool support (opencode → Copilot Claude).
 *
 * Protocol: the model emits one or more `<tool_call>{"name": …, "arguments": {…}}</tool_call>`
 * blocks after an optional short sentence. The tolerant parser below handles code fences,
 * attributes on the tag, stringified arguments, aliases (`parameters`/`input`), a missing closing
 * tag at the very end, and surrounding prose. Arguments are validated with ajv against the tool's
 * JSON schema; failures trigger one repair round-trip in the adapter.
 */

export function buildToolInstructions(
  tools: ToolDefinition[],
  toolChoice: ToolChoice | undefined,
  parallel: boolean | undefined,
): string {
  const specs = tools.map((t) =>
    JSON.stringify({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }),
  );
  const rules: string[] = [
    'You can call the tools listed below. Tool results are provided to you in later messages.',
    'To call a tool, output a block of exactly this form:',
    '<tool_call>{"name": "<tool name>", "arguments": {<arguments as a JSON object>}}</tool_call>',
    'Rules:',
    '- The content of each block must be a single valid JSON object with the keys "name" and "arguments".',
    '- "arguments" must satisfy the tool\'s JSON Schema "parameters" (correct types, all required fields, no extra fields).',
    '- You may write one short sentence before the first block. Write nothing after the last block.',
    '- Do not wrap blocks in code fences or markdown.',
    '- Never invent or predict tool results; stop after the tool call(s) and wait for the results.',
    '- If no tool is needed, answer normally without any <tool_call> block.',
  ];
  if (parallel === false) rules.push('- Call at most one tool per reply.');
  else
    rules.push(
      '- You may call several tools in one reply by emitting several blocks, if they are independent.',
    );
  if (toolChoice === 'required') {
    rules.push('- You MUST call at least one tool in this reply.');
  } else if (typeof toolChoice === 'object') {
    rules.push(
      `- You MUST call the tool "${toolChoice.function.name}" in this reply, and no other tool.`,
    );
  }
  return ['# Tools', ...rules, '', '<tools>', ...specs, '</tools>'].join('\n');
}

export interface ParsedToolCalls {
  /** Whether any `<tool_call>` block was found. */
  found: boolean;
  calls: ToolCall[];
  /** Text outside the blocks (trimmed), or null when empty. */
  content: string | null;
  /** Validation/parsing problems (empty = valid). */
  errors: string[];
}

const OPEN_TAG = /<tool_call\b[^>]*>/gi;
const CLOSE_TAG = /<\/tool_call\s*>/i;

/** Removes code fences that wrap tool-call blocks, keeping other fenced code intact. */
function stripFencesAroundToolCalls(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*[ \t]*\n?([\s\S]*?)```/g, (whole, inner: string) =>
    /<tool_call\b/i.test(inner) ? inner : whole,
  );
}

/** Extracts the first balanced JSON object from a string (tolerates trailing junk). */
export function extractJsonObject(s: string): string | undefined {
  const start = s.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

interface RawBlock {
  body: string;
  start: number;
  end: number;
}

function findBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  OPEN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  let searchFrom = 0;
  while ((m = OPEN_TAG.exec(text)) !== null) {
    if (m.index < searchFrom) continue;
    const bodyStart = m.index + m[0].length;
    const rest = text.slice(bodyStart);
    const close = CLOSE_TAG.exec(rest);
    // Unterminated block: take the balanced JSON object (model hit a stop or forgot the tag).
    const bodyEnd = close
      ? bodyStart + close.index
      : bodyStart + (extractJsonObject(rest)?.length ?? rest.length);
    const end = close ? bodyStart + close.index + close[0].length : bodyEnd;
    blocks.push({ body: text.slice(bodyStart, bodyEnd), start: m.index, end });
    searchFrom = end;
    OPEN_TAG.lastIndex = end;
  }
  return blocks;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Parses and validates emulated tool calls in a model reply. */
export function parseToolCalls(
  rawText: string,
  tools: ToolDefinition[],
  opts: { toolChoice?: ToolChoice; parallel?: boolean; validator?: SchemaValidator } = {},
): ParsedToolCalls {
  const validator = opts.validator ?? sharedValidator;
  const text = stripFencesAroundToolCalls(rawText);
  const blocks = findBlocks(text);
  const errors: string[] = [];
  const calls: ToolCall[] = [];
  const byName = new Map(tools.map((t) => [t.function.name, t]));

  blocks.forEach((block, i) => {
    const label = `tool call #${i + 1}`;
    const json = extractJsonObject(block.body);
    if (!json) {
      errors.push(`${label}: block does not contain a JSON object`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      errors.push(`${label}: invalid JSON (${(err as Error).message})`);
      return;
    }
    const obj = asRecord(parsed);
    const name = obj?.name ?? obj?.tool ?? obj?.function;
    if (typeof name !== 'string' || !name) {
      errors.push(`${label}: missing "name"`);
      return;
    }
    const tool = byName.get(name);
    if (!tool) {
      errors.push(`${label}: unknown tool "${name}" (available: ${[...byName.keys()].join(', ')})`);
      return;
    }
    let args: unknown = obj?.arguments ?? obj?.parameters ?? obj?.input ?? {};
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        errors.push(`${label} (${name}): "arguments" is a string that is not valid JSON`);
        return;
      }
    }
    if (!asRecord(args)) {
      errors.push(`${label} (${name}): "arguments" must be a JSON object`);
      return;
    }
    const result = validator.validate(tool.function.parameters, args, {
      strict: tool.function.strict === true,
    });
    if (!result.valid) {
      errors.push(
        `${label} (${name}): arguments do not match the schema: ${result.errors.join('; ')}`,
      );
      return;
    }
    calls.push({
      id: newToolCallId(),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  });

  // Text outside of the blocks.
  let outside = '';
  let cursor = 0;
  for (const b of blocks) {
    outside += text.slice(cursor, b.start);
    cursor = b.end;
  }
  outside += text.slice(cursor);
  const content = outside.replace(/```[a-zA-Z0-9_-]*\s*```/g, '').trim();

  const choice = opts.toolChoice;
  if (errors.length === 0) {
    if (choice === 'required' && calls.length === 0)
      errors.push('a tool call is required but none was made');
    if (typeof choice === 'object') {
      const forced = choice.function.name;
      if (!calls.some((c) => c.function.name === forced))
        errors.push(`the tool "${forced}" must be called`);
    }
  }
  const finalCalls = opts.parallel === false ? calls.slice(0, 1) : calls;
  return {
    found: blocks.length > 0,
    calls: finalCalls,
    content: content.length > 0 ? content : null,
    errors,
  };
}

export function buildToolRepairPrompt(errors: string[]): string {
  return [
    'Your previous reply could not be processed because of these problems:',
    ...errors.map((e) => `- ${e}`),
    '',
    'Reply again with the corrected tool call block(s) only, using exactly the format',
    '<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>',
    'with arguments that satisfy the tool schema. No code fences, no other text.',
  ].join('\n');
}

const MARKERS = ['<tool_call', '```'];

/**
 * Incremental filter for streamed text when tools are enabled: passes text through until a
 * possible tool-call block (or a code fence that might wrap one) starts, then holds the rest
 * back for the final parse. Also holds back a trailing partial marker (e.g. "<tool_ca").
 */
export class ToolStreamFilter {
  private buffer = '';
  private emitted = 0;
  private holding = false;

  /** Feed a delta; returns text that is safe to emit now. */
  push(delta: string): string {
    this.buffer += delta;
    if (this.holding) return '';
    const pending = this.buffer.slice(this.emitted);
    let cut = pending.length;
    for (const marker of MARKERS) {
      const idx = pending.indexOf(marker);
      if (idx !== -1 && idx < cut) {
        cut = idx;
        this.holding = true;
      }
    }
    if (!this.holding) {
      // Hold back any suffix that is a prefix of a marker.
      for (const marker of MARKERS) {
        for (let k = Math.min(marker.length - 1, pending.length); k > 0; k--) {
          if (pending.endsWith(marker.slice(0, k))) {
            cut = Math.min(cut, pending.length - k);
            break;
          }
        }
      }
    }
    const out = pending.slice(0, cut);
    this.emitted += out.length;
    return out;
  }

  /** Text emitted so far. */
  get emittedText(): string {
    return this.buffer.slice(0, this.emitted);
  }

  get fullText(): string {
    return this.buffer;
  }
}
