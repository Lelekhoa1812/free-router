import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getQuotaSnapshot: vi.fn() }));

vi.mock("./ledger", async () => {
  const actual = await vi.importActual<any>("./ledger");
  return { ...actual, getQuotaSnapshot: mocks.getQuotaSnapshot };
});

import { getQuotaDashboard } from "./dashboard";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QUOTA_CONFIG_JSON;
  delete process.env.QUOTA_MODE;
  mocks.getQuotaSnapshot.mockResolvedValue({
    available: true,
    used: { requestsDay: 3, requestsMinute: 1, tokensDay: 100, tokensMinute: 20 },
    remaining: { requestsDay: 47, requestsMinute: 19, tokensDay: null, tokensMinute: null },
    resetAt: "2026-11-04T00:00:00.000Z",
  });
});

describe("quota dashboard projection", () => {
  it("shows model-scoped Google rows and one account-wide OpenRouter row", async () => {
    const dashboard = await getQuotaDashboard(new Date("2026-11-03T12:00:00.000Z"));
    expect(dashboard.available).toBe(true);
    expect(dashboard.mode).toBe("observe");
    const google = dashboard.providers.find((provider) => provider.id === "google")!;
    expect(google.groups[0].scope).toBe("model");
    expect(google.groups[0].rows.length).toBeGreaterThan(0);
    expect(google.groups[0].rows[0].model).toContain("google/");
    const openrouter = dashboard.providers.find((provider) => provider.id === "openrouter")!;
    expect(openrouter.groups[0].scope).toBe("group");
    expect(openrouter.groups[0].rows).toHaveLength(1);
    expect(openrouter.groups[0].rows[0].model).toBe("*");
    expect(dashboard.warnings.join(" ")).toContain("Google quotas");
  });

  it("marks the projection unavailable when a counter read fails", async () => {
    mocks.getQuotaSnapshot.mockResolvedValue({
      available: false,
      used: { requestsDay: 0, requestsMinute: 0, tokensDay: 0, tokensMinute: 0 },
      remaining: { requestsDay: null, requestsMinute: null, tokensDay: null, tokensMinute: null },
      resetAt: null,
    });
    const dashboard = await getQuotaDashboard();
    expect(dashboard.available).toBe(false);
  });
});
