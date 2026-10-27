/**
 * `${VAR}` / `${VAR:-default}` interpolation applied to every string value of the parsed YAML tree
 * (never to raw text, so values cannot inject YAML structure). `$${` escapes a literal `${`.
 *
 * - `${VAR}`: error if VAR is unset (empty string counts as set).
 * - `${VAR:-default}`: default if VAR is unset or empty (shell semantics).
 * - `${VAR-default}`: default only if VAR is unset.
 */

export interface InterpolationIssue {
  path: string;
  variable: string;
}

export class InterpolationError extends Error {
  readonly issues: InterpolationIssue[];
  constructor(issues: InterpolationIssue[]) {
    const lines = issues.map(
      (i) =>
        `  - \${${i.variable}} at ${i.path || '<root>'} is not set (use \${${i.variable}:-default} for a fallback)`,
    );
    super(`Missing environment variables in config:\n${lines.join('\n')}`);
    this.name = 'InterpolationError';
    this.issues = issues;
  }
}

const PATTERN = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)((?:[^}\\]|\\.)*))?\}/g;

export function interpolateString(
  input: string,
  env: Record<string, string | undefined>,
  path: string,
  issues: InterpolationIssue[],
): string {
  return input.replace(
    PATTERN,
    (match, name: string | undefined, op: string | undefined, def: string | undefined) => {
      if (match === '$${') return '${';
      if (!name) return match;
      const value = env[name];
      if (op === ':-') return value === undefined || value === '' ? unescape(def ?? '') : value;
      if (op === '-') return value === undefined ? unescape(def ?? '') : value;
      if (value === undefined) {
        issues.push({ path, variable: name });
        return '';
      }
      return value;
    },
  );
}

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

/** Recursively interpolates all strings; throws InterpolationError listing every missing variable. */
export function interpolate<T>(value: T, env: Record<string, string | undefined> = process.env): T {
  const issues: InterpolationIssue[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') return interpolateString(v, env, path, issues);
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child, path ? `${path}.${k}` : k);
      return out;
    }
    return v;
  };
  const result = walk(value, '') as T;
  if (issues.length > 0) throw new InterpolationError(issues);
  return result;
}
