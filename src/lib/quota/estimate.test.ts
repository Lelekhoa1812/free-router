import { describe, expect, it } from "vitest";
import { MODEL_BY_ID } from "@/lib/models/catalog";
import {
  estimateOutputReserve,
  estimatePromptTokens,
  estimatedUsage,
  normalizeUsage,
  resolveUsage,
} from "./estimate";

const profile = MODEL_BY_ID.get("google/gemini-3.6-flash")!;

describe("quota estimates", () => {
  it("counts text, images, tools and message overhead", () => {
    const text = estimatePromptTokens([{ role: "user", content: "hello" }]);
    const image = estimatePromptTokens([
      { role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ]);
    expect(text).toBeGreaterThan(0);
    expect(image).toBeGreaterThan(text + 1_000);
    expect(estimatePromptTokens([{ role: "user", content: "hello" }], [{ type: "function", function: { name: "x" } }])).toBeGreaterThan(text);
  });

  it("caps the output reservation even when the caller asks for more", () => {
    expect(estimateOutputReserve({ max_completion_tokens: 100_000 }, profile)).toBe(8_192);
    expect(estimateOutputReserve({ max_tokens: 128 }, profile)).toBe(128);
    expect(estimateOutputReserve({}, profile)).toBe(4_096);
    const small = { ...profile, maxOutput: 1_000 };
    expect(estimateOutputReserve({ max_completion_tokens: 8_000 }, small)).toBe(1_000);
  });

  it("normalizes provider usage and ignores malformed values", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ input: 10, output: 5, total: 15 });
    expect(normalizeUsage({ input_tokens: 3, output_tokens: -2, total_tokens: 9 })).toEqual({ input: 3, output: 0, total: 9 });
    expect(normalizeUsage({ foo: 1 })).toBeNull();
  });

  it("distinguishes provider and estimated usage", () => {
    expect(resolveUsage({ prompt_tokens: 10, completion_tokens: 5 }, 100, "ignored").source).toBe("provider");
    const estimated = resolveUsage(null, 100, "hello world");
    expect(estimated.source).toBe("estimated");
    expect(estimated.input).toBe(100);
    expect(estimated.output).toBeGreaterThan(0);
    expect(estimatedUsage(10, "abc").total).toBeGreaterThan(10);
  });

  it("includes tool-call arguments in the fallback output estimate", () => {
    const tools = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: "a long tool argument payload" }) } }];
    const withoutTools = resolveUsage(null, 100, "hello");
    const withTools = resolveUsage(null, 100, "hello", tools);
    expect(withTools.source).toBe("estimated");
    expect(withTools.output).toBeGreaterThan(withoutTools.output);
    expect(withTools.total).toBeGreaterThan(withoutTools.total);
  });
});
