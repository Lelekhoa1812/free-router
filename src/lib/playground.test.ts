import { describe, expect, it } from "vitest";
import { buildDecisionPlaygroundBody, buildEmbeddingPlaygroundBody, buildEmbeddingPlaygroundInput, extractPlaygroundModels } from "@/lib/playground";

describe("playground request builders", () => {
  it("creates OpenAI Decisions and native System One request bodies", () => {
    expect(buildDecisionPlaygroundBody("decisions", "jev/jev-latest", "Evidence", "Decide?")).toEqual({
      model: "jev/jev-latest",
      input: "Evidence",
      questions: [{ type: "predicate", instructions: "Decide?" }],
    });
    expect(buildDecisionPlaygroundBody("systemone", "jev/jev-preview", "Evidence", "Decide?")).toEqual({
      model: "jev-preview",
      state: "Evidence",
      questions: { prioritize_hotfix: { type: "noul", instructions: "Decide?" } },
    });
    expect(buildDecisionPlaygroundBody("decisions", "jev/jev-latest", "Evidence", "Pick one", "choice", ["defer", "ship"])).toEqual({
      model: "jev/jev-latest", input: "Evidence", questions: [{ type: "choice", instructions: "Pick one", choices: [{ value: "defer", description: "defer" }, { value: "ship", description: "ship" }] }],
    });
    expect(buildDecisionPlaygroundBody("systemone", "jev-latest", "Evidence", "Rate this", "score", ["low", "medium", "high"])).toEqual({
      model: "jev-latest", state: "Evidence", questions: { prioritize_hotfix: { type: "score", instructions: "Rate this", criteria: ["low", "medium", "high"] } },
    });
  });

  it("preserves one embedding text and turns non-empty lines into independent inputs", () => {
    expect(buildEmbeddingPlaygroundInput(" one \n two ", "single")).toBe(" one \n two ");
    expect(buildEmbeddingPlaygroundInput(" one \r\n\r\n two \n", "lines")).toEqual(["one", "two"]);
  });

  it("requires an explicit embedding model and validates optional dimensions", () => {
    expect(buildEmbeddingPlaygroundBody("google/text-embedding", ["a", "b"], "float", "256")).toEqual({
      model: "google/text-embedding", input: ["a", "b"], encoding_format: "float", dimensions: 256,
    });
    expect(() => buildEmbeddingPlaygroundBody("fr-auto", "text", "float", "")).toThrow(/concrete embedding model/);
    expect(() => buildEmbeddingPlaygroundBody("nim/embed", "text", "base64", "1.5")).toThrow(/positive whole number/);
    expect(() => buildEmbeddingPlaygroundBody("nim/embed", [], "float", "")).toThrow(/at least one input/);
  });

  it("accepts model arrays and OpenAI-style discovery envelopes while ignoring malformed rows", () => {
    expect(extractPlaygroundModels({ data: [{ id: "nvidia/embed" }, { name: "missing id" }, null] })).toEqual([{ id: "nvidia/embed" }]);
    expect(extractPlaygroundModels([{ id: "google/embed" }])).toEqual([{ id: "google/embed" }]);
    expect(extractPlaygroundModels({ data: "not-an-array" })).toEqual([]);
  });
});
