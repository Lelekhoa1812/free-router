import { getProviderCredentials } from '@/lib/env';
import { getDb } from '@/lib/db';
import { ALIASES, MODEL_CATALOG, publicModels, type ModelProfile } from '@/lib/models/catalog';
import { isModelCoolingDown } from '@/lib/models/overload-breaker';

export async function availablePublicModels() {
  const credentials = getProviderCredentials();
  const fingerprints = credentials.map((c) => c.fingerprint);
  if (!fingerprints.length) return [];
  const db = await getDb();
  const nowDate = new Date();
  const [health, bindings, overloaded] = await Promise.all([
    db.collection<any>('credential_health').find({ fingerprint: { $in: fingerprints } }).toArray(),
    db.collection<any>('model_bindings').find({ fingerprint: { $in: fingerprints } }).toArray(),
    db.collection<any>('model_overload_breakers').find({ cooldownUntil: { $gt: nowDate } }, { projection: { provider: 1, model: 1, cooldownUntil: 1 } }).toArray(),
  ]);
  const healthByCredential = new Map(health.map((r) => [`${r.provider}:${r.fingerprint}`, r]));
  const bindingByCredential = new Map(bindings.map((r) => [`${r.provider}:${r.model}:${r.fingerprint}`, r]));
  const overloadByModel = new Map(overloaded.map((r) => [`${r.provider}:${r.model}`, r]));
  const now = Date.now();
  const available = (profile: ModelProfile) => {
    if (isModelCoolingDown(overloadByModel.get(`${profile.provider}:${profile.upstream}`), new Date(now))) return false;
    return credentials.filter((c) => c.provider === profile.provider).some((c) => {
    const h = healthByCredential.get(`${profile.provider}:${c.fingerprint}`);
    const b = bindingByCredential.get(`${profile.provider}:${profile.upstream}:${c.fingerprint}`);
    if (h?.paused || h?.authStatus === 'invalid' || (h?.cooldownUntil && new Date(h.cooldownUntil).getTime() > now)) return false;
    if (b?.status === 'unavailable' || (b?.cooldownUntil && new Date(b.cooldownUntil).getTime() > now)) return false;
    return true;
    });
  };
  const availableIds = new Set(MODEL_CATALOG.filter((m) => m.status === 'ready' && m.text === 'passed' && available(m)).map((m) => m.id));
  const hasAliasCandidate = (name: string) => (ALIASES[name] || []).some((id) => availableIds.has(id));
  const aliases = new Set(Object.keys(ALIASES).filter(hasAliasCandidate));
  if ([...availableIds].length) aliases.add('fr-auto');
  return publicModels().filter((m) => m.owned_by === 'freerouter' ? aliases.has(m.id) : availableIds.has(m.id));
}
