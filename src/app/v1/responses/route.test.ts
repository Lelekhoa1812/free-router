import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateClient: vi.fn(), bindInternalClient: vi.fn(), chatPost: vi.fn(), getDb: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient, bindInternalClient: mocks.bindInternalClient }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/app/v1/chat/completions/route", () => ({ POST: mocks.chatPost }));

import { POST } from "./route";

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
