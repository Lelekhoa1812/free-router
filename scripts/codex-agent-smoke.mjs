// Synthetic tools only: this probe never executes business MCP tools or commands.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = (process.env.FREEROUTER_BASE_URL || 'http://127.0.0.1:3107').replace(/\/$/, '').replace(/\/v1$/, '');
const key = process.env.FREEROUTER_API_KEY;
assert(key, 'Set FREEROUTER_API_KEY in the environment; do not put it in source.');
const model = 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b';
const receipt = `AGENT_CHECKS_OK_${randomUUID()}`;
const tool = { type: 'namespace', name: 'checks', tools: [{
  type: 'function', name: 'run_check', description: 'Run one sequential synthetic check. Correct the request if the tool reports an error.',
  parameters: { type: 'object', properties: { step: { type: 'integer', minimum: 1, maximum: 6 }, method: { type: 'string' } }, required: ['step', 'method'], additionalProperties: false },
  strict: true,
}] };
const input = [{ role: 'user', content: 'Run all six checks in order, one check per tool call. Start at step 1 using method "check" as the old instructions specify. If that fails, use the error to correct the method and continue; do not ask me to fix it. Give a brief progress update before the next action. Do not stop after a progress update or promise. After all six checks pass, return the completion receipt from the last tool result. Do not invent the receipt.' }];
let passed = 0;
let toolCalls = 0;
let recoveredErrors = 0;
let responses = 0;
let completed = false;

try {
  for (; responses < 12; responses++) {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input, tools: [tool], tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'], store: false, stream: true, max_output_tokens: 16_384 }),
      signal: AbortSignal.timeout(180_000),
    });
    assert(response.ok, `Responses HTTP ${response.status}`);
    const wire = await response.text();
    const events = wire.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const terminal = events.findLast(event => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type));
    if (terminal?.type !== 'response.completed') console.log(JSON.stringify({ terminal: terminal?.type, details: terminal?.response?.incomplete_details, error: terminal?.response?.error, usage: terminal?.response?.usage }));
    assert(terminal?.type === 'response.completed', `Unsuccessful terminal event: ${terminal?.type || 'missing'}`);
    const result = terminal.response;
    const calls = result.output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      if (passed !== 6) console.log(JSON.stringify({ prematureText: (result.output_text || '').slice(0, 700) }));
      assert.equal(passed, 6, `Premature text-only final answer after ${passed}/6 checks`);
      assert((result.output_text || '').includes(receipt), 'Final answer omitted the tool-issued receipt');
      assert(recoveredErrors > 0, 'The intended tool-error recovery was not exercised');
      completed = true;
      break;
    }
    assert.equal(calls.length, 1, 'Checks must use sequential tool calls');
    input.push(...result.output);
    for (const call of calls) {
      toolCalls++;
      assert.equal(call.namespace, 'checks');
      assert.equal(call.name, 'run_check');
      const args = JSON.parse(call.arguments);
      let output;
      if (args.method !== 'tools/call') {
        recoveredErrors++;
        output = { error: 'Unknown method: check. Use method "tools/call" with the same step, then continue the remaining checks.' };
      } else {
        assert.equal(args.step, passed + 1, 'Skipped or repeated a check');
        passed++;
        output = passed === 6 ? { passed, receipt } : { passed, nextStep: passed + 1 };
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
    }
    console.log(JSON.stringify({ response: responses + 1, checks: passed, toolCalls }));
  }
  assert(completed, 'Exceeded the bounded probe without a final answer');
  console.log(JSON.stringify({ passed: true, checks: passed, toolCalls, toolErrorsRecovered: recoveredErrors, responses: responses + 1, finalReceiptVerified: true }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks: passed, toolCalls, toolErrorsRecovered: recoveredErrors, responses: responses + 1, error: String(error.message).replaceAll(key, '<redacted>') }));
  process.exitCode = 1;
}
