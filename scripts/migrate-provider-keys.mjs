import nextEnv from "@next/env";
import { MongoClient } from "mongodb";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

nextEnv.loadEnvConfig(process.cwd());

const providerList = [
  { id: "openrouter", prefix: "OPEN_ROUTER_API_KEY_", label: "OpenRouter", url: "https://openrouter.ai/api/v1/key", header: "authorization", base: "Bearer " },
  { id: "google", prefix: "GEMINI_API_KEY_", label: "Google AI Studio", url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", header: "x-goog-api-key", base: "" },
  { id: "nvidia", prefix: "NVIDIA_NIM_API_KEY_", label: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1/models", header: "authorization", base: "Bearer " },
  { id: "matilda", prefix: "MATILDA_API_KEY_", label: "Matilda (Maincode)", url: "https://matilda.maincode.com/api/v1/models", header: "authorization", base: "Bearer " },
  { id: "mistral", prefix: "MISTRAL_API_KEY_", label: "Mistral AI", url: "https://api.mistral.ai/v1/models", header: "authorization", base: "Bearer " },
];
const selectedProvider = process.env.MIGRATE_PROVIDER;
if (selectedProvider && !providerList.some((provider) => provider.id === selectedProvider)) throw new Error("Unknown MIGRATE_PROVIDER.");
const selectedProviders = selectedProvider ? providerList.filter((provider) => provider.id === selectedProvider) : providerList;
const encryptionSecret = process.env.STATE_ENCRYPTION_KEY;
if (!process.env.MONGO_DB_CONNECTION_STRING || !encryptionSecret || Buffer.byteLength(encryptionSecret) < 32) throw new Error("MongoDB and a 32-byte STATE_ENCRYPTION_KEY are required.");

function encrypt(secret, provider, slot) {
  const key = createHash("sha256").update(encryptionSecret).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`freerouter:provider-credential:${provider}:${slot}:v1`));
  const compressed = gzipSync(Buffer.from(JSON.stringify({ secret })));
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return { v: 2, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), body: body.toString("base64url") };
}

const client = new MongoClient(process.env.MONGO_DB_CONNECTION_STRING, { maxPoolSize: 1, serverSelectionTimeoutMS: 8000, appName: "FreeRouter provider key migration" });
await client.connect();
try {
  const db = client.db(process.env.MONGODB_DB || "freerouter");
  await db.collection("provider_credentials").createIndex({ provider: 1, slot: 1 }, { unique: true, name: "provider_credential_slot" });
  let healthy = 0, invalid = 0, removed = 0, skipped = 0, conflicts = 0;
  for (const provider of selectedProviders) {
    for (let slot = 1; slot <= 9; slot++) {
      const secret = process.env[`${provider.prefix}${slot}`]?.trim();
      if (!secret) { skipped++; continue; }
      const keyFingerprint = createHash("sha256").update(secret).digest("hex");
      const existing = await db.collection("provider_credentials").findOne({ provider: provider.id, slot });
      if (existing && existing.fingerprint !== keyFingerprint) { conflicts++; continue; }
      let status;
      try {
        const response = await fetch(provider.url, { headers: { [provider.header]: `${provider.base}${secret}` }, signal: AbortSignal.timeout(12000), cache: "no-store" });
        status = response.status;
        await response.body?.cancel();
      } catch { skipped++; continue; }
      const now = new Date();
      if (status >= 200 && status < 300) {
        try {
          await db.collection("provider_credentials").updateOne({ provider: provider.id, slot, fingerprint: keyFingerprint }, { $set: { provider: provider.id, slot, label: `${provider.label} key ${slot}`, fingerprint: keyFingerprint, encryptedSecret: encrypt(secret, provider.id, slot), updatedAt: now, probeStatus: status }, $setOnInsert: { createdAt: now } }, { upsert: true });
        } catch (error) {
          if (error?.code === 11000) { conflicts++; continue; }
          throw error;
        }
        await db.collection("credential_health").updateOne({ provider: provider.id, fingerprint: keyFingerprint }, { $set: { authStatus: "healthy", lastRetestAt: now, lastErrorStatus: null, updatedAt: now } }, { upsert: true });
        healthy++;
      } else if (status === 401) {
        // Seeding Mistral must not remove an existing registered credential.
        if (provider.id === "mistral") { invalid++; continue; }
        if (existing?.fingerprint === keyFingerprint) {
          const result = await db.collection("provider_credentials").deleteOne({ provider: provider.id, slot, fingerprint: keyFingerprint });
          removed += result.deletedCount;
        }
        await Promise.all([
          ...(existing?.fingerprint === keyFingerprint ? [db.collection("credential_health").deleteOne({ provider: provider.id, fingerprint: keyFingerprint }), db.collection("model_bindings").deleteMany({ provider: provider.id, fingerprint: keyFingerprint })] : []),
          db.collection("credential_health").deleteOne({ provider: provider.id, fingerprint: keyFingerprint }),
          db.collection("model_bindings").deleteMany({ provider: provider.id, fingerprint: keyFingerprint }),
        ]);
        invalid++;
      } else skipped++;
    }
  }
  console.log(JSON.stringify({ migratedHealthy: healthy, invalid, removedInvalid: removed, skipped, conflicts, providers: selectedProviders.map((p) => p.id) }));
} finally { await client.close(); }
