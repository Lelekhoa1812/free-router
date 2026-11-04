import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderEmbeddingBody,
  EmbeddingProviderError,
  EmbeddingProviderRequestError,
  upstreamEmbedding,
} from "@/lib/providers/embeddings";

describe("provider embedding adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps standard OpenAI fields to the selected provider's upstream model", () => {
    expect(buildProviderEmbeddingBody(
      { id: "google/gemini-embedding-2", provider: "google", upstream: "gemini-embedding-2-preview" },
      { model: "google/gemini-embedding-2", input: ["a", "b"], dimensions: 768, encoding_format: "float", user: "user-1" },
    )).toEqual({ model: "gemini-embedding-2-preview", input: ["a", "b"], dimensions: 768, encoding_format: "float", user: "user-1" });
  });

  it("keeps NVIDIA's retrieval direction explicit and forwards supported model extensions", () => {
    const profile = { id: "nvidia/nemotron-3.5-embed-1b", provider: "nvidia" as const, upstream: "nvidia/nemotron-3.5-embed-1b", inputType: "required" as const };
    expect(buildProviderEmbeddingBody(profile, { model: profile.id, input: "query", input_type: "query", dimensions: 512, truncate: "END", embedding_type: "float" })).toEqual({
      model: profile.upstream, input: "query", input_type: "query", dimensions: 512, truncate: "END", embedding_type: "float",
    });
    expect(() => buildProviderEmbeddingBody(profile, { model: profile.id, input: "query" })).toThrowError(expect.objectContaining({ code: "input_type_required" }));
  });

  it("rejects streaming and provider-specific fields that would otherwise be silently ignored", () => {
    const google = { id: "google/e", provider: "google" as const, upstream: "gemini-embedding-2-preview" };
    expect(() => buildProviderEmbeddingBody(google, { model: google.id, input: "x", stream: true })).toThrowError(EmbeddingProviderRequestError);
    expect(() => buildProviderEmbeddingBody(google, { model: google.id, input: "x", input_type: "query" })).toThrow(/not supported by the Google/);
  });

  it("rejects empty inputs and model/profile mismatches", () => {
    const profile = { id: "openrouter/nvidia/nemotron-3.5-embed-1b:free", provider: "openrouter" as const, upstream: "nvidia/nemotron-3.5-embed-1b:free" };
    expect(() => buildProviderEmbeddingBody(profile, { model: profile.id, input: [] })).toThrow(/non-empty/);
    expect(() => buildProviderEmbeddingBody(profile, { model: "some-other-model", input: "x" })).toThrow(/does not match/);
  });

  it("uses the configured provider embeddings URL and never requests an SSE stream", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ object: "list", model: "upstream-model", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const profile = { id: "openrouter/nvidia/nemotron-3.5-embed-1b:free", provider: "openrouter" as const, upstream: "nvidia/nemotron-3.5-embed-1b:free" };
    const result = await upstreamEmbedding(profile, { secret: "test-secret" }, { model: profile.id, input: "hello" });
    expect(result).toEqual({ object: "list", model: profile.id, upstreamModel: "upstream-model", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } });
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/embeddings", expect.objectContaining({
      method: "POST", cache: "no-store", body: JSON.stringify({ model: profile.upstream, input: "hello" }),
    }));
    const request = fetch.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: "Bearer test-secret", accept: "application/json" });
    expect(request.headers).not.toHaveProperty("accept", expect.stringContaining("text/event-stream"));
  });

  it("checks returned vector count, dimensions, indices and finite numeric values", async () => {
    const profile = { id: "google/e", provider: "google" as const, upstream: "gemini-embedding-2-preview" };
    const call = (data: unknown[]) => {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      return upstreamEmbedding(profile, { secret: "test-secret" }, { model: profile.id, input: ["a", "b"], dimensions: 2 });
    };
    await expect(call([{ index: 0, embedding: [1, 2] }])).rejects.toMatchObject({ code: "upstream_invalid_response" });
    await expect(call([{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }])).rejects.toMatchObject({ code: "upstream_invalid_response" });
    await expect(call([{ index: 0, embedding: [1, Number.NaN] }, { index: 1, embedding: [1, 2] }])).rejects.toMatchObject({ code: "upstream_invalid_response" });
  });

  it("converts float arrays and base64 vectors to the requested OpenAI encoding", async () => {
    const profile = { id: "google/e", provider: "google" as const, upstream: "gemini-embedding-2-preview" };
    const values = [0.25, -0.5];
    const bytes = Buffer.alloc(8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const floatFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: values }] }), { status: 200 }));
    vi.stubGlobal("fetch", floatFetch);
    const encoded = await upstreamEmbedding(profile, { secret: "test-secret" }, { model: profile.id, input: "x", encoding_format: "base64" });
    expect(encoded.data[0]?.embedding).toBe(bytes.toString("base64"));

    const base64Fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: bytes.toString("base64") }] }), { status: 200 }));
    vi.stubGlobal("fetch", base64Fetch);
    const decoded = await upstreamEmbedding(profile, { secret: "test-secret" }, { model: profile.id, input: "x", encoding_format: "float", dimensions: 2 });
    expect(decoded.data[0]?.embedding).toEqual(values);
  });

  it("sanitizes provider failures and preserves status, safe code, and Retry-After", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "rate_limit", message: "input was secret prompt text" } }), { status: 429, headers: { "retry-after": "12" } }));
    vi.stubGlobal("fetch", fetch);
    const profile = { id: "openrouter/e", provider: "openrouter" as const, upstream: "embed-model" };
    await expect(upstreamEmbedding(profile, { secret: "test-secret" }, { model: profile.id, input: "sensitive caller text" })).rejects.toMatchObject<Partial<EmbeddingProviderError>>({
      message: "Embedding provider request failed", status: 429, code: "upstream_embedding_error", providerCode: "rate_limit", retryAfter: "12",
    });
  });
});
