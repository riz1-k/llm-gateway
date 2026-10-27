# /// script
# requires-python = ">=3.10"
# dependencies = ["langchain-openai==1.7.3", "langchain-core==1.7.0"]
# ///
"""Switchyard with LangChain's ChatOpenAI and OpenAIEmbeddings (the setup OpsAgent uses).

Run: uv run --script main.py
"""

import os

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

BASE_URL = os.environ.get("SWITCHYARD_BASE_URL", "http://127.0.0.1:8787/v1")
API_KEY = os.environ.get("SWITCHYARD_API_KEY", "sk-sy-examples-local")


def check(condition: object, message: str) -> None:
    if not condition:
        raise SystemExit(f"check failed: {message}")


# 1. Chat. `model` is a Switchyard route. include_response_headers exposes the x-sy-* headers,
#    and the raw usage dict (with Switchyard's `cost`) is kept in response_metadata.
llm = ChatOpenAI(
    model="chat",
    base_url=BASE_URL,
    api_key=API_KEY,
    max_retries=0,
    include_response_headers=True,
    # Attribution: stored with the usage event of every request this client makes.
    default_headers={"x-sy-user": "example-user", "x-sy-tags": "app:examples,sdk:langchain-python"},
)
msg = llm.invoke("hello from langchain")
headers = msg.response_metadata.get("headers", {})
cost = msg.response_metadata.get("token_usage", {}).get("cost")
check(msg.content == "hello from langchain", "echoed content")
check(headers.get("x-sy-route") == "chat", "x-sy-route header")
print(
    f'✔ chat: "{msg.content}" tokens={msg.usage_metadata["total_tokens"]} cost=${cost:.8f} '
    f"x-sy-route={headers.get('x-sy-route')} x-sy-cache={headers.get('x-sy-cache')}"
)

# 2. Streaming with stream_usage: the final chunk carries token usage.
text, total = "", None
for chunk in llm.stream("stream me a short answer", stream_usage=True):
    text += chunk.content if isinstance(chunk.content, str) else ""
    if chunk.usage_metadata:
        total = chunk.usage_metadata["total_tokens"]
check(text == "stream me a short answer", "streamed text")
check(total, "usage on the final chunk")
print(f'✔ stream: "{text}" total_tokens={total}')


# 3. Tool binding: the model calls the tool, we run it and pass the ToolMessage back.
@tool
def get_weather(city: str) -> str:
    """Current weather for a city."""
    return f'{{"city": "{city}", "temperature_c": 18}}'


agent_llm = ChatOpenAI(model="tools", base_url=BASE_URL, api_key=API_KEY, max_retries=0)
with_tools = agent_llm.bind_tools([get_weather])
messages: list = [HumanMessage("What is the weather in Paris?")]
ai = with_tools.invoke(messages)
check(ai.tool_calls and ai.tool_calls[0]["name"] == "get_weather", "tool call")
call = ai.tool_calls[0]
messages += [ai, ToolMessage(get_weather.invoke(call["args"]), tool_call_id=call["id"])]
final = with_tools.invoke(messages)
check("temperature_c" in final.content, "final answer uses the tool result")
print(f'✔ tools: get_weather({call["args"]}) → "{final.content}"')

# 4. Embeddings. check_embedding_ctx_length=False sends strings, not tiktoken token ids.
emb = OpenAIEmbeddings(model="embed", base_url=BASE_URL, api_key=API_KEY, check_embedding_ctx_length=False)
vectors = emb.embed_documents(["virtual keys", "budgets"])
check(len(vectors) == 2, "two vectors")
print(f"✔ embeddings: {len(vectors)} x {len(vectors[0])}-d")

print("langchain-python: all checks passed")
