import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const providers = [
  { id: 'google', prefix: 'GEMINI_API_KEY_', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'nvidia', prefix: 'NVIDIA_NIM_API_KEY_', url: 'https://integrate.api.nvidia.com/v1' },
  { id: 'openrouter', prefix: 'OPEN_ROUTER_API_KEY_', url: 'https://openrouter.ai/api/v1' },
];
const models = [
  ['google', 'gemini-3-flash-preview'], ['google', 'gemini-3.1-flash-lite-preview'],
  ['google', 'gemini-3.1-flash-lite'], ['google', 'gemini-3.5-flash'],
  ['google', 'gemini-3.5-flash-lite'], ['google', 'gemini-3.6-flash'],
  ['nvidia', 'z-ai/glm-5.3-flash'],
  ['nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b'], ['nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'],
  ['nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'], ['nvidia', 'poolside/laguna-xs-2.1'],
  ['openrouter', 'nvidia/nemotron-3.5-super-vl:free'], ['openrouter', 'dots-studio/dots-3-note-preview:free'],
  ['openrouter', 'cohere/north-mini-code:free'], ['openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
];
const timeout = Number(process.env.SMOKE_MODEL_TIMEOUT_MS || 120000);
const filter = process.env.SMOKE_MODEL_FILTER;
const results = [];
for (const [providerId, model] of models.filter(([, id]) => !filter || id.includes(filter))) {
  const provider = providers.find((p) => p.id === providerId);
  const credential = Array.from({ length: 9 }, (_, i) => ({ slot: i + 1, key: process.env[`${provider.prefix}${i + 1}`]?.trim() })).find((x) => x.key);
  if (!credential) { results.push({ provider: providerId, model, status: 'skipped', reason: 'no configured credential' }); continue; }
  const controller = new AbortController();
  const started = Date.now(); let firstByteMs = null; let bytes = 0; let sawDone = false; let sawFinish = false; let textChars = 0; let buffer = '';
  const eventShapes = [];
  const consume = (event) => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') { sawDone = true; continue; }
      try {
        const payload = JSON.parse(data); const choices = payload.choices || [];
        for (const choice of choices) {
          if (typeof choice.delta?.content === 'string') textChars += choice.delta.content.length;
          if (choice.finish_reason) sawFinish = true;
        }
        if (eventShapes.length < 3) eventShapes.push({ choices: choices.length, deltaKeys: [...new Set(choices.flatMap((c) => Object.keys(c.delta || {})))], contentChars: choices.reduce((n, c) => n + (typeof c.delta?.content === 'string' ? c.delta.content.length : 0), 0), finish: choices.map((c) => c.finish_reason).filter(Boolean) });
      } catch {}
    }
  };
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${provider.url}/chat/completions`, {
      method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json', accept: 'text/event-stream', ...(providerId === 'openrouter' ? { 'HTTP-Referer': 'https://freerouter.local', 'X-Title': 'FreeRouter live smoke' } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly FR_OK.' }], max_tokens: 128, stream: true }),
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text()).slice(0, 240).replace(/[\r\n]+/g, ' ');
      results.push({ provider: providerId, model, slot: credential.slot, status: 'failed', http: response.status, detail, elapsedMs: Date.now() - started });
      continue;
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      firstByteMs ??= Date.now() - started; bytes += value.byteLength; buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || '';
      for (const event of events) consume(event);
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    clearTimeout(timer);
    const passed = textChars > 0 && (sawDone || sawFinish);
    results.push({ provider: providerId, model, slot: credential.slot, status: passed ? 'passed' : 'failed', reason: passed ? undefined : 'stream ended without visible text and a finish marker', elapsedMs: Date.now() - started, firstByteMs, bytes, textChars, finishMarker: sawDone || sawFinish, eventShapes });
  } catch (error) {
    results.push({ provider: providerId, model, slot: credential.slot, status: 'failed', reason: error?.name === 'AbortError' ? `timeout after ${timeout}ms` : String(error).slice(0, 180), elapsedMs: Date.now() - started });
  } finally { clearTimeout(timer); }
}
console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
