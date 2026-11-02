import { NextResponse } from "next/server";
import { adminCookieName } from "@/lib/auth/admin";
export async function POST() { const r = NextResponse.json({ ok: true }); r.cookies.set(adminCookieName, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 0 }); return r; }
