import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(), getAdminSessionEmail: vi.fn(), addAdminUser: vi.fn(), currentAccessPassword: vi.fn(), listAdminUsers: vi.fn(), normalizeAdminEmail: vi.fn((email: string) => email.trim().toLowerCase()), removeAdminUser: vi.fn(),
  sendAccessPassword: vi.fn(), sendPasswordToAll: vi.fn(), ensureInitialPassword: vi.fn(), validAdminEmail: vi.fn(() => true), recordAdminAuthAudit: vi.fn(),
}));
vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession, getAdminSessionEmail: mocks.getAdminSessionEmail }));
vi.mock("@/lib/auth/access", () => ({ addAdminUser: mocks.addAdminUser, currentAccessPassword: mocks.currentAccessPassword, listAdminUsers: mocks.listAdminUsers, normalizeAdminEmail: mocks.normalizeAdminEmail, removeAdminUser: mocks.removeAdminUser, sendAccessPassword: mocks.sendAccessPassword, sendPasswordToAll: mocks.sendPasswordToAll, ensureInitialPassword: mocks.ensureInitialPassword, validAdminEmail: mocks.validAdminEmail, recordAdminAuthAudit: mocks.recordAdminAuthAudit }));

import { GET, POST } from "./route";
function request(email: string, origin = "https://freerouter.test") { return new NextRequest("https://freerouter.test/api/admin/users", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email }) }); }

describe("/api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue(true);
    mocks.getAdminSessionEmail.mockResolvedValue("actor@example.com");
    mocks.addAdminUser.mockResolvedValue(true);
    mocks.ensureInitialPassword.mockResolvedValue({ created: false, code: "123456" });
    mocks.sendAccessPassword.mockResolvedValue(undefined);
    mocks.sendPasswordToAll.mockResolvedValue({ sent: 1, failed: [] });
    mocks.listAdminUsers.mockResolvedValue([]);
    mocks.currentAccessPassword.mockResolvedValue({ password: "123456", epoch: 1, rotatedAt: null, lastSentAt: null });
    mocks.recordAdminAuthAudit.mockResolvedValue(undefined);
  });

  it("requires a same-origin admin session before listing users", async () => {
    mocks.getAdminSession.mockResolvedValue(false);
    const denied = await GET();
    expect(denied.status).toBe(401);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();

    mocks.getAdminSession.mockResolvedValue(true);
    const accepted = await GET();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-origin and unauthenticated mutations", async () => {
    const crossOrigin = await POST(request("new@example.com", "https://evil.test"));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.getAdminSession).not.toHaveBeenCalled();

    mocks.getAdminSession.mockResolvedValue(false);
    const unauthenticated = await POST(request("new@example.com"));
    expect(unauthenticated.status).toBe(401);
    expect(mocks.addAdminUser).not.toHaveBeenCalled();
  });

  it("keeps an added address authorized when email delivery fails and reports only delivery status", async () => {
    mocks.sendAccessPassword.mockRejectedValue(new Error("SMTP credentials must never be returned"));
    const response = await POST(request("  New@Example.com "));
    expect(response.status).toBe(201);
    expect(mocks.addAdminUser).toHaveBeenCalledWith("new@example.com");
    expect(mocks.sendAccessPassword).toHaveBeenCalledWith("new@example.com", "123456");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, user: { email: "new@example.com" }, delivery: "failed" });
    expect(JSON.stringify(body)).not.toContain("SMTP credentials");
    expect(mocks.recordAdminAuthAudit).toHaveBeenCalledWith({ action: "admin-user-added", actorEmail: "actor@example.com", targetEmail: "new@example.com", targetCount: 1, outcome: "failed" });
    const auditBody = JSON.stringify(mocks.recordAdminAuthAudit.mock.calls[0]?.[0]);
    expect(auditBody).not.toContain("123456");
    expect(auditBody.toLowerCase()).not.toContain("smtp");
  });

  it("audits deletion with the actor and target address but no access password", async () => {
    mocks.removeAdminUser.mockResolvedValue(true);
    const response = await (await import("./route")).DELETE(new NextRequest("https://freerouter.test/api/admin/users", { method: "DELETE", headers: { origin: "https://freerouter.test", "content-type": "application/json" }, body: JSON.stringify({ email: "remove@example.com" }) }));
    expect(response.status).toBe(200);
    expect(mocks.recordAdminAuthAudit).toHaveBeenCalledWith({ action: "admin-user-deleted", actorEmail: "actor@example.com", targetEmail: "remove@example.com", targetCount: 1, outcome: "deleted" });
    expect(JSON.stringify(mocks.recordAdminAuthAudit.mock.calls[0]?.[0])).not.toContain("123456");
  });
});
