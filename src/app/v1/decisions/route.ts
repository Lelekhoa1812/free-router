import { authenticateClient } from "@/lib/auth/client";
import { env } from "@/lib/env";
import { callSystemOne, decisionToSystemOne, mapUpstreamError, systemOneToDecision } from "@/lib/jev";
import { readJson, jsonError } from "@/lib/http";
import { useDailyBudget } from "@/lib/redis";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateClient(request, "decisions");
  if ("error" in auth) return jsonError(401, "Invalid API key", "invalid_api_key");

  let body: any;
  try {
    body = await readJson(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return jsonError(
      message === "body_too_large" ? 413 : message === "unsupported_content_type" || message === "unsupported_encoding" ? 415 : 400,
      message,
      "invalid_request",
    );
  }

  const containsImage = (value: any): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsImage);
    if (value.type === "input_image" || value.type === "image_url" || value.type === "image") return true;
    return Object.values(value).some(containsImage);
  };
  const imageInstruction = Array.isArray(body?.questions)
    ? body.questions.some(
        (question: any) => Array.isArray(question?.instructions) && question.instructions.some((part: any) => part?.type === "input_image"),
      )
    : false;
  if (containsImage(body?.input) || imageInstruction) {
    return jsonError(400, "Image decision evidence is not enabled", "unsupported_parameter");
  }

  if (body?.stream === true) return jsonError(400, "The Decisions API does not support streaming", "unsupported_parameter");

  let wire: unknown;
  let maps: Record<string, any>;
  let model: string;
  try {
    ({ wire, maps, model } = decisionToSystemOne(body));
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : "Invalid Decisions request", "invalid_request");
  }

  if (!(await useDailyBudget(`jev-total:${auth.key._id}`, 100))) {
    return jsonError(429, "Gateway Jev daily request allowance reached", "rate_limit_exceeded");
  }

  let raw: string;
  try {
    const upstream = await callSystemOne(wire);
    raw = await upstream.text();
    if (!upstream.ok) {
      let payload: any = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      const mapped = mapUpstreamError(upstream.status, payload);
      return Response.json(mapped.body, { status: mapped.status, headers: { "cache-control": "no-store" } });
    }
  } catch {
    return jsonError(503, env.jevKey ? "Jev is unavailable" : "Jev is not configured", "jev_unavailable");
  }

  try {
    return Response.json(systemOneToDecision(JSON.parse(raw), maps, model), { headers: { "cache-control": "no-store" } });
  } catch {
    return jsonError(502, "Jev returned an invalid response", "upstream_invalid_response");
  }
}
