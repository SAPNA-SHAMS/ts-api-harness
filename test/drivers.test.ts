// Driver translation, checked against the wire-level validators of the offline provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import claude, { fromWire as fromClaude, toWire as toClaude } from '../drivers/claude.ts';
import openai, { fromWire as fromOpenAI, toWire as toOpenAI } from '../drivers/openai.ts';
import type { Message, ModelRequest } from '../src/core/sdk.ts';
import { startFakeProvider } from './fake-provider/server.ts';

const history: Message[] = [
  { role: 'user', text: 'start' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/app.ts' } }, { id: 'c2', name: 'get_task', args: {} }] },
  { role: 'tool', results: [{ callId: 'c1', name: 'read_file', content: '1| x' }, { callId: 'c2', name: 'get_task', content: 'task' }] },
];

test('claude adapter: tool results become tool_result blocks in one user turn', () => {
  const wire = toClaude(history);
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(wire[2]?.content.length, 2);
  const r = fromClaude({ content: [{ type: 'tool_use', id: 't', name: 'run_tests', input: { path: 'a' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } });
  assert.deepEqual(r.toolCalls, [{ id: 't', name: 'run_tests', args: { path: 'a' } }]);
  assert.equal(r.stop, 'tools');
});

test('openai adapter: system first, tool messages keyed by tool_call_id, JSON-string arguments', () => {
  const wire = toOpenAI('sys', history);
  assert.equal(wire[0]?.['role'], 'system');
  assert.deepEqual(wire.slice(3).map((m) => m['tool_call_id']), ['c1', 'c2']);
  const r = fromOpenAI({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 'finish', arguments: '{"summary":"s"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
  assert.deepEqual(r.toolCalls[0]?.args, { summary: 's' });
  assert.equal(r.usage.inputTokens, 5);
});

test('both real drivers round-trip through a wire-validating endpoint with identical neutral requests', async () => {
  const provider = await startFakeProvider([{ name: 'get_task', args: {} }, { name: 'finish', args: { summary: 'x' } }]);
  try {
    const req: ModelRequest = { system: 's', messages: [{ role: 'user', text: 'go' }], tools: [{ name: 'get_task', description: 'd', parameters: { type: 'object', properties: {} } }, { name: 'finish', description: 'd', parameters: { type: 'object', properties: { summary: { type: 'string' } } } }], maxOutputTokens: 100 };
    const env = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_BASE_URL: provider.url, OPENAI_BASE_URL: `${provider.url}/v1` };
    const a = await claude.create(env).run(req);
    const o = await openai.create(env).run(req);
    assert.equal(a.toolCalls[0]?.name, 'get_task');
    assert.equal(o.toolCalls[0]?.name, 'finish');
    assert.ok(a.usage.inputTokens > 0 && o.usage.inputTokens > 0);
  } finally {
    await provider.close();
  }
});

test('missing provider key fails loudly, naming the variable', () => {
  assert.throws(() => claude.create({}), /ANTHROPIC_API_KEY is not set/);
  assert.throws(() => openai.create({}), /OPENAI_API_KEY is not set/);
});
