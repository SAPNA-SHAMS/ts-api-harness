// Grader scenarios end to end: the real CLI, both real drivers, the offline wire-level provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { offlineRun } from '../scripts/offline-run.ts';
import { findLeaks } from '../scripts/lint-agnostic.ts';
import { graderSim } from '../scripts/grader-sim.ts';
import { ship } from '../src/core/ship.ts';
import { loadTask } from '../src/core/task.ts';
import { loadConfig, REPO_ROOT, sha256 } from '../src/core/util.ts';
import type { RunReport } from '../src/core/engine.ts';

// Test runs write their evidence to a scratch directory, not the submission's logs/tokens/reports.
process.env['HARNESS_OUT_DIR'] = join(REPO_ROOT, 'runs', 'test-out');

type Tokens = { reductionPercent: number; turns: { actualInputTokensEstimated: number; baselineInputTokensEstimated: number }[]; reductionVsMeasuredBaselinePercent?: number; contextFetchers: boolean; compaction: boolean };

const reportFrom = (output: string, nth = -1): RunReport => {
  const paths = [...output.matchAll(/report\s+(\S*reports\/\S+\.json)/g)].map((m) => m[1] ?? '');
  const p = paths.at(nth);
  assert.ok(p !== undefined && p.length > 0, `no report path in output:\n${output.slice(-2000)}`);
  return JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8')) as RunReport;
};
const tokensOf = (r: RunReport): Tokens => JSON.parse(readFileSync(join(REPO_ROOT, r.paths.tokens), 'utf8')) as Tokens;

test('model agnosticism: same task file, both drivers, zero diff in task/hooks/checks, both green', async () => {
  const task = join(REPO_ROOT, 'tasks/users-api.json');
  const before = sha256(readFileSync(task, 'utf8'));
  const a = reportFrom((await offlineRun(['--task', 'tasks/users-api.json', '--driver', 'claude', '--no-ship'], { quiet: true })).output);
  const b = reportFrom((await offlineRun(['--task', 'tasks/users-api.json', '--driver', 'openai', '--no-ship'], { quiet: true })).output);
  assert.equal(a.verdict, 'green');
  assert.equal(b.verdict, 'green');
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(sha256(readFileSync(task, 'utf8')), before);
  assert.match(a.standards, /verdict\s+100%/);
  assert.match(b.standards, /verdict\s+100%/);
  assert.deepEqual(findLeaks(), []);
});

test('task files naming a registered driver are rejected', () => {
  assert.throws(() => loadTask(join(REPO_ROOT, 'tasks/users-api.json'), ['users']), /names 'users'/);
});

test('token efficiency: measured baseline vs JIT on the same driver, computed from per-turn numbers', async () => {
  const out = (await offlineRun(['--task', 'tasks/orders-cancel.json', '--driver', 'claude', '--no-ship', '--with-baseline'], { quiet: true })).output;
  const actual = reportFrom(out, -1);
  const baseline = reportFrom(out, -2);
  assert.equal(baseline.mode, 'baseline');
  assert.equal(actual.mode, 'jit');
  const t = tokensOf(actual);
  assert.equal(t.contextFetchers, true);
  assert.equal(t.compaction, true);
  const a = t.turns.reduce((n, x) => n + x.actualInputTokensEstimated, 0);
  const b = t.turns.reduce((n, x) => n + x.baselineInputTokensEstimated, 0);
  assert.equal(t.reductionPercent, Math.round((1 - a / b) * 1000) / 10);
  // Regression floor, not the 90% target: compaction keeps fetched context until the model acts on
  // it (live models looped without that), which costs the scripted run a few points. See docs/design.md §3.
  assert.ok(t.reductionPercent > 80, `shadow-baseline reduction ${t.reductionPercent}%`);
  assert.ok((t.reductionVsMeasuredBaselinePercent ?? 0) > 80, `measured-baseline reduction ${String(t.reductionVsMeasuredBaselinePercent)}%`);
  assert.equal(actual.verdict, 'green');
  assert.equal(baseline.verdict, 'green');
});

test('brownfield: gates block source-before-red and test deletion, regression stays green', async () => {
  const r = reportFrom((await offlineRun(['--task', 'tasks/orders-cancel.json', '--driver', 'openai', '--no-ship'], { quiet: true })).output);
  assert.equal(r.verdict, 'green');
  assert.equal(r.hooks.blockedBy['observed-red'], 1);
  assert.equal(r.hooks.blockedBy['protect-existing-tests'], 1);
  assert.ok(r.gates.some((g) => g.id === 'regression' && g.status === 'pass'));
  assert.deepEqual(r.observedRed.map((o) => o.unlockedBy), ['test/orders-cancel.test.ts', 'test/orders-cancel.test.ts']);
});

test('extensibility: tool, ORM validator and linter rule added without touching src/core', () => {
  const r = graderSim();
  assert.ok(r.ok, r.log);
});

test('ship refuses on red and never targets a protected branch', async () => {
  const { task, info } = loadTask(join(REPO_ROOT, 'tasks/users-api.json'), []);
  const base = { runId: 'test-run-000000', task, info, driverId: 'x', workspace: join(REPO_ROOT, 'context/scaffold'), push: false, gateSummary: [] };
  const red = await ship({ ...base, green: false, config: loadConfig() });
  assert.equal(red.status, 'refused');
  assert.match(red.reason ?? '', /no commit on red/);
  const prot = await ship({ ...base, green: true, config: { ...loadConfig(), branchPrefix: '', protectedBranches: ['*'] } });
  assert.notEqual(prot.status, 'committed');
});
