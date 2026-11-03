import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdminSession: vi.fn(), getQuotaDashboard: vi.fn() }));

vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession }));
vi.mock("@/lib/quota/dashboard", () => ({ getQuotaDashboard: mocks.getQuotaDashboard }));

import { GET } from "./route";

describe("admin quota endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue({ actor: "admin" });
    mocks.getQuotaDashboard.mockResolvedValue({
      available: true,
      mode: "observe",
      generatedAt: "2026-11-03T12:00:00.000Z",
      warnings: [],
      providers: [],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("requires an admin session", async () => {
    mocks.getAdminSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.getQuotaDashboard).not.toHaveBeenCalled();
  });

  it("returns the quota projection without caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ available: true, mode: "observe" });
  });

  it("degrades to an explicit unavailable projection", async () => {
    mocks.getQuotaDashboard.mockRejectedValue(new Error("redis unavailable"));
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      available: false,
      warnings: ["quota_dashboard_unavailable"],
      providers: [],
    });
  });
});
