import { NextRequest } from "next/server";
import { allowCodeSend, ensureInitialPassword, listAdminUsers, normalizeAdminEmail, seedBootstrapUser, sendAccessPassword, markPasswordSent, validAdminEmail, sendPasswordToAll } from "@/lib/auth/access";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  let body: unknown;
  try { body = await readJson(request, 4096); } catch { return jsonError(400, "Invalid request", "invalid_request"); }
  const rawEmail = body && typeof body === "object" ? (body as Record<string, unknown>).email : undefined;
  const email = typeof rawEmail === "string" ? normalizeAdminEmail(rawEmail) : "";
  if (!validAdminEmail(email)) return jsonError(400, "Enter a valid email address", "invalid_email");
  try {
    const ip = request.headers.get("x-real-ip") || "unknown";
    if (!await allowCodeSend(ip, email)) return jsonError(429, "Too many requests. Try again later.", "login_rate_limited");
    await seedBootstrapUser(email);
    const users = await listAdminUsers();
    const authorized = users.some((user) => user.email === email);
    if (authorized) {
      const state = await ensureInitialPassword();
      if (state.created) await sendPasswordToAll(state.code!);
      else if (state.code) { await sendAccessPassword(email, state.code); await markPasswordSent(); }
    }
  } catch {
    // Keep membership indistinguishable from delivery/dependency failures.
  }
  return Response.json({ ok: true, message: "If this address is authorized, the current access password will be emailed shortly." }, { headers: { "cache-control": "no-store" } });
}
