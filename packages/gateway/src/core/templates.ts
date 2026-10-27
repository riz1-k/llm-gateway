import type { ResolvedModel } from '../config/resolve.js';
import type { EmbeddingRequest } from './types.js';

/**
 * Applies a target's embedding `input_templates` for the request's `input_type`.
 *
 * Templates use `{text}` and optionally `{title}` (from the `input_titles` extension, default
 * "none"), e.g. embeddinggemma: query → `task: search result | query: {text}`,
 * document → `title: {title} | text: {text}`. Token-array inputs are passed through unchanged.
 * The Switchyard-only fields are always stripped before the request goes upstream.
 */
export function applyInputTemplates(req: EmbeddingRequest, model: ResolvedModel): EmbeddingRequest {
  const { input_type: inputType, input_titles: rawTitles, ...rest } = req;
  const upstream: EmbeddingRequest = { ...rest };
  const template = inputType ? model.inputTemplates?.[inputType] : undefined;
  if (!template) return upstream;
  const titles = Array.isArray(rawTitles) ? (rawTitles as (string | null)[]) : [];
  const render = (text: string, i: number): string =>
    template
      .replace(/\{title\}/g, () => titles[i]?.trim() || 'none')
      .replace(/\{text\}/g, () => text);
  if (typeof req.input === 'string') return { ...upstream, input: render(req.input, 0) };
  if (Array.isArray(req.input) && req.input.every((x): x is string => typeof x === 'string')) {
    return { ...upstream, input: req.input.map(render) };
  }
  return upstream;
}

export function embeddingInputs(input: EmbeddingRequest['input']): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input) && input.every((x): x is string => typeof x === 'string')) return input;
  return [];
}
