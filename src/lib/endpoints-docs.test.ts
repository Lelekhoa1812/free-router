import { describe, expect, it } from "vitest";
import { DOCUMENTED_EMBEDDING_POLICY, ENDPOINT_DOCS } from "@/lib/endpoints-docs";

describe("public endpoint reference inventory", () => {
  it("documents the public Chat, Responses, decisions, and native Jev paths", () => {
    expect(ENDPOINT_DOCS.llm.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/models",
      "GET /v1/models/{model}",
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "GET /v1/responses/{id}",
      "GET /v1/responses/{id}/input_items",
      "DELETE /v1/responses/{id}",
    ]);
    expect(ENDPOINT_DOCS.decisions.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/models?type=decision",
      "GET /v1/systemone/models",
      "POST /v1/decisions",
      "POST /v1/systemone",
    ]);
  });

  it("keeps embeddings model-specific and discoverable through the model list", () => {
    expect(DOCUMENTED_EMBEDDING_POLICY).toEqual({
      autoRouted: false,
      modelRequired: true,
      discoveryPath: "/v1/models?type=embedding",
      endpointPath: "/v1/embeddings",
    });
    expect(ENDPOINT_DOCS.embeddings.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/models?type=embedding",
      "POST /v1/embeddings",
    ]);
    expect(ENDPOINT_DOCS.embeddings.some(({ path }) => /fr-auto|fr-(?:fast|code|quality)/.test(path))).toBe(false);
  });

  it("includes explanatory copy for every listed endpoint", () => {
    for (const endpoint of Object.values(ENDPOINT_DOCS).flat()) {
      expect(endpoint.title.length).toBeGreaterThan(3);
      expect(endpoint.description.length).toBeGreaterThan(20);
      expect(endpoint.auth).toBe("client");
    }
  });
});
