import type { ResponseFormat } from '../../core/types.js';
import { sharedValidator, type SchemaValidator } from '../../util/json-schema.js';

/**
 * JSON-mode emulation (`response_format: json_object | json_schema`) for upstreams whose native
 * structured output is unavailable (opencode → Copilot Claude): prompt instructions, tolerant
 * extraction (code fences, surrounding prose), parsing, ajv validation, one repair round-trip.
 */

export type JsonFormat = Exclude<ResponseFormat, { type: 'text' }>;

export function isJsonFormat(f: ResponseFormat | undefined): f is JsonFormat {
  return f !== undefined && (f.type === 'json_object' || f.type === 'json_schema');
}

export function buildJsonInstructions(format: JsonFormat): string {
  const common = [
    '# Output format',
    'Respond with a single valid JSON value and nothing else: no prose before or after, no markdown, no code fences.',
  ];
  if (format.type === 'json_object') {
    return [...common, 'The JSON value must be an object.'].join('\n');
  }
  const spec = format.json_schema;
  return [
    ...common,
    `The JSON must conform to the JSON Schema named "${spec.name}"${spec.description ? ` (${spec.description})` : ''}:`,
    JSON.stringify(spec.schema ?? { type: 'object' }),
    spec.strict
      ? 'Strict mode: include every required property and no properties that the schema does not define.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface JsonParseResult {
  ok: boolean;
  /** Canonical JSON text to return as message content (when ok). */
  text: string;
  value?: unknown;
  errors: string[];
}

/** Finds the JSON payload in a model reply. */
export function extractJsonText(raw: string): string {
  let s = raw.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/m.exec(s);
  if (fence) s = fence[1]!.trim();
  if (s.startsWith('{') || s.startsWith('[')) return s;
  // Prose around the JSON: take the outermost object/array.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const starts = [firstObj, firstArr].filter((i) => i !== -1);
  if (starts.length === 0) return s;
  const start = Math.min(...starts);
  const close = s[start] === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  return end > start ? s.slice(start, end + 1) : s;
}

export function parseJsonOutput(
  raw: string,
  format: JsonFormat,
  validator: SchemaValidator = sharedValidator,
): JsonParseResult {
  const candidate = extractJsonText(raw);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      text: raw,
      errors: [`output is not valid JSON (${(err as Error).message})`],
    };
  }
  if (format.type === 'json_object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, text: raw, errors: ['output must be a JSON object'] };
    }
    return { ok: true, text: JSON.stringify(value), value, errors: [] };
  }
  const result = validator.validate(format.json_schema.schema, value, {
    strict: format.json_schema.strict === true,
  });
  if (!result.valid)
    return {
      ok: false,
      text: raw,
      value,
      errors: result.errors.map((e) => `schema violation: ${e}`),
    };
  return { ok: true, text: JSON.stringify(value), value, errors: [] };
}

export function buildJsonRepairPrompt(errors: string[], format: JsonFormat): string {
  return [
    'Your previous reply was not acceptable:',
    ...errors.map((e) => `- ${e}`),
    '',
    format.type === 'json_schema'
      ? 'Reply again with only the corrected JSON that conforms to the schema. No prose, no code fences.'
      : 'Reply again with only a single valid JSON object. No prose, no code fences.',
  ].join('\n');
}
