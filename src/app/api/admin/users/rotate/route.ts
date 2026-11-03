import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, getAdminSessionEmail, createAdminSession, adminCookieName, adminCookieOptions } from "@/lib/auth/admin";
import { rotateAccessPassword, sendPasswordToAll, recordAdminAuthAudit } from "@/lib/auth/access";
import { jsonError, sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  const sessionEmail = await getAdminSessionEmail();
  const email = sessionEmail ?? "shared-password";
  try {
    const changed = await rotateAccessPassword();
    const delivery = await sendPasswordToAll(changed.code);
    const targetCount = delivery.sent + delivery.failed.length;
    await recordAdminAuthAudit({ action: "admin-password-rotated", actorEmail: email, targetCount, sentCount: delivery.sent, failedCount: delivery.failed.length, outcome: delivery.failed.length === 0 ? "sent" : delivery.sent === 0 ? "delivery_failed" : "delivery_partial" });
    const response = NextResponse.json({ password: changed.code, sent: delivery.sent, failed: delivery.failed, rotatedAt: changed.rotatedAt.toISOString() }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(adminCookieName, await createAdminSession(sessionEmail, changed.epoch), adminCookieOptions());
    return response;
  } catch { return jsonError(503, "Unable to rotate and deliver the access password", "rotation_unavailable"); }
}
