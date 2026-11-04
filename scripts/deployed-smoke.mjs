import nextEnv from '@next/env';
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';
import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const base = (process.env.FREEROUTER_BASE_URL || '').replace(/\/$/, '');
const adminEmail = (process.env.FREEROUTER_ADMIN_EMAIL || process.env.SMTP_USER || '').trim().toLowerCase();
if (!base || !adminEmail) throw new Error('Set FREEROUTER_BASE_URL and SMTP_USER (or FREEROUTER_ADMIN_EMAIL) in the local environment.');
const origin = base;
const results = [];
let clientKeyId;
let apiKey;
let cookie;
let providerSmokeSlot;
const record = (name, status, detail) => { const item = { name, status, ...(detail ? { detail } : {}) }; results.push(item); console.log(JSON.stringify(item)); };
const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}), origin } });
async function readCurrentAccessState() {
  if (/^\d{6}$/.test(process.env.FREEROUTER_ADMIN_PASSWORD || '')) return { code: process.env.FREEROUTER_ADMIN_PASSWORD, lastSentAt: null };
  const uri = process.env.MONGO_DB_CONNECTION_STRING;
  const encryptionSecret = process.env.STATE_ENCRYPTION_KEY;
  if (!uri || !encryptionSecret || Buffer.byteLength(encryptionSecret) < 32) throw new Error('Set FREEROUTER_ADMIN_PASSWORD or provide the configured MongoDB and state-encryption variables locally.');
  const client = new MongoClient(uri, { maxPoolSize: 1, serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000, appName: 'FreeRouter deployment smoke' });
  try {
    const db = client.db(process.env.MONGODB_DB || 'freerouter');
    const auth = await db.collection('admin_auth').findOne({ _id: 'current' });
    const encrypted = auth?.password;
    if (!encrypted || ![1, 2].includes(encrypted.v)) throw new Error('No current email access password is available for deployment smoke.');
    const key = createHash('sha256').update(Buffer.from(encryptionSecret)).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.nonce, 'base64url'));
    decipher.setAAD(Buffer.from('freerouter:admin-access-password:v1'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.body, 'base64url')), decipher.final()]);
    const raw = encrypted.v === 2 ? gunzipSync(decrypted, { maxOutputLength: 8 * 1024 * 1024 }) : decrypted;
    const code = JSON.parse(raw.toString('utf8')).code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Stored access password has an invalid format.');
    return { code, lastSentAt: auth.lastSentAt ? new Date(auth.lastSentAt) : null };
  } finally { await client.close(); }
}
try {
  if (process.env.SMOKE_REQUEST_CODE === 'true') {
    let previousSentAt = null;
    try { previousSentAt = (await readCurrentAccessState()).lastSentAt; } catch { /* first password may be bootstrapped by the request */ }
    const mailed = await fetch(`${base}/api/auth/request-code`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: adminEmail }) });
    if (!mailed.ok) throw new Error(`Email sign-in request failed (${mailed.status}).`);
    const sentState = await readCurrentAccessState();
    const delivered = Boolean(sentState.lastSentAt && (!previousSentAt || sentState.lastSentAt.getTime() > previousSentAt.getTime()));
    record('Email sign-in delivery', delivered ? 'passed' : 'failed', `HTTP ${mailed.status}; authorized mailbox delivery ${delivered ? 'recorded' : 'not recorded'}`);
    if (!delivered) throw new Error('SMTP delivery was not recorded; check the production mail configuration without exposing the password.');
  }
  const password = (await readCurrentAccessState()).code;
  const loginRequirementsResponse = await request('/api/auth/login');
  if (!loginRequirementsResponse.ok) throw new Error(`Could not read sign-in requirements (${loginRequirementsResponse.status}).`);
  const loginRequirements = await loginRequirementsResponse.json();
  const loginBody = loginRequirements.emailRequired ? { email: adminEmail, password } : { password };
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loginBody) });
  if (!login.ok) throw new Error(`Admin login failed (${login.status}); verify that the configured smoke email is authorized and the local MongoDB credentials match this deployment.`);
  cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie') || '']).map((x) => x.split(';')[0]).join('; ');
  const create = await request('/api/admin/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `deployed-smoke-${Date.now()}`, description: 'Temporary automated deployment verification', scopes: ['chat', 'responses', 'decisions', 'embeddings'], models: ['*'] }) });
  if (!create.ok) throw new Error(`Temporary client-key creation failed (${create.status}).`);
  const issued = await create.json(); clientKeyId = issued.id; apiKey = issued.key;
  const api = new OpenAI({ apiKey, baseURL: `${base}/v1`, maxRetries: 0, timeout: 300000 });

  const [live, ready, adminProviders, modelList] = await Promise.all([
    fetch(`${base}/api/health/live`), fetch(`${base}/api/health/ready`), request('/api/admin/providers'), api.models.list(),
  ]);
  record('health/live', live.ok ? 'passed' : 'failed', `HTTP ${live.status}`);
  record('health/ready', ready.ok ? 'passed' : 'failed', `HTTP ${ready.status}`);
  record('admin/provider health', adminProviders.ok ? 'passed' : 'failed', `HTTP ${adminProviders.status}`);
  if (adminProviders.ok) {
    const inventory = await adminProviders.json();
    const summary = inventory.map((provider) => `${provider.id}:${provider.configured}/${provider.slots.length}`).join(', ');
    const secret = process.env.OPEN_ROUTER_API_KEY_1?.trim();
    const slot = inventory.find((provider) => provider.id === 'openrouter')?.slots.find((item) => item.slot === 9);
    if (secret && slot && !slot.configured) {
      try {
        const saved = await request('/api/admin/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openrouter', slot: 9, label: 'Temporary deployment smoke', secret, action: 'save' }) });
        const savedBody = await saved.text();
        if (!saved.ok || savedBody.includes(secret)) throw new Error(`save returned HTTP ${saved.status} or echoed secret material`);
        providerSmokeSlot = { provider: 'openrouter', slot: 9 };
        const remove = await request('/api/admin/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...providerSmokeSlot, action: 'remove' }) });
        if (!remove.ok) throw new Error(`remove returned HTTP ${remove.status}`);
        providerSmokeSlot = null;
        record('Provider-key add/remove and secret redaction', 'passed', 'Temporary slot verified, then removed');
      } catch (error) {
        record('Provider-key add/remove and secret redaction', 'failed', error?.message || 'credential management failed');
      }
    } else record('Provider-key add/remove and secret redaction', 'skipped', secret ? `OpenRouter slot 9 is occupied; inventory ${summary}` : 'No local OpenRouter test key is configured.');
    record('MongoDB provider slot inventory', 'passed', summary);
  }
  record('OpenAI SDK models.list', modelList.data.length ? 'passed' : 'failed', `${modelList.data.length} visible models`);

  try {
    const discovery = await fetch(`${base}/v1/models?type=embedding`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await discovery.json();
    if (!discovery.ok) throw new Error(`HTTP ${discovery.status}`);
    const embeddingModels = body.data || [];
    record('OpenAI-compatible embedding discovery', embeddingModels.length ? 'passed' : 'failed', `${embeddingModels.length} allowed models`);
    const chosen = process.env.SMOKE_EMBEDDING_IDS?.split(',').map((value) => value.trim()).filter(Boolean);
    const modelsToTest = chosen?.length ? embeddingModels.filter((model) => chosen.includes(model.id)) : embeddingModels;
    if (chosen?.some((id) => !embeddingModels.some((model) => model.id === id))) throw new Error('An explicitly selected embedding model was not discoverable');
    for (const model of modelsToTest) {
      const started = Date.now();
      try {
        const result = await api.embeddings.create({
          model: model.id,
          input: ['FreeRouter embedding endpoint smoke test.'],
          ...(model.input_type_required ? { input_type: 'query' } : {}),
        }, { maxRetries: 0, timeout: 280000 });
        const vector = result.data?.[0]?.embedding;
        const dimensions = Array.isArray(vector) ? vector.length : 0;
        record(`OpenAI SDK embeddings ${model.id}`, dimensions > 0 && result.data?.[0]?.index === 0 ? 'passed' : 'failed', `${Date.now() - started} ms; dimensions=${dimensions}; usage=${result.usage?.total_tokens ?? 'not reported'}`);
      } catch (error) {
        record(`OpenAI SDK embeddings ${model.id}`, 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`);
      }
    }
  } catch (error) { record('OpenAI-compatible embedding discovery', 'failed', error?.message || 'discovery failed'); }

  try {
    const modelsResponse = await request('/api/admin/playground/embedding/models');
    const listed = await modelsResponse.json();
    if (!modelsResponse.ok || !(listed.data || []).length) throw new Error(`HTTP ${modelsResponse.status}; no model available`);
    const model = listed.data[0];
    const response = await request('/api/admin/playground/embedding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id, input: 'Admin Playground embedding smoke test.', ...(model.input_type_required ? { input_type: 'query' } : {}) }) });
    const result = await response.json();
    const dimensions = result.data?.[0]?.embedding?.length || 0;
    record('Admin Playground embedding proxy', response.ok && dimensions > 0 ? 'passed' : 'failed', `HTTP ${response.status}; model=${model.id}; dimensions=${dimensions}`);
  } catch (error) { record('Admin Playground embedding proxy', 'failed', error?.message || 'request failed'); }

  try {
    const response = await request('/api/admin/playground/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'decisions', model: 'jev/jev-latest', body: { model: 'jev/jev-latest', input: 'A smoke test request for the admin playground.', questions: [{ type: 'predicate', name: 'valid', instructions: 'Is this a valid smoke test?' }] } }) });
    const result = await response.json();
    record('Admin Playground Decisions proxy', response.ok && Array.isArray(result.answers) ? 'passed' : 'failed', `HTTP ${response.status}; answers=${result.answers?.length ?? 0}`);
  } catch (error) { record('Admin Playground Decisions proxy', 'failed', error?.message || 'request failed'); }

  const exactModels = modelList.data.filter((m) => ['google', 'nvidia', 'openrouter', 'matilda'].includes(m.owned_by) && m.id.includes('/'));
  const selectedModels = process.env.SMOKE_MODEL_IDS?.split(',').map((value) => value.trim()).filter(Boolean);
  const matildaSmoke = process.env.SMOKE_MATILDA === 'true';
  const routes = matildaSmoke ? ['matilda/matilda'] : process.env.SMOKE_MODELS === 'false' ? ['fr-code', 'fr-auto'] : selectedModels?.length ? [...new Set(['fr-code', 'fr-auto', ...selectedModels])] : [...new Set(['fr-code', 'fr-auto', ...exactModels.map((m) => m.id)])];
  const chatModel = matildaSmoke ? 'matilda/matilda' : 'fr-code';
  for (const model of routes) {
    const started = Date.now(); let text = ''; let finish = false;
    try {
      const stream = await api.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with exactly FR_OK.' }], max_completion_tokens: 1024, ...((model.startsWith('fr-') || model.includes('glm-5.3-flash')) ? { reasoning_effort: 'low' } : {}), stream: true });
      for await (const chunk of stream) { const c = chunk.choices?.[0]; if (typeof c?.delta?.content === 'string') text += c.delta.content; if (c?.finish_reason) finish = true; }
      record(`Chat SSE ${model}`, text.length > 0 && finish ? 'passed' : 'failed', `${Date.now() - started} ms; ${text.length} visible chars; finish=${finish}`);
    } catch (error) { record(`Chat SSE ${model}`, 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }
  }

  try {
    const result = await api.chat.completions.create({ model: chatModel, messages: [{ role: 'user', content: 'Reply with exactly FR_OK.' }], stream: false, ...(!matildaSmoke ? { reasoning_effort: 'low' } : {}), max_completion_tokens: 512 });
    record('Chat nonstreaming response', typeof result.choices[0]?.message?.content === 'string' ? 'passed' : 'failed');
  } catch (error) { record('Chat nonstreaming response', 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }

  try {
    const tools = [{ type: 'function', function: { name: 'smoke_echo', description: 'Return a test value to verify the FreeRouter tool protocol.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
    const first = await api.chat.completions.create({ model: chatModel, messages: [{ role: 'user', content: 'Call smoke_echo with value FR_TOOL.' }], tools, tool_choice: { type: 'function', function: { name: 'smoke_echo' } }, ...(!matildaSmoke ? { reasoning_effort: 'low' } : {}), max_completion_tokens: 512 });
    const call = first.choices[0]?.message?.tool_calls?.[0];
    const args = call && JSON.parse(call.function.arguments);
    if (!call || args?.value !== 'FR_TOOL') throw new Error('required tool call was missing or invalid');
    const second = await api.chat.completions.create({ model: chatModel, messages: [{ role: 'user', content: 'Call smoke_echo with value FR_TOOL.' }, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'FR_TOOL' }], tools, ...(!matildaSmoke ? { reasoning_effort: 'low' } : {}), max_completion_tokens: 512 });
    record('Chat tool-call continuation', typeof second.choices[0]?.message?.content === 'string' ? 'passed' : 'failed');
  } catch (error) { record('Chat tool-call continuation', 'failed', `HTTP ${error?.status || 'contract'}${error?.code ? ` ${error.code}` : ''}`); }

  try {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=';
    const stream = await api.chat.completions.create({ model: matildaSmoke ? 'matilda/matilda' : 'fr-vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image in a few words.' }, { type: 'image_url', image_url: { url: image } }] }], ...(!matildaSmoke ? { reasoning_effort: 'low' } : {}), max_completion_tokens: 512, stream: true });
    let text = ''; for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content || '';
    record(matildaSmoke ? 'Matilda vision capability gate' : 'Chat vision SSE', !matildaSmoke && text.length > 0 ? 'passed' : 'failed', `${text.length} visible chars; unsupported Matilda vision was unexpectedly accepted=${matildaSmoke}`);
  } catch (error) {
    const expectedUnsupported = matildaSmoke && error?.status === 400;
    record(matildaSmoke ? 'Matilda vision capability gate' : 'Chat vision SSE', expectedUnsupported ? 'passed' : 'failed', matildaSmoke ? `HTTP ${error?.status || 'network'}; unsupported capability rejected` : `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`);
  }

  try {
    const json = await api.chat.completions.create({ model: chatModel, messages: [{ role: 'user', content: 'Return a JSON object with ok set to true.' }], ...(!matildaSmoke ? { reasoning_effort: 'low' } : {}), response_format: { type: 'json_schema', json_schema: { name: 'smoke', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } });
    const value = JSON.parse(json.choices[0].message.content); record('Chat strict JSON Schema', value.ok === true ? 'passed' : 'failed');
  } catch (error) { record('Chat strict JSON Schema', 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }

  if (matildaSmoke) {
    try {
      const json = await api.chat.completions.create({ model: chatModel, messages: [{ role: 'user', content: 'Return JSON with ok set to true.' }], response_format: { type: 'json_object' } });
      const value = JSON.parse(json.choices[0].message.content); record('Chat JSON mode', value.ok === true ? 'passed' : 'failed');
    } catch (error) { record('Chat JSON mode', 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }
  }

  try {
    const response = await api.responses.create({ model: chatModel, input: 'Reply with exactly FR_OK.', ...(!matildaSmoke ? { reasoning: { effort: 'low' } } : {}), store: false, stream: true });
    let terminal = false; let outputText = 0;
    for await (const event of response) { if (event.type === 'response.completed') terminal = true; if (event.type === 'response.output_text.delta') outputText += event.delta.length; }
    record('Responses SSE store:false', terminal && outputText > 0 ? 'passed' : 'failed', `text=${outputText}; completed=${terminal}`);
  } catch (error) { record('Responses SSE store:false', 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }

  try {
    const response = await api.responses.create({ model: chatModel, input: 'Reply with exactly FR_OK.', ...(!matildaSmoke ? { reasoning: { effort: 'low' } } : {}), store: true });
    const retrieved = await api.responses.retrieve(response.id);
    const deleted = await api.responses.delete(response.id);
    record('Responses stored retrieve/delete', retrieved.id === response.id && deleted.deleted === true ? 'passed' : 'failed');
  } catch (error) { record('Responses stored retrieve/delete', 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`); }

  for (const [label, path] of [['Jev model discovery', '/models?type=decision'], ['System One model discovery', '/systemone/models']]) {
    try { const res = await fetch(`${base}/v1${path}`, { headers: { authorization: `Bearer ${apiKey}` } }); const body = await res.json(); record(label, res.ok ? 'passed' : 'failed', `HTTP ${res.status}; models=${body.data?.length ?? body.models?.length ?? 'unknown'}`); } catch { record(label, 'failed', 'network or invalid JSON'); }
  }
  if (process.env.SMOKE_JEV !== 'false') {
    try {
      const response = await fetch(`${base}/v1/decisions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'jev/jev-latest', input: 'A production web service is returning HTTP 500 for all users.', questions: [{ type: 'predicate', name: 'urgent', instructions: 'Is immediate engineering action warranted?' }] }) });
      const value = await response.json(); record('Jev OpenAI Decisions call', response.ok ? 'passed' : 'failed', `HTTP ${response.status}; answer=${value.answers?.[0]?.type || value.error?.code || 'missing'}`);
    } catch { record('Jev OpenAI Decisions call', 'failed', 'network error'); }
    try {
      const response = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state: 'A production web service is returning HTTP 500 for all users.', questions: { urgent: { type: 'noul', instructions: 'Is immediate engineering action warranted?' } } }) });
      const value = await response.json(); record('Jev native System One call', response.ok ? 'passed' : 'failed', `HTTP ${response.status}; model=${value.model || value.error?.code || 'missing'}`);
    } catch { record('Jev native System One call', 'failed', 'network error'); }
  }
} catch (error) {
  record('deployment setup', 'failed', String(error?.message || error));
} finally {
  if (providerSmokeSlot && cookie) {
    await request('/api/admin/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...providerSmokeSlot, action: 'remove' }) }).catch(() => undefined);
  }
  if (clientKeyId && cookie) {
    await request(`/api/admin/keys/${clientKeyId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) }).catch(() => undefined);
    await request(`/api/admin/keys/${clientKeyId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) }).catch(() => undefined);
  }
}
console.log(JSON.stringify({ base, testedAt: new Date().toISOString(), results }, null, 2));
if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
