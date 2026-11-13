import { describe, expect, it } from "vitest";
import { parseChatRequest, parseResponsesRequest, RequestValidationError } from "./validation";

function rejection(run: () => unknown): RequestValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestValidationError);
    return error as RequestValidationError;
  }
  throw new Error("expected validation to fail");
}

const userMessage = { role: "user", content: "hello" };

describe("parseChatRequest", () => {
  it("accepts a minimal chat request and preserves unknown message fields", () => {
    const parsed = parseChatRequest({
      model: "fr-fast",
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: "{}" } }], audio: null }],
    });
    expect(parsed.model).toBe("fr-fast");
    expect((parsed.messages[0] as Record<string, unknown>).audio).toBeNull();
  });

  it("reports the offending field for an unsupported top-level parameter", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [userMessage], n: 2 }));
    expect(error.param).toBe("n");
    expect(error.kind).toBe("unsupported_parameter");
    expect(error.message).toContain("Unsupported request field: n");
  });

  it("rejects an empty message list", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [] }));
    expect(error.param).toBe("messages");
  });

  it("rejects an unknown role", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [{ role: "robot", content: "hi" }] }));
    expect(error.param).toBe("messages[0].role");
  });

  it("requires tool_call_id on tool messages", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [{ role: "tool", content: "result" }] }));
    expect(error.param).toBe("messages[0].tool_call_id");
  });

  it("rejects image parts without a url", () => {
    const error = rejection(() =>
      parseChatRequest({ model: "fr-fast", messages: [{ role: "user", content: [{ type: "image_url" }] }] }),
    );
    expect(error.param).toBe("messages[0].content[0].image_url");
  });

  it("rejects content part types the gateway cannot translate", () => {
    const error = rejection(() =>
      parseChatRequest({ model: "fr-fast", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }),
    );
    expect(error.param).toBe("messages[0].content[0].type");
  });

  it("rejects conflicting output-token limits", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [userMessage], max_tokens: 10, max_completion_tokens: 20 }));
    expect(error.param).toBe("max_completion_tokens");
  });

  it("rejects chat storage with a pointer to the Responses API", () => {
    const error = rejection(() => parseChatRequest({ model: "fr-fast", messages: [userMessage], store: true }));
    expect(error.param).toBe("store");
    expect(error.message).toContain("Responses API");
  });

  it("bounds sampling parameters", () => {
    expect(rejection(() => parseChatRequest({ model: "fr-fast", messages: [userMessage], temperature: 3 })).param).toBe("temperature");
    expect(rejection(() => parseChatRequest({ model: "fr-fast", messages: [userMessage], top_p: -1 })).param).toBe("top_p");
  });

  it("requires a schema when the response format is json_schema", () => {
    const error = rejection(() =>
      parseChatRequest({ model: "fr-fast", messages: [userMessage], response_format: { type: "json_schema" } }),
    );
    expect(error.param).toBe("response_format.json_schema");
  });

  it("accepts a strict function tool and a matching tool choice", () => {
    const parsed = parseChatRequest({
      model: "fr-code",
      messages: [userMessage],
      tools: [{ type: "function", function: { name: "lookup_order", description: "Look up an order", parameters: { type: "object" }, strict: true } }],
      tool_choice: { type: "function", function: { name: "lookup_order" } },
    });
    expect(parsed.tools).toHaveLength(1);
  });

  it("rejects a non-object body", () => {
    expect(rejection(() => parseChatRequest("hello")).param).toBe("request");
  });
});

describe("parseResponsesRequest", () => {
  it("accepts a string input with streaming and metadata", () => {
    const parsed = parseResponsesRequest({ model: "fr-code", input: "hi", stream: true, metadata: { trace: "local" } });
    expect(parsed.stream).toBe(true);
    expect(parsed.metadata).toEqual({ trace: "local" });
  });

  it("rejects unknown fields with the parameter name", () => {
    const error = rejection(() => parseResponsesRequest({ model: "fr-code", input: "hi", background: true }));
    expect(error.param).toBe("background");
    expect(error.kind).toBe("unsupported_parameter");
  });

  it("accepts Codex reasoning selectors and client metadata without claiming reasoning state", () => {
    const parsed = parseResponsesRequest({ model: "fr-code", input: "hi", include: ["reasoning.encrypted_content"], client_metadata: { thread_id: "local-thread" }, prompt_cache_key: "cache-affinity" });
    expect(parsed.include).toEqual(["reasoning.encrypted_content"]);
    expect(parsed.client_metadata).toEqual({ thread_id: "local-thread" });
    expect(parsed.prompt_cache_key).toBe("cache-affinity");
  });

  it("still rejects include fields the adapter cannot serve", () => {
    const error = rejection(() => parseResponsesRequest({ model: "fr-code", input: "hi", include: ["file_search_call.results"] }));
    expect(error.param).toBe("include");
  });

  it("bounds metadata entries", () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]));
    expect(rejection(() => parseResponsesRequest({ model: "fr-code", input: "hi", metadata })).param).toBe("metadata");
  });

  it("rejects unsupported truncation modes", () => {
    expect(rejection(() => parseResponsesRequest({ model: "fr-code", input: "hi", truncation: "auto" })).param).toBe("truncation");
  });

  it("rejects input items without a role or type", () => {
    const error = rejection(() => parseResponsesRequest({ model: "fr-code", input: [{ content: "hi" }] }));
    expect(error.param).toBe("input[0].type");
  });

  it("requires a model", () => {
    expect(rejection(() => parseResponsesRequest({ input: "hi" })).param).toBe("model");
  });

  it("accepts a json_schema text format", () => {
    const parsed = parseResponsesRequest({
      model: "fr-code",
      input: "hi",
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
    });
    expect(parsed.text?.format?.type).toBe("json_schema");
  });
});
