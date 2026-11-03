import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(), getProviderCredentials: vi.fn(), getProviderCredentialSlots: vi.fn(),
  probeProviderCredential: vi.fn(), removeProviderCredential: vi.fn(), saveProviderCredential: vi.fn(), getDb: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/providers/credentials", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  getProviderCredentialSlots: mocks.getProviderCredentialSlots,
  probeProviderCredential: mocks.probeProviderCredential,
  removeProviderCredential: mocks.removeProviderCredential,
  saveProviderCredential: mocks.saveProviderCredential,
}));

import { GET, POST } from "./route";

const request = (body: unknown) => new Request("https://freerouter.test/api/admin/providers", {
  method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("admin provider key management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue({ actor: "admin" });
    mocks.probeProviderCredential.mockResolvedValue({ status: 200, ok: true });
    mocks.saveProviderCredential.mockResolvedValue({ authStatus: "healthy", fingerprint: "redacted" });
    mocks.getProviderCredentialSlots.mockResolvedValue([{ id: "google", configured: 1, slots: [{ slot: 1, configured: true }] }]);
    mocks.getProviderCredentials.mockResolvedValue([{ provider: "google", slot: 1, secret: "private-upstream-secret", fingerprint: "fingerprint" }]);
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => ({ updateOne: vi.fn().mockResolvedValue({}) })) });
  });

  it("requires an admin session and never returns provider secret values", async () => {
    mocks.getAdminSession.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
    const response = await GET();
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("private-upstream-secret");
  });

  it("probes and saves a submitted secret without echoing it", async () => {
    const response = await POST(request({ provider: "google", slot: 3, action: "save", label: "backup", secret: "new-private-secret" }));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.probeProviderCredential).toHaveBeenCalledWith("google", "new-private-secret");
    expect(mocks.saveProviderCredential).toHaveBeenCalledWith({ provider: "google", slot: 3, secret: "new-private-secret", label: "backup", probeStatus: 200 });
    expect(body).not.toContain("new-private-secret");
  });

  it("rejects out-of-range slots before probing", async () => {
    const response = await POST(request({ provider: "google", slot: 10, action: "save", secret: "key" }));
    expect(response.status).toBe(400);
    expect(mocks.probeProviderCredential).not.toHaveBeenCalled();
  });

  it("removes a slot through the authenticated dashboard operation", async () => {
    mocks.removeProviderCredential.mockResolvedValue(true);
    const response = await POST(request({ provider: "nvidia", slot: 2, action: "remove" }));
    expect(response.status).toBe(200);
    expect(mocks.removeProviderCredential).toHaveBeenCalledWith("nvidia", 2);
  });
});
