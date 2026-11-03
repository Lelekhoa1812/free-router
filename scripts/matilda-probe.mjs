import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const base = 'https://matilda.maincode.com/api/v1';
const key = Array.from({ length: 9 }, (_, index) => process.env[`MATILDA_API_KEY_${index + 1}`]?.trim()).find(Boolean);
if (!key) {
  console.log('Matilda probe skipped: no MATILDA_API_KEY_1..9 configured.');
  process.exit(0);
}

const headers = { authorization: `Bearer ${key}` };
const failures = [];

function report(name, ok, detail) {
  console.log(`${name}: ${ok ? 'pass' : 'fail'}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  return { response, text: await response.text() };
}

let model = 'matilda';
try {
  const { response, text } = await request('/models');
  let ids = [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.data || parsed.models || [];
    ids = list.map((entry) => entry?.id || entry?.name).filter(Boolean);
  } catch {}
  if (ids.length) model = ids[0];
  report('models', response.ok && ids.length > 0, `HTTP ${response.status}; ids=${ids.length ? ids.join(', ') : 'unavailable'}`);
} catch (error) {
  report('models', false, error?.name || 'network error');
}

async function chat(body) {
  try {
    return await request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    report('chat transport', false, error?.name || 'network error');
    return undefined;
  }
}

const plain = await chat({
  model,
  messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
  max_tokens: 16,
  stream: false,
});
if (plain) {
  let parsed;
  try {
    parsed = JSON.parse(plain.text);
  } catch {}
  const content = parsed?.choices?.[0]?.message?.content;
  report(
    'chat',
    plain.response.ok && typeof content === 'string' && content.trim().length > 0,
    `HTTP ${plain.response.status}; finish=${parsed?.choices?.[0]?.finish_reason || 'none'}; contentChars=${typeof content === 'string' ? content.length : 0}; usage=${parsed?.usage ? 'present' : 'absent'}`,
  );
}

const streamed = await chat({
  model,
  messages: [{ role: 'user', content: 'Count from one to three.' }],
  max_tokens: 32,
  stream: true,
});
if (streamed) {
  const contentType = streamed.response.headers.get('content-type') || '';
  const dataLines = streamed.text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const done = dataLines.includes('[DONE]');
  let events = [];
  try {
    events = dataLines.filter((line) => line !== '[DONE]').map((line) => JSON.parse(line));
  } catch {}
  const chunkShape = events.length > 0 && events.every((event) => event?.object === 'chat.completion.chunk');
  const deltas = events.filter((event) => event?.choices?.[0]?.delta).length;
  report(
    'stream',
    streamed.response.ok && contentType.includes('text/event-stream') && done && chunkShape && deltas > 0,
    `HTTP ${streamed.response.status}; events=${events.length}; deltas=${deltas}; done=${done}; shape=${chunkShape ? 'openai-delta' : 'unknown'}`,
  );
}

const schema = await chat({
  model,
  messages: [{ role: 'user', content: 'Return a JSON object with status set to the word ok.' }],
  max_tokens: 128,
  stream: false,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'probe_reply',
      strict: true,
      schema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
        additionalProperties: false,
      },
    },
  },
});
if (schema) {
  let content;
  let parsed;
  try {
    const envelope = JSON.parse(schema.text);
    content = envelope?.choices?.[0]?.message?.content;
    parsed = typeof content === 'string' ? JSON.parse(content) : undefined;
  } catch {}
  report(
    'schema',
    schema.response.ok && parsed?.status === 'ok',
    `HTTP ${schema.response.status}; parsed=${parsed ? 'yes' : 'no'}; status=${parsed?.status || 'none'}`,
  );
}

if (failures.length) {
  console.error(`Matilda probe failed: ${failures.join(', ')}.`);
  process.exit(1);
}
console.log('Matilda probe passed: models, chat, stream and schema.');
