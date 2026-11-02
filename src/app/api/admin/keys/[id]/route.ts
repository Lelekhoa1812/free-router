import { ObjectId } from "mongodb";
import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  if(!sameOrigin(request))return Response.json({error:"cross_origin_request"},{status:403});
  try { const { id } = await ctx.params; if (!ObjectId.isValid(id)) return Response.json({ error: "not_found" }, { status: 404 }); const body = await request.json(); const db = await getDb(); const update: Record<string, unknown> = {};
    if (body.action === "revoke") update.status = "revoked"; else if (body.action === "delete") { const existing=await db.collection("client_keys").findOne({_id:new ObjectId(id)});if(existing?.status!=="revoked")return Response.json({error:"revoke_before_delete"},{status:409});update.deletedAt = new Date(); } else if (typeof body.name === "string" && body.name.trim()) { update.name = body.name.slice(0, 64); update.description = String(body.description || "").slice(0, 500); } else return Response.json({ error: "invalid_action" }, { status: 400 });
    await db.collection("client_keys").updateOne({ _id: new ObjectId(id) }, { $set: body.action === "delete" ? { ...update, status:"deleted" } : update }); if (body.action === "delete") await db.collection("responses").deleteMany({ ownerId: id }); return Response.json({ ok: true });
  } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
}
