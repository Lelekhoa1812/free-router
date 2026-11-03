import { NextRequest, NextResponse } from "next/server";
import { createAdminSession, adminCookieName, adminCookieOptions } from "@/lib/auth/admin";
import { validAdminPassword, normalizeAdminEmail, validAdminEmail, loginEmailAllowed, failedEmailLogin, clearEmailLoginFailures } from "@/lib/auth/access";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
import { loginAllowed, failedLogin, clearLoginFailures } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  let body: unknown;
  try { body = await readJson(request, 4096); } catch { return jsonError(400, "Invalid login request", "invalid_request"); }
  const { email, password } = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const normalized = typeof email === "string" ? normalizeAdminEmail(email) : "";
  const ip = request.headers.get("x-real-ip") || "unknown";
  if (!validAdminEmail(normalized) || typeof password !== "string" || !/^\d{6}$/.test(password)) {
    await failedLogin(ip);
    return jsonError(401, "Email or password is incorrect", "invalid_admin_password");
  }
  try {
    if (!await loginAllowed(ip) || !await loginEmailAllowed(normalized)) return jsonError(429, "Too many failed attempts. Try again in 15 minutes.", "login_rate_limited");
    if (!await validAdminPassword(normalized, password)) {
      await Promise.all([failedLogin(ip), failedEmailLogin(normalized)]);
      return jsonError(401, "Email or password is incorrect", "invalid_admin_password");
    }
    await Promise.all([clearLoginFailures(ip), clearEmailLoginFailures(normalized)]);
    const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(adminCookieName, await createAdminSession(normalized), adminCookieOptions());
    return response;
  } catch {
    return jsonError(503, "Sign-in is temporarily unavailable", "authentication_unavailable");
  }
}
