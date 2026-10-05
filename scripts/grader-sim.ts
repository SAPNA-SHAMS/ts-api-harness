// Simulates the extensibility grader: in a scratch git clone of this repo, add (1) a new tool,
// (2) a custom ORM validator, (3) a linter rule, one at a time. After each, show that it is live
// and that `git diff --stat` touches only the plugin's own files plus a registry entry.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, writeText } from '../src/core/util.ts';

const CORE = 'src/core/';

const OPENAPI_DIFF = `// Grader addition 1: a new tool, registered by dropping this file into plugins/tools/.
import { buildCheckContext } from '../../src/core/apimodel.ts';
import { extractContract, readSnapshot } from '../../src/core/contract.ts';
import { defineTool } from '../../src/core/sdk.ts';

const toPaths = (routes: { method: string; path: string }[]): string[] =>
  routes.map((r) => \`\${r.method.toLowerCase()} \${r.path.replace(/:(\\w+)/g, '{$1}')}\`).sort();

export default defineTool({
  name: 'openapi_diff',
  description: 'OpenAPI-style path diff between the shipped snapshot and the current routes.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run(_args, ctx) {
    const now = toPaths(extractContract(buildCheckContext(ctx.workspace, ctx.task)).routes);
    const before = toPaths(readSnapshot(ctx.workspace)?.routes ?? []);
    const added = now.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !now.includes(p));
    return { status: 'ok', summary: \`openapi: +\${added.length} -\${removed.length} operations\`, compact: [...added.map((a) => \`+ \${a}\`), ...removed.map((r) => \`- \${r}\`)].join('\\n') || 'no change' };
  },
});
`;

const DRIZZLE_VALIDATOR = `// Grader addition 2: a custom ORM validator, registered by dropping this file into plugins/validators/.
import ts from 'typescript';
import { defineValidator, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

export default defineValidator({
  id: 'drizzle-users-select-columns',
  description: 'every Drizzle query on users selects explicit columns',
  run(ctx) {
    const findings: Finding[] = [];
    let queries = 0;
    const files = new Set<string>();
    for (const f of ctx.src) {
      walk(f.sf, (n) => {
        if (!ts.isCallExpression(n) || !/\\.from$/.test(n.expression.getText(f.sf)) || n.arguments[0]?.getText(f.sf) !== 'users') return;
        queries++;
        files.add(f.rel);
        const sel = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : undefined;
        if (sel !== undefined && ts.isCallExpression(sel) && sel.arguments.length === 0) {
          findings.push({ file: f.rel, line: f.line(n.getStart(f.sf)), message: 'select() on users must name its columns' });
        }
      }, ts);
    }
    return ruleResult({ unit: 'queries', total: queries, files: [...files], findings });
  },
});
`;

const NO_CONSOLE_RULE = `// Grader addition 3: a linter rule, registered through plugins/registry.json.
import ts from 'typescript';
import { defineRule, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

export default defineRule({
  id: 'no-console',
  description: 'no console.* calls in API source',
  run(ctx) {
    const findings: Finding[] = [];
    for (const f of ctx.src) {
      walk(f.sf, (n) => {
        if (ts.isCallExpression(n) && /^console\\./.test(n.expression.getText(f.sf))) {
          findings.push({ file: f.rel, line: f.line(n.getStart(f.sf)), message: \`\${n.expression.getText(f.sf)} in API source\` });
        }
      }, ts);
    }
    return ruleResult({ unit: 'files', total: ctx.src.length, files: ctx.src.map((f) => f.rel), findings, failedUnits: new Set(findings.map((x) => x.file)).size });
  },
});
`;

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

export function graderSim(): { ok: boolean; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-grader-'));
  const repo = join(dir, 'repo');
  const out: string[] = [];
  let ok = true;
  const say = (s: string): void => void out.push(s);
  try {
    cpSync(REPO_ROOT, repo, {
      recursive: true,
      filter: (src) => !/\/(node_modules|runs|\.git)(\/|$)/.test(src.slice(REPO_ROOT.length)),
    });
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(repo, 'node_modules'));
    sh('git', ['init', '-q', '-b', 'main'], repo);
    sh('git', ['add', '-A'], repo);
    sh('git', ['-c', 'user.name=grader', '-c', 'user.email=grader@localhost', 'commit', '-q', '-m', 'baseline'], repo);

    // A throwaway API with a Drizzle query and a console call, outside the repo, so the new
    // validator and rule have something to fail on.
    const fixture = join(repo, '..', 'fixture-api');
    cpSync(join(repo, 'examples', 'orders-api'), fixture, { recursive: true });
    writeText(join(fixture, 'src', 'orders', 'users-query.ts'), "declare const db: { select: () => { from: (t: unknown) => unknown } };\ndeclare const users: unknown;\nexport const all = (): unknown => db.select().from(users);\nexport const log = (): void => console.log('x');\n");

    const step = (title: string, files: Record<string, string>, verify: () => boolean): void => {
      for (const [rel, text] of Object.entries(files)) writeText(join(repo, rel), text);
      sh('git', ['add', '-N', '.'], repo);
      const stat = sh('git', ['diff', '--stat'], repo).trim();
      const changed = sh('git', ['diff', '--name-only'], repo).trim().split('\n').filter((l) => l.length > 0);
      const coreTouched = changed.filter((f) => f.startsWith(CORE));
      say(`\n== ${title}\n$ git diff --stat\n${stat}`);
      say(`core (${CORE}) touched: ${coreTouched.length === 0 ? 'no' : coreTouched.join(', ')}`);
      const live = verify();
      const pass = live && coreTouched.length === 0;
      ok &&= pass;
      say(`result: ${pass ? 'PASS (live, core untouched)' : 'FAIL'}`);
      sh('git', ['add', '-A'], repo);
      sh('git', ['-c', 'user.name=grader', '-c', 'user.email=grader@localhost', 'commit', '-q', '-m', title], repo);
    };

    step('1. register a new tool (openapi_diff)', { 'plugins/tools/openapi-diff.ts': OPENAPI_DIFF }, () => {
      const listing = sh(process.execPath, ['src/core/cli.ts', 'plugins'], repo);
      const run = sh(process.execPath, ['scripts/offline-run.ts', '--task', 'tasks/orders-cancel.json', '--driver', 'openai', '--no-ship', '--max-turns', '1'], repo);
      const toolsLine = run.split('\n').find((l) => l.startsWith('[harness] tools:')) ?? '';
      say(`$ harness plugins | grep openapi\n${listing.split('\n').filter((l) => l.includes('openapi')).join('\n')}`);
      say(`$ harness run … (next run)\n${toolsLine}`);
      return listing.includes('openapi_diff') && toolsLine.includes('openapi_diff');
    });

    step('2. add a custom ORM validator (drizzle-users-select-columns)', { 'plugins/validators/drizzle-users-select-columns.ts': DRIZZLE_VALIDATOR }, () => {
      const check = sh(process.execPath, ['src/core/cli.ts', 'check', '--api', fixture], repo);
      const lines = check.split('\n').filter((l) => l.startsWith('drizzle-users-select-columns'));
      say(`$ harness check --api <fixture with db.select().from(users)>\n${lines.join('\n')}`);
      return lines.some((l) => /FAIL\s+src\/orders\/users-query\.ts:3/.test(l));
    });

    step('3. add a linter rule via the registry manifest (no-console)', {
      'plugins/custom/no-console.ts': NO_CONSOLE_RULE,
      'plugins/registry.json': `${JSON.stringify({ modules: ['plugins/custom/no-console.ts'] }, null, 2)}\n`,
    }, () => {
      const check = sh(process.execPath, ['src/core/cli.ts', 'check', '--api', fixture], repo);
      const lines = check.split('\n').filter((l) => l.startsWith('no-console'));
      say(`$ harness check --api <fixture>\n${lines.filter((l) => /FAIL|files/.test(l)).join('\n')}`);
      const clean = sh(process.execPath, ['src/core/cli.ts', 'check', '--api', 'examples/orders-api'], repo);
      say(`$ harness check --api examples/orders-api | grep no-console\n${clean.split('\n').filter((l) => /^no-console\s+(pass|FAIL)\s+\d/.test(l)).join('\n')}`);
      return lines.some((l) => /FAIL\s+src\/orders\/users-query\.ts:4/.test(l));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  say(`\ngrader-sim: ${ok ? 'PASS' : 'FAIL'} (core directory: ${CORE})`);
  return { ok, log: out.join('\n') };
}

if (import.meta.main) {
  const r = graderSim();
  process.stdout.write(`${r.log}\n`);
  writeText(join(REPO_ROOT, 'reports', 'grader-sim.txt'), `${r.log}\n`);
  process.exit(r.ok ? 0 : 1);
}
