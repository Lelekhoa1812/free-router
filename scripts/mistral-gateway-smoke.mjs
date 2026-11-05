import nextEnv from '@next/env';
import { readFile } from 'node:fs/promises';
import { assert, createReporter, describeError, openGatewaySession } from './lib/smoke-helpers.mjs';

nextEnv.loadEnvConfig(process.cwd());
const base = (process.env.FREEROUTER_BASE_URL || '').replace(/\/$/, '');
const model = process.env.MISTRAL_SMOKE_MODEL;
const email = (process.env.FREEROUTER_ADMIN_EMAIL || process.env.SMTP_USER || '').trim().toLowerCase();
if (!base || !model || !model.startsWith('mistral/') || !email) throw new Error('Set FREEROUTER_BASE_URL, MISTRAL_SMOKE_MODEL and an admin email.');
const reporter = createReporter();
const { check } = reporter;
let session;
try {
  session = await openGatewaySession({ base, email, name: 'mistral-smoke', models: [model], reporter });
  const { api } = session;
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
} catch (error) { reporter.record('smoke setup', false, describeError(error)); }
finally { await session?.close(); }
if (reporter.failures) process.exitCode = 1;
