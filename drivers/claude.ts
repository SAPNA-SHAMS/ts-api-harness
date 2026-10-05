// Anthropic Messages API adapter. Everything provider-specific lives in this file.
import { defineDriver, type Message, type ModelRequest, type ModelResponse, type ToolCall } from '../src/core/sdk.ts';
import { arr, obj, postJson, requireEnv } from './_http.ts';

type Block = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: Block[] };

export function toWire(messages: Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    else if (m.role === 'assistant') {
      const blocks: Block[] = m.text.length > 0 ? [{ type: 'text', text: m.text }] : [];
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      push('assistant', blocks.length > 0 ? blocks : [{ type: 'text', text: '(no content)' }]);
    } else push('user', m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.content })));
  }
  return out;
}

export function fromWire(body: unknown): ModelResponse {
  const b = obj(body);
  const content = arr(b['content']).map(obj);
  const toolCalls: ToolCall[] = content
    .filter((c) => c['type'] === 'tool_use')
    .map((c) => ({ id: String(c['id']), name: String(c['name']), args: obj(c['input']) }));
  const text = content.filter((c) => c['type'] === 'text').map((c) => String(c['text'] ?? '')).join('\n');
  const usage = obj(b['usage']);
  const input = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((n, k) => n + (typeof usage[k] === 'number' ? usage[k] : 0), 0);
  const stop = b['stop_reason'] === 'tool_use' ? 'tools' : b['stop_reason'] === 'max_tokens' ? 'length' : 'end';
  return { text, toolCalls, stop, usage: { inputTokens: input, outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0 }, model: String(b['model'] ?? '') };
}

export default defineDriver({
  id: 'claude',
  create(env) {
    const key = requireEnv(env, 'ANTHROPIC_API_KEY');
    const base = (env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const model = env['HARNESS_CLAUDE_MODEL'] ?? 'claude-sonnet-5-5';
    return {
      id: 'claude',
      async run(req: ModelRequest): Promise<ModelResponse> {
        const body = {
          model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: toWire(req.messages),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        };
        return fromWire(await postJson(`${base}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body));
      },
    };
  },
});
