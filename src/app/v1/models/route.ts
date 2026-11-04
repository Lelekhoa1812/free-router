import { availablePublicModels } from "@/lib/models/availability";
import { authenticateClient } from "@/lib/auth/client";
import { env } from "@/lib/env";
import { availablePublicEmbeddingModels } from "@/lib/models/embedding-availability";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const type = new URL(request.url).searchParams.get("type");
  const scope = type === "decision" ? "decisions" : type === "embedding" ? "embeddings" : ["chat", "responses", "embeddings"];
  const auth = await authenticateClient(request, scope);
  if ("error" in auth) {
    const status = auth.error === "invalid_api_key" ? 401 : 403;
    return Response.json({ error: { message: status === 401 ? "Invalid API key" : "API key cannot access this request", type: status === 401 ? "authentication_error" : "invalid_request_error", code: auth.error || "insufficient_scope" } }, { status, headers: noStore });
  }

  if (type === "decision") {
    if (!env.jevKey) return Response.json({ object: "list", data: [] }, { headers: noStore });
    try {
      const response = await fetch("https://api.typesafe.ai/v1/models", { headers: { authorization: `Bearer ${env.jevKey}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
      const result = await response.json() as any;
      const data = (result.models || []).map((model: any) => ({ id: `jev/${model.name}`, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "jev", ...model }));
      return Response.json({ object: "list", data: data.filter((model: { id: string }) => !auth.key.models || auth.key.models.includes("*") || auth.key.models.includes(model.id)) }, { headers: noStore });
    } catch {
      return Response.json({ error: { message: "Jev unavailable", type: "server_error", code: "jev_unavailable" } }, { status: 503, headers: noStore });
    }
  }

  if (type === "embedding") {
    try {
      const models = await availablePublicEmbeddingModels();
      return Response.json({ object: "list", data: models.filter((model) => !auth.key.models || auth.key.models.includes("*") || auth.key.models.includes(model.id)) }, { headers: noStore });
    } catch {
      return Response.json({ error: { message: "Embedding model availability is temporarily unavailable", type: "server_error", code: "model_registry_unavailable" } }, { status: 503, headers: noStore });
    }
  }

  try {
    const [models, embeddings] = await Promise.all([
      auth.key.scopes.some((scope) => scope === "chat" || scope === "responses") ? availablePublicModels() : Promise.resolve([]),
      auth.key.scopes.includes("embeddings") ? availablePublicEmbeddingModels() : Promise.resolve([]),
    ]);
    const allowed = (model: { id: string }) => !auth.key.models || auth.key.models.includes("*") || auth.key.models.includes(model.id);
    return Response.json({ object: "list", data: [...models, ...embeddings].filter(allowed) }, { headers: noStore });
  } catch {
    return Response.json({ error: { message: "Model availability is temporarily unavailable", type: "server_error", code: "model_registry_unavailable" } }, { status: 503, headers: noStore });
  }
}
