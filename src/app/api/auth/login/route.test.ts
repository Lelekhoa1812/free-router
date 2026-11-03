import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createAdminSession: vi.fn(), adminCookieName: "fr_admin", adminCookieOptions: vi.fn(() => ({ httpOnly: true, secure: false, sameSite: "strict", path: "/", maxAge: 43200 })),
  validAdminPassword: vi.fn(), normalizeAdminEmail: vi.fn((email: string) => email.trim().toLowerCase()), validAdminEmail: vi.fn(() => true),
  loginEmailAllowed: vi.fn(), failedEmailLogin: vi.fn(), clearEmailLoginFailures: vi.fn(),
  loginAllowed: vi.fn(), failedLogin: vi.fn(), clearLoginFailures: vi.fn(),
}));
vi.mock("@/lib/auth/admin", () => ({ createAdminSession: mocks.createAdminSession, adminCookieName: mocks.adminCookieName, adminCookieOptions: mocks.adminCookieOptions }));
vi.mock("@/lib/auth/access", () => ({ validAdminPassword: mocks.validAdminPassword, normalizeAdminEmail: mocks.normalizeAdminEmail, validAdminEmail: mocks.validAdminEmail, loginEmailAllowed: mocks.loginEmailAllowed, failedEmailLogin: mocks.failedEmailLogin, clearEmailLoginFailures: mocks.clearEmailLoginFailures }));
vi.mock("@/lib/redis", () => ({ loginAllowed: mocks.loginAllowed, failedLogin: mocks.failedLogin, clearLoginFailures: mocks.clearLoginFailures }));

import { POST } from "./route";
function request(email: string, password: string) { return new NextRequest("https://freerouter.test/api/auth/login", { method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json", "x-real-ip": "192.0.2.9" }, body: JSON.stringify({ email, password }) }); }

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminSession.mockResolvedValue("signed-session");
    mocks.loginAllowed.mockResolvedValue(true);
    mocks.loginEmailAllowed.mockResolvedValue(true);
    mocks.validAdminPassword.mockResolvedValue(true);
    mocks.failedLogin.mockResolvedValue(1);
    mocks.failedEmailLogin.mockResolvedValue(1);
    mocks.clearLoginFailures.mockResolvedValue(undefined);
    mocks.clearEmailLoginFailures.mockResolvedValue(undefined);
  });

  it("establishes a session using an allowlisted email and six-digit password", async () => {
    const response = await POST(request(" Admin@Example.com ", "012345"));
    expect(response.status).toBe(200);
    expect(mocks.validAdminPassword).toHaveBeenCalledWith("admin@example.com", "012345");
    expect(mocks.createAdminSession).toHaveBeenCalledWith("admin@example.com");
    expect(response.headers.get("set-cookie")).toContain("fr_admin=signed-session");
    expect(mocks.clearEmailLoginFailures).toHaveBeenCalledWith("admin@example.com");
  });

  it("denies a wrong code and an unknown email without distinguishing them", async () => {
    mocks.validAdminPassword.mockResolvedValue(false);
    const wrong = await POST(request("known@example.com", "999999"));
    const unknown = await POST(request("unknown@example.com", "999999"));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(mocks.failedEmailLogin).toHaveBeenCalledTimes(2);
    expect(mocks.createAdminSession).not.toHaveBeenCalled();
  });

  it("enforces the combined IP/email throttles before checking the code", async () => {
    mocks.loginEmailAllowed.mockResolvedValue(false);
    const response = await POST(request("admin@example.com", "012345"));
    expect(response.status).toBe(429);
    expect(mocks.validAdminPassword).not.toHaveBeenCalled();
  });

  it("records malformed six-digit codes against the caller IP", async () => {
    const response = await POST(request("admin@example.com", "12345"));
    expect(response.status).toBe(401);
    expect(mocks.failedLogin).toHaveBeenCalledWith("192.0.2.9");
    expect(mocks.validAdminPassword).not.toHaveBeenCalled();
  });
});
