// Switchyard with LangChain.js. The gateway URL goes in `configuration.baseURL` (the options of
// the underlying openai client), not in a top-level `baseURL`.
// Runs as plain TypeScript on Node >= 22.18, Bun and Deno.
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

const configuration = {
  baseURL: process.env.SWITCHYARD_BASE_URL ?? 'http://127.0.0.1:8787/v1',
  defaultHeaders: { 'x-sy-user': 'example-user', 'x-sy-tags': 'app:examples,sdk:langchain-js' },
};
const apiKey = process.env.SWITCHYARD_API_KEY ?? 'sk-sy-examples-local';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

// 1. Chat. `model` is a Switchyard route.
{
  const llm = new ChatOpenAI({ model: 'chat', apiKey, configuration, maxRetries: 0 });
  const msg = await llm.invoke('hello from langchain.js');
  check(msg.content === 'hello from langchain.js', 'echoed content');
  console.log(`✔ chat: "${String(msg.content)}" tokens=${msg.usage_metadata?.total_tokens}`);
}

// 2. Tool binding: the model calls the tool, we run it and pass the ToolMessage back.
{
  const getWeather = tool(async ({ city }) => JSON.stringify({ city, temperature_c: 18 }), {
    name: 'get_weather',
    description: 'Current weather for a city',
    schema: z.object({ city: z.string() }),
  });
  const llm = new ChatOpenAI({ model: 'tools', apiKey, configuration, maxRetries: 0 });
  const withTools = llm.bindTools([getWeather]);
  const messages: BaseMessage[] = [new HumanMessage('What is the weather in Paris?')];
  const ai = await withTools.invoke(messages);
  const call = ai.tool_calls?.[0];
  check(call?.name === 'get_weather', 'tool call');
  const result = (await getWeather.invoke(call.args as { city: string })) as string;
  messages.push(ai, new ToolMessage({ content: result, tool_call_id: call.id ?? '' }));
  const final = await withTools.invoke(messages);
  check(String(final.content).includes('temperature_c'), 'final answer uses the tool result');
  console.log(`✔ tools: get_weather(${JSON.stringify(call.args)}) → "${String(final.content)}"`);
}

// 3. Structured output: withStructuredOutput sends response_format json_schema and parses it.
{
  const City = z.object({ city: z.string(), country: z.string(), population_millions: z.number() });
  const llm = new ChatOpenAI({ model: 'structured', apiKey, configuration, maxRetries: 0 });
  const city = await llm
    .withStructuredOutput(City, { name: 'city', method: 'jsonSchema' })
    .invoke('Which city is the capital of France?');
  check(city.city === 'Paris', 'parsed object');
  console.log(`✔ withStructuredOutput: ${JSON.stringify(city)}`);
}

console.log('langchain-js: all checks passed');
