import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { hashClientKey } from "@/lib/crypto";
export interface ClientKey { _id: ObjectId; name: string; scopes: string[]; models?: string[]; status: "active" | "revoked"; allowJevRouting?: boolean; }
export async function authenticateClient(request: Request, scope: string, model?: string) {
  const raw = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!raw || !raw.startsWith("sk-fr-")) return { error: "invalid_api_key" as const };
  const db = await getDb();
  const record = await db.collection<ClientKey & { tokenHash: string; expiresAt?: Date }>("client_keys").findOne({ tokenHash: hashClientKey(raw), status: "active" });
  if (!record || (record.expiresAt && record.expiresAt <= new Date())) return { error: "invalid_api_key" as const };
  if (!record.scopes.includes(scope)) return { error: "insufficient_scope" as const };
  if (model && record.models?.length && !record.models.includes(model) && !record.models.includes("*")) return { error: "model_forbidden" as const };
  await db.collection("client_keys").updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
  return { key: record };
}
