import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

test('POST /v1/orders creates an order (201) and replays on the same Idempotency-Key', async () => {
  const first = await call(base, 'POST', '/v1/orders', { item: 'widget', quantity: 2 }, 'order-key-0001');
  assert.equal(first.status, 201);
  assert.equal(field(first.json, 'status'), 'pending');
  const replay = await call(base, 'POST', '/v1/orders', { item: 'widget', quantity: 2 }, 'order-key-0001');
  assert.equal(replay.status, 201);
  assert.equal(field(replay.json, 'id'), field(first.json, 'id'));
  const conflict = await call(base, 'POST', '/v1/orders', { item: 'other', quantity: 1 }, 'order-key-0001');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.type, 'application/problem+json');
});

test('POST /v1/orders rejects invalid bodies with 422 problem+json', async () => {
  const res = await call(base, 'POST', '/v1/orders', { item: '', quantity: 0 }, 'order-key-0002');
  assert.equal(res.status, 422);
  assert.equal(res.type, 'application/problem+json');
  for (const k of ['type', 'title', 'status', 'detail', 'instance']) assert.ok(field(res.json, k) !== undefined, k);
  assert.equal(field(res.json, 'instance'), '/v1/orders');
});

test('GET /v1/orders/:id returns 404 problem+json for unknown ids', async () => {
  const res = await call(base, 'GET', '/v1/orders/00000000-0000-4000-8000-000000000000');
  assert.equal(res.status, 404);
  assert.equal(res.type, 'application/problem+json');
});

test('GET /v1/orders paginates with an opaque cursor', async () => {
  for (let i = 0; i < 3; i++) await call(base, 'POST', '/v1/orders', { item: `bulk-${i}`, quantity: 1 }, `order-bulk-${i}-key`);
  const page1 = await call(base, 'GET', '/v1/orders?limit=2');
  assert.equal(page1.status, 200);
  const cursor = field(page1.json, 'nextCursor');
  assert.equal(typeof cursor, 'string');
  const page2 = await call(base, 'GET', `/v1/orders?limit=2&cursor=${String(cursor)}`);
  assert.equal(page2.status, 200);
  const bad = await call(base, 'GET', '/v1/orders?cursor=%%%');
  assert.equal(bad.status, 422);
});

test('PATCH /v1/orders/:id ships an order; quantity changes after shipping are 409', async () => {
  const created = await call(base, 'POST', '/v1/orders', { item: 'gadget', quantity: 1 }, 'order-key-0003');
  const id = String(field(created.json, 'id'));
  const shipped = await call(base, 'PATCH', `/v1/orders/${id}`, { status: 'shipped' });
  assert.equal(shipped.status, 200);
  assert.equal(field(shipped.json, 'status'), 'shipped');
  const late = await call(base, 'PATCH', `/v1/orders/${id}`, { quantity: 5 });
  assert.equal(late.status, 409);
});
