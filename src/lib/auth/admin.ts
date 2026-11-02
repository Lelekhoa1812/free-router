import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { verifySignature, signValue, safeCompare } from "@/lib/crypto";
const COOKIE = "fr_admin";
const sessionVersion = () => signValue(`admin-session:${env.adminPassword ?? ""}`).slice(0, 16);
export async function getAdminSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !verifySignature(payload, signature)) return false;
  try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()); return data.exp > Date.now() && data.ver === sessionVersion(); } catch { return false; }
}
export function createAdminSession() { const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60_000, ver: sessionVersion() })).toString("base64url"); return `${payload}.${signValue(payload)}`; }
export function validAdminPassword(input: string) { return Boolean(env.adminPassword && safeCompare(input, env.adminPassword)); }
export const adminCookieName = COOKIE;
