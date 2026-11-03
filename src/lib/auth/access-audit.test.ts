import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), insertOne: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

import { recordAdminAuthAudit } from "./access";

describe("admin auth audit records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertOne.mockResolvedValue({ acknowledged: true });
    mocks.getDb.mockResolvedValue({ collection: () => ({ insertOne: mocks.insertOne }) });
  });

  it("stores only action metadata and expires the audit record after 30 days", async () => {
    await recordAdminAuthAudit({ action: "admin-password-rotated", actorEmail: "admin@example.com", targetCount: 2, sentCount: 1, failedCount: 1, outcome: "delivery_partial" });
    const event = mocks.insertOne.mock.calls[0]?.[0];
    expect(event).toMatchObject({ action: "admin-password-rotated", actorEmail: "admin@example.com", targetCount: 2, sentCount: 1, failedCount: 1, outcome: "delivery_partial" });
    expect(event.createdAt).toBeInstanceOf(Date);
    expect(event.expiresAt.getTime() - event.createdAt.getTime()).toBe(30 * 86400_000);
    expect(Object.keys(event)).not.toContain("password");
    expect(JSON.stringify(event).toLowerCase()).not.toContain("smtp");
  });
});
