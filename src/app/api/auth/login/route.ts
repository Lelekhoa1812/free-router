import { NextRequest, NextResponse } from "next/server";
import { createAdminSession, adminCookieName, adminCookieOptions } from "@/lib/auth/admin";
import { adminLoginRequiresEmail, validAdminPassword, normalizeAdminEmail, validAdminEmail, loginEmailAllowed, failedEmailLogin, clearEmailLoginFailures } from "@/lib/auth/access";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
import { beginLoginAttempt, clearLoginFailures } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const emailRequired = await adminLoginRequiresEmail();
    return Response.json({ emailRequired }, { headers: { "cache-control": "no-store" } });
  } catch {
    return jsonError(503, "Sign-in is temporarily unavailable", "authentication_unavailable");
  }
}

function loginRateLimited() {
  const response = jsonError(429, "Too many failed attempts. Try again in 15 minutes.", "login_rate_limited");
  response.headers.set("retry-after", "900");
  return response;
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  let body: unknown;
  try { body = await readJson(request, 4096); } catch { return jsonError(400, "Invalid login request", "invalid_request"); }
  const { email, password } = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const ip = request.headers.get("x-real-ip") || "unknown";
  try {
    const emailRequired = await adminLoginRequiresEmail();
    const normalized = emailRequired && typeof email === "string" ? normalizeAdminEmail(email) : null;
    if (!await beginLoginAttempt(ip) || (emailRequired && normalized && !await loginEmailAllowed(normalized))) return loginRateLimited();
    if ((emailRequired && (!normalized || !validAdminEmail(normalized))) || typeof password !== "string" || !/^\d{6}$/.test(password)) {
      if (emailRequired && normalized && validAdminEmail(normalized)) await failedEmailLogin(normalized);
      return jsonError(401, "Email or password is incorrect", "invalid_admin_password");
    }
    if (!await validAdminPassword(normalized, password)) {
      if (emailRequired && normalized) await failedEmailLogin(normalized);
      return jsonError(401, "Email or password is incorrect", "invalid_admin_password");
    }
    await clearLoginFailures(ip);
    if (emailRequired && normalized) await clearEmailLoginFailures(normalized);
    const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(adminCookieName, await createAdminSession(normalized), adminCookieOptions());
    return response;
  } catch {
    return jsonError(503, "Sign-in is temporarily unavailable", "authentication_unavailable");
  }
}
