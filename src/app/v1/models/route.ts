import { availablePublicModels } from "@/lib/models/availability";
import { authenticateClient } from "@/lib/auth/client";
import { env } from "@/lib/env";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const type = new URL(request.url).searchParams.get("type");
  const auth = await authenticateClient(request, type === "decision" ? "decisions" : "chat");
  if ("error" in auth) return Response.json({ error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } }, { status: 401, headers: noStore });

  if (type === "decision") {
    if (!env.jevKey) return Response.json({ object: "list", data: [] }, { headers: noStore });
    try {
      const response = await fetch("https://api.typesafe.ai/v1/models", { headers: { authorization: `Bearer ${env.jevKey}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
      const result = await response.json() as any;
      return Response.json({ object: "list", data: (result.models || []).map((model: any) => ({ id: `jev/${model.name}`, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "jev", ...model })) }, { headers: noStore });
    } catch {
      return Response.json({ error: { message: "Jev unavailable", type: "server_error", code: "jev_unavailable" } }, { status: 503, headers: noStore });
    }
  }

  try {
    const models = await availablePublicModels();
    return Response.json({ object: "list", data: models.filter((model) => !auth.key.models || auth.key.models.includes("*") || auth.key.models.includes(model.id)) }, { headers: noStore });
  } catch {
    return Response.json({ error: { message: "Model availability is temporarily unavailable", type: "server_error", code: "model_registry_unavailable" } }, { status: 503, headers: noStore });
  }
}
