// Switchyard with the official OpenAI Node SDK: point `baseURL` at the gateway, use a Switchyard
// key, and name a route as the model. Runs as plain TypeScript on Node >= 22.18, Bun and Deno.
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources';

const client = new OpenAI({
  baseURL: process.env.SWITCHYARD_BASE_URL ?? 'http://127.0.0.1:8787/v1',
  apiKey: process.env.SWITCHYARD_API_KEY ?? 'sk-sy-examples-local',
  maxRetries: 0,
});

/** Switchyard adds these fields to the standard `usage` object (additive, see docs/API.md). */
type SwitchyardUsage = { cost?: number; sy_cache?: string; sy_saved_cost?: number };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

// 1. Chat. The cost of the request is in usage.cost (USD).
{
  const res = await client.chat.completions.create({
    model: 'chat',
    messages: [{ role: 'user', content: 'hello from the openai node sdk' }],
  });
  const usage = res.usage as (typeof res.usage & SwitchyardUsage) | undefined;
  check(res.choices[0]?.message.content === 'hello from the openai node sdk', 'echoed content');
  check(typeof usage?.cost === 'number', 'usage.cost');
  console.log(`✔ chat: "${res.choices[0]?.message.content}" cost=$${usage?.cost}`);
}

// 2. Streaming. With include_usage, the final chunk (empty choices) carries usage.cost.
{
  const stream = await client.chat.completions.create({
    model: 'chat',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'stream me a short answer' }],
  });
  let text = '';
  let usage: SwitchyardUsage | undefined;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? '';
    if (chunk.usage) usage = chunk.usage as typeof chunk.usage & SwitchyardUsage;
  }
  check(text === 'stream me a short answer', 'streamed text');
  check(typeof usage?.cost === 'number', 'usage.cost in the final chunk');
  console.log(`✔ stream: "${text}" final-chunk cost=$${usage?.cost} (${usage?.sy_cache})`);
}

// 3. Embeddings with the `input_type` extension: the gateway applies the model's query/document
//    templates. The SDK sends unknown body fields as-is; the cast only satisfies TypeScript.
{
  const params: OpenAI.EmbeddingCreateParams & { input_type: 'query' | 'document' } = {
    model: 'embed',
    input: ['how do budgets work?', 'what is a virtual key?'],
    input_type: 'query',
  };
  const res = await client.embeddings.create(params);
  check(res.data.length === 2, 'two vectors');
  console.log(
    `✔ embeddings: ${res.data.length} x ${res.data[0]?.embedding.length}-d (input_type=query)`,
  );
}

// 4. Tool calling: the model asks for a tool, we run it and send the result back.
{
  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ];
  const messages: ChatCompletionMessageParam[] = [
    { role: 'user', content: 'What is the weather in Paris?' },
  ];
  const first = await client.chat.completions.create({ model: 'tools', messages, tools });
  const call = first.choices[0]?.message.tool_calls?.[0];
  check(call?.type === 'function' && call.function.name === 'get_weather', 'tool call');
  const args = JSON.parse(call.function.arguments) as { city: string };
  messages.push(first.choices[0]!.message, {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify({ city: args.city, temperature_c: 18 }),
  });
  const second = await client.chat.completions.create({ model: 'tools', messages, tools });
  const answer = second.choices[0]?.message.content ?? '';
  check(answer.includes('temperature_c'), 'final answer uses the tool result');
  console.log(`✔ tools: get_weather(${call.function.arguments}) → "${answer}"`);
}

// 5. Structured output with response_format json_schema.
{
  const res = await client.chat.completions.create({
    model: 'structured',
    messages: [{ role: 'user', content: 'Which city is the capital of France?' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'city',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            country: { type: 'string' },
            population_millions: { type: 'number' },
          },
          required: ['city', 'country', 'population_millions'],
          additionalProperties: false,
        },
      },
    },
  });
  const city = JSON.parse(res.choices[0]?.message.content ?? '{}') as { city?: string };
  check(city.city === 'Paris', 'parsed JSON');
  console.log(`✔ json_schema: ${res.choices[0]?.message.content}`);
}

// 6. Response headers: withResponse() returns the parsed body and the raw Response.
{
  const { data, response } = await client.chat.completions
    .create({ model: 'chat', messages: [{ role: 'user', content: 'which route served me?' }] })
    .withResponse();
  const h = (name: string) => response.headers.get(name);
  check(h('x-sy-route') === 'chat' && h('x-sy-cost-usd') !== null, 'x-sy-* headers');
  console.log(
    `✔ headers: x-sy-route=${h('x-sy-route')} x-sy-provider=${h('x-sy-provider')} ` +
      `x-sy-model=${h('x-sy-model')} x-sy-cache=${h('x-sy-cache')} ` +
      `x-sy-cost-usd=${h('x-sy-cost-usd')} (id ${data.id})`,
  );
}

// 7. Errors use the OpenAI envelope, so the SDK raises its usual typed errors.
{
  const bad = new OpenAI({ baseURL: client.baseURL, apiKey: 'sk-sy-test-wrong-key', maxRetries: 0 });
  try {
    await bad.chat.completions.create({
      model: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    check(false, 'expected a 401');
  } catch (err) {
    check(err instanceof OpenAI.AuthenticationError, 'AuthenticationError');
    console.log(`✔ errors: ${err.status} ${err.code} (OpenAI.AuthenticationError)`);
  }
}

console.log('openai-node: all checks passed');
