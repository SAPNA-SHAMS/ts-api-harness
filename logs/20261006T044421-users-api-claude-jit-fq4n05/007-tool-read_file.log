// Harness-owned test helpers: start the app on an ephemeral port and call it.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.ts';

export async function start(): Promise<{ base: string; server: Server }> {
  const server = buildApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

export async function call(base: string, method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; type: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key !== undefined) headers['idempotency-key'] = key;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: res.status, type: res.headers.get('content-type') ?? '', json };
}

export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}
