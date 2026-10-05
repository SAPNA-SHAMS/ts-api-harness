import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

test('DELETE /v1/orders/:id cancels a pending order (204) and it is gone', async () => {
  const created = await call(base, 'POST', '/v1/orders', { item: 'cancel-me', quantity: 1 }, 'cancel-key-0001');
  const path = `/v1/orders/${String(field(created.json, 'id'))}`;
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
  const path = `/v1/orders/${String(field(created.json, 'id'))}`;
  await call(base, 'PATCH', path, { status: 'shipped' });
  const res = await call(base, 'DELETE', path);
  assert.equal(res.status, 409);
  assert.equal(res.type, 'application/problem+json');
  assert.equal(field(res.json, 'status'), 409);
});
