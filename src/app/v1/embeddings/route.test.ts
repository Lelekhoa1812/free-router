import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateClient: vi.fn(), getProviderCredentials: vi.fn(), getDb: vi.fn(),
  checkAdmission: vi.fn(), releaseAdmission: vi.fn(), reserveQuota: vi.fn(), settleQuota: vi.fn(), upstreamEmbedding: vi.fn(),
}));

vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient }));
vi.mock("@/lib/providers/credentials", () => ({ getProviderCredentials: mocks.getProviderCredentials }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/redis", () => ({ checkAdmission: mocks.checkAdmission, releaseAdmission: mocks.releaseAdmission }));
vi.mock("@/lib/quota/ledger", () => ({ reserveQuota: mocks.reserveQuota, settleQuota: mocks.settleQuota }));
vi.mock("@/lib/providers/embeddings", async () => {
  const actual = await vi.importActual<any>("@/lib/providers/embeddings");
  return { ...actual, upstreamEmbedding: mocks.upstreamEmbedding };
});

import { parseRetryAfterSeconds, POST } from "./route";
import { EmbeddingProviderError } from "@/lib/providers/embeddings";

function request(body: unknown, token = "sk-fr-test") {
  return new Request("https://freerouter.test/v1/embeddings", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /v1/embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateClient.mockResolvedValue({ key: { _id: { toString: () => "client-1" } } });
    mocks.getProviderCredentials.mockResolvedValue([{ provider: "google", slot: 1, fingerprint: "fp", secret: "secret" }]);
    const collection = { find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })), updateOne: vi.fn().mockResolvedValue({}), insertOne: vi.fn().mockResolvedValue({}) };
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => collection) });
    mocks.checkAdmission.mockResolvedValue({ allowed: true });
    mocks.reserveQuota.mockResolvedValue({ allowed: true, reservation: { id: "r" } });
    mocks.releaseAdmission.mockResolvedValue(undefined);
    mocks.settleQuota.mockResolvedValue(true);
    mocks.upstreamEmbedding.mockResolvedValue({ object: "list", model: "google/gemini-embedding-2", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } });
  });

  it("parses both Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterSeconds("12")).toBe(12);
    expect(parseRetryAfterSeconds(new Date(Date.now() + 20_000).toUTCString())).toBeGreaterThanOrEqual(19);
    expect(parseRetryAfterSeconds("not-a-date")).toBeUndefined();
  });

  it("rejects automatic routing because embeddings require a concrete model", async () => {
    const response = await POST(request({ model: "fr-auto", input: "hello" }));
    expect(response.status).toBe(404);
    expect(mocks.upstreamEmbedding).not.toHaveBeenCalled();
  });

  it("rejects streaming and malformed batch shapes", async () => {
    expect((await POST(request({ model: "google/gemini-embedding-2", input: "hello", stream: true }))).status).toBe(400);
    expect((await POST(request({ model: "google/gemini-embedding-2", input: ["hello", 2] }))).status).toBe(400);
    expect(mocks.upstreamEmbedding).not.toHaveBeenCalled();
  });

  it("requires retrieval mode and fixed dimensions for the matching NVIDIA model", async () => {
    const missingMode = await POST(request({ model: "nvidia/nvidia/nemotron-3-embed-1b", input: "hello" }));
    expect(missingMode.status).toBe(400);
    const badDimensions = await POST(request({ model: "nvidia/nvidia/nemotron-3-embed-1b", input: "hello", input_type: "query", dimensions: 768 }));
    expect(badDimensions.status).toBe(400);
    expect(mocks.upstreamEmbedding).not.toHaveBeenCalled();
  });

  it("authenticates with the embeddings scope and returns a standard non-streaming envelope", async () => {
    const response = await POST(request({ model: "google/gemini-embedding-2", input: ["one", "two"], encoding_format: "float" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-freerouter-resolved-model")).toBe("google/gemini-embedding-2");
    expect(mocks.authenticateClient).toHaveBeenCalledWith(expect.any(Request), "embeddings", "google/gemini-embedding-2");
    expect(mocks.upstreamEmbedding).toHaveBeenCalledWith(expect.objectContaining({ upstream: "gemini-embedding-2" }), expect.anything(), expect.objectContaining({ input: ["one", "two"] }), expect.any(AbortSignal));
    expect(await response.json()).toMatchObject({ object: "list", model: "google/gemini-embedding-2", data: [{ index: 0 }], usage: { total_tokens: 3 } });
    expect(mocks.reserveQuota).toHaveBeenCalledOnce();
    expect(mocks.settleQuota).toHaveBeenCalledOnce();
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
  });

  it("returns a scope or key authorization error without reaching a provider", async () => {
    mocks.authenticateClient.mockResolvedValue({ error: "insufficient_scope" });
    const response = await POST(request({ model: "google/gemini-embedding-2", input: "hello" }));
    expect(response.status).toBe(403);
    expect(mocks.upstreamEmbedding).not.toHaveBeenCalled();
  });

  it("quarantines a credential with exhausted provider credits and retries only the same model", async () => {
    mocks.getProviderCredentials.mockResolvedValue([
      { provider: "google", slot: 1, fingerprint: "fp1", secret: "secret1" },
      { provider: "google", slot: 2, fingerprint: "fp2", secret: "secret2" },
    ]);
    mocks.upstreamEmbedding.mockRejectedValueOnce(new EmbeddingProviderError("payment required", 402, "insufficient_credits"));
    const response = await POST(request({ model: "google/gemini-embedding-2", input: "hello" }));
    expect(response.status).toBe(200);
    expect(mocks.upstreamEmbedding).toHaveBeenCalledTimes(2);
    expect(mocks.upstreamEmbedding.mock.calls.map(([profile]) => profile.id)).toEqual(["google/gemini-embedding-2", "google/gemini-embedding-2"]);
  });
});
