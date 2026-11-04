import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(), getDb: vi.fn(), getProviderCredentials: vi.fn(), upstreamEmbedding: vi.fn(),
  checkAdmission: vi.fn(), releaseAdmission: vi.fn(), reserveQuota: vi.fn(), settleQuota: vi.fn(),
}));
vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/providers/credentials", () => ({ getProviderCredentials: mocks.getProviderCredentials }));
vi.mock("@/lib/providers/embeddings", async () => { const actual = await vi.importActual<any>("@/lib/providers/embeddings"); return { ...actual, upstreamEmbedding: mocks.upstreamEmbedding }; });
vi.mock("@/lib/redis", () => ({ checkAdmission: mocks.checkAdmission, releaseAdmission: mocks.releaseAdmission }));
vi.mock("@/lib/quota/ledger", () => ({ reserveQuota: mocks.reserveQuota, settleQuota: mocks.settleQuota }));

import { POST } from "./route";

function request(body: unknown, origin = "https://freerouter.test") {
  return new Request("https://freerouter.test/api/admin/playground/embedding", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("admin Playground embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue({ actor: "admin" });
    mocks.getProviderCredentials.mockResolvedValue([{ provider: "nvidia", slot: 1, fingerprint: "fp", secret: "secret" }]);
    const collection = { find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })), updateOne: vi.fn().mockResolvedValue({}), insertOne: vi.fn().mockResolvedValue({}) };
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => collection) });
    mocks.checkAdmission.mockResolvedValue({ allowed: true });
    mocks.reserveQuota.mockResolvedValue({ allowed: true, reservation: { id: "reservation" } });
    mocks.settleQuota.mockResolvedValue(true);
    mocks.releaseAdmission.mockResolvedValue(undefined);
    mocks.upstreamEmbedding.mockResolvedValue({ object: "list", model: "nvidia/nemotron-3.5-embed-1b", data: [{ object: "embedding", index: 0, embedding: [0.2, 0.4] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
  });

  it("requires an explicit retrieval mode for NVIDIA and reports the actual vectors", async () => {
    const missingMode = await POST(request({ model: "nvidia/nvidia/nemotron-3.5-embed-1b", input: "query text" }));
    expect(missingMode.status).toBe(400);
    const response = await POST(request({ model: "nvidia/nvidia/nemotron-3.5-embed-1b", input: "query text", input_type: "query" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "nvidia/nvidia/nemotron-3.5-embed-1b", data: [{ embedding: [0.2, 0.4] }], request_id: expect.stringMatching(/^fr_/) });
    expect(mocks.upstreamEmbedding).toHaveBeenCalledWith(expect.objectContaining({ inputType: "required" }), expect.anything(), expect.objectContaining({ input_type: "query" }), expect.any(AbortSignal));
    expect(mocks.checkAdmission).toHaveBeenCalledOnce();
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
  });

  it("never stores input text or vector data in operational request metadata", async () => {
    const text = "private sentence that must not be persisted";
    await POST(request({ model: "nvidia/nvidia/nemotron-3.5-embed-1b", input: text, input_type: "passage" }));
    const db = await mocks.getDb.mock.results[0].value;
    const insert = db.collection.mock.results[0].value.insertOne;
    const record = insert.mock.calls[0][0];
    expect(JSON.stringify(record)).not.toContain(text);
    expect(record).not.toHaveProperty("data");
    expect(record).not.toHaveProperty("embedding");
    expect(record).toMatchObject({ protocol: "embeddings", actor: "admin-playground", inputCount: 1 });
  });

  it("rejects cross-origin and alias requests before provider dispatch", async () => {
    expect((await POST(request({ model: "google/gemini-embedding-2", input: "hello" }, "https://attacker.example"))).status).toBe(403);
    expect((await POST(request({ model: "fr-auto", input: "hello" }))).status).toBe(404);
    expect(mocks.upstreamEmbedding).not.toHaveBeenCalled();
  });
});
