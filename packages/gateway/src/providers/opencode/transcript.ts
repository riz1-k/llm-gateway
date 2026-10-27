import { ProviderError } from '../../core/errors.js';
import type { ChatMessage, ContentPart, ToolCall } from '../../core/types.js';

/**
 * Renders an OpenAI conversation into opencode's single-message format.
 *
 * opencode sessions are used statelessly (one session per request), so prior turns — including
 * assistant tool calls and tool results — are serialized into one text part using a small
 * XML-ish transcript format the model can follow reliably.
 */

export interface OpencodeTextPart {
  type: 'text';
  text: string;
}

export interface OpencodeFilePart {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

export type OpencodePart = OpencodeTextPart | OpencodeFilePart;

export interface RenderedTranscript {
  /** Caller system/developer messages joined (protocol instructions are appended by the adapter). */
  system: string | undefined;
  parts: OpencodePart[];
}

export const TRANSCRIPT_TRAILER = "Reply with the assistant's next message only.";

/** Text of a message's content; image parts are collected separately. */
function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        p.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)(?:;[^,]*)?,/;

function filePartsOf(
  content: string | ContentPart[] | null | undefined,
  provider: string,
): OpencodeFilePart[] {
  if (!Array.isArray(content)) return [];
  const files: OpencodeFilePart[] = [];
  for (const part of content) {
    if (part.type === 'text') continue;
    if (part.type === 'image_url') {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      const m = typeof url === 'string' ? DATA_URL.exec(url) : null;
      if (!m || typeof url !== 'string') {
        throw new ProviderError({
          status: 400,
          code: 'unsupported_content',
          message: `${provider}: only data: URLs are supported for images (got a remote URL)`,
          provider,
          fallback: true,
        });
      }
      files.push({
        type: 'file',
        mime: m[1]!,
        url,
        filename: `image-${files.length + 1}.${m[1]!.split('/')[1] ?? 'bin'}`,
      });
      continue;
    }
    throw new ProviderError({
      status: 400,
      code: 'unsupported_content',
      message: `${provider}: content part type "${part.type}" is not supported`,
      provider,
      fallback: true,
    });
  }
  return files;
}

/** Prevents message content from closing the transcript's own tags. */
const escapeBody = (s: string): string => s.replace(/<\/(message|conversation)>/gi, '&lt;/$1&gt;');
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderToolCall(tc: ToolCall): string {
  let args: unknown = tc.function.arguments;
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    // keep the raw string if the client sent non-JSON arguments
  }
  return `<tool_call id="${escapeAttr(tc.id)}">${JSON.stringify({ name: tc.function.name, arguments: args })}</tool_call>`;
}

/** Splits system/developer messages from the conversation and renders the rest. */
export function renderTranscript(
  messages: ChatMessage[],
  provider = 'opencode',
): RenderedTranscript {
  const systemTexts: string[] = [];
  const turns: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOf(m.content);
      if (t.trim()) systemTexts.push(t);
    } else {
      turns.push(m);
    }
  }
  const system = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined;

  if (turns.length === 0) {
    throw new ProviderError({
      status: 400,
      code: 'invalid_request',
      message: 'messages must contain at least one non-system message',
      provider,
    });
  }

  // Fast path: a single user message is sent verbatim.
  const only = turns[0]!;
  if (turns.length === 1 && only.role === 'user') {
    const files = filePartsOf(only.content, provider);
    const text = textOf(only.content);
    return { system, parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files] };
  }

  const toolNames = new Map<string, string>();
  const files: OpencodeFilePart[] = [];
  const lines: string[] = ['<conversation>'];
  for (const m of turns) {
    switch (m.role) {
      case 'user': {
        const f = filePartsOf(m.content, provider);
        const refs = f.map((_, i) => `[attached image ${files.length + i + 1}]`).join(' ');
        files.push(...f);
        const body = [escapeBody(textOf(m.content)), refs].filter(Boolean).join('\n');
        lines.push(`<message role="user">${body}</message>`);
        break;
      }
      case 'assistant': {
        const calls = (m.tool_calls ?? []).map((tc) => {
          toolNames.set(tc.id, tc.function.name);
          return renderToolCall(tc);
        });
        const body = [escapeBody(textOf(m.content ?? null)), ...calls].filter(Boolean).join('\n');
        lines.push(`<message role="assistant">${body}</message>`);
        break;
      }
      case 'tool': {
        const name = m.name ?? toolNames.get(m.tool_call_id) ?? 'unknown';
        lines.push(
          `<message role="tool" tool_call_id="${escapeAttr(m.tool_call_id)}" name="${escapeAttr(name)}">${escapeBody(textOf(m.content))}</message>`,
        );
        break;
      }
    }
  }
  lines.push('</conversation>', TRANSCRIPT_TRAILER);
  return { system, parts: [{ type: 'text', text: lines.join('\n') }, ...files] };
}
