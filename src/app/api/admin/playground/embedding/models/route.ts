import { getAdminSession } from "@/lib/auth/admin";
import { availablePublicEmbeddingModels } from "@/lib/models/embedding-availability";
import { EMBEDDING_MODEL_BY_ID } from "@/lib/models/embedding-catalog";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: { message: "Unauthorized", code: "unauthorized" } }, { status: 401 });
  try {
    const models = await availablePublicEmbeddingModels();
    return Response.json({ data: models.map((model) => ({ ...model, name: EMBEDDING_MODEL_BY_ID.get(model.id)?.label || model.id })) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: { message: "Embedding models are unavailable", code: "model_registry_unavailable" } }, { status: 503 });
  }
}
