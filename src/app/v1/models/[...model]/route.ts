import { availablePublicModels } from "@/lib/models/availability";
import { authenticateClient } from "@/lib/auth/client";
import { jsonError } from "@/lib/http";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request, ctx: { params: Promise<{ model: string[] }> }) {
  const { model } = await ctx.params;
  const id = model.join("/");
  const auth = await authenticateClient(request, "chat", id);
  if ("error" in auth) return jsonError(auth.error === "invalid_api_key" ? 401 : 403, auth.error === "invalid_api_key" ? "Invalid API key" : "API key cannot access this request", String(auth.error));
  try {
    const found = (await availablePublicModels()).find((entry) => entry.id === id);
    return found ? Response.json(found, { headers: noStore }) : Response.json({ error: { message: "Model not found", type: "invalid_request_error", code: "model_not_found" } }, { status: 404, headers: noStore });
  } catch {
    return Response.json({ error: { message: "Model availability is temporarily unavailable", type: "server_error", code: "model_registry_unavailable" } }, { status: 503, headers: noStore });
  }
}
