import nextEnv from '@next/env';
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';
import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

nextEnv.loadEnvConfig(process.cwd());
const base = (process.env.FREEROUTER_BASE_URL || '').replace(/\/$/, '');
const model = process.env.MISTRAL_SMOKE_MODEL;
const email = (process.env.FREEROUTER_ADMIN_EMAIL || process.env.SMTP_USER || '').trim().toLowerCase();
if (!base || !model || !model.startsWith('mistral/') || !email) throw new Error('Set FREEROUTER_BASE_URL, MISTRAL_SMOKE_MODEL and an admin email.');
let cookie, keyId, failures = 0;
const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}), origin: base } });
const record = (name, ok, detail = '') => { if (!ok) failures++; console.log(JSON.stringify({ name, status: ok ? 'passed' : 'failed', ...(detail ? { detail } : {}) })); };
async function check(name, run) { try { await run(); record(name, true); } catch (error) { record(name, false, `HTTP ${error?.status || 'unknown'}${error?.code ? `; code=${error.code}` : ''}`); } }
function assert(value) { if (!value) throw new Error('Unexpected response'); }
async function password() {
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
try {
  const requirements = await request('/api/auth/login');
  assert(requirements.ok);
  const { emailRequired } = await requirements.json();
  const code = await password();
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(emailRequired ? { email, password: code } : { password: code }) });
  assert(login.ok);
  cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie') || '']).map((value) => value.split(';')[0]).join('; ');
  const created = await request('/api/admin/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `mistral-smoke-${Date.now()}`, scopes: ['chat', 'responses'], models: [model] }) });
  assert(created.ok);
  const issued = await created.json(); keyId = issued.id;
  const api = new OpenAI({ apiKey: issued.key, baseURL: `${base}/v1`, maxRetries: 0, timeout: 90000 });
  await check('model discovery', async () => { const models = await api.models.list(); assert(models.data.some((item) => item.id === model)); });
  await check('streamed Chat', async () => { const stream = await api.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply FR_OK.' }], stream: true, max_completion_tokens: 96 }); let text = '', finish = false; for await (const event of stream) { text += event.choices?.[0]?.delta?.content || ''; finish ||= Boolean(event.choices?.[0]?.finish_reason); } assert(text.length > 0 && finish); });
  await check('Chat tool call and continuation', async () => {
    const messages = [{ role: 'user', content: 'Call echo with value hello.' }];
    const tools = [{ type: 'function', function: { name: 'echo', description: 'Echo a value', strict: true, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
    const first = await api.chat.completions.create({ model, messages, tools, tool_choice: 'required', parallel_tool_calls: false, max_completion_tokens: 128 });
    const call = first.choices?.[0]?.message?.tool_calls?.[0]; assert(call?.function?.name === 'echo'); assert(JSON.parse(call.function.arguments).value);
    const next = await api.chat.completions.create({ model, messages: [...messages, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'hello' }], tools, max_completion_tokens: 128 });
    assert(typeof next.choices?.[0]?.message?.content === 'string' && next.choices[0].message.content.length > 0);
  });
  await check('streamed tool call', async () => {
    const tools = [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
    const events = await api.chat.completions.create({ model, messages: [{ role: 'user', content: 'Call echo with value hello.' }], tools, tool_choice: 'required', stream: true, max_completion_tokens: 128 });
    let name = '', args = '', finish = false;
    for await (const event of events) { const choice = event.choices?.[0]; for (const call of choice?.delta?.tool_calls || []) { name += call.function?.name || ''; args += call.function?.arguments || ''; } finish ||= choice?.finish_reason === 'tool_calls'; }
    assert(name === 'echo' && JSON.parse(args).value && finish);
  });
  await check('strict JSON schema', async () => { const result = await api.chat.completions.create({ model, messages: [{ role: 'user', content: 'Return JSON with ok true.' }], response_format: { type: 'json_schema', json_schema: { name: 'check', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }, max_completion_tokens: 96 }); assert(JSON.parse(result.choices[0].message.content).ok === true); });
  await check('developer role', async () => { const result = await api.chat.completions.create({ model, messages: [{ role: 'developer', content: 'Answer briefly.' }, { role: 'user', content: 'Say hello.' }], max_completion_tokens: 96 }); assert(result.choices[0].message.content); });
  if (process.env.MISTRAL_SMOKE_IMAGE) await check('vision', async () => {
    const image = (await readFile(process.env.MISTRAL_SMOKE_IMAGE)).toString('base64');
    const result = await api.chat.completions.create({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Which shape is blue? Answer with one word.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }] }], max_completion_tokens: 64 });
    assert(/\bcircle\b/i.test(result.choices?.[0]?.message?.content || ''));
  });
  await check('Responses streaming', async () => { const events = await api.responses.create({ model, input: 'Say hello.', stream: true, store: false, max_output_tokens: 96 }); let completed = false, text = false; for await (const event of events) { completed ||= event.type === 'response.completed'; text ||= event.type === 'response.output_text.delta' && Boolean(event.delta); } assert(completed && text); });
  await check('stored Responses retrieve and delete', async () => {
    let responseId;
    try {
      const response = await api.responses.create({ model, input: 'Say hello.', store: true, max_output_tokens: 96 }); responseId = response.id;
      const stored = await api.responses.retrieve(responseId); assert(stored.id === responseId && stored.status === 'completed');
    } finally { if (responseId) await api.responses.delete(responseId); }
  });
} catch (error) { record('smoke setup', false, `HTTP ${error?.status || 'unknown'}${error?.code ? `; code=${error.code}` : ''}`); }
finally {
  if (keyId && cookie) {
    try {
      const revoke = await request(`/api/admin/keys/${keyId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) });
      const remove = await request(`/api/admin/keys/${keyId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) });
      record('temporary key revoked and deleted', revoke.ok && remove.ok);
    } catch { record('temporary key revoked and deleted', false); }
  }
}
if (failures) process.exitCode = 1;
