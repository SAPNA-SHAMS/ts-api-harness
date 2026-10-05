// The route contract of an API, extracted statically. The harness writes it to
// contract.snapshot.json when it ships, so the next change is diffed against it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CheckContext } from './sdk.ts';

export const SNAPSHOT_FILE = 'contract.snapshot.json';

export const ContractRoute = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
  errors: z.array(z.number()),
  body: z.array(z.object({ name: z.string(), optional: z.boolean() })).nullable(),
  response: z.array(z.string()).nullable(),
});
export type ContractRoute = z.infer<typeof ContractRoute>;
export const Contract = z.object({ version: z.literal(1), routes: z.array(ContractRoute) });
export type Contract = z.infer<typeof Contract>;

export const routeKey = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

export function extractContract(ctx: CheckContext): Contract {
  const routes = ctx.routes
    .map((r) => ({
      method: r.method,
      path: r.path,
      status: r.status ?? null,
      errors: [...r.errors].sort((a, b) => a - b),
      body: r.schemas.body === undefined || r.schemas.body === 'NoBody' ? null : (r.bodyFields ?? null),
      response: r.responseFields === undefined ? null : [...r.responseFields].sort(),
    }))
    .sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
  return { version: 1, routes };
}

export function readSnapshot(root: string): Contract | undefined {
  const file = join(root, SNAPSHOT_FILE);
  if (!existsSync(file)) return undefined;
  return Contract.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export type ContractChange = { key: string; kind: 'added' | 'removed' | 'changed'; breaking: boolean; detail: string };

export function diffContracts(before: Contract, after: Contract): ContractChange[] {
  const changes: ContractChange[] = [];
  const old = new Map(before.routes.map((r) => [routeKey(r), r]));
  const now = new Map(after.routes.map((r) => [routeKey(r), r]));
  for (const [key, r] of old) {
    const n = now.get(key);
    if (n === undefined) {
      changes.push({ key, kind: 'removed', breaking: true, detail: 'route removed' });
      continue;
    }
    if (r.status !== n.status) changes.push({ key, kind: 'changed', breaking: true, detail: `success status ${r.status ?? '?'} → ${n.status ?? '?'}` });
    for (const f of r.response ?? []) {
      if (!(n.response ?? []).includes(f)) changes.push({ key, kind: 'changed', breaking: true, detail: `response field '${f}' removed` });
    }
    const oldBody = new Map((r.body ?? []).map((f) => [f.name, f]));
    for (const f of n.body ?? []) {
      const prev = oldBody.get(f.name);
      if (!f.optional && (prev === undefined || prev.optional)) changes.push({ key, kind: 'changed', breaking: true, detail: `body field '${f.name}' became required` });
    }
    for (const f of r.body ?? []) {
      if (!(n.body ?? []).some((x) => x.name === f.name)) changes.push({ key, kind: 'changed', breaking: true, detail: `body field '${f.name}' no longer accepted` });
    }
    const addedErrors = n.errors.filter((e) => !r.errors.includes(e));
    if (addedErrors.length > 0) changes.push({ key, kind: 'changed', breaking: false, detail: `new error statuses ${addedErrors.join(',')}` });
  }
  for (const [key] of now) if (!old.has(key)) changes.push({ key, kind: 'added', breaking: false, detail: 'route added' });
  return changes;
}
