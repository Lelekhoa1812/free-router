import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getAdminSession, getAdminSessionEmail } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { hashClientKey } from "@/lib/crypto";
import { readJson,sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  const docs = await (await getDb()).collection("client_keys").find({ deletedAt: { $exists: false } }, { projection: { tokenHash: 0 } }).sort({ createdAt: -1 }).toArray();
  return Response.json(docs.map(k => ({ ...k, _id: String(k._id) })));
}
export async function POST(request: Request) {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  if(!sameOrigin(request))return Response.json({error:"cross_origin_request"},{status:403});
  try { const input = await readJson(request) as Record<string, unknown>; const name = String(input.name || "").trim(); const description = String(input.description || "").trim();
    if (name.length < 1 || name.length > 64 || description.length > 500) return Response.json({ error: "Invalid name or description" }, { status: 400 });
    if (input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.some(x => !["chat", "responses", "decisions", "embeddings"].includes(String(x))))) return Response.json({ error: "Scopes must include at least one supported API scope" }, { status: 400 });
    if (input.models !== undefined && (!Array.isArray(input.models) || input.models.length < 1)) return Response.json({ error: "Models must contain at least one model or *" }, { status: 400 });
    const scopes = Array.isArray(input.scopes) ? input.scopes as string[] : ["chat", "responses", "decisions", "embeddings"];
    const expiresAt = input.expiresAt ? new Date(String(input.expiresAt)) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return Response.json({ error: "Expiry must be a valid future date" }, { status: 400 });
    const secret = `sk-fr-${randomBytes(32).toString("base64url")}`; const now = new Date(); const id = new ObjectId();
    const doc = { _id: id, name, description, prefix: secret.slice(0, 14), tokenHash: hashClientKey(secret), scopes: [...new Set(scopes)], models: Array.isArray(input.models) ? input.models.map(String).slice(0, 100) : ["*"], status: "active", allowJevRouting: input.allowJevRouting !== false, createdAt: now, lastUsedAt: null, expiresAt };
    const db = await getDb();
    await db.collection("client_keys").insertOne(doc);
    await recordAudit(db, { action: "client-key-created", actorEmail: (await getAdminSessionEmail()) ?? "shared-password", outcome: "created", targetId: String(id), targetName: name, detail: { scopes: doc.scopes.join(",") } });
    return Response.json({ id: String(id), key: secret, name, prefix: doc.prefix }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "Unable to create key" }, { status: 400 }); }
}
