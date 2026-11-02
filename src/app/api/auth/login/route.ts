import { NextRequest, NextResponse } from "next/server";
import { createAdminSession, validAdminPassword, adminCookieName } from "@/lib/auth/admin";
import { jsonError,sameOrigin } from "@/lib/http";
import { loginAllowed, failedLogin, clearLoginFailures } from "@/lib/redis";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if(!sameOrigin(request))return jsonError(403,"Cross-origin request rejected","cross_origin_request");
  try { const ip=request.headers.get("x-real-ip")||"unknown";if(!await loginAllowed(ip))return jsonError(429,"Too many failed attempts. Try again in 15 minutes.","login_rate_limited");const body = await request.json(); if (typeof body.password !== "string" || !validAdminPassword(body.password)) { await failedLogin(ip); return jsonError(401, "Incorrect password", "invalid_admin_password"); }await clearLoginFailures(ip);
    const response = NextResponse.json({ ok: true }); response.cookies.set(adminCookieName, createAdminSession(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 43200 }); return response;
  } catch { return jsonError(400, "Invalid login request", "invalid_request"); }
}
