import nextEnv from '@next/env';
import OpenAI from 'openai';
import { MongoClient } from 'mongodb';
import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

nextEnv.loadEnvConfig(process.cwd());

const mongoUri = process.env.MONGO_DB_CONNECTION_STRING;
const dbName = process.env.MONGODB_DB || 'freerouter';
const encryptionSecret = process.env.STATE_ENCRYPTION_KEY;
if (!mongoUri || !encryptionSecret || Buffer.byteLength(encryptionSecret) < 32) {
  throw new Error('Set MongoDB and the configured state-encryption variables locally.');
}

const mongo = new MongoClient(mongoUri, {
  maxPoolSize: 1,
  serverSelectionTimeoutMS: 7000,
  connectTimeoutMS: 7000,
  appName: 'FreeRouter Matilda certification',
});
const results = [];
const record = (name, status, detail) => {
  const item = { name, status, ...(detail ? { detail } : {}) };
  results.push(item);
  console.log(`${status.toUpperCase()} ${name}${detail ? ` — ${detail}` : ''}`);
};

function decryptCredential(record) {
  const key = createHash('sha256').update(Buffer.from(encryptionSecret)).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64url'));
  decipher.setAAD(Buffer.from('freerouter:provider-credential:matilda:1:v1'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  const encrypted = Buffer.concat([decipher.update(Buffer.from(record.body, 'base64url')), decipher.final()]);
  const plain = record.v === 2 ? gunzipSync(encrypted, { maxOutputLength: 8 * 1024 * 1024 }) : encrypted;
  if (plain.length > 8 * 1024 * 1024) throw new Error('Stored credential record exceeds the plaintext limit.');
  return JSON.parse(plain.toString('utf8')).secret;
}

async function check(name, run) {
  try {
    const detail = await run();
    record(name, 'passed', detail);
    return true;
  } catch (error) {
    record(name, 'failed', `HTTP ${error?.status || 'network'}${error?.code ? ` ${error.code}` : ''}`);
    return false;
  }
}

try {
  await mongo.connect();
  const stored = await mongo.db(dbName).collection('provider_credentials').findOne(
    { provider: 'matilda', slot: 1 },
    { projection: { encryptedSecret: 1 } },
  );
  if (!stored?.encryptedSecret) throw new Error('Matilda slot 1 is not configured in MongoDB.');
  const api = new OpenAI({
    apiKey: decryptCredential(stored.encryptedSecret),
    baseURL: 'https://matilda.maincode.com/api/v1',
    maxRetries: 0,
    timeout: 120000,
  });

  await check('OpenAI SDK models.list', async () => {
    const response = await api.models.list();
    if (!response.data.some((model) => model.id === 'matilda')) throw new Error('Matilda model was not listed.');
    return `${response.data.length} model(s)`;
  });

  await check('OpenAI SDK streamed Chat with system/developer roles', async () => {
    const stream = await api.chat.completions.create({
      model: 'matilda',
      messages: [
        { role: 'system', content: 'You are a compatibility probe.' },
        { role: 'developer', content: 'Answer using the exact token requested.' },
        { role: 'user', content: 'Reply with exactly FR_MATILDA_OK.' },
      ],
      max_tokens: 64,
      stream: true,
    });
    let text = '';
    let finished = false;
    for await (const chunk of stream) {
      text += chunk.choices?.[0]?.delta?.content || '';
      if (chunk.choices?.[0]?.finish_reason) finished = true;
    }
    if (!text.includes('FR_MATILDA_OK') || !finished) throw new Error('Missing streamed text or finish event.');
    return `${text.length} visible chars; terminal finish received`;
  });

  await check('OpenAI SDK JSON mode', async () => {
    const stream = await api.chat.completions.create({
      model: 'matilda',
      messages: [{ role: 'user', content: 'Return a JSON object with ok set to true.' }],
      max_tokens: 80,
      response_format: { type: 'json_object' },
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content || '';
    const value = JSON.parse(text);
    if (value.ok !== true) throw new Error('JSON mode returned the wrong object.');
    return `${text.length} streamed chars; valid JSON`;
  });

  await check('OpenAI SDK strict JSON Schema', async () => {
    const stream = await api.chat.completions.create({
      model: 'matilda',
      messages: [{ role: 'user', content: 'Return status exactly ok.' }],
      max_tokens: 100,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'status_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content || '';
    const value = JSON.parse(text);
    if (value.status !== 'ok' || Object.keys(value).length !== 1) throw new Error('Schema response did not conform.');
    return `${text.length} streamed chars; schema validated`;
  });

  let toolCall;
  const toolDefinition = {
    type: 'function',
    function: {
      name: 'smoke_echo',
      description: 'Echo a test value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  };
  await check('OpenAI SDK streamed native function call', async () => {
    const stream = await api.chat.completions.create({
      model: 'matilda',
      messages: [{ role: 'user', content: 'Call smoke_echo with value FR_TOOL.' }],
      tools: [toolDefinition],
      tool_choice: 'required',
      max_tokens: 120,
      stream: true,
    });
    const pending = new Map();
    let finishReason = '';
    for await (const chunk of stream) {
      for (const delta of chunk.choices?.[0]?.delta?.tool_calls || []) {
        const call = pending.get(delta.index) || { id: '', name: '', arguments: '' };
        call.id += delta.id || '';
        call.name += delta.function?.name || '';
        call.arguments += delta.function?.arguments || '';
        pending.set(delta.index, call);
      }
      finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
    }
    toolCall = [...pending.values()][0];
    const args = JSON.parse(toolCall?.arguments || 'null');
    if (pending.size !== 1 || toolCall.name !== 'smoke_echo' || args?.value !== 'FR_TOOL' || finishReason !== 'tool_calls') {
      throw new Error('Tool call was missing or malformed.');
    }
    return `one tool; finish_reason=${finishReason}; arguments valid`;
  });

  await check('OpenAI parallel_tool_calls:false', async () => {
    const response = await api.chat.completions.create({
      model: 'matilda',
      messages: [{ role: 'user', content: 'Call the tool once with value FR_TOOL.' }],
      tools: [toolDefinition],
      tool_choice: { type: 'function', function: { name: 'smoke_echo' } },
      parallel_tool_calls: false,
      max_tokens: 120,
    });
    const calls = response.choices[0]?.message?.tool_calls || [];
    if (calls.length !== 1 || calls[0].function.name !== 'smoke_echo') throw new Error('Expected exactly one matching tool call.');
    return 'one named tool call';
  });

  if (toolCall) await check('OpenAI SDK tool-result continuation', async () => {
    const response = await api.chat.completions.create({
      model: 'matilda',
      messages: [
        { role: 'user', content: 'Call smoke_echo with value FR_TOOL.' },
        { role: 'assistant', content: null, tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] },
        { role: 'tool', tool_call_id: toolCall.id, content: 'FR_TOOL' },
      ],
      tools: [toolDefinition],
      max_tokens: 100,
    });
    const text = response.choices[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) throw new Error('No assistant completion after tool result.');
    return 'assistant completed after tool output';
  });

  try {
    await api.chat.completions.create({
      model: 'matilda',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in one word.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=' } },
        ],
      }],
      max_tokens: 50,
      stream: true,
    });
    record('OpenAI inline image_url', 'unexpectedly_supported', 'Upstream accepted the image request; review the gateway capability profile before enabling vision.');
  } catch (error) {
    if (error?.status === 400) record('OpenAI inline image_url', 'unsupported', 'HTTP 400 from the upstream endpoint; keep vision disabled.');
    else record('OpenAI inline image_url', 'inconclusive', `HTTP ${error?.status || 'network'}`);
  }
} finally {
  await mongo.close();
}

console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.status === 'failed' || result.status === 'inconclusive' || result.status === 'unexpectedly_supported')) process.exitCode = 1;
