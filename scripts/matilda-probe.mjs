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
const started = Date.now();

let modelsResponse;
try {
  modelsResponse = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
} catch (error) {
  console.error('Matilda model discovery failed:', error?.name || 'network error');
  process.exit(1);
}
const modelsText = await modelsResponse.text();
let modelIds = [];
try {
  const parsed = JSON.parse(modelsText);
  const list = Array.isArray(parsed) ? parsed : parsed.data || parsed.models || [];
  modelIds = list.map((model) => model?.id || model?.name).filter(Boolean);
} catch {}
console.log(`Models: HTTP ${modelsResponse.status}; ids=${modelIds.length ? modelIds.join(', ') : 'unavailable'}`);
if (!modelsResponse.ok) process.exit(1);

let chatResponse;
try {
  chatResponse = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelIds[0] || 'matilda',
      messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
      max_tokens: 16,
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
} catch (error) {
  console.error('Matilda chat probe failed:', error?.name || 'network error');
  process.exit(1);
}

const chatText = await chatResponse.text();
let parsed;
try {
  parsed = JSON.parse(chatText);
} catch {}
const content = parsed?.choices?.[0]?.message?.content;
const finish = parsed?.choices?.[0]?.finish_reason;
console.log(
  `Chat: HTTP ${chatResponse.status}; finish=${finish || 'none'}; contentChars=${typeof content === 'string' ? content.length : 0}; usage=${parsed?.usage ? 'present' : 'absent'}; elapsedMs=${Date.now() - started}`,
);
if (!chatResponse.ok || typeof content !== 'string' || !content.trim()) process.exit(1);
console.log('Matilda probe passed.');
