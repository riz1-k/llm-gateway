import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

/**
 * Cached JSON Schema validation (ajv). Used to validate emulated tool-call arguments and
 * structured outputs. Schemas are compiled once and cached by their canonical JSON.
 */

// ajv-formats ships CJS with a default export; normalize the interop shape.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv) => Ajv;

const MAX_CACHE = 500;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class SchemaValidator {
  private readonly lenient: Ajv;
  private readonly strict: Ajv;
  private readonly cache = new Map<string, ValidateFunction | Error>();

  constructor() {
    const base = { allErrors: true, strict: false, validateFormats: true } as const;
    this.lenient = addFormats(new Ajv({ ...base }));
    // `strict` structured outputs: forbid additional properties when the schema omits the keyword.
    this.strict = addFormats(new Ajv({ ...base }));
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
      try {
        fn = (opts.strict ? this.strict : this.lenient).compile(effective);
      } catch (err) {
        fn = err instanceof Error ? err : new Error(String(err));
      }
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
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
