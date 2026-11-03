import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(), getAdminSessionEmail: vi.fn(), createAdminSession: vi.fn(), adminCookieName: "fr_admin", adminCookieOptions: vi.fn(() => ({ httpOnly: true, secure: false, sameSite: "strict", path: "/", maxAge: 43200 })),
  rotateAccessPassword: vi.fn(), sendPasswordToAll: vi.fn(), recordAdminAuthAudit: vi.fn(),
}));
vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession, getAdminSessionEmail: mocks.getAdminSessionEmail, createAdminSession: mocks.createAdminSession, adminCookieName: mocks.adminCookieName, adminCookieOptions: mocks.adminCookieOptions }));
vi.mock("@/lib/auth/access", () => ({ rotateAccessPassword: mocks.rotateAccessPassword, sendPasswordToAll: mocks.sendPasswordToAll, recordAdminAuthAudit: mocks.recordAdminAuthAudit }));

import { POST } from "./route";
function request(origin = "https://freerouter.test") { return new NextRequest("https://freerouter.test/api/admin/users/rotate", { method: "POST", headers: { origin } }); }

describe("POST /api/admin/users/rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue(true);
    mocks.getAdminSessionEmail.mockResolvedValue("admin@example.com");
    mocks.createAdminSession.mockResolvedValue("refreshed-session");
    mocks.rotateAccessPassword.mockResolvedValue({ code: "001234", epoch: 8, rotatedAt: new Date("2026-11-03T00:00:00.000Z") });
    mocks.sendPasswordToAll.mockResolvedValue({ sent: 0, failed: ["admin@example.com", "other@example.com"] });
    mocks.recordAdminAuthAudit.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated or cross-origin rotations before changing the password", async () => {
    mocks.getAdminSession.mockResolvedValue(false);
    const denied = await POST(request());
    expect(denied.status).toBe(401);
    expect(mocks.rotateAccessPassword).not.toHaveBeenCalled();

    mocks.getAdminSession.mockResolvedValue(true);
    const crossOrigin = await POST(request("https://evil.test"));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.rotateAccessPassword).not.toHaveBeenCalled();
  });

  it("keeps the rotation and reports sanitized delivery failures while refreshing the caller session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.rotateAccessPassword).toHaveBeenCalledOnce();
    expect(mocks.sendPasswordToAll).toHaveBeenCalledWith("001234");
    expect(mocks.recordAdminAuthAudit).toHaveBeenCalledWith({ action: "admin-password-rotated", actorEmail: "admin@example.com", targetCount: 2, sentCount: 0, failedCount: 2, outcome: "delivery_failed" });
    expect(mocks.createAdminSession).toHaveBeenCalledWith("admin@example.com", 8);
    expect(response.headers.get("set-cookie")).toContain("fr_admin=refreshed-session");
    const body = await response.json();
    expect(body).toMatchObject({ password: "001234", sent: 0, failed: ["admin@example.com", "other@example.com"] });
    expect(JSON.stringify(body)).not.toContain("SMTP");
    const auditBody = JSON.stringify(mocks.recordAdminAuthAudit.mock.calls[0]?.[0]);
    expect(auditBody).not.toContain("001234");
    expect(auditBody.toLowerCase()).not.toContain("smtp");
  });

  it("lets a shared-password session rotate the code and refresh its generic session", async () => {
    mocks.getAdminSessionEmail.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.recordAdminAuthAudit).toHaveBeenCalledWith({ action: "admin-password-rotated", actorEmail: "shared-password", targetCount: 2, sentCount: 0, failedCount: 2, outcome: "delivery_failed" });
    expect(mocks.createAdminSession).toHaveBeenCalledWith(null, 8);
  });
});
