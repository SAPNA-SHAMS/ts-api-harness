// A scripted stand-in for a model, used only when no provider key is available. It plays a fixed
// plan for a task and deliberately trips three gates (source-before-red, a non-RFC-7807 throw, an
// attempt to delete an existing test) so the evidence shows the hooks working. It knows nothing
// about the harness internals: it only sees tool results arriving over the provider wire format.
import { readFileSync } from 'node:fs';

export type Step = { name: string; args: Record<string, unknown> };
export type Seen = { name: string; args: Record<string, unknown>; result: string };

type Field = { name: string; type: string; required?: boolean; unique?: boolean; min?: number; max?: number };
type GreenTask = { name: string; mode: 'greenfield'; apiVersion?: string; resource: { name: string; singular: string; fields: Field[] }; behaviors: string[] };
type BrownTask = { name: string; mode: 'brownfield'; resource: { name: string } };

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function zodFor(f: Field): string {
  const range = (base: string): string => `${base}${f.min !== undefined ? `.min(${f.min})` : ''}${f.max !== undefined ? `.max(${f.max})` : ''}`;
  switch (f.type) {
    case 'email':
      return 'z.email()';
    case 'integer':
      return range('z.number().int()');
    case 'number':
      return range('z.number()');
    case 'boolean':
      return 'z.boolean()';
    case 'datetime':
      return 'z.iso.datetime()';
    default:
      return range('z.string()');
  }
}

function sampleFor(f: Field): string {
  switch (f.type) {
    case 'email':
      return '`user${n}@example.com`';
    case 'integer':
      return String(f.min ?? 1);
    case 'number':
      return String(f.min ?? 1.5);
    case 'boolean':
      return 'true';
    case 'datetime':
      return "'2024-01-01T00:00:00.000Z'";
    default:
      return `\`${f.name}-\${n}\``;
  }
}

function greenfieldFiles(t: GreenTask): Record<string, string> {
  const plural = t.resource.name;
  const S = cap(t.resource.singular);
  const v = t.apiVersion ?? 'v1';
  const fields = t.resource.fields;
  const has = (b: string): boolean => t.behaviors.includes(b);
  const unique = fields.filter((f) => f.unique === true);

  const schema = `import { z } from 'zod';
import { PageQuery, pageOf } from '../lib/pagination.ts';

export const ${S} = z.object({
  id: z.uuid(),
${fields.map((f) => `  ${f.name}: ${zodFor(f)}${f.required === false ? '.optional()' : ''},`).join('\n')}
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ${S} = z.infer<typeof ${S}>;

export const ${S}Create = z
  .object({
${fields.map((f) => `    ${f.name}: ${zodFor(f)}${f.required === false ? '.optional()' : ''},`).join('\n')}
  })
  .strict();
export type ${S}Create = z.infer<typeof ${S}Create>;

export const ${S}Update = z
  .object({
${fields.map((f) => `    ${f.name}: ${zodFor(f)}.optional(),`).join('\n')}
  })
  .strict();
export type ${S}Update = z.infer<typeof ${S}Update>;

export const ${S}IdParams = z.object({ id: z.uuid() }).strict();
export const List${cap(plural)}Query = PageQuery;
export const ${S}Page = pageOf(${S});
`;

  const uniqueCheck = unique.length === 0 ? '' : `
  #assertUnique(input: { ${unique.map((f) => `${f.name}?: ${f.type === 'integer' || f.type === 'number' ? 'number' : 'string'} | undefined`).join('; ')} }, selfId: string | undefined): void {
    for (const existing of this.#items.values()) {
      if (existing.id === selfId) continue;
${unique.map((f) => `      if (input.${f.name} !== undefined && String(existing.${f.name}).toLowerCase() === String(input.${f.name}).toLowerCase()) {
        throw problem(409, 'conflict', '${S} already exists', \`A ${t.resource.singular} with ${f.name} '\${String(input.${f.name})}' already exists\`);
      }`).join('\n')}
    }
  }
`;
  const store = `import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { problem } from '../lib/problem.ts';
import type { ${S}, ${S}Create, ${S}Update } from './schema.ts';

export class ${S}Store {
  readonly #items = new Map<string, ${S}>();

  list(cursor: string | undefined, limit: number): { data: ${S}[]; nextCursor: string | null } {
    return paginate([...this.#items.values()], cursor, limit);
  }

  get(id: string): ${S} {
    const item = this.#items.get(id);
    if (item === undefined) throw problem(404, 'not-found', '${S} not found', \`No ${t.resource.singular} with id '\${id}'\`);
    return item;
  }

  create(input: ${S}Create): ${S} {${unique.length > 0 ? '\n    this.#assertUnique(input, undefined);' : ''}
    const now = new Date().toISOString();
    const item: ${S} = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.#items.set(item.id, item);
    return item;
  }

  update(id: string, patch: ${S}Update): ${S} {
    const current = this.get(id);${unique.length > 0 ? '\n    this.#assertUnique(patch, id);' : ''}
    const next: ${S} = {
      ...current,
${fields.map((f) => `      ${f.name}: patch.${f.name} ?? current.${f.name},`).join('\n')}
      updatedAt: new Date().toISOString(),
    };
    this.#items.set(id, next);
    return next;
  }

  remove(id: string): void {
    this.get(id);
    this.#items.delete(id);
  }
${uniqueCheck}}
`;

  const route = (b: string, flawed: boolean): string => {
    const coll = `/${v}/${plural}`;
    switch (b) {
      case 'list':
        return `    defineRoute({
      method: 'GET',
      path: '${coll}',
      status: 200,
      errors: [422],
      params: NoParams,
      query: List${cap(plural)}Query,
      body: NoBody,
      response: ${S}Page,
      handler: async ({ query }) => store.list(query.cursor, query.limit),
    }),`;
      case 'get':
        return `    defineRoute({
      method: 'GET',
      path: '${coll}/:id',
      status: 200,
      errors: [404, 422],
      params: ${S}IdParams,
      query: NoParams,
      body: NoBody,
      response: ${S},
      handler: async ({ params }) => ${flawed ? `{
        try {
          return store.get(params.id);
        } catch {
          throw new Error('${S} not found');
        }
      }` : 'store.get(params.id)'},
    }),`;
      case 'create':
        return `    defineRoute({
      method: 'POST',
      path: '${coll}',
      status: 201,
      idempotent: true,
      errors: [409, 422],
      params: NoParams,
      query: NoParams,
      body: ${S}Create,
      response: ${S},
      handler: async ({ body }) => store.create(body),
    }),`;
      case 'update':
        return `    defineRoute({
      method: 'PATCH',
      path: '${coll}/:id',
      status: 200,
      errors: [404, ${unique.length > 0 ? '409, ' : ''}422],
      params: ${S}IdParams,
      query: NoParams,
      body: ${S}Update,
      response: ${S},
      handler: async ({ params, body }) => store.update(params.id, body),
    }),`;
      default:
        return `    defineRoute({
      method: 'DELETE',
      path: '${coll}/:id',
      status: 204,
      errors: [404, 422],
      params: ${S}IdParams,
      query: NoParams,
      body: NoBody,
      response: NoBody,
      handler: async ({ params }) => {
        store.remove(params.id);
      },
    }),`;
    }
  };
  const routes = (flawed: boolean): string => `import { defineRoute, NoBody, NoParams, type Route } from '../lib/http.ts';
import { List${cap(plural)}Query, ${S}, ${S}Create, ${S}IdParams, ${S}Page, ${S}Update } from './schema.ts';
import type { ${S}Store } from './store.ts';

export function ${t.resource.singular}Routes(store: ${S}Store): Route[] {
  return [
${t.behaviors.map((b) => route(b, flawed)).join('\n')}
  ];
}
`;
  const app = `import type { Server } from 'node:http';
import { createApp } from './lib/http.ts';
import { ${t.resource.singular}Routes } from './${plural}/routes.ts';
import { ${S}Store } from './${plural}/store.ts';

export function buildApp(): Server {
  return createApp([...${t.resource.singular}Routes(new ${S}Store())]);
}
`;
  const coll = `/${v}/${plural}`;
  const missing = "'/" + v + '/' + plural + "/00000000-0000-4000-8000-000000000000'";
  const emailField = fields.find((f) => f.type === 'email');
  const firstString = fields.find((f) => f.type === 'string');
  const bad = emailField !== undefined ? `{ ...valid(99), ${emailField.name}: 'not-an-email' }` : `{ ...valid(99), ${fields[0]?.name ?? 'x'}: 12345 }`;
  const patchField = firstString ?? fields[0];
  const tests: string[] = [];
  if (has('create')) {
    tests.push(`test('POST ${coll} creates (201) and replays the same Idempotency-Key', async () => {
  const first = await call(base, 'POST', '${coll}', valid(1), 'create-key-0001');
  assert.equal(first.status, 201);
  assert.equal(first.type, 'application/json');
  assert.equal(typeof field(first.json, 'id'), 'string');
  const replay = await call(base, 'POST', '${coll}', valid(1), 'create-key-0001');
  assert.equal(replay.status, 201);
  assert.equal(field(replay.json, 'id'), field(first.json, 'id'));
  const reused = await call(base, 'POST', '${coll}', valid(2), 'create-key-0001');
  assert.equal(reused.status, 409);
  assert.equal(reused.type, 'application/problem+json');
});

test('POST ${coll} rejects an invalid body with 422 problem+json', async () => {
  const res = await call(base, 'POST', '${coll}', ${bad}, 'create-key-0002');
  assert.equal(res.status, 422);
  assert.equal(res.type, 'application/problem+json');
  for (const k of ['type', 'title', 'status', 'detail', 'instance']) assert.ok(field(res.json, k) !== undefined, k);
  assert.equal(field(res.json, 'status'), 422);
  assert.equal(field(res.json, 'instance'), '${coll}');
});

test('POST ${coll} without an Idempotency-Key is 422', async () => {
  const res = await call(base, 'POST', '${coll}', valid(3));
  assert.equal(res.status, 422);
  assert.equal(res.type, 'application/problem+json');
});`);
    for (const u of unique) {
      tests.push(`test('POST ${coll} with a duplicate ${u.name} is 409 problem+json', async () => {
  await call(base, 'POST', '${coll}', valid(4), 'dup-key-0001');
  const res = await call(base, 'POST', '${coll}', { ...valid(5), ${u.name}: valid(4)['${u.name}'] }, 'dup-key-0002');
  assert.equal(res.status, 409);
  assert.equal(res.type, 'application/problem+json');
});`);
    }
  }
  if (has('get')) {
    tests.push(`test('GET ${coll}/:id returns the item, or 404 problem+json', async () => {
  const created = await call(base, 'POST', '${coll}', valid(6), 'get-key-0001');
  const res = await call(base, 'GET', \`${coll}/\${String(field(created.json, 'id'))}\`);
  assert.equal(res.status, 200);
  const missing = await call(base, 'GET', ${missing});
  assert.equal(missing.status, 404);
  assert.equal(missing.type, 'application/problem+json');
  const badId = await call(base, 'GET', '${coll}/not-a-uuid');
  assert.equal(badId.status, 422);
});`);
  }
  if (has('list')) {
    tests.push(`test('GET ${coll} paginates with an opaque cursor', async () => {
  for (let i = 10; i < 13; i++) await call(base, 'POST', '${coll}', valid(i), \`list-key-\${i}-0001\`);
  const page1 = await call(base, 'GET', '${coll}?limit=2');
  assert.equal(page1.status, 200);
  const data = field(page1.json, 'data');
  assert.ok(Array.isArray(data) && data.length === 2);
  const cursor = field(page1.json, 'nextCursor');
  assert.equal(typeof cursor, 'string');
  const page2 = await call(base, 'GET', \`${coll}?limit=2&cursor=\${String(cursor)}\`);
  assert.equal(page2.status, 200);
  const bad = await call(base, 'GET', '${coll}?cursor=%%%');
  assert.equal(bad.status, 422);
  assert.equal(bad.type, 'application/problem+json');
});`);
  }
  if (has('update') && patchField !== undefined) {
    tests.push(`test('PATCH ${coll}/:id updates (200), 404 when missing, 422 when invalid', async () => {
  const created = await call(base, 'POST', '${coll}', valid(20), 'patch-key-0001');
  const id = String(field(created.json, 'id'));
  const res = await call(base, 'PATCH', \`${coll}/\${id}\`, { ${patchField.name}: valid(21)['${patchField.name}'] });
  assert.equal(res.status, 200);
  assert.equal(field(res.json, '${patchField.name}'), valid(21)['${patchField.name}']);
  const missing = await call(base, 'PATCH', ${missing}, { ${patchField.name}: valid(22)['${patchField.name}'] });
  assert.equal(missing.status, 404);
  const invalid = await call(base, 'PATCH', \`${coll}/\${id}\`, { unknownField: true });
  assert.equal(invalid.status, 422);
});`);
  }
  if (has('delete')) {
    tests.push(`test('DELETE ${coll}/:id returns 204, then 404', async () => {
  const created = await call(base, 'POST', '${coll}', valid(30), 'delete-key-0001');
  const path = \`${coll}/\${String(field(created.json, 'id'))}\`;
  const res = await call(base, 'DELETE', path);
  assert.equal(res.status, 204);
  const gone = await call(base, 'GET', path);
  assert.equal(gone.status, 404);
  const again = await call(base, 'DELETE', path);
  assert.equal(again.status, 404);
  assert.equal(again.type, 'application/problem+json');
});`);
  }
  const testFile = `import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

const valid = (n: number): Record<string, unknown> => ({
${fields.map((f) => `  ${f.name}: ${sampleFor(f)},`).join('\n')}
});

${tests.join('\n\n')}
`;
  return {
    [`src/${plural}/schema.ts`]: schema,
    [`src/${plural}/store.ts`]: store,
    [`src/${plural}/routes.flawed.ts`]: routes(true),
    [`src/${plural}/routes.ts`]: routes(false),
    'src/app.ts': app,
    [`test/${plural}.test.ts`]: testFile,
  };
}

function greenfieldPlan(t: GreenTask): Step[] {
  const files = greenfieldFiles(t);
  const p = t.resource.name;
  const f = (k: string): string => files[k] ?? '';
  return [
    { name: 'get_task', args: {} },
    { name: 'get_reference', args: { topic: 'routes' } },
    // Deliberate: try to write source before any test has been observed failing.
    { name: 'write_file', args: { path: `src/${p}/schema.ts`, content: f(`src/${p}/schema.ts`) } },
    { name: 'write_file', args: { path: `test/${p}.test.ts`, content: f(`test/${p}.test.ts`) } },
    { name: 'run_tests', args: { path: `test/${p}.test.ts` } },
    { name: 'write_file', args: { path: `src/${p}/schema.ts`, content: f(`src/${p}/schema.ts`) } },
    { name: 'write_file', args: { path: `src/${p}/store.ts`, content: f(`src/${p}/store.ts`) } },
    // Deliberate: a handler that throws a plain Error (not RFC 7807). The post-write hook flags it.
    { name: 'write_file', args: { path: `src/${p}/routes.ts`, content: f(`src/${p}/routes.flawed.ts`) } },
    { name: 'write_file', args: { path: `src/${p}/routes.ts`, content: f(`src/${p}/routes.ts`) } },
    { name: 'write_file', args: { path: 'src/app.ts', content: f('src/app.ts') } },
    { name: 'run_tests', args: {} },
    { name: 'run_checks', args: {} },
    { name: 'finish', args: { summary: `${p} API implemented with tests` } },
  ];
}

const CANCEL_TEST = `import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

test('DELETE /v1/orders/:id cancels a pending order (204) and it is gone', async () => {
  const created = await call(base, 'POST', '/v1/orders', { item: 'cancel-me', quantity: 1 }, 'cancel-key-0001');
  const path = \`/v1/orders/\${String(field(created.json, 'id'))}\`;
  const res = await call(base, 'DELETE', path);
  assert.equal(res.status, 204);
  const gone = await call(base, 'GET', path);
  assert.equal(gone.status, 404);
});

test('DELETE /v1/orders/:id on an unknown order is 404 problem+json', async () => {
  const res = await call(base, 'DELETE', '/v1/orders/00000000-0000-4000-8000-000000000000');
  assert.equal(res.status, 404);
  assert.equal(res.type, 'application/problem+json');
});

test('DELETE /v1/orders/:id on a shipped order is 409 problem+json', async () => {
  const created = await call(base, 'POST', '/v1/orders', { item: 'shipped', quantity: 1 }, 'cancel-key-0002');
  const path = \`/v1/orders/\${String(field(created.json, 'id'))}\`;
  await call(base, 'PATCH', path, { status: 'shipped' });
  const res = await call(base, 'DELETE', path);
  assert.equal(res.status, 409);
  assert.equal(res.type, 'application/problem+json');
  assert.equal(field(res.json, 'status'), 409);
});
`;

function brownfieldPlan(t: BrownTask): Step[] {
  const r = t.resource.name;
  return [
    { name: 'get_task', args: {} },
    { name: 'get_scope', args: {} },
    { name: 'read_file', args: { path: `src/${r}/store.ts`, start: 20, end: 30 } },
    { name: 'read_file', args: { path: `src/${r}/routes.ts`, start: 44, end: 60 } },
    // Deliberate: edit source before a test has been observed failing.
    { name: 'edit_file', args: { path: `src/${r}/routes.ts`, find: '  ];\n}', replace: '    // cancel\n  ];\n}' } },
    // Deliberate: try to delete an existing test to make room. protect-existing-tests blocks it.
    { name: 'write_file', args: { path: `test/${r}.test.ts`, content: "import { test } from 'node:test';\ntest('placeholder', () => {});\n" } },
    { name: 'write_file', args: { path: `test/${r}-cancel.test.ts`, content: CANCEL_TEST } },
    { name: 'run_tests', args: { path: `test/${r}-cancel.test.ts` } },
    {
      name: 'edit_file',
      args: {
        path: `src/${r}/store.ts`,
        find: '  update(id: string, patch: OrderUpdate): Order {',
        replace: `  remove(id: string): void {
    const order = this.get(id);
    if (order.status === 'shipped') {
      throw problem(409, 'order-shipped', 'Order already shipped', \`Order '\${id}' has shipped and cannot be cancelled\`);
    }
    this.#orders.delete(id);
  }

  update(id: string, patch: OrderUpdate): Order {`,
      },
    },
    {
      name: 'edit_file',
      args: {
        path: `src/${r}/routes.ts`,
        find: '      handler: async ({ params, body }) => store.update(params.id, body),\n    }),\n',
        replace: `      handler: async ({ params, body }) => store.update(params.id, body),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/v1/orders/:id',
      status: 204,
      errors: [404, 409, 422],
      params: OrderIdParams,
      query: NoParams,
      body: NoBody,
      response: NoBody,
      handler: async ({ params }) => {
        store.remove(params.id);
      },
    }),
`,
      },
    },
    { name: 'run_tests', args: {} },
    { name: 'run_checks', args: {} },
    { name: 'contract_diff', args: {} },
    { name: 'finish', args: { summary: 'order cancellation added' } },
  ];
}

export function planFor(taskFile: string): Step[] {
  const task = JSON.parse(readFileSync(taskFile, 'utf8')) as GreenTask | BrownTask;
  return task.mode === 'greenfield' ? greenfieldPlan(task) : brownfieldPlan(task);
}

/** Next step for this session; undefined when the plan is exhausted (the stand-in then stops). */
export function nextStep(plan: Step[], served: number): Step | undefined {
  return plan[served];
}
