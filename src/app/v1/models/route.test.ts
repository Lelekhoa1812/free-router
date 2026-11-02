import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateClient: vi.fn(), availablePublicModels: vi.fn() }));

vi.mock("@/lib/auth/client", () => ({ authenticateClient: mocks.authenticateClient }));
vi.mock("@/lib/models/availability", () => ({ availablePublicModels: mocks.availablePublicModels }));

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

  it("marks successful model discovery no-store", async () => {
    mocks.authenticateClient.mockResolvedValue({ key: { models: ["*"] } });
    mocks.availablePublicModels.mockResolvedValue([{ id: "google/gemini-test" }]);

    const response = await GET(new Request("https://freerouter.test/v1/models"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "google/gemini-test" }] });
  });
});
