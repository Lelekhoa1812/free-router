import { getAdminSession } from "@/lib/auth/admin";
import { getConfigurationStatus } from "@/lib/env";
import { getDb } from "@/lib/db";
import { MODEL_CATALOG } from "@/lib/models/catalog";
export const runtime = "nodejs";
export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  try { const db = await getDb(); const [keys, requests, recent] = await Promise.all([
    db.collection("client_keys").countDocuments({ status: "active" }),
    db.collection("requests").countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    db.collection("requests").find({}, { projection: { requestId: 1, model: 1, provider: 1, status: 1, createdAt: 1, durationMs: 1 } }).sort({ createdAt: -1 }).limit(12).toArray(),
  ]); return Response.json({ configuration: getConfigurationStatus(), keys, requests24h: requests, models: MODEL_CATALOG.filter(m => m.status === "ready").length, recent: recent.map(r => ({ ...r, _id: String(r._id) })) }); }
  catch { return Response.json({ configuration: getConfigurationStatus(), keys: 0, requests24h: 0, models: MODEL_CATALOG.filter(m => m.status === "ready").length, recent: [], database: "unavailable" }); }
}
