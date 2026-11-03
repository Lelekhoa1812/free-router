import { cookies } from "next/headers";
import { verifySignature, signValue } from "@/lib/crypto";
import { currentAuthEpoch, normalizeAdminEmail } from "@/lib/auth/access";
import { getDb } from "@/lib/db";

const COOKIE = "fr_admin";
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

export async function getAdminSessionEmail() {
  const token = (await cookies()).get(COOKIE)?.value;
  return (await parseSession(token))?.email ?? null;
}
export async function getAdminSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  return Boolean(await parseSession(token));
}
export async function createAdminSession(email: string | null, epoch?: number) {
  const sessionEpoch = epoch ?? await currentAuthEpoch();
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60_000, epoch: sessionEpoch, email: email === null ? null : normalizeAdminEmail(email) })).toString("base64url");
  return `${payload}.${signValue(payload)}`;
}
export function adminCookieOptions() { return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: 43200 }; }
export const adminCookieName = COOKIE;
