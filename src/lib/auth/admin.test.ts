import { NextResponse } from "next/server";
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

import { ADMIN_SESSION_TTL_MS, ADMIN_SESSION_TTL_SECONDS, adminCookieOptions, createAdminSession, getAdminSession, refreshAdminSession } from "./admin";
function session(epoch: number, email: string | null = "Admin@Example.com", exp = Date.now() + 60_000) { return `${Buffer.from(JSON.stringify({ epoch, email, exp })).toString("base64url")}.sig`; }

describe("admin sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 4;
    mocks.userExists = true;
    mocks.token = session(4);
    mocks.getDb.mockResolvedValue({ collection: () => ({ findOne: mocks.findUser }) });
  });

  it("uses SameSite=Lax and a 30-day session lifetime", async () => {
    const options = adminCookieOptions();
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 2_592_000 });
    expect(ADMIN_SESSION_TTL_SECONDS).toBe(2_592_000);
    const before = Date.now();
    const created = await createAdminSession(null, 4);
    const payload = JSON.parse(Buffer.from(created.split(".")[0], "base64url").toString()) as { exp: number; epoch: number; email: string | null };
    expect(payload.epoch).toBe(4);
    expect(payload.email).toBeNull();
    expect(payload.exp).toBeGreaterThanOrEqual(before + ADMIN_SESSION_TTL_MS - 1000);
    expect(payload.exp).toBeLessThanOrEqual(Date.now() + ADMIN_SESSION_TTL_MS + 1000);
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

  it("refreshes an active session cookie once at least 24 hours have elapsed", async () => {
    mocks.token = session(4, null, Date.now() + ADMIN_SESSION_TTL_MS - 25 * 60 * 60_000);
    const response = NextResponse.json({ ok: true });
    expect(await refreshAdminSession(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("fr_admin=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  it("skips refreshing a freshly issued session and rejects invalid sessions", async () => {
    mocks.token = session(4, null, Date.now() + ADMIN_SESSION_TTL_MS - 60_000);
    const freshResponse = NextResponse.json({ ok: true });
    expect(await refreshAdminSession(freshResponse)).toBe(false);
    expect(freshResponse.headers.get("set-cookie")).toBeNull();

    mocks.epoch = 5;
    const staleResponse = NextResponse.json({ ok: true });
    expect(await refreshAdminSession(staleResponse)).toBe(false);
    expect(staleResponse.headers.get("set-cookie")).toBeNull();
  });
});
