// The standards checker on a known-good API, then one deliberate violation at a time.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runStandards } from '../src/core/checker.ts';
import { REPO_ROOT } from '../src/core/util.ts';

const SRC = join(REPO_ROOT, 'examples', 'orders-api');
const made: string[] = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function copy(name: string): string {
  const dir = join(REPO_ROOT, 'runs', `mutation-${process.pid}-${name}`);
  cpSync(SRC, dir, { recursive: true });
  made.push(dir);
  return dir;
}

function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = join(dir, rel);
  const before = readFileSync(p, 'utf8');
  const after = fn(before);
  assert.notEqual(after, before, `mutation did not apply to ${rel}`);
  writeFileSync(p, after);
}

test('known-good API scores 100%', async () => {
  const r = await runStandards(SRC);
  assert.equal(r.verdict.status, 'pass', JSON.stringify(r.rules.filter((x) => x.status !== 'pass' && x.status !== 'n/a')));
  assert.equal(r.verdict.percent, 100);
});

const MUTATIONS: { name: string; rule: string; file: string; mutate: (d: string) => void }[] = [
  { name: 'missing body schema', rule: 'zod-boundary', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('      body: OrderCreate,\n', '')) },
  { name: 'opaque z.any() schema', rule: 'zod-boundary', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('body: OrderUpdate,', 'body: z.any(),')) },
  { name: 'handler reads raw request', rule: 'zod-boundary', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('handler: async ({ params }) => store.get(params.id),', "handler: async ({ params, headers: req }) => store.get(params.id + String(req['x'])),")) },
  { name: 'hand-written interface', rule: 'zod-boundary', file: 'src/orders/schema.ts', mutate: (d) => edit(d, 'src/orders/schema.ts', (s) => `${s}export interface OrderDto { id: string }\n`) },
  { name: 'ad-hoc { error } shape', rule: 'problem-json', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => `${s}export const notFound = { error: 'Order not found' };\n`) },
  { name: 'raw response write (no problem+json)', rule: 'problem-json', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => `${s}export function raw(res: { writeHead: (n: number) => void }): void {\n  res.writeHead(500);\n}\n`) },
  { name: 'throw new Error', rule: 'problem-json', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => s.replace("throw problem(404, 'not-found', 'Order not found', `No order with id '${id}'`);", "throw new Error('not found');")) },
  { name: 'tests never assert problem+json', rule: 'problem-json', file: 'test', mutate: (d) => edit(d, 'test/orders.test.ts', (s) => s.replaceAll('application/problem+json', 'application/json')) },
  { name: 'explicit any', rule: 'strict-types', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => `${s}export const loose: any = 1;\n`) },
  { name: 'non-null assertion', rule: 'strict-types', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => `${s}export const first = [1][0]!;\n`) },
  { name: '@ts-ignore', rule: 'strict-types', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => `${s}// @ts-ignore\nexport const n: number = 1;\n`) },
  { name: 'noUncheckedIndexedAccess off', rule: 'strict-types', file: 'tsconfig.json', mutate: (d) => edit(d, 'tsconfig.json', (s) => s.replace('"noUncheckedIndexedAccess": true', '"noUncheckedIndexedAccess": false')) },
  { name: 'type error', rule: 'tsc-strict', file: 'src/orders/store.ts', mutate: (d) => edit(d, 'src/orders/store.ts', (s) => `${s}export const bad: number = 'nope';\n`) },
  { name: 'unversioned path', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replaceAll("'/v1/orders", "'/orders")) },
  { name: 'singular resource noun', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replaceAll("'/v1/orders", "'/v1/order")) },
  { name: 'list without cursor pagination', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('query: ListOrdersQuery,', 'query: NoParams,')) },
  { name: 'POST returns 200 instead of 201', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('status: 201,', 'status: 200,')) },
  { name: 'POST without idempotency key', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('      idempotent: true,\n', '')) },
  { name: 'item route without 404', rule: 'rest-conventions', file: 'src/orders/routes.ts', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace('errors: [404, 422],', 'errors: [422],')) },
  { name: 'route removed (breaking contract)', rule: 'contract-drift', file: 'contract.snapshot.json', mutate: (d) => edit(d, 'src/orders/routes.ts', (s) => s.replace(/    defineRoute\(\{\n      method: 'PATCH'[\s\S]*?\n    \}\),\n/, '')) },
];

for (const m of MUTATIONS) {
  test(`detects: ${m.name} → ${m.rule} FAIL with location`, async () => {
    const dir = copy(m.name.replace(/\W+/g, '-'));
    m.mutate(dir);
    const r = await runStandards(dir);
    const rule = r.rules.find((x) => x.id === m.rule);
    assert.ok(rule !== undefined);
    assert.equal(rule.status, 'fail', `${m.rule} should fail`);
    assert.ok(rule.findings.some((f) => f.file === m.file || f.file.startsWith(m.file)), `finding located in ${m.file}: ${JSON.stringify(rule.findings)}`);
    assert.notEqual(r.verdict.status, 'pass');
  });
}

test('the original API is untouched by the mutation tests', async () => {
  assert.equal((await runStandards(SRC)).verdict.status, 'pass');
});
