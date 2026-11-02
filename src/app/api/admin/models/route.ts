import { getAdminSession } from "@/lib/auth/admin";
import { MODEL_CATALOG } from "@/lib/models/catalog";
export async function GET() { if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 }); return Response.json(MODEL_CATALOG); }
