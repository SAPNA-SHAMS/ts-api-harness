// Shared by drivers (the leading underscore keeps it out of plugin discovery).
export async function postJson(url: string, headers: Record<string, string>, body: unknown, attempts = 4): Promise<unknown> {
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as unknown;
    lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw new Error(lastError);
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is not set (provider keys come from the environment)`);
  return v;
}

export const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
