import { Ajv, type CodeOptions, type ErrorObject, type ValidateFunction } from 'ajv';

type RegExpEngine = NonNullable<CodeOptions['regExp']>;
import addFormatsModule from 'ajv-formats';

/**
 * Cached JSON Schema validation (ajv). Used to validate emulated tool-call arguments and
 * structured outputs. Schemas are compiled once and cached by their canonical JSON.
 *
 * Schemas come from API clients (tools, response_format) and the validated values from model
 * output that a client can steer, so validation must stay cheap:
 * - `pattern` / `patternProperties` regexes run through {@link guardedRegExp}: only patterns that
 *   cannot backtrack catastrophically are enforced (others are treated as annotations);
 * - the cache is bounded by recycling the ajv instances (ajv itself never forgets a compiled
 *   schema), and schemas are never registered by `$id` (no cross-request `$ref` resolution or
 *   id collisions).
 */

// ajv-formats ships CJS with a default export; normalize the interop shape.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv) => Ajv;

const MAX_CACHE = 500;

/** Longest pattern source that is enforced. */
export const MAX_PATTERN_LENGTH = 256;
/** Longest string tested against a pattern; longer strings are not checked. */
export const MAX_PATTERN_INPUT = 4096;

const REPEAT_QUANTIFIER = /^(?:[*+]|\{(\d+)(?:,(\d*))?\})/;

/**
 * Conservative ReDoS screen for client-supplied JSON-Schema patterns. A pattern is accepted only
 * if it has no backreferences or lookarounds, no repeated group that itself contains a repetition
 * or an alternation (star height ≤ 1), and at most one unbounded (or > 16) repetition overall —
 * which keeps backtracking polynomial with a small exponent for the bounded inputs we test.
 */
export function isSafePattern(source: string): boolean {
  if (source.length > MAX_PATTERN_LENGTH) return false;
  type Group = { repeat: boolean; alt: boolean };
  const stack: Group[] = [{ repeat: false, alt: false }];
  let unbounded = 0;
  // Applies a quantifier at position i (if any) to an atom; returns the index after it.
  const quantifier = (i: number, atom: Group | undefined): number | false => {
    const rest = source.slice(i);
    let len = 0;
    let repeats = false;
    if (rest[0] === '?') {
      len = 1;
    } else {
      const m = REPEAT_QUANTIFIER.exec(rest);
      if (m) {
        len = m[0].length;
        const min = m[1] === undefined ? undefined : Number(m[1]);
        const max = m[2] === undefined ? min : m[2] === '' ? Infinity : Number(m[2]);
        repeats = max === undefined || max > 1;
        if (max === undefined || max > 16) unbounded++;
      }
    }
    if (len === 0) return i;
    if (source[i + len] === '?' || source[i + len] === '+') len++; // lazy/possessive suffix
    if (repeats) {
      if (atom && (atom.repeat || atom.alt)) return false; // nested repetition / alternation
      stack[stack.length - 1]!.repeat = true;
    }
    return i + len;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    let atom: Group | undefined;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9k]/.test(next)) return false; // backreference
      i += 2;
    } else if (ch === '[') {
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      if (j >= source.length) return false;
      i = j + 1;
    } else if (ch === '(') {
      i++;
      if (source[i] === '?') {
        const kind = source.slice(i + 1, i + 3);
        if (kind[0] === '=' || kind[0] === '!' || kind === '<=' || kind === '<!') return false;
        if (kind[0] === ':') i += 2;
        else if (kind[0] === '<') {
          const close = source.indexOf('>', i);
          if (close < 0) return false;
          i = close + 1;
        } else return false;
      }
      stack.push({ repeat: false, alt: false });
      continue;
    } else if (ch === ')') {
      if (stack.length < 2) return false;
      atom = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      parent.repeat ||= atom.repeat;
      parent.alt ||= atom.alt;
      i++;
    } else if (ch === '|') {
      stack[stack.length - 1]!.alt = true;
      i++;
      continue;
    } else if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      if (ch !== '{' || REPEAT_QUANTIFIER.test(source.slice(i))) return false; // dangling quantifier
      i++;
      continue;
    } else {
      i++;
    }
    const after = quantifier(i, atom);
    if (after === false) return false;
    i = after;
  }
  return stack.length === 1 && unbounded <= 1;
}

/**
 * ajv regex engine for untrusted schemas: unsafe patterns (see {@link isSafePattern}) and overlong
 * inputs are not enforced instead of risking an event-loop stall.
 */
export const guardedRegExp: RegExpEngine = Object.assign(
  (pattern: string, flags: string) => {
    const rx = new RegExp(pattern, flags); // invalid patterns still fail schema compilation
    const safe = isSafePattern(pattern);
    return {
      test: (s: string): boolean => !safe || s.length > MAX_PATTERN_INPUT || rx.test(s),
      // ajv dedupes compiled regexes by this string.
      toString: () => `${safe ? '' : 'unenforced:'}${rx.toString()}`,
    };
  },
  { code: 'guardedRegExp' },
);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class SchemaValidator {
  private lenient!: Ajv;
  private strict!: Ajv;
  private readonly cache = new Map<string, ValidateFunction | Error>();

  constructor() {
    this.reset();
  }

  /**
   * Fresh ajv instances. ajv retains every compiled schema (its schema cache and its shared code
   * scope) for the life of the instance, so a bounded cache must drop the instances themselves.
   */
  private reset(): void {
    const base = {
      allErrors: true,
      strict: false,
      validateFormats: true,
      addUsedSchema: false,
      code: { regExp: guardedRegExp },
    } as const;
    this.lenient = addFormats(new Ajv({ ...base }));
    // `strict` structured outputs: forbid additional properties when the schema omits the keyword.
    this.strict = addFormats(new Ajv({ ...base }));
    this.cache.clear();
  }

  validate(
    schema: Record<string, unknown> | undefined,
    value: unknown,
    opts: { strict?: boolean } = {},
  ): ValidationResult {
    if (!schema || Object.keys(schema).length === 0) return { valid: true, errors: [] };
    const effective = opts.strict ? closeObjects(schema) : schema;
    const key = `${opts.strict ? 's' : 'l'}:${JSON.stringify(effective)}`;
    let fn = this.cache.get(key);
    if (!fn) {
      if (this.cache.size >= MAX_CACHE) this.reset();
      try {
        fn = (opts.strict ? this.strict : this.lenient).compile(effective);
      } catch (err) {
        fn = err instanceof Error ? err : new Error(String(err));
      }
      this.cache.set(key, fn);
    }
    if (fn instanceof Error) {
      // An invalid schema should not make every response fail: accept and report.
      return { valid: true, errors: [`schema could not be compiled: ${fn.message}`] };
    }
    const valid = fn(value);
    return { valid, errors: valid ? [] : formatErrors(fn.errors ?? []) };
  }
}

export function formatErrors(errors: ErrorObject[]): string[] {
  return errors.slice(0, 10).map((e) => {
    const where = e.instancePath || '(root)';
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: unknown }).additionalProperty)})`
        : e.keyword === 'enum'
          ? ` (allowed: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
          : '';
    return `${where} ${e.message ?? 'is invalid'}${extra}`;
  });
}

/** Adds `additionalProperties: false` to object schemas that don't specify it (OpenAI strict mode semantics). */
function closeObjects(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if (out.type === 'object' && out.properties && out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

export const sharedValidator = new SchemaValidator();
