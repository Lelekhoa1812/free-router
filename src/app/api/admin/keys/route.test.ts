import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdminSession: vi.fn(), getAdminSessionEmail: vi.fn(), recordAudit: vi.fn(), getDb: vi.fn(), hashClientKey: vi.fn(() => "hash") }));

vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession, getAdminSessionEmail: mocks.getAdminSessionEmail }));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({ hashClientKey: mocks.hashClientKey }));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("https://freerouter.test/api/admin/keys", {
    method: "POST",
    headers: { origin: "https://freerouter.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/keys model allowlist", () => {
  const insertOne = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    insertOne.mockResolvedValue({});
    mocks.getAdminSession.mockResolvedValue({ email: "admin@example.com" });
    mocks.getAdminSessionEmail.mockResolvedValue("admin@example.com");
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => ({ insertOne })) });
  });

  it("rejects an explicit empty allowlist instead of storing a fail-open key", async () => {
    const response = await POST(request({ name: "restricted", scopes: ["chat"], models: [] }));

    expect(response.status).toBe(400);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("defaults a missing allowlist to the wildcard", async () => {
    const response = await POST(request({ name: "default", scopes: ["chat"] }));

    expect(response.status).toBe(201);
    expect(insertOne.mock.calls[0][0].models).toEqual(["*"]);
  });
});
