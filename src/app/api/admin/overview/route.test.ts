import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(),
  refreshAdminSession: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession, refreshAdminSession: mocks.refreshAdminSession }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/env", () => ({ getConfigurationStatus: () => ({ mongo: true, redis: true }) }));
vi.mock("@/lib/models/catalog", () => ({ MODEL_CATALOG: [{ status: "ready" }] }));

import { GET } from "./route";

describe("GET /api/admin/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshAdminSession.mockResolvedValue(false);
    mocks.getDb.mockResolvedValue({
      collection: (name: string) => {
        if (name === "client_keys") return { countDocuments: async () => 2 };
        return {
          countDocuments: async () => 5,
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        };
      },
    });
  });

  it("rejects unauthenticated requests with 401 and no-store", async () => {
    mocks.getAdminSession.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.refreshAdminSession).not.toHaveBeenCalled();
  });

  it("returns overview data and refreshes active sessions when needed", async () => {
    mocks.getAdminSession.mockResolvedValue(true);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ keys: 2, requests24h: 5, models: 1 });
    expect(mocks.refreshAdminSession).toHaveBeenCalledOnce();
  });
});
