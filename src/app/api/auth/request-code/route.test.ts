import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  adminLoginRequiresEmail: vi.fn(),
  allowCodeSend: vi.fn(), ensureInitialPassword: vi.fn(), listAdminUsers: vi.fn(), normalizeAdminEmail: vi.fn((email: string) => email.trim().toLowerCase()),
  seedBootstrapUser: vi.fn(), sendAccessPassword: vi.fn(), markPasswordSent: vi.fn(), validAdminEmail: vi.fn(() => true), sendPasswordToAll: vi.fn(),
}));
vi.mock("@/lib/auth/access", () => mocks);

import { POST } from "./route";
const email = "person@example.com";
function request(value: string) { return new NextRequest("https://freerouter.test/api/auth/request-code", { method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json", "x-real-ip": "192.0.2.2" }, body: JSON.stringify({ email: value }) }); }

describe("POST /api/auth/request-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminLoginRequiresEmail.mockResolvedValue(true);
    mocks.allowCodeSend.mockResolvedValue(true);
    mocks.seedBootstrapUser.mockResolvedValue(false);
    mocks.listAdminUsers.mockResolvedValue([{ email }]);
    mocks.ensureInitialPassword.mockResolvedValue({ created: false, code: "012345" });
    mocks.sendAccessPassword.mockResolvedValue(undefined);
    mocks.markPasswordSent.mockResolvedValue(undefined);
    mocks.sendPasswordToAll.mockResolvedValue({ sent: 1, failed: [] });
  });

  it("returns the same generic response for authorized and unauthorized recipients", async () => {
    const authorized = await POST(request(email));
    const authorizedBody = await authorized.json();
    expect(authorized.status).toBe(200);
    expect(authorizedBody).toEqual({ ok: true, message: "If this address is authorized, the current access password will be emailed shortly." });
    expect(mocks.sendAccessPassword).toHaveBeenCalledWith(email, "012345");

    vi.clearAllMocks();
    mocks.allowCodeSend.mockResolvedValue(true);
    mocks.listAdminUsers.mockResolvedValue([{ email: "other@example.com" }]);
    const unauthorized = await POST(request(email));
    expect(unauthorized.status).toBe(200);
    expect(await unauthorized.json()).toEqual(authorizedBody);
    expect(mocks.sendAccessPassword).not.toHaveBeenCalled();
    expect(mocks.sendPasswordToAll).not.toHaveBeenCalled();
  });

  it("sends a newly created bootstrap password to authorized recipients", async () => {
    mocks.listAdminUsers.mockResolvedValue([{ email }]);
    mocks.ensureInitialPassword.mockResolvedValue({ created: true, code: "000007" });
    const response = await POST(request(email));
    expect(response.status).toBe(200);
    expect(mocks.sendPasswordToAll).toHaveBeenCalledWith("000007");
    expect(mocks.sendAccessPassword).not.toHaveBeenCalled();
  });

  it("disables email password delivery in shared-password-only mode", async () => {
    mocks.adminLoginRequiresEmail.mockResolvedValue(false);
    const response = await POST(request(email));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "email_password_delivery_disabled" } });
    expect(mocks.allowCodeSend).not.toHaveBeenCalled();
    expect(mocks.seedBootstrapUser).not.toHaveBeenCalled();
    expect(mocks.sendAccessPassword).not.toHaveBeenCalled();
    expect(mocks.sendPasswordToAll).not.toHaveBeenCalled();
  });

  it("fails closed if it cannot determine which sign-in mode is active", async () => {
    mocks.adminLoginRequiresEmail.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(request(email));
    expect(response.status).toBe(503);
    expect(mocks.allowCodeSend).not.toHaveBeenCalled();
    expect(mocks.sendAccessPassword).not.toHaveBeenCalled();
  });

  it("rejects cross-origin code requests", async () => {
    const req = new NextRequest("https://freerouter.test/api/auth/request-code", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(mocks.allowCodeSend).not.toHaveBeenCalled();
  });
});
