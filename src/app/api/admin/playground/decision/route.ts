import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { decisionToSystemOne, callSystemOne, systemOneToDecision } from "@/lib/jev";
import { env } from "@/lib/env";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
import { useDailyBudget } from "@/lib/redis";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  if (!env.jevKey) return Response.json({ data: [] }, { headers: { "cache-control": "no-store" } });
  try {
    const response = await fetch("https://api.typesafe.ai/v1/models", { headers: { authorization: `Bearer ${env.jevKey}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return jsonError(503, "Jev model discovery is unavailable", "jev_unavailable");
    const value = await response.json() as any;
    return Response.json({ data: (value.models || []).map((model: any) => ({ id: `jev/${model.name}`, name: model.name, ...model })) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return jsonError(503, "Jev model discovery is unavailable", "jev_unavailable");
  }
}

export async function POST(request: Request) {
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  let input: any;
  try { input = await readJson(request); }
  catch (error) { const message = error instanceof Error ? error.message : "invalid_json"; return jsonError(message === "body_too_large" ? 413 : message === "unsupported_content_type" || message === "unsupported_encoding" ? 415 : 400, message, "invalid_request"); }
  const protocol = input?.protocol;
  if (protocol !== "decisions" && protocol !== "systemone") return jsonError(400, "protocol must be decisions or systemone", "invalid_request");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) return jsonError(400, "body must be a JSON object", "invalid_request");
  if (input.body.stream === true) return jsonError(400, "Jev does not support streaming", "unsupported_parameter");
  if (!env.jevKey) return jsonError(503, "Jev is not configured", "jev_unavailable");

  let wire: any;
  let maps: Record<string, any> | undefined;
  let model: string | undefined;
  try {
    if (protocol === "decisions") ({ wire, maps, model } = decisionToSystemOne(input.body));
    else {
      wire = input.body;
      if (typeof wire.model !== "string" || !["jev-latest", "jev-preview"].includes(wire.model.replace(/^jev\//, "")) || !("state" in wire) || !wire.questions || typeof wire.questions !== "object" || Array.isArray(wire.questions)) throw new Error("Native request requires a supported model, state, and named questions.");
      wire.model = wire.model.replace(/^jev\//, "");
    }
  } catch (error) { return jsonError(400, error instanceof Error ? error.message : "Invalid Jev request", "invalid_request"); }

  const actor = "admin-playground";
  try {
    if (!await useDailyBudget(`jev-total:${actor}`, 100)) return jsonError(429, "Gateway Jev daily request allowance reached", "rate_limit_exceeded");
    const upstream = await callSystemOne(wire, undefined, 90_000, request.signal);
    const raw = await upstream.text();
    if (!upstream.ok) return new Response(raw, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const parsed = JSON.parse(raw);
    const result = protocol === "decisions" ? systemOneToDecision(parsed, maps!, model!) : parsed;
    void getDb().then((db) => db.collection("requests").insertOne({ requestId: `playground_jev_${Date.now()}`, requestedModel: input.body.model, model: parsed.model, provider: "jev", protocol, status: "completed", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000), usage: parsed.usage })).catch(() => undefined);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return jsonError(503, "Jev is unavailable", "jev_unavailable");
  }
}
