import { getDb } from "@/lib/db";
import { getProviderCredentials } from "@/lib/providers/credentials";
import { EMBEDDING_MODELS, publicEmbeddingModels } from "@/lib/models/embedding-catalog";

export async function availablePublicEmbeddingModels() {
  const credentials = await getProviderCredentials();
  if (!credentials.length) return [];
  const fingerprints = credentials.map((credential) => credential.fingerprint);
  const db = await getDb();
  const [health, bindings] = await Promise.all([
    db.collection<any>("credential_health").find({ fingerprint: { $in: fingerprints } }).toArray(),
    db.collection<any>("embedding_bindings").find({ fingerprint: { $in: fingerprints } }).toArray(),
  ]);
  const healthByCredential = new Map(health.map((row) => [`${row.provider}:${row.fingerprint}`, row]));
  const bindingByCredential = new Map(bindings.map((row) => [`${row.provider}:${row.model}:${row.fingerprint}`, row]));
  const now = Date.now();
  const isAvailable = (model: (typeof EMBEDDING_MODELS)[number]) => credentials.some((credential) => {
    if (credential.provider !== model.provider) return false;
    const credentialHealth = healthByCredential.get(`${model.provider}:${credential.fingerprint}`);
    const binding = bindingByCredential.get(`${model.provider}:${model.upstream}:${credential.fingerprint}`);
    if (credentialHealth?.paused || credentialHealth?.authStatus === "invalid") return false;
    if (credentialHealth?.cooldownUntil && new Date(credentialHealth.cooldownUntil).getTime() > now) return false;
    if (binding?.status === "unavailable") return false;
    if (binding?.cooldownUntil && new Date(binding.cooldownUntil).getTime() > now) return false;
    return true;
  });
  const available = new Set(EMBEDDING_MODELS.filter((model) => model.status === "ready" && isAvailable(model)).map((model) => model.id));
  return publicEmbeddingModels().filter((model) => available.has(model.id));
}
