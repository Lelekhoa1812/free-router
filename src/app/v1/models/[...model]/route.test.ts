import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateClient: vi.fn(), availablePublicModels: vi.fn(), availablePublicEmbeddingModels: vi.fn() }));

vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient }));
vi.mock("@/lib/models/availability", () => ({ availablePublicModels: mocks.availablePublicModels }));
vi.mock("@/lib/models/embedding-availability", () => ({ availablePublicEmbeddingModels: mocks.availablePublicEmbeddingModels }));

import { GET } from "./route";

function context(model: string[]) {
  return { params: Promise.resolve({ model }) };
}

describe("GET /v1/models/[model]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the requested model into authentication and denies a restricted key", async () => {
    mocks.authenticateClient.mockResolvedValue({ error: "model_forbidden" });

    const response = await GET(
      new Request("https://freerouter.test/v1/models/google/gemini-test"),
      context(["google", "gemini-test"]),
    );

    expect(mocks.authenticateClient).toHaveBeenCalledWith(expect.any(Request), ["chat", "responses"], "google/gemini-test");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "model_forbidden" } });
    expect(mocks.availablePublicModels).not.toHaveBeenCalled();
  });

  it("returns an allowed model", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: {} });
    mocks.availablePublicModels.mockResolvedValue([{ id: "google/gemini-test", object: "model" }]);

    const response = await GET(
      new Request("https://freerouter.test/v1/models/google/gemini-test"),
      context(["google", "gemini-test"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "google/gemini-test" });
  });

  it("retrieves embedding model IDs using the embeddings scope", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: {} });
    mocks.availablePublicEmbeddingModels.mockResolvedValue([{ id: "google/gemini-embedding-2", object: "model" }]);
    const response = await GET(
      new Request("https://freerouter.test/v1/models/google/gemini-embedding-2"),
      context(["google", "gemini-embedding-2"]),
    );
    expect(mocks.authenticateClient).toHaveBeenCalledWith(expect.any(Request), "embeddings", "google/gemini-embedding-2");
    await expect(response.json()).resolves.toMatchObject({ id: "google/gemini-embedding-2" });
  });
});
