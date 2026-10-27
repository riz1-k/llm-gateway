import { customAlphabet } from 'nanoid';

const alnum = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 24);
const shortAlnum = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  12,
);

export const newRequestId = (): string => `req_${alnum()}`;
export const newCompletionId = (): string => `chatcmpl-${alnum()}`;
export const newToolCallId = (): string => `call_${alnum()}`;
export const newRerankId = (): string => `rerank-${shortAlnum()}`;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Honors a client supplied `x-request-id` if it is safe to echo/log, else generates one. */
export function resolveRequestId(header: string | null | undefined): string {
  if (header && SAFE_REQUEST_ID.test(header)) return header;
  return newRequestId();
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
