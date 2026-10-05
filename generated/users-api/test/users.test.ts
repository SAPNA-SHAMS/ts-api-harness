import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

const valid = (n: number): Record<string, unknown> => ({
  name: `name-${n}`,
  email: `user${n}@example.com`,
  age: 0,
});

test('POST /v1/users creates (201) and replays the same Idempotency-Key', async () => {
  const first = await call(base, 'POST', '/v1/users', valid(1), 'create-key-0001');
  assert.equal(first.status, 201);
  assert.equal(first.type, 'application/json');
  assert.equal(typeof field(first.json, 'id'), 'string');
  const replay = await call(base, 'POST', '/v1/users', valid(1), 'create-key-0001');
  assert.equal(replay.status, 201);
  assert.equal(field(replay.json, 'id'), field(first.json, 'id'));
  const reused = await call(base, 'POST', '/v1/users', valid(2), 'create-key-0001');
  assert.equal(reused.status, 409);
  assert.equal(reused.type, 'application/problem+json');
});

test('POST /v1/users rejects an invalid body with 422 problem+json', async () => {
  const res = await call(base, 'POST', '/v1/users', { ...valid(99), email: 'not-an-email' }, 'create-key-0002');
  assert.equal(res.status, 422);
  assert.equal(res.type, 'application/problem+json');
  for (const k of ['type', 'title', 'status', 'detail', 'instance']) assert.ok(field(res.json, k) !== undefined, k);
  assert.equal(field(res.json, 'status'), 422);
  assert.equal(field(res.json, 'instance'), '/v1/users');
});

test('POST /v1/users without an Idempotency-Key is 422', async () => {
  const res = await call(base, 'POST', '/v1/users', valid(3));
  assert.equal(res.status, 422);
  assert.equal(res.type, 'application/problem+json');
});

test('POST /v1/users with a duplicate email is 409 problem+json', async () => {
  await call(base, 'POST', '/v1/users', valid(4), 'dup-key-0001');
  const res = await call(base, 'POST', '/v1/users', { ...valid(5), email: valid(4)['email'] }, 'dup-key-0002');
  assert.equal(res.status, 409);
  assert.equal(res.type, 'application/problem+json');
});

test('GET /v1/users/:id returns the item, or 404 problem+json', async () => {
  const created = await call(base, 'POST', '/v1/users', valid(6), 'get-key-0001');
  const res = await call(base, 'GET', `/v1/users/${String(field(created.json, 'id'))}`);
  assert.equal(res.status, 200);
  const missing = await call(base, 'GET', '/v1/users/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.type, 'application/problem+json');
  const badId = await call(base, 'GET', '/v1/users/not-a-uuid');
  assert.equal(badId.status, 422);
});

test('GET /v1/users paginates with an opaque cursor', async () => {
  for (let i = 10; i < 13; i++) await call(base, 'POST', '/v1/users', valid(i), `list-key-${i}-0001`);
  const page1 = await call(base, 'GET', '/v1/users?limit=2');
  assert.equal(page1.status, 200);
  const data = field(page1.json, 'data');
  assert.ok(Array.isArray(data) && data.length === 2);
  const cursor = field(page1.json, 'nextCursor');
  assert.equal(typeof cursor, 'string');
  const page2 = await call(base, 'GET', `/v1/users?limit=2&cursor=${String(cursor)}`);
  assert.equal(page2.status, 200);
  const bad = await call(base, 'GET', '/v1/users?cursor=%%%');
  assert.equal(bad.status, 422);
  assert.equal(bad.type, 'application/problem+json');
});

test('PATCH /v1/users/:id updates (200), 404 when missing, 422 when invalid', async () => {
  const created = await call(base, 'POST', '/v1/users', valid(20), 'patch-key-0001');
  const id = String(field(created.json, 'id'));
  const res = await call(base, 'PATCH', `/v1/users/${id}`, { name: valid(21)['name'] });
  assert.equal(res.status, 200);
  assert.equal(field(res.json, 'name'), valid(21)['name']);
  const missing = await call(base, 'PATCH', '/v1/users/00000000-0000-4000-8000-000000000000', { name: valid(22)['name'] });
  assert.equal(missing.status, 404);
  const invalid = await call(base, 'PATCH', `/v1/users/${id}`, { unknownField: true });
  assert.equal(invalid.status, 422);
});

test('DELETE /v1/users/:id returns 204, then 404', async () => {
  const created = await call(base, 'POST', '/v1/users', valid(30), 'delete-key-0001');
  const path = `/v1/users/${String(field(created.json, 'id'))}`;
  const res = await call(base, 'DELETE', path);
  assert.equal(res.status, 204);
  const gone = await call(base, 'GET', path);
  assert.equal(gone.status, 404);
  const again = await call(base, 'DELETE', path);
  assert.equal(again.status, 404);
  assert.equal(again.type, 'application/problem+json');
});
