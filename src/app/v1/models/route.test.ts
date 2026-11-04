import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateClient: vi.fn(), availablePublicModels: vi.fn(), availablePublicEmbeddingModels: vi.fn() }));

vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient }));
vi.mock("@/lib/models/availability", () => ({ availablePublicModels: mocks.availablePublicModels }));
vi.mock("@/lib/models/embedding-availability", () => ({ availablePublicEmbeddingModels: mocks.availablePublicEmbeddingModels }));

import { GET } from "./route";

describe("GET /v1/models cache policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks authentication failures no-store", async () => {
    mocks.authenticateClient.mockResolvedValue({ error: "invalid_api_key" });

    const response = await GET(new Request("https://freerouter.test/v1/models"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a scope error for a valid key without any discovery scope", async () => {
    mocks.authenticateClient.mockResolvedValue({ error: "insufficient_scope" });
    const response = await GET(new Request("https://freerouter.test/v1/models?type=embedding"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks successful model discovery no-store", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { scopes: ["chat"], models: ["*"] } });
    mocks.availablePublicModels.mockResolvedValue([{ id: "google/gemini-test" }]);
    mocks.availablePublicEmbeddingModels.mockResolvedValue([]);

    const response = await GET(new Request("https://freerouter.test/v1/models"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "google/gemini-test" }] });
  });

  it("treats an explicit empty allowlist as deny-all", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { scopes: ["chat"], models: [] } });
    mocks.availablePublicModels.mockResolvedValue([{ id: "google/gemini-test" }]);
    mocks.availablePublicEmbeddingModels.mockResolvedValue([]);

    const response = await GET(new Request("https://freerouter.test/v1/models"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [] });
  });

  it("allows an embeddings-only key to discover only its embedding models", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { scopes: ["embeddings"], models: ["*"] } });
    mocks.availablePublicEmbeddingModels.mockResolvedValue([{ id: "google/gemini-embedding-2" }]);
    const response = await GET(new Request("https://freerouter.test/v1/models?type=embedding"));
    expect(mocks.authenticateClient).toHaveBeenCalledWith(expect.any(Request), "embeddings");
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "google/gemini-embedding-2" }] });
  });

  it("includes embeddings in unfiltered discovery only when the key has that scope", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { scopes: ["chat", "embeddings"], models: ["*"] } });
    mocks.availablePublicModels.mockResolvedValue([{ id: "fr-code" }]);
    mocks.availablePublicEmbeddingModels.mockResolvedValue([{ id: "google/gemini-embedding-2" }]);
    const response = await GET(new Request("https://freerouter.test/v1/models"));
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "fr-code" }, { id: "google/gemini-embedding-2" }] });
  });

  it("allows Responses-only keys to discover chat-family models without gaining embeddings", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { scopes: ["responses"], models: ["*"] } });
    mocks.availablePublicModels.mockResolvedValue([{ id: "fr-code" }]);
    const response = await GET(new Request("https://freerouter.test/v1/models"));
    expect(mocks.authenticateClient).toHaveBeenCalledWith(expect.any(Request), ["chat", "responses", "embeddings"]);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "fr-code" }] });
    expect(mocks.availablePublicEmbeddingModels).not.toHaveBeenCalled();
  });
});
