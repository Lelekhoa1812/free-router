import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: "",
  epoch: 4,
  userExists: true,
  currentAuthEpoch: vi.fn(async () => mocks.epoch),
  getDb: vi.fn(),
  findUser: vi.fn(async () => mocks.userExists ? { email: "admin@example.com" } : null),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => key === "fr_admin" ? { value: mocks.token } : undefined }) }));
vi.mock("@/lib/auth/access", () => ({ currentAuthEpoch: mocks.currentAuthEpoch, normalizeAdminEmail: (email: string) => email.trim().toLowerCase() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({ verifySignature: () => true, signValue: () => "sig" }));

import { getAdminSession } from "./admin";
function session(epoch: number, email: string | null = "Admin@Example.com", exp = Date.now() + 60_000) { return `${Buffer.from(JSON.stringify({ epoch, email, exp })).toString("base64url")}.sig`; }

describe("admin sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 4;
    mocks.userExists = true;
    mocks.token = session(4);
    mocks.getDb.mockResolvedValue({ collection: () => ({ findOne: mocks.findUser }) });
  });

  it("accepts a valid current session for a still-authorized email", async () => {
    expect(await getAdminSession()).toBe(true);
    expect(mocks.findUser).toHaveBeenCalledWith({ email: "admin@example.com" }, { projection: { _id: 1 } });
  });

  it("accepts a shared-password session without tying it to a recipient email", async () => {
    mocks.token = session(4, null);
    mocks.userExists = false;
    expect(await getAdminSession()).toBe(true);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("invalidates every prior session when the shared password rotates", async () => {
    mocks.epoch = 5;
    expect(await getAdminSession()).toBe(false);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("invalidates a session when its email is removed from the allowlist", async () => {
    mocks.userExists = false;
    expect(await getAdminSession()).toBe(false);
  });

  it("rejects an expired session", async () => {
    mocks.token = session(4, "admin@example.com", Date.now() - 1);
    expect(await getAdminSession()).toBe(false);
    expect(mocks.currentAuthEpoch).not.toHaveBeenCalled();
  });
});
