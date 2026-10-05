import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateWrite, newGateState, testsFor } from '../src/core/gates.ts';
import { runTestFile } from '../src/core/runner.ts';
import { TaskSchema, type Task } from '../src/core/task.ts';
import { REPO_ROOT } from '../src/core/util.ts';

const green: Task = TaskSchema.parse({
  name: 'widgets', mode: 'greenfield', description: 'd',
  resource: { name: 'widgets', singular: 'widget', fields: [{ name: 'name', type: 'string' }] }, behaviors: ['create'],
});
const brown: Task = TaskSchema.parse({
  name: 'orders-x', mode: 'brownfield', description: 'd', repo: 'examples/orders-api', resource: { name: 'orders' }, change: { summary: 's', adds: ['delete'] },
});

test('path-guard refuses traversal, absolute paths and non-source files', () => {
  const s = newGateState([]);
  assert.equal(gateWrite(undefined, '', s, green, []).decision, 'block');
  assert.match(gateWrite('README.md', '', s, green, []).feedback ?? '', /only src\/\*\* and test\/\*\*/);
  assert.equal(gateWrite('node_modules/x.ts', '', s, green, []).decision, 'block');
});

test('harness-owned files are read-only', () => {
  const s = newGateState([]);
  for (const p of ['src/lib/http.ts', 'src/server.ts', 'test/helpers.ts']) assert.equal(gateWrite(p, 'x', s, green, []).gate, 'harness-owned');
});

test('secret-guard blocks key-shaped content', () => {
  const s = newGateState([]);
  const key = ['sk', 'ant', 'api03', 'A'.repeat(30)].join('-');
  assert.equal(gateWrite('test/widgets.test.ts', `const k = '${key}';`, s, green, []).gate, 'secret-guard');
});

test('observed-red: source refused until a mapped test was seen failing at its current version', () => {
  const s = newGateState([]);
  const tests = ['test/widgets.test.ts'];
  assert.equal(gateWrite('src/widgets/store.ts', 'x', s, green, tests).decision, 'block');
  s.versions.set('test/widgets.test.ts', 1);
  s.redAt.set('test/widgets.test.ts', new Set([1]));
  assert.equal(gateWrite('src/widgets/store.ts', 'x', s, green, tests).decision, 'pass');
  assert.equal(s.unlockedBy.get('src/widgets/store.ts'), 'test/widgets.test.ts');
  // Editing the test again invalidates the observation for further source edits.
  s.versions.set('test/widgets.test.ts', 2);
  assert.equal(gateWrite('src/widgets/routes.ts', 'x', s, green, tests).decision, 'block');
});

test('scope-guard confines brownfield writes to the change scope', () => {
  const s = newGateState([]);
  assert.equal(gateWrite('src/payments/x.ts', 'x', s, brown, []).gate, 'scope-guard');
  assert.notEqual(gateWrite('test/orders-cancel.test.ts', 'x', s, brown, []).gate, 'scope-guard');
});

test('test mapping: resource name convention and shared entry files', () => {
  const tests = ['test/orders.test.ts', 'test/orders-cancel.test.ts', 'test/users.test.ts'];
  assert.deepEqual(testsFor('src/orders/routes.ts', tests, brown), ['test/orders.test.ts', 'test/orders-cancel.test.ts']);
  assert.deepEqual(testsFor('src/app.ts', tests, brown), tests);
});

test('runner: failing file is RED, passing file GREEN, a file with no tests is never GREEN', async () => {
  const dir = join(REPO_ROOT, 'runs', `runner-${process.pid}`);
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test/a.test.ts'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => assert.equal(1, 2));\n");
  writeFileSync(join(dir, 'test/b.test.ts'), "import { test } from 'node:test';\ntest('x', () => {});\n");
  writeFileSync(join(dir, 'test/c.test.ts'), 'export {};\n');
  try {
    assert.equal((await runTestFile(dir, 'test/a.test.ts', join(dir, 'a.log'))).status, 'red');
    assert.equal((await runTestFile(dir, 'test/b.test.ts', join(dir, 'b.log'))).status, 'green');
    assert.notEqual((await runTestFile(dir, 'test/c.test.ts', join(dir, 'c.log'))).status, 'green');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
