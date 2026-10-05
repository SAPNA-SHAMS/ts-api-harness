# tests: node:test against the real app
```ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { call, field, start } from './helpers.ts';

let base = '';
let server: Server | undefined;
before(async () => ({ base, server } = await start()));
after(() => server?.close());

test('GET /v1/widgets/:id returns 404 problem+json', async () => {
  const res = await call(base, 'GET', '/v1/widgets/00000000-0000-4000-8000-000000000000');
  assert.equal(res.status, 404);
  assert.equal(res.type, 'application/problem+json');
});
```
`call(base, method, path, body?, idempotencyKey?)` returns `{ status, type, json }`.
POST requests need an Idempotency-Key (8+ chars). Write the test first: the harness must see it fail.
