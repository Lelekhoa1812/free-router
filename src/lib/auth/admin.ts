import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { verifySignature, signValue } from "@/lib/crypto";
import { currentAuthEpoch, normalizeAdminEmail } from "@/lib/auth/access";
import { getDb } from "@/lib/db";

const COOKIE = "fr_admin";
export const ADMIN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ADMIN_SESSION_TTL_MS = ADMIN_SESSION_TTL_SECONDS * 1000;
const ADMIN_SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
type SessionData = { exp: number; epoch: number; email: string | null };

async function parseSession(token: string | undefined): Promise<SessionData | null> {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !verifySignature(payload, signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as SessionData;
    if (!data || !Number.isFinite(data.exp) || !Number.isInteger(data.epoch) || !(typeof data.email === "string" || data.email === null) || data.exp <= Date.now()) return null;
    if (data.epoch !== await currentAuthEpoch()) return null;
    if (data.email !== null) {
      const db = await getDb();
      if (!await db.collection("admin_users").findOne({ email: normalizeAdminEmail(data.email) }, { projection: { _id: 1 } })) return null;
    }
    return data;
  } catch { return null; }
}

async function getValidAdminSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  return parseSession(token);
}

export async function getAdminSessionEmail() {
  return (await getValidAdminSession())?.email ?? null;
}
export async function getAdminSession() {
  return Boolean(await getValidAdminSession());
}
export async function createAdminSession(email: string | null, epoch?: number) {
  const sessionEpoch = epoch ?? await currentAuthEpoch();
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_TTL_MS, epoch: sessionEpoch, email: email === null ? null : normalizeAdminEmail(email) })).toString("base64url");
  return `${payload}.${signValue(payload)}`;
}
export async function refreshAdminSession(response: NextResponse) {
  const session = await getValidAdminSession();
  if (!session || session.exp - Date.now() > ADMIN_SESSION_TTL_MS - ADMIN_SESSION_REFRESH_INTERVAL_MS) return false;
  response.cookies.set(COOKIE, await createAdminSession(session.email, session.epoch), adminCookieOptions());
  return true;
}
export function adminCookieOptions() { return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: ADMIN_SESSION_TTL_SECONDS }; }
export const adminCookieName = COOKIE;
