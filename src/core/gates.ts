// Core pre-tool gates. These run before every write and cannot be disabled by configuration:
// path containment, harness-owned files, secrets, brownfield scope and observed red.
import { isAbsolute, normalize } from 'node:path';
import type { HookDecision } from './sdk.ts';
import type { Task } from './task.ts';
import type { TestRun } from './runner.ts';
import { globToRegExp, matchesAny } from './util.ts';

export const HARNESS_OWNED = ['src/lib/**', 'src/server.ts', 'test/helpers.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'contract.snapshot.json'];
export const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const SHARED_SOURCES = ['src/app.ts', 'src/index.ts'];

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'provider API key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, 'provider API key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
];

export type GateState = {
  versions: Map<string, number>;
  redAt: Map<string, Set<number>>;
  lastRun: Map<string, TestRun>;
  unlockedBy: Map<string, string>;
  written: Set<string>;
  initialFiles: Set<string>;
};

export function newGateState(initialFiles: readonly string[]): GateState {
  return { versions: new Map(), redAt: new Map(), lastRun: new Map(), unlockedBy: new Map(), written: new Set(), initialFiles: new Set(initialFiles) };
}

export const isTestFile = (rel: string): boolean => rel.startsWith('test/') && rel.endsWith('.test.ts');
export const isSourceFile = (rel: string): boolean => rel.startsWith('src/');

export function normalizeRel(p: unknown): string | undefined {
  if (typeof p !== 'string' || p.length === 0 || isAbsolute(p)) return undefined;
  const n = normalize(p).split('\\').join('/');
  if (n.startsWith('..') || n.includes('/../') || n.startsWith('/')) return undefined;
  return n;
}

const tokens = (rel: string): string[] =>
  rel.replace(/\.test\.ts$|\.ts$/, '').split(/[/.\-_]/).filter((t) => t.length > 0 && !['src', 'test', 'lib', 'index'].includes(t));

/** Tests that cover a source file: explicit task map, shared entry files, then name convention. */
export function testsFor(source: string, testFiles: readonly string[], task: Task): string[] {
  const explicit = task.testMap.filter((m) => globToRegExp(m.source).test(source)).flatMap((m) => testFiles.filter((t) => globToRegExp(m.tests).test(t)));
  if (explicit.length > 0) return [...new Set(explicit)];
  if (SHARED_SOURCES.includes(source)) return [...testFiles];
  const srcTokens = new Set(tokens(source));
  return testFiles.filter((t) => {
    const lead = tokens(t)[0];
    return lead !== undefined && srcTokens.has(lead);
  });
}

export function scopeGlobs(task: Task): string[] {
  if (task.mode !== 'brownfield') return [];
  if (task.scope.length > 0) return task.scope;
  return [`src/${task.resource.name}/**`, 'src/app.ts', 'test/**'];
}

export function gateWrite(rel: string | undefined, content: string, state: GateState, task: Task, testFiles: readonly string[]): HookDecision & { gate: string } {
  if (rel === undefined) return { gate: 'path-guard', decision: 'block', feedback: 'BLOCKED path-guard: path must be relative and inside the workspace' };
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return { gate: 'path-guard', decision: 'block', feedback: `BLOCKED path-guard: ${rel} is not writable` };
  if (!rel.startsWith('src/') && !rel.startsWith('test/')) return { gate: 'path-guard', decision: 'block', feedback: `BLOCKED path-guard: only src/** and test/** are writable, not ${rel}` };
  if (!rel.endsWith('.ts')) return { gate: 'path-guard', decision: 'block', feedback: `BLOCKED path-guard: only .ts files are writable` };
  if (matchesAny(rel, HARNESS_OWNED)) return { gate: 'harness-owned', decision: 'block', feedback: `BLOCKED harness-owned: ${rel} is owned by the harness (read it, import from it, do not edit it)` };
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(content)) return { gate: 'secret-guard', decision: 'block', feedback: `BLOCKED secret-guard: content contains what looks like a ${what}` };
  }
  const scope = scopeGlobs(task);
  if (scope.length > 0 && !matchesAny(rel, scope)) return { gate: 'scope-guard', decision: 'block', feedback: `BLOCKED scope-guard: ${rel} is outside the change scope (${scope.join(', ')})` };
  if (isSourceFile(rel)) {
    const mapped = testsFor(rel, testFiles, task);
    const red = mapped.find((t) => state.redAt.get(t)?.has(state.versions.get(t) ?? 0) === true);
    if (red === undefined) {
      const hint = mapped.length === 0
        ? `no test maps to ${rel}; write test/<name>.test.ts first`
        : `mapped tests ${mapped.join(', ')} have not been observed failing at their current version; run_tests first`;
      return { gate: 'observed-red', decision: 'block', feedback: `BLOCKED observed-red: ${hint}` };
    }
    if (!state.unlockedBy.has(rel)) state.unlockedBy.set(rel, red);
    return { gate: 'observed-red', decision: 'pass' };
  }
  if (isTestFile(rel) || rel.startsWith('test/')) return { gate: 'test-write', decision: 'pass' };
  return { gate: 'path-guard', decision: 'pass' };
}
