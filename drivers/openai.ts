// OpenAI Chat Completions adapter. Everything provider-specific lives in this file.
import { defineDriver, type Message, type ModelRequest, type ModelResponse, type ToolCall } from '../src/core/sdk.ts';
import { arr, obj, postJson, requireEnv } from './_http.ts';

type WireMessage = Record<string, unknown>;

export function toWire(system: string, messages: Message[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text.length > 0 ? m.text : null,
        ...(m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    } else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
  }
  return out;
}

export function fromWire(body: unknown): ModelResponse {
  const b = obj(body);
  const choice = obj(arr(b['choices'])[0]);
  const msg = obj(choice['message']);
  const toolCalls: ToolCall[] = arr(msg['tool_calls']).map((raw) => {
    const c = obj(raw);
    const fn = obj(c['function']);
    let args: Record<string, unknown>;
    try {
      args = obj(JSON.parse(String(fn['arguments'] ?? '{}')));
    } catch {
      args = { __invalid_json: String(fn['arguments'] ?? '') };
    }
    return { id: String(c['id']), name: String(fn['name']), args };
  });
  const usage = obj(b['usage']);
  const finish = choice['finish_reason'];
  return {
    text: typeof msg['content'] === 'string' ? msg['content'] : '',
    toolCalls,
    stop: finish === 'tool_calls' ? 'tools' : finish === 'length' ? 'length' : 'end',
    usage: {
      inputTokens: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
      outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
    },
    model: String(b['model'] ?? ''),
  };
}

export default defineDriver({
  id: 'openai',
  create(env) {
    const key = requireEnv(env, 'OPENAI_API_KEY');
    const base = (env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = env['HARNESS_OPENAI_MODEL'] ?? 'gpt-5';
    return {
      id: 'openai',
      async run(req: ModelRequest): Promise<ModelResponse> {
        const body = {
          model,
          max_completion_tokens: req.maxOutputTokens,
          messages: toWire(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        };
        return fromWire(await postJson(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, body));
      },
    };
  },
});
