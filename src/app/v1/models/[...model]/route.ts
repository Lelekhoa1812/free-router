import { availablePublicModels } from "@/lib/models/availability";
import { authenticateClient } from "@/lib/auth/client";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request, ctx: { params: Promise<{ model: string[] }> }) {
  const auth = await authenticateClient(request, "chat");
  if ("error" in auth) return Response.json({ error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } }, { status: 401, headers: noStore });
  const { model } = await ctx.params;
  const id = model.join("/");
  try {
    const found = (await availablePublicModels()).find((entry) => entry.id === id);
    return found ? Response.json(found, { headers: noStore }) : Response.json({ error: { message: "Model not found", type: "invalid_request_error", code: "model_not_found" } }, { status: 404, headers: noStore });
  } catch {
    return Response.json({ error: { message: "Model availability is temporarily unavailable", type: "server_error", code: "model_registry_unavailable" } }, { status: 503, headers: noStore });
  }
}
