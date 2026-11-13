import { describe, expect, it } from "vitest";
import { responsesTools } from "./responses-tools";
import { parseChatRequest, parseResponsesRequest, RequestValidationError } from "./validation";

const declaration = (namespace: string) => ({ type: "namespace", name: namespace, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] });

describe("Responses namespace bridge", () => {
  it("keeps same-named functions distinct across namespaces, top-level tools and reserved names", () => {
    const adapter = responsesTools([declaration("crm"), declaration("inventory"), { type: "function", name: "lookup" }]);
    const names = adapter.tools!.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(3);
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(adapter.decode(names[0])).toEqual({ name: "lookup", namespace: "crm" });
    expect(responsesTools([declaration("crm")]).encode("lookup", "crm")).toBe(names[0]);
    const reserved = responsesTools([{ type: "function", name: names[0] }]);
    expect(reserved.tools![0].function.name).not.toBe(names[0]);
    expect(reserved.decode(reserved.tools![0].function.name)).toEqual({ name: names[0] });
  });

  it("maps namespaced tool selection and rejects ambiguous or undeclared selection", () => {
    const adapter = responsesTools([declaration("crm")]);
    expect(adapter.choice({ type: "function", name: "lookup", namespace: "crm" })).toEqual({ type: "function", function: { name: adapter.encode("lookup", "crm") } });
    expect(() => adapter.choice({ type: "function", name: "lookup" })).toThrow(RequestValidationError);
    expect(() => responsesTools([declaration("crm"), declaration("crm")])).toThrow("Duplicate function identity");
  });

  it("admits a desktop-sized tool inventory through canonical Chat validation", () => {
    const adapter = responsesTools([{ type: "namespace", name: "desktop", tools: Array.from({ length: 399 }, (_, n) => ({ type: "function", name: `tool_${n}`, description: "x".repeat(5_033), parameters: { type: "object" } })) }]);
    const chat = parseChatRequest({ model: "fr-code", messages: [{ role: "user", content: "hi" }], tools: adapter.tools });
    expect(chat.tools).toHaveLength(399);
  });

  it.each([513, 1025, 2048])("preserves every function in a %i-function namespace and admits canonical Chat", (count) => {
    const request = parseResponsesRequest({ model: "fr-code", tools: [{ type: "namespace", name: "desktop", tools: Array.from({ length: count }, (_, n) => ({ type: "function", name: `tool_${n}`, parameters: { type: "object" } })) }] });
    const adapter = responsesTools(request.tools);
    const chat = parseChatRequest({ model: request.model, messages: [{ role: "user", content: "hi" }], tools: adapter.tools });
    expect(chat.tools).toHaveLength(count);
    const last = adapter.tools!.at(-1)!.function.name;
    expect(adapter.decode(last)).toEqual({ name: `tool_${count - 1}`, namespace: "desktop" });
    expect(adapter.choice({ type: "function", name: `tool_${count - 1}`, namespace: "desktop" })).toEqual({ type: "function", function: { name: last } });
  });

  it("admits more than 128 top-level namespaces without dropping functions", () => {
    const request = parseResponsesRequest({ model: "fr-code", tools: Array.from({ length: 129 }, (_, n) => declaration(`namespace_${n}`)) });
    expect(responsesTools(request.tools).tools).toHaveLength(129);
  });

  it("bounds namespace expansion by UTF-8 bytes even when the incoming definitions are small", () => {
    const tools = [{ type: "namespace", name: "desktop", description: "界".repeat(5_000), tools: Array.from({ length: 300 }, (_, n) => ({ type: "function", name: `tool_${n}` })) }];
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(100_000);
    expect(() => responsesTools(tools)).toThrow("Expanded tool definitions exceed the 4 MiB JSON size limit");
  });

  it("rejects hosted/custom tools instead of pretending to execute them", () => {
    expect(() => responsesTools([{ type: "web_search" }])).toThrow("Only caller-executed function tools");
    expect(() => responsesTools([{ type: "namespace", name: "desktop", tools: [{ type: "custom", name: "apply_patch" }] }])).toThrow(RequestValidationError);
  });
});
