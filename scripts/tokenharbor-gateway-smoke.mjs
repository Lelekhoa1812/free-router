// TokenHarbor certification in two stages.
//
//   pnpm smoke:tokenharbor             direct upstream probe with TOKENHARBOR_API_KEY_<slot>
//   pnpm smoke:tokenharbor --gateway   OpenAI SDK smoke through a deployed FreeRouter
//
// The gateway hides and refuses catalog models that are not `ready` with text
// `passed`, so run the upstream probe first and promote the model in
// src/lib/models/catalog.ts only after it passes. The gateway stage then checks
// the promoted model end to end.
import nextEnv from '@next/env';
import OpenAI from 'openai';
import { assert, createReporter, describeError, openGatewaySession } from './lib/smoke-helpers.mjs';

nextEnv.loadEnvConfig(process.cwd());
const model = process.env.TOKENHARBOR_SMOKE_MODEL || 'tokenharbor/deepseek-v4-flash:free';
if (!model.startsWith('tokenharbor/')) throw new Error('TOKENHARBOR_SMOKE_MODEL must be a tokenharbor/ catalog id.');
const reporter = createReporter();
const { check } = reporter;

async function streamedText(stream) {
  let text = '', finish = false;
  for await (const event of stream) {
    text += event.choices?.[0]?.delta?.content || '';
    finish ||= Boolean(event.choices?.[0]?.finish_reason);
  }
  assert(text.length > 0, 'Stream returned no text');
  assert(finish, 'Stream ended without a finish_reason');
}

async function probeUpstream() {
  const slot = process.env.TOKENHARBOR_SMOKE_SLOT || '1';
  const secret = process.env[`TOKENHARBOR_API_KEY_${slot}`]?.trim();
  if (!secret) throw new Error(`Set TOKENHARBOR_API_KEY_${slot} for the upstream probe.`);
  const upstream = model.slice('tokenharbor/'.length);
  const api = new OpenAI({ apiKey: secret, baseURL: 'https://tokenharbor.ai/v1', maxRetries: 0, timeout: 90000 });
  const weather = { type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } };

  await check('upstream model discovery', async () => { const models = await api.models.list(); assert(models.data.some((item) => item.id === upstream), `${upstream} is not listed`); });
  await check('upstream streamed Chat', async () => streamedText(await api.chat.completions.create({ model: upstream, messages: [{ role: 'user', content: 'Reply FR_OK.' }], stream: true, max_tokens: 96 })));
  await check('upstream developer message', async () => streamedText(await api.chat.completions.create({ model: upstream, messages: [{ role: 'developer', content: 'Answer in one word.' }, { role: 'user', content: 'Say hello.' }], stream: true, max_tokens: 96 })));
  await check('upstream tool call and continuation', async () => {
    const messages = [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }];
    const first = await api.chat.completions.create({ model: upstream, messages, tools: [weather], tool_choice: 'required', max_tokens: 256 });
    const call = first.choices[0]?.message?.tool_calls?.[0];
    assert(call?.function?.name === 'get_weather', 'No get_weather tool call');
    JSON.parse(call.function.arguments);
    const second = await api.chat.completions.create({ model: upstream, messages: [...messages, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: '{"celsius":18}' }], tools: [weather], max_tokens: 256 });
    assert(second.choices[0]?.message?.content, 'No answer after the tool result');
  });
  await check('upstream strict JSON Schema', async () => {
    const response = await api.chat.completions.create({ model: upstream, messages: [{ role: 'user', content: 'Return the number 7.' }], max_tokens: 128, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } } });
    assert(Number.isInteger(JSON.parse(response.choices[0]?.message?.content || 'null')?.value), 'Response does not match the schema');
  });
}

async function smokeGateway() {
  const base = (process.env.FREEROUTER_BASE_URL || '').replace(/\/$/, '');
  const email = (process.env.FREEROUTER_ADMIN_EMAIL || process.env.SMTP_USER || '').trim().toLowerCase();
  if (!base || !email) throw new Error('Set FREEROUTER_BASE_URL and an admin email for the gateway smoke.');
  const session = await openGatewaySession({ base, email, name: 'tokenharbor-smoke', models: [model], reporter });
  try {
    const { api } = session;
    const listed = (await api.models.list()).data.some((item) => item.id === model);
    reporter.record('model discovery', listed, listed ? '' : `${model} is not ready in the catalog; pass the upstream probe and promote it first`);
    if (!listed) return;
    await check('streamed Chat', async () => streamedText(await api.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply FR_OK.' }], stream: true, max_completion_tokens: 96 })));
    await check('Responses streaming', async () => {
      const events = await api.responses.create({ model, input: 'Say hello.', stream: true, store: false, max_output_tokens: 96 });
      let completed = false, text = false;
      for await (const event of events) { completed ||= event.type === 'response.completed'; text ||= event.type === 'response.output_text.delta' && Boolean(event.delta); }
      assert(text, 'No output_text delta');
      assert(completed, 'No response.completed event');
    });
    await check('stored Responses retrieve and delete', async () => {
      let responseId;
      try {
        const response = await api.responses.create({ model, input: 'Say hello.', store: true, max_output_tokens: 96 }); responseId = response.id;
        const stored = await api.responses.retrieve(responseId); assert(stored.id === responseId && stored.status === 'completed', 'Stored response not completed');
      } finally { if (responseId) await api.responses.delete(responseId); }
    });
  } finally { await session.close(); }
}

const gateway = process.argv.includes('--gateway');
try { await (gateway ? smokeGateway() : probeUpstream()); } catch (error) { reporter.record(gateway ? 'gateway setup' : 'upstream setup', false, describeError(error)); }
if (reporter.failures) process.exitCode = 1;
