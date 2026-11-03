import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { providers } from "@/lib/env";

export type ProviderId = (typeof providers)[number]["id"];
export type ProviderCredential = { provider: ProviderId; label: string; slot: number; secret: string; fingerprint: string };
type StoredCredential = { v: number; nonce: string; tag: string; body: string };

const aad = (provider: string, slot: number) => `freerouter:provider-credential:${provider}:${slot}:v1`;
const fingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex");
const providerConfig = (provider: string) => providers.find((p) => p.id === provider);

export async function getProviderCredentials(provider?: ProviderId): Promise<ProviderCredential[]> {
  const db = await getDb();
  const query = provider ? { provider } : {};
  const rows = await db.collection<any>("provider_credentials").find(query).sort({ provider: 1, slot: 1 }).toArray();
  return rows.map((row) => {
    const config = providerConfig(row.provider);
    if (!config) return null;
    const secret = decryptJson<{ secret: string }>(row.encryptedSecret as StoredCredential, aad(row.provider, row.slot)).secret;
    return { provider: row.provider, label: row.label || config.label, slot: row.slot, secret, fingerprint: row.fingerprint } as ProviderCredential;
  }).filter((row): row is ProviderCredential => row !== null);
}

export async function getProviderCredentialSlots() {
  const db = await getDb();
  const rows = await db.collection<any>("provider_credentials").find({}, { projection: { provider: 1, slot: 1, label: 1, fingerprint: 1, createdAt: 1, updatedAt: 1, lastRetestAt: 1 } }).toArray();
  const healthRows = await db.collection<any>("credential_health").find({ fingerprint: { $in: rows.map((r) => r.fingerprint) } }).toArray();
  const health = new Map(healthRows.map((row) => [`${row.provider}:${row.fingerprint}`, row]));
  return providers.map((provider) => {
    const credentials = new Map(rows.filter((row) => row.provider === provider.id).map((row) => [row.slot, row]));
    const slots = Array.from({ length: provider.count }, (_, i) => {
      const slot = i + 1, row = credentials.get(slot), h = row && health.get(`${provider.id}:${row.fingerprint}`);
      return { slot, configured: Boolean(row), label: row?.label || null, health: row ? (h?.authStatus || "unknown") : "empty", paused: h?.paused === true, lastSuccessAt: h?.lastSuccessAt || null, lastRetestAt: h?.lastRetestAt || row?.lastRetestAt || null, fingerprint: row?.fingerprint ? `${row.fingerprint.slice(0, 10)}…` : null };
    });
    return { id: provider.id, label: provider.label, configured: slots.filter((s) => s.configured).length, slots };
  });
}

export async function saveProviderCredential(input: { provider: ProviderId; slot: number; secret: string; label?: string; probeStatus: number }) {
  const config = providerConfig(input.provider);
  if (!config || !Number.isInteger(input.slot) || input.slot < 1 || input.slot > config.count) throw new Error("invalid_provider_slot");
  const db = await getDb();
  const now = new Date();
  const fp = fingerprint(input.secret);
  const existing = await db.collection<any>("provider_credentials").findOne({ provider: input.provider, slot: input.slot });
  if (existing?.fingerprint && existing.fingerprint !== fp) {
    await Promise.all([
      db.collection("credential_health").deleteOne({ provider: input.provider, fingerprint: existing.fingerprint }),
      db.collection("model_bindings").deleteMany({ provider: input.provider, fingerprint: existing.fingerprint }),
    ]);
  }
  const encryptedSecret = encryptJson({ secret: input.secret }, aad(input.provider, input.slot));
  const authStatus = input.probeStatus >= 200 && input.probeStatus < 300 ? "healthy" : input.probeStatus === 401 ? "invalid" : input.probeStatus === 429 ? "rate_limited" : "unknown";
  await db.collection<any>("provider_credentials").updateOne({ provider: input.provider, slot: input.slot }, {
    $set: { provider: input.provider, slot: input.slot, label: input.label?.trim() || `${config.label} key ${input.slot}`, fingerprint: fp, encryptedSecret, updatedAt: now, probeStatus: input.probeStatus },
    $setOnInsert: { createdAt: now },
  }, { upsert: true });
  await db.collection<any>("credential_health").updateOne({ provider: input.provider, fingerprint: fp }, { $set: { authStatus, lastRetestAt: now, lastErrorStatus: input.probeStatus >= 400 ? input.probeStatus : null, updatedAt: now } }, { upsert: true });
  await db.collection("audit_events").insertOne({ action: existing ? "provider_credential_replaced" : "provider_credential_added", provider: input.provider, slot: input.slot, fingerprint: fp.slice(0, 10), createdAt: now });
  return { authStatus, fingerprint: fp.slice(0, 10) };
}

export async function removeProviderCredential(provider: ProviderId, slot: number) {
  const db = await getDb();
  const existing = await db.collection<any>("provider_credentials").findOne({ provider, slot });
  if (!existing) return false;
  await Promise.all([
    db.collection("provider_credentials").deleteOne({ provider, slot }),
    db.collection("credential_health").deleteOne({ provider, fingerprint: existing.fingerprint }),
    db.collection("model_bindings").deleteMany({ provider, fingerprint: existing.fingerprint }),
  ]);
  await db.collection("audit_events").insertOne({ action: "provider_credential_removed", provider, slot, fingerprint: String(existing.fingerprint).slice(0, 10), createdAt: new Date() });
  return true;
}

export async function probeProviderCredential(provider: ProviderId, secret: string) {
  const config = providerConfig(provider);
  if (!config) throw new Error("invalid_provider");
  const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/key" : provider === "google" ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1" : `${config.baseUrl}/models`;
  const headers: Record<string, string> = provider === "google" ? { "x-goog-api-key": secret } : { authorization: `Bearer ${secret}` };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000), cache: "no-store" });
  return { status: response.status, ok: response.ok };
}
