/** Minimal, spec-compliant Server-Sent Events parsing and encoding. */

export interface SSEEvent {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

/**
 * Parses an SSE byte stream into events. Handles CRLF/LF/CR line endings, multi-line `data:`,
 * comments, and events split across chunk boundaries.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const dispatchLine = (line: string): SSEEvent | undefined => {
    if (line === '') {
      if (data.length === 0) {
        event = undefined;
        return undefined;
      }
      const ev: SSEEvent = { event, data: data.join('\n'), id };
      data = [];
      event = undefined;
      return ev;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    return undefined;
  };

  const iterable: AsyncIterable<Uint8Array> =
    Symbol.asyncIterator in body ? body : streamToIterable(body);

  for await (const chunk of iterable) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = findLineEnd(buffer)) !== -1) {
      const line = buffer.slice(0, idx);
      const skip = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
      // A lone trailing CR might be followed by LF in the next chunk.
      if (buffer[idx] === '\r' && idx + 1 === buffer.length) break;
      buffer = buffer.slice(idx + skip);
      const ev = dispatchLine(line);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    for (const line of buffer.split(/\r\n|\r|\n/)) {
      const ev = dispatchLine(line);
      if (ev) yield ev;
    }
  }
  const last = dispatchLine('');
  if (last) yield last;
}

function findLineEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) return i;
  }
  return -1;
}

async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();

export function encodeSSE(data: string, event?: string): Uint8Array {
  const lines = data
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n');
  return encoder.encode(`${event ? `event: ${event}\n` : ''}${lines}\n\n`);
}

export const SSE_DONE = encoder.encode('data: [DONE]\n\n');
