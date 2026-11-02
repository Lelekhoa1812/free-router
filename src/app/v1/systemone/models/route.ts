import { authenticateClient } from "@/lib/auth/client";
import { env } from "@/lib/env";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const auth = await authenticateClient(request, "decisions");
  if ("error" in auth) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  if (!env.jevKey) return Response.json({ error: "jev_not_configured" }, { status: 503, headers: noStore });
  try {
    const response = await fetch("https://api.typesafe.ai/v1/models", { headers: { authorization: `Bearer ${env.jevKey}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json", ...noStore } });
  } catch {
    return Response.json({ error: "jev_unavailable" }, { status: 503, headers: noStore });
  }
}
