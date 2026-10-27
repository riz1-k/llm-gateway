import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { ChatRequest, EmbeddingRequest, RerankRequest } from '../core/types.js';

/**
 * Request body validation. Schemas are deliberately loose (`looseObject`): unknown fields are
 * preserved and forwarded to OpenAI-family upstreams, while the fields the gateway interprets
 * are type-checked.
 */

const contentPart = z.looseObject({ type: z.string().min(1) });
const content = z.union([z.string(), z.array(contentPart)]);

const toolCall = z.looseObject({
  id: z.string().min(1),
  type: z.literal('function').default('function'),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string().default('') }),
});

const message = z.discriminatedUnion('role', [
  z.looseObject({ role: z.literal('system'), content, name: z.string().optional() }),
  z.looseObject({ role: z.literal('developer'), content, name: z.string().optional() }),
  z.looseObject({ role: z.literal('user'), content, name: z.string().optional() }),
  z.looseObject({
    role: z.literal('assistant'),
    content: content.nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(toolCall).optional(),
  }),
  z.looseObject({
    role: z.literal('tool'),
    content,
    tool_call_id: z.string().min(1),
    name: z.string().optional(),
  }),
]);

const tool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,64}$/, 'tool names must match ^[a-zA-Z0-9_.-]{1,64}$'),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
});

const toolChoice = z.union([
  z.enum(['auto', 'none', 'required']),
  z.looseObject({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
]);

const responseFormat = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.looseObject({
      name: z.string().min(1),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().nullable().optional(),
    }),
  }),
]);

const optNum = (s: z.ZodNumber) => s.nullable().optional();

export const chatRequestSchema = z
  .looseObject({
    model: z.string().min(1),
    messages: z.array(message).min(1, 'messages must contain at least one message'),
    stream: z.boolean().nullable().optional(),
    stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullable().optional(),
    tools: z.array(tool).optional(),
    tool_choice: toolChoice.optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: responseFormat.optional(),
    max_tokens: optNum(z.number().int().positive()),
    max_completion_tokens: optNum(z.number().int().positive()),
    temperature: optNum(z.number().min(0).max(2)),
    top_p: optNum(z.number().min(0).max(1)),
    stop: z
      .union([z.string(), z.array(z.string()).max(4)])
      .nullable()
      .optional(),
    seed: optNum(z.number().int()),
    n: optNum(z.number().int().min(1).max(8)),
    reasoning_effort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'])
      .nullable()
      .optional(),
    user: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((req, ctx) => {
    const choice = req.tool_choice;
    if (choice && typeof choice === 'object') {
      if (!req.tools?.some((t) => t.function.name === choice.function.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tool_choice'],
          message: `tool_choice names unknown tool "${choice.function.name}"`,
        });
      }
    }
    if ((choice === 'required' || typeof choice === 'object') && !req.tools?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tool_choice'],
        message: 'tool_choice requires tools',
      });
    }
  });

export const embeddingRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([
    z.string(),
    z.array(z.string()).min(1),
    z.array(z.number().int()).min(1),
    z.array(z.array(z.number().int()).min(1)).min(1),
  ]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  // Bounded: some upstreams (and the mock) allocate `dimensions`-sized vectors per input.
  dimensions: z.number().int().positive().max(16_384).optional(),
  user: z.string().optional(),
  input_type: z.enum(['query', 'document']).optional(),
  input_titles: z.array(z.string().nullable()).optional(),
});

const rerankDocument = z.union([
  z.string(),
  z.looseObject({ text: z.string() }).transform((d) => d.text),
]);

export const rerankRequestSchema = z.object({
  model: z.string().min(1),
  query: z.string().min(1),
  documents: z.array(rerankDocument).min(1).max(1000),
  top_n: z.number().int().positive().optional(),
  return_documents: z.boolean().optional(),
});

function fail(error: z.ZodError): never {
  const issue = error.issues[0]!;
  const path = issue.path.map(String).join('.');
  throw new GatewayError(
    400,
    'invalid_request',
    path ? `Invalid request: ${path}: ${issue.message}` : `Invalid request: ${issue.message}`,
    {
      param: path || null,
    },
  );
}

export function parseChatRequest(body: unknown): ChatRequest {
  const r = chatRequestSchema.safeParse(body);
  if (!r.success) fail(r.error);
  return r.data;
}

export function parseEmbeddingRequest(body: unknown): EmbeddingRequest {
  const r = embeddingRequestSchema.safeParse(body);
  if (!r.success) fail(r.error);
  const req = r.data as unknown as EmbeddingRequest;
  const titles = r.data.input_titles;
  const count = typeof r.data.input === 'string' ? 1 : r.data.input.length;
  if (titles && titles.length !== count) {
    throw new GatewayError(
      400,
      'invalid_request',
      'Invalid request: input_titles must have the same length as input',
      { param: 'input_titles' },
    );
  }
  return req;
}

export function parseRerankRequest(body: unknown): RerankRequest {
  const r = rerankRequestSchema.safeParse(body);
  if (!r.success) fail(r.error);
  return r.data;
}
