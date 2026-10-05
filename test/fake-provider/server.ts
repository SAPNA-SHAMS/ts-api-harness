// A local HTTP server that speaks both provider wire formats (Anthropic Messages and OpenAI Chat
// Completions) and validates requests the way the real APIs do. The drivers are pointed at it via
// ANTHROPIC_BASE_URL / OPENAI_BASE_URL, so the real driver code paths are exercised end to end.
// Responses come from a scripted policy, not a model: runs against it prove the harness, the
// drivers' translation and the gates, never model quality.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nextStep, type Seen, type Step } from './policy.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const est = (s: string): number => Math.ceil(s.length / 4);

class WireError extends Error {}
const must = (cond: boolean, msg: string): void => {
  if (!cond) throw new WireError(msg);
};

/** Anthropic: alternating roles, tool_result ids must answer the previous assistant's tool_use ids. */
function seenFromAnthropic(body: Obj): Seen[] {
  must(typeof body['model'] === 'string', 'model is required');
  must(typeof body['max_tokens'] === 'number', 'max_tokens is required');
  must(typeof body['system'] === 'string', 'system must be a string');
  for (const t of arr(body['tools'])) must(typeof obj(obj(t)['input_schema'])['type'] === 'string', 'tools[].input_schema required');
  const msgs = arr(body['messages']).map(obj);
  must(msgs[0]?.['role'] === 'user', 'first message must be user');
  const seen: Seen[] = [];
  let pending = new Map<string, { name: string; args: Obj }>();
  msgs.forEach((m, i) => {
    if (i > 0) must(m['role'] !== msgs[i - 1]?.['role'], 'roles must alternate');
    const content = arr(m['content']).map(obj);
    must(content.length > 0, 'content must be non-empty');
    if (m['role'] === 'assistant') {
      must(pending.size === 0, 'tool_use without tool_result');
      for (const b of content) if (b['type'] === 'tool_use') pending.set(String(b['id']), { name: String(b['name']), args: obj(b['input']) });
    } else {
      const results = content.filter((b) => b['type'] === 'tool_result');
      must(results.length === pending.size, `expected ${pending.size} tool_result blocks, got ${results.length}`);
      for (const r of results) {
        const call = pending.get(String(r['tool_use_id']));
        must(call !== undefined, `tool_result for unknown tool_use_id ${String(r['tool_use_id'])}`);
        if (call !== undefined) seen.push({ ...call, result: String(r['content']) });
      }
      pending = new Map();
    }
  });
  return seen;
}

/** OpenAI: system first, every assistant tool_call answered by a tool message with its id. */
function seenFromOpenAI(body: Obj): Seen[] {
  must(typeof body['model'] === 'string', 'model is required');
  for (const t of arr(body['tools'])) must(obj(t)['type'] === 'function' && typeof obj(obj(t)['function'])['parameters'] === 'object', 'tools[] must be functions');
  const msgs = arr(body['messages']).map(obj);
  must(msgs[0]?.['role'] === 'system', 'first message must be system');
  const seen: Seen[] = [];
  let pending = new Map<string, { name: string; args: Obj }>();
  for (const m of msgs.slice(1)) {
    if (m['role'] === 'assistant') {
      must(pending.size === 0, 'assistant message before all tool calls were answered');
      for (const c of arr(m['tool_calls']).map(obj)) {
        const fn = obj(c['function']);
        must(typeof fn['arguments'] === 'string', 'function.arguments must be a JSON string');
        pending.set(String(c['id']), { name: String(fn['name']), args: obj(JSON.parse(String(fn['arguments']))) });
      }
    } else if (m['role'] === 'tool') {
      const call = pending.get(String(m['tool_call_id']));
      must(call !== undefined, `tool message for unknown tool_call_id ${String(m['tool_call_id'])}`);
      if (call !== undefined) seen.push({ ...call, result: String(m['content']) });
      pending.delete(String(m['tool_call_id']));
    } else must(m['role'] === 'user', `unexpected role ${String(m['role'])}`);
  }
  must(pending.size === 0, 'unanswered tool_calls');
  return seen;
}

async function readJson(req: IncomingMessage): Promise<{ text: string; body: Obj }> {
  let text = '';
  for await (const c of req) text += String(c);
  return { text, body: obj(JSON.parse(text)) };
}

/** Like a real model, only call tools that were offered; deferred ones go through the dispatcher. */
function offered(step: Step | undefined, names: string[]): Step | undefined {
  if (step === undefined || names.includes(step.name) || !names.includes('use_tool')) return step;
  return { name: 'use_tool', args: { name: step.name, args: step.args } };
}

export type FakeProvider = { url: string; server: Server; requests: { wire: string; inputTokens: number }[]; close: () => Promise<void> };

export async function startFakeProvider(plan: Step[]): Promise<FakeProvider> {
  const requests: FakeProvider['requests'] = [];
  let ids = 0;
  // The harness compacts history, so the stand-in keeps its own place in the plan per session.
  let served = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const { text, body } = await readJson(req);
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        if (req.url === '/v1/messages') {
          must(typeof req.headers['x-api-key'] === 'string', 'x-api-key header required');
          must(req.headers['anthropic-version'] === '2023-06-01', 'anthropic-version header required');
          seenFromAnthropic(body);
          const step = offered(nextStep(plan, served++), arr(body['tools']).map((t) => String(obj(t)['name'])));
          const content = step === undefined ? [{ type: 'text', text: 'I have nothing further to try.' }] : [{ type: 'tool_use', id: `toolu_${++ids}`, name: step.name, input: step.args }];
          requests.push({ wire: 'anthropic', inputTokens: est(text) });
          reply(200, {
            id: `msg_${ids}`,
            type: 'message',
            role: 'assistant',
            model: 'scripted-replay (no live model)',
            content,
            stop_reason: step === undefined ? 'end_turn' : 'tool_use',
            usage: { input_tokens: est(text), output_tokens: est(JSON.stringify(content)) },
          });
          return;
        }
        if (req.url === '/v1/chat/completions') {
          must(/^Bearer .+/.test(String(req.headers['authorization'])), 'Bearer authorization required');
          seenFromOpenAI(body);
          const step = offered(nextStep(plan, served++), arr(body['tools']).map((t) => String(obj(obj(t)['function'])['name'])));
          const message = step === undefined
            ? { role: 'assistant', content: 'I have nothing further to try.' }
            : { role: 'assistant', content: null, tool_calls: [{ id: `call_${++ids}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
          requests.push({ wire: 'openai', inputTokens: est(text) });
          reply(200, {
            id: `chatcmpl_${ids}`,
            object: 'chat.completion',
            model: 'scripted-replay (no live model)',
            choices: [{ index: 0, message, finish_reason: step === undefined ? 'stop' : 'tool_calls' }],
            usage: { prompt_tokens: est(text), completion_tokens: est(JSON.stringify(message)) },
          });
          return;
        }
        reply(404, { error: { message: `no route ${req.url ?? ''}` } });
      } catch (err) {
        reply(400, { error: { type: 'invalid_request_error', message: err instanceof Error ? err.message : String(err) } });
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, requests, close: () => new Promise((r) => server.close(() => r())) };
}
