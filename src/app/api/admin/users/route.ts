import { NextRequest } from "next/server";
import { getAdminSession, getAdminSessionEmail } from "@/lib/auth/admin";
import { addAdminUser, currentAccessPassword, listAdminUsers, normalizeAdminEmail, removeAdminUser, sendAccessPassword, sendPasswordToAll, ensureInitialPassword, validAdminEmail, recordAdminAuthAudit } from "@/lib/auth/access";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function bodyEmail(request: Request) {
  const body = await readJson(request, 4096);
  const email = body && typeof body === "object" ? (body as Record<string, unknown>).email : undefined;
  if (typeof email !== "string") throw new Error("invalid_email");
  const normalized = normalizeAdminEmail(email);
  if (!validAdminEmail(normalized)) throw new Error("invalid_email");
  return normalized;
}

export async function GET() {
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  try {
    const [users, state] = await Promise.all([listAdminUsers(), currentAccessPassword()]);
    return Response.json({ users, password: state.password, rotatedAt: state.rotatedAt, lastSentAt: state.lastSentAt }, { headers: { "cache-control": "no-store" } });
  } catch { return jsonError(503, "Unable to load access users", "users_unavailable"); }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  const actorEmail = await getAdminSessionEmail();
  if (!actorEmail) return jsonError(401, "Unauthorized", "unauthorized");
  let email: string;
  try { email = await bodyEmail(request); } catch { return jsonError(400, "Enter a valid email address", "invalid_email"); }
  try {
    if (!await addAdminUser(email)) {
      await recordAdminAuthAudit({ action: "admin-user-added", actorEmail, targetEmail: email, targetCount: 1, outcome: "already_exists" });
      return jsonError(409, "That email is already authorized", "user_already_exists");
    }
    const initial = await ensureInitialPassword();
    let delivery: "sent" | "failed" = "failed";
    if (initial.created && initial.code) {
      const result = await sendPasswordToAll(initial.code);
      delivery = result.failed.includes(email) ? "failed" : "sent";
    } else if (initial.code) {
      try { await sendAccessPassword(email, initial.code); delivery = "sent"; }
      catch { delivery = "failed"; }
    }
    await recordAdminAuthAudit({ action: "admin-user-added", actorEmail, targetEmail: email, targetCount: 1, outcome: delivery });
    return Response.json({ ok: true, user: { email, createdAt: new Date().toISOString() }, delivery }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch { return jsonError(503, "Unable to add access user", "users_unavailable"); }
}

export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  const actorEmail = await getAdminSessionEmail();
  if (!actorEmail) return jsonError(401, "Unauthorized", "unauthorized");
  let email: string;
  try { email = await bodyEmail(request); } catch { return jsonError(400, "Enter a valid email address", "invalid_email"); }
  try {
    const removed = await removeAdminUser(email);
    if (!removed) {
      await recordAdminAuthAudit({ action: "admin-user-deleted", actorEmail, targetEmail: email, targetCount: 1, outcome: "not_found" });
      return jsonError(404, "Access user not found", "user_not_found");
    }
    await recordAdminAuthAudit({ action: "admin-user-deleted", actorEmail, targetEmail: email, targetCount: 1, outcome: "deleted" });
    return Response.json({ ok: true, email }, { headers: { "cache-control": "no-store" } });
  } catch { return jsonError(503, "Unable to remove access user", "users_unavailable"); }
}
