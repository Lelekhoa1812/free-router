import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { readJson, sameOrigin } from "@/lib/http";
import { env } from "@/lib/env";
import { getProviderCredentials, getProviderCredentialSlots, probeProviderCredential, removeProviderCredential, saveProviderCredential, type ProviderId } from "@/lib/providers/credentials";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  try { return Response.json(await getProviderCredentialSlots(), { headers: { "cache-control": "no-store" } }); }
  catch { return Response.json({ error: "provider_status_unavailable" }, { status: 503 }); }
}

export async function POST(request: Request) {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "cross_origin_request" }, { status: 403 });
  try {
    const value = await readJson(request) as Record<string, unknown>;
    const provider = env.providers.find((p) => p.id === value.provider);
    const slot = Number(value.slot);
    if (!provider || !Number.isInteger(slot) || slot < 1 || slot > provider.count) return Response.json({ error: "invalid_provider_slot" }, { status: 400 });
    const providerId = provider.id as ProviderId;
    const db = await getDb();

    if (value.action === "save") {
      const secret = typeof value.secret === "string" ? value.secret.trim() : "";
      const label = typeof value.label === "string" ? value.label.trim() : "";
      if (!secret || secret.length > 8192) return Response.json({ error: "invalid_secret" }, { status: 400 });
      if (label.length > 80) return Response.json({ error: "invalid_label" }, { status: 400 });
      const result = await probeProviderCredential(providerId, secret);
      const saved = await saveProviderCredential({ provider: providerId, slot, secret, label: label || undefined, probeStatus: result.status });
      return Response.json({ ok: true, health: saved.authStatus, probeStatus: result.status }, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (value.action === "remove") {
      const removed = await removeProviderCredential(providerId, slot);
      return Response.json({ ok: true, removed }, { headers: { "cache-control": "no-store" } });
    }

    const credential = (await getProviderCredentials(providerId)).find((item) => item.slot === slot);
    if (!credential) return Response.json({ error: "credential_not_found" }, { status: 404 });
    const query = { provider: providerId, fingerprint: credential.fingerprint };
    if (value.action === "pause" || value.action === "resume") {
      await db.collection("credential_health").updateOne(query, { $set: { paused: value.action === "pause", updatedAt: new Date() } }, { upsert: true });
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    if (value.action === "retest") {
      const result = await probeProviderCredential(providerId, credential.secret);
      const authStatus = result.ok ? "healthy" : result.status === 401 ? "invalid" : result.status === 429 ? "rate_limited" : "unknown";
      await db.collection<any>("credential_health").updateOne(query, { $set: { authStatus, lastRetestAt: new Date(), lastErrorStatus: result.ok ? null : result.status, updatedAt: new Date() } }, { upsert: true });
      return Response.json({ ok: result.ok, status: authStatus, probeStatus: result.status }, { status: result.ok ? 200 : 502, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "invalid_action" }, { status: 400 });
  } catch {
    return Response.json({ error: "provider_operation_failed" }, { status: 400 });
  }
}
