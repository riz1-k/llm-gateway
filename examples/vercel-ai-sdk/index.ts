// Switchyard with the Vercel AI SDK: `@ai-sdk/openai-compatible` pointed at the gateway.
// Runs as plain TypeScript on Node >= 22.18, Bun and Deno.
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import { embedMany, generateText, isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';

/** Copies Switchyard's `usage.cost` / `usage.sy_cache` into providerMetadata.switchyard. */
const switchyardUsage: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => pick((parsedBody as { usage?: unknown }).usage),
  createStreamExtractor: () => {
    let usage: unknown;
    return {
      processChunk: (chunk) => {
        usage = (chunk as { usage?: unknown }).usage ?? usage;
      },
      buildMetadata: () => pick(usage),
    };
  },
};
function pick(usage: unknown) {
  const u = (usage ?? {}) as { cost?: number; sy_cache?: string };
  if (u.cost === undefined) return undefined;
  return { switchyard: { cost: u.cost, cache: u.sy_cache ?? null } };
}

const switchyard = createOpenAICompatible({
  name: 'switchyard',
  baseURL: process.env.SWITCHYARD_BASE_URL ?? 'http://127.0.0.1:8787/v1',
  apiKey: process.env.SWITCHYARD_API_KEY ?? 'sk-sy-examples-local',
  includeUsage: true, // stream_options.include_usage → the final chunk carries usage and cost
  supportsStructuredOutputs: true,
  metadataExtractor: switchyardUsage,
  headers: { 'x-sy-user': 'example-user', 'x-sy-tags': 'app:examples,sdk:vercel-ai' },
});

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

// 1. generateText. The route name is the model id; response headers carry x-sy-*.
{
  const res = await generateText({
    model: switchyard('chat'),
    prompt: 'hello from the vercel ai sdk',
    maxRetries: 0,
  });
  check(res.text === 'hello from the vercel ai sdk', 'echoed text');
  const headers = res.response.headers ?? {};
  check(headers['x-sy-route'] === 'chat', 'x-sy-route header');
  console.log(
    `✔ generateText: "${res.text}" tokens=${res.usage.totalTokens} ` +
      `cost=$${res.providerMetadata?.switchyard?.cost} x-sy-route=${headers['x-sy-route']}`,
  );
}

// 2. streamText. Usage and cost arrive with the final chunk.
{
  const result = streamText({
    model: switchyard('chat'),
    prompt: 'stream from the vercel ai sdk',
    maxRetries: 0,
  });
  let text = '';
  for await (const delta of result.textStream) text += delta;
  const usage = await result.usage;
  const meta = await result.providerMetadata;
  check(text === 'stream from the vercel ai sdk', 'streamed text');
  check(typeof meta?.switchyard?.cost === 'number', 'streamed cost');
  console.log(
    `✔ streamText: "${text}" tokens=${usage.totalTokens} cost=$${meta?.switchyard?.cost}`,
  );
}

// 3. A tool call: the SDK runs `execute` and sends the result back for the final answer.
{
  const res = await generateText({
    model: switchyard('tools'),
    prompt: 'What is the weather in Paris?',
    maxRetries: 0,
    tools: {
      get_weather: tool({
        description: 'Current weather for a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temperature_c: 18 }),
      }),
    },
    stopWhen: isStepCount(2),
  });
  const call = res.steps[0]?.toolCalls[0];
  check(call?.toolName === 'get_weather', 'tool call');
  check(res.text.includes('temperature_c'), 'final answer uses the tool result');
  console.log(
    `✔ tools: ${res.steps.length} steps, get_weather(${JSON.stringify(call.input)}) → "${res.text}"`,
  );
}

// 4. Embeddings.
{
  const { embeddings } = await embedMany({
    model: switchyard.embeddingModel('embed'),
    values: ['virtual keys', 'budgets'],
    maxRetries: 0,
  });
  check(embeddings.length === 2, 'two vectors');
  console.log(`✔ embedMany: ${embeddings.length} x ${embeddings[0]?.length}-d`);
}

console.log('vercel-ai-sdk: all checks passed');
