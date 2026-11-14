import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateClient: vi.fn(), bindInternalClient: vi.fn(), chatPost: vi.fn(), getDb: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient, bindInternalClient: mocks.bindInternalClient }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/app/v1/chat/completions/route", () => ({ POST: mocks.chatPost }));

import { POST } from "./route";
import { parseChatRequest } from "@/lib/validation";

function chatStream(frames: unknown[]) {
  const body = frames.map((frame) => frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", "x-freerouter-resolved-model": "google/gemini-test" } });
}

describe("Responses streaming adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateClient.mockResolvedValue({ key: { _id: "client-test" } });
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => ({ insertOne: vi.fn().mockResolvedValue({}) })) });
  });

  it("keeps a Nemotron progress-only response open until a caller tool action, hiding private controls", async () => {
    let publicName = "";
    mocks.chatPost.mockImplementationOnce(async (request: Request) => {
      const body = await request.json();
      expect(body.tool_choice).toBe("required");
      publicName = body.tools[0].function.name;
      const progress = body.tools.find((tool: any) => tool.function.description?.includes(".progress]")).function.name;
      return chatStream([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "private-1", type: "function", function: { name: progress, arguments: '{"message":"Let me fix the script."}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }, "[DONE]",
      ]);
    }).mockImplementationOnce(async (request: Request) => {
      const body = await request.json();
      expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "private-1" });
      return chatStream([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "caller-1", type: "function", function: { name: publicName, arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } }, "[DONE]",
      ]);
    });
    const response = await POST(new Request("https://freerouter.test/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", input: "Finish the work", tools: [{ type: "function", name: "run_check", parameters: { type: "object" } }], stream: true, store: false, include: ["reasoning.encrypted_content"] }) }));
    const wire = await response.text();
    const complete = JSON.parse(wire.split("event: response.completed\ndata: ")[1].split("\n\n")[0]).response;
    expect(mocks.chatPost).toHaveBeenCalledTimes(2);
    expect(complete.output).toContainEqual(expect.objectContaining({ type: "function_call", name: "run_check", call_id: "caller-1" }));
    expect(complete.usage).toMatchObject({ input_tokens: 220, output_tokens: 30, total_tokens: 250 });
    expect(wire).not.toContain("private-1");
    expect(wire).not.toContain("fr_runtime_");
  });

  it.each(["none", "required"])("preserves an explicit %s tool choice without enabling agent controls", async choice => {
    mocks.chatPost.mockImplementationOnce(async (request: Request) => {
      const body = await request.json();
      expect(body.tool_choice).toBe(choice);
      expect(body.tools).toHaveLength(1);
      return chatStream([{ choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    });
    const response = await POST(new Request("https://freerouter.test/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", input: "Check", tools: [{ type: "function", name: "run_check" }], stream: true, store: false, include: ["reasoning.encrypted_content"], tool_choice: choice }) }));
    await response.text();
    expect(mocks.chatPost).toHaveBeenCalledOnce();
  });

  it.each(["medium", "high"])("accepts Codex's include/metadata with %s reasoning and completes a namespaced tool call and replay", async (effort) => {
    const tools = [{ type: "namespace", name: "crm", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }, ...Array.from({ length: 700 }, (_, n) => ({ type: "function", name: `extra_${n}`, parameters: { type: "object" } }))] }];
    let wireName = "";
    mocks.chatPost.mockImplementationOnce(async (request: Request) => {
      const body = await request.json();
      parseChatRequest(body);
      expect(body.tools).toHaveLength(701);
      expect(body).not.toHaveProperty("include");
      expect(body).not.toHaveProperty("client_metadata");
      expect(body.prompt_cache_key).toBe("affinity-test");
      expect(body.reasoning_effort).toBe(effort);
      wireName = body.tools[0].function.name;
      expect(body.tool_choice.function.name).toBe(wireName);
      return chatStream([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-ns", type: "function", function: { name: wireName.slice(0, 10), arguments: "{\"id\":" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: wireName.slice(10), arguments: "7}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, "[DONE]",
      ]);
    });
    const first = await POST(new Request("https://freerouter.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "fr-code", input: "Look up 7", stream: true, store: false, tools, tool_choice: { type: "function", name: "lookup", namespace: "crm" }, reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"], client_metadata: { thread_id: "not-an-owner" }, prompt_cache_key: "affinity-test" }),
    }));
    expect(first.status).toBe(200);
    const wire = await first.text();
    const events = [...wire.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((match) => JSON.parse(match[2]));
    const added = events.find((event) => event.type === "response.output_item.added").item;
    expect(added).toMatchObject({ type: "function_call", namespace: "crm", name: "lookup", call_id: "call-ns" });
    const complete = events.at(-1).response;
    expect(complete.status).toBe("completed");
    expect(complete.output[0]).toMatchObject({ ...added, status: "completed", arguments: '{"id":7}' });
    expect(complete.output.some((item: any) => item.type === "reasoning")).toBe(false);
    expect(events.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta).join("")).toBe('{"id":7}');

    mocks.chatPost.mockImplementationOnce(async (request: Request) => {
      const body = await request.json();
      parseChatRequest(body);
      expect(body.messages[1].content).toEqual([{ type: "text", text: "Checking." }]);
      expect(body.messages[2].tool_calls[0]).toMatchObject({ id: "call-ns", function: { name: wireName, arguments: '{"id":7}' } });
      expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-ns", content: "FOUND" });
      return Response.json({ choices: [{ message: { content: "Found it." } }] });
    });
    const second = await POST(new Request("https://freerouter.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "fr-code", store: false, tools, input: [{ role: "user", content: "Look up 7" }, { role: "assistant", content: [{ type: "output_text", text: "Checking." }] }, ...complete.output, { type: "function_call_output", call_id: "call-ns", output: [{ type: "input_text", text: "FOUND" }] }] }),
    }));
    expect(second.status).toBe(200);
    expect((await second.json()).output_text).toBe("Found it.");
  });

  it("rejects unsupported reasoning state and unsupported tool kinds before dispatch", async () => {
    for (const extra of [{ input: [{ type: "reasoning", encrypted_content: "opaque" }] }, { tools: [{ type: "web_search" }] }]) {
      const response = await POST(new Request("https://freerouter.test/v1/responses", {
        method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
        body: JSON.stringify({ model: "fr-code", input: "hi", store: false, ...extra }),
      }));
      expect(response.status).toBe(400);
    }
    expect(mocks.chatPost).not.toHaveBeenCalled();
  });

  it("streams Chat output as incremental Responses events and requests upstream streaming", async () => {
    mocks.chatPost.mockImplementation(async (request: Request) => {
      const body = await request.json();
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return chatStream([
        { id: "chat-1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: "chat-1", choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] },
        { id: "chat-1", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
        { id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "chat-1", choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
        "[DONE]",
      ]);
    });

    const response = await POST(new Request("https://freerouter.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "fr-code", input: "Say hello", stream: true, store: false }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const output = await response.text();
    const events = [...output.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((match) => ({ type: match[1], data: JSON.parse(match[2]) }));
    expect(events[0].type).toBe("response.created");
    expect(events.some((event) => event.type === "response.output_text.delta" && event.data.delta === "Hello ")).toBe(true);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(events.at(-1)?.data.response.output_text).toBe("Hello world");
    expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index));
  });

  it("keeps tool call identity and arguments in the Responses event stream", async () => {
    mocks.chatPost.mockResolvedValue(chatStream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"id\":" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "7}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Tool result follows." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]));
    const response = await POST(new Request("https://freerouter.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "fr-code", input: "Look up 7", stream: true, store: false }),
    }));
    const output = await response.text();
    expect(output).toContain('"call_id":"call-1"');
    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"arguments":"{\\"id\\":7}"');
    expect(output).toContain("event: response.completed");
    const completion = output.split("event: response.completed\ndata: ")[1].split("\n\n")[0];
    expect(JSON.parse(completion).response.output.map((item: any) => item.type)).toEqual(["function_call", "message"]);
  });

  it("handles split UTF-8 SSE chunks and marks token-limit finishes incomplete", async () => {
    const wire = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi 👋" }, finish_reason: null }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ].join("");
    const bytes = new TextEncoder().encode(wire);
    mocks.chatPost.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await POST(new Request("https://freerouter.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer sk-fr-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "fr-code", input: "Say hi", stream: true, store: false }),
    }));
    const output = await response.text();
    expect(output).toContain('"delta":"Hi 👋"');
    expect(output).toContain("event: response.incomplete");
    expect(output).toContain('"reason":"max_output_tokens"');
    expect(output).not.toContain("event: response.completed");
  });
});
