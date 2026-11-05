// Shared plumbing for the gateway smoke scripts: result reporting, admin login
// and a temporary client key that is always revoked and deleted afterwards.
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';
import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function createReporter() {
  let failures = 0;
  const record = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(JSON.stringify({ name, status: ok ? 'passed' : 'failed', ...(detail ? { detail } : {}) }));
  };
  const check = async (name, run) => {
    try { await run(); record(name, true); } catch (error) { record(name, false, describeError(error)); }
  };
  return { record, check, get failures() { return failures; } };
}

// HTTP errors carry a status; failed assertions and network errors do not, so
// keep their message instead of collapsing everything into "HTTP unknown".
export function describeError(error) {
  if (error?.status) return `HTTP ${error.status}${error?.code ? `; code=${error.code}` : ''}`;
  return String(error?.message || error || 'unknown error').slice(0, 200);
}

export function assert(value, message = 'Unexpected response') {
  if (!value) throw new Error(message);
}

async function accessPassword() {
  if (/^\d{6}$/.test(process.env.FREEROUTER_ADMIN_PASSWORD || '')) return process.env.FREEROUTER_ADMIN_PASSWORD;
  const dbClient = new MongoClient(process.env.MONGO_DB_CONNECTION_STRING, { maxPoolSize: 1, serverSelectionTimeoutMS: 4000 });
  try {
    const auth = await dbClient.db(process.env.MONGODB_DB || 'freerouter').collection('admin_auth').findOne({ _id: 'current' });
    const stored = auth?.password;
    if (!stored || ![1, 2].includes(stored.v)) throw new Error('No stored access password');
    const key = createHash('sha256').update(Buffer.from(process.env.STATE_ENCRYPTION_KEY)).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.nonce, 'base64url'));
    decipher.setAAD(Buffer.from('freerouter:admin-access-password:v1'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64url'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(stored.body, 'base64url')), decipher.final()]);
    const code = JSON.parse((stored.v === 2 ? gunzipSync(decrypted, { maxOutputLength: 8 * 1024 * 1024 }) : decrypted).toString()).code;
    if (!/^\d{6}$/.test(code)) throw new Error('Invalid stored access password');
    return code;
  } finally { await dbClient.close(); }
}

// Signs in to the dashboard, issues a key limited to `models`, and returns an
// OpenAI client for it. Always call `close()`; it revokes and deletes the key.
export async function openGatewaySession({ base, email, name, models, scopes = ['chat', 'responses'], reporter }) {
  let cookie, keyId;
  const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}), origin: base } });
  const close = async () => {
    if (!keyId || !cookie) return;
    try {
      const patch = (action) => request(`/api/admin/keys/${keyId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const revoke = await patch('revoke');
      const remove = await patch('delete');
      reporter.record('temporary key revoked and deleted', revoke.ok && remove.ok);
    } catch { reporter.record('temporary key revoked and deleted', false); }
  };
  const requirements = await request('/api/auth/login');
  assert(requirements.ok, 'Login requirements unavailable');
  const { emailRequired } = await requirements.json();
  const code = await accessPassword();
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(emailRequired ? { email, password: code } : { password: code }) });
  assert(login.ok, 'Dashboard login failed');
  cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie') || '']).map((value) => value.split(';')[0]).join('; ');
  const created = await request('/api/admin/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `${name}-${Date.now()}`, scopes, models }) });
  assert(created.ok, 'Temporary key creation failed');
  const issued = await created.json();
  keyId = issued.id;
  const api = new OpenAI({ apiKey: issued.key, baseURL: `${base}/v1`, maxRetries: 0, timeout: 90000 });
  return { api, close };
}
