import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  try { const docs = await (await getDb()).collection("requests").find({}, { projection: { content: 0, prompt: 0, completion: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(); return Response.json(docs.map(d => ({ ...d, _id: String(d._id) }))); } catch { return Response.json([]); }
}
