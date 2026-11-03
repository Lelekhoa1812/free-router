import { NextResponse } from "next/server";
import { adminCookieName } from "@/lib/auth/admin";
import { adminCookieOptions } from "@/lib/auth/admin";
import { jsonError, sameOrigin } from "@/lib/http";
export async function POST(request: Request) { if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request"); const r = NextResponse.json({ ok: true }); r.cookies.set(adminCookieName, "", { ...adminCookieOptions(), maxAge: 0 }); return r; }
