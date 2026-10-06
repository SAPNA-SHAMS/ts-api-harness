// Built-in tools. Every tool returns a one-line summary, a compact form for the model and the
// raw form for disk. Writes go through the gates in the engine before these run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatStandards } from './checker.ts';
import { HARNESS_OWNED, isTestFile, normalizeRel, testsFor, type GateState } from './gates.ts';
import { runTestFile, type TestRun } from './runner.ts';
import type { ToolContext, ToolDef, ToolOutput } from './sdk.ts';
import { defineTool } from './sdk.ts';
import type { Task } from './task.ts';
import ts from 'typescript';
import { ensureDir, lineCount, matchesAny, OUT_ROOT, truncateLines } from './util.ts';

export type ToolRuntime = {
  task: Task;
  state: GateState;
  logDir: string;
  readFileMaxLines: number;
  nextLogPath: (label: string) => string;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/** Declarations without bodies: what a caller needs from a module, at a fraction of its size. */
export function exportSurface(rel: string, text: string): string {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const head = (n: ts.Node, body: ts.Node | undefined): string => text.slice(n.getStart(sf), body === undefined ? n.end : body.getStart(sf)).trim();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) continue;
    const docs = ts.getJSDocCommentsAndTags(st).map((d) => d.getText(sf));
    if (ts.isFunctionDeclaration(st)) out.push(...docs, `${head(st, st.body)};`);
    else if (ts.isClassDeclaration(st)) {
      const members = st.members.map((m) => (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ? `  ${head(m, m.body)};` : `  ${m.getText(sf)}`));
      out.push(...docs, `${head(st, st.members[0]) || head(st, undefined)}`.replace(/\{?\s*$/, '{'), ...members, '}');
    } else out.push(...docs, st.getText(sf));
  }
  return out.join('\n');
}

function bump(state: GateState, rel: string): void {
  state.versions.set(rel, (state.versions.get(rel) ?? 0) + 1);
  state.written.add(rel);
}

function describeRun(r: TestRun, logRel: string): string {
  const head = `${r.status.toUpperCase()} ${r.file} ${r.passed} passed, ${r.failed} failed`;
  return r.status === 'green' ? head : `${head}\n  first failure: ${r.firstFailure}\n  log: ${logRel}`;
}

export function coreTools(rt: ToolRuntime): ToolDef[] {
  const testFiles = (ctx: ToolContext): string[] => ctx.listFiles().filter(isTestFile);

  return [
    defineTool({
      name: 'get_task',
      description: 'The task: resource, fields, routes, acceptance.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: (_args, ctx) => {
        const t = rt.task;
        const lines = [`task ${t.name} (${t.mode}): ${t.description}`];
        if (t.mode === 'greenfield') {
          lines.push(`resource ${t.resource.name} (singular ${t.resource.singular}), api ${t.apiVersion}`);
          for (const f of t.resource.fields) lines.push(`  field ${f.name}: ${f.type}${f.required ? '' : '?'}${f.unique ? ' unique' : ''}${f.min !== undefined ? ` min ${f.min}` : ''}${f.max !== undefined ? ` max ${f.max}` : ''}`);
        } else {
          lines.push(`change: ${t.change.summary}`);
        }
        for (const r of ctx.task.expectedRoutes) lines.push(`  route ${r.method} ${r.path} (${r.behavior})`);
        for (const a of t.acceptance) lines.push(`  accept: ${a}`);
        const text = lines.join('\n');
        return { status: 'ok', summary: `task ${t.name}: ${ctx.task.expectedRoutes.length} routes`, compact: text, raw: JSON.stringify(t, null, 2), pin: true };
      },
    }),
    defineTool({
      name: 'get_scope',
      description: 'Relevant files, the tests mapped to them, harness-owned files.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: (_args, ctx) => {
        const files = ctx.listFiles();
        const res = rt.task.resource.name;
        const tests = files.filter(isTestFile);
        const relevant = files.filter((f) => f.startsWith('src/') && !f.startsWith('src/lib/') && (f.includes(res) || f === 'src/app.ts'));
        const lines = relevant.map((f) => `  ${f} → tests: ${testsFor(f, tests, rt.task).join(', ') || '(none yet)'}`);
        if (rt.task.mode === 'greenfield' && relevant.length === 0) {
          lines.push(`  (new) src/${res}/schema.ts, src/${res}/store.ts, src/${res}/routes.ts, src/app.ts → test/${res}.test.ts`);
        }
        const owned = files.filter((f) => f.startsWith('src/lib/') || f === 'test/helpers.ts');
        const text = [`scope for ${rt.task.name}:`, ...lines, `harness-owned (import, do not edit): ${owned.join(', ')}`].join('\n');
        return { status: 'ok', summary: `${relevant.length} relevant files, ${tests.length} tests`, compact: text, raw: `${text}\n\nall files:\n${files.join('\n')}`, pin: true };
      },
    }),
    defineTool({
      name: 'list_files',
      description: 'List files with line counts.',
      parameters: { type: 'object', properties: { dir: { type: 'string' } }, additionalProperties: false },
      run: (args, ctx) => {
        const dir = str(args['dir']) ?? '';
        const files = ctx.listFiles().filter((f) => f.startsWith(dir));
        const text = files.map((f) => `${f} (${lineCount(ctx.readText(f) ?? '')} lines)`).join('\n');
        return { status: 'ok', summary: `${files.length} files under '${dir || '.'}'`, compact: text };
      },
    }),
    defineTool({
      name: 'read_file',
      description: 'Read a file; start/end lines fetch a slice.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const rel = normalizeRel(args['path']);
        // Log paths handed out by the harness (logs/<this run>/...) are readable; nothing else outside the workspace.
        const logRel = rel !== undefined && rel.startsWith('logs/') ? join(OUT_ROOT, rel) : undefined;
        const text = rel === undefined
          ? undefined
          : logRel !== undefined
            ? (logRel.startsWith(`${rt.logDir}/`) && existsSync(logRel) ? readFileSync(logRel, 'utf8') : undefined)
            : ctx.readText(rel);
        if (rel === undefined || text === undefined) return { status: 'error', summary: `no such file: ${String(args['path'])}` };
        const lines = text.split('\n');
        const ranged = args['start'] !== undefined || args['end'] !== undefined;
        if (!ranged && matchesAny(rel, HARNESS_OWNED) && rel.endsWith('.ts')) {
          const surface = exportSurface(rel, text);
          return {
            status: 'ok',
            summary: `read ${rel} export surface (${lines.length} lines)`,
            compact: `[export surface of a harness-owned file: import from it, do not edit; pass start/end for bodies]\n${surface}`,
            raw: text,
          };
        }
        const start = Math.max(1, int(args['start']) ?? 1);
        const end = Math.min(lines.length, int(args['end']) ?? lines.length);
        const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i}| ${l}`).join('\n');
        return {
          status: 'ok',
          summary: `read ${rel} lines ${start}-${end} of ${lines.length}`,
          compact: truncateLines(numbered, rt.readFileMaxLines),
          raw: text,
        };
      },
    }),
    defineTool({
      name: 'write_file',
      description: 'Create/replace a src/ or test/ file. src/ needs an observed-red test.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const rel = normalizeRel(args['path']);
        const content = str(args['content']);
        if (rel === undefined || content === undefined) return { status: 'error', summary: 'write_file needs path and content' };
        const abs = join(ctx.workspace, rel);
        ensureDir(dirname(abs));
        writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
        bump(rt.state, rel);
        return { status: 'ok', summary: `wrote ${rel} (${lineCount(content)} lines)` };
      },
    }),
    defineTool({
      name: 'edit_file',
      description: 'Replace the unique occurrence of find with replace. Gated like write_file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['path', 'find', 'replace'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const rel = normalizeRel(args['path']);
        const find = str(args['find']);
        const replace = str(args['replace']);
        if (rel === undefined || find === undefined || replace === undefined || find.length === 0) return { status: 'error', summary: 'edit_file needs path, find and replace' };
        const abs = join(ctx.workspace, rel);
        if (!existsSync(abs)) return { status: 'error', summary: `no such file: ${rel}` };
        const text = readFileSync(abs, 'utf8');
        const hits = text.split(find).length - 1;
        if (hits !== 1) return { status: 'error', summary: `edit_file: 'find' matched ${hits} times in ${rel}; it must match exactly once` };
        writeFileSync(abs, text.replace(find, () => replace));
        bump(rt.state, rel);
        return { status: 'ok', summary: `edited ${rel} (-${lineCount(find)} +${lineCount(replace)} lines)` };
      },
    }),
    defineTool({
      name: 'run_tests',
      description: 'Run one test file, or all. The harness records red/green.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      run: async (args, ctx): Promise<ToolOutput> => {
        const one = args['path'] === undefined ? undefined : normalizeRel(args['path']);
        const files = one === undefined ? testFiles(ctx) : [one];
        if (files.length === 0) return { status: 'error', summary: 'no test files (test/*.test.ts) to run' };
        const runs: TestRun[] = [];
        for (const f of files) {
          if (!existsSync(join(ctx.workspace, f))) return { status: 'error', summary: `no such test file: ${f}` };
          const logPath = rt.nextLogPath(`test-${f.replace(/[/.]/g, '_')}`);
          const r = await runTestFile(ctx.workspace, f, logPath);
          runs.push(r);
          rt.state.lastRun.set(f, r);
          if (r.status === 'red') {
            const set = rt.state.redAt.get(f) ?? new Set<number>();
            set.add(rt.state.versions.get(f) ?? 0);
            rt.state.redAt.set(f, set);
          }
        }
        const rel = (p: string): string => p.slice(p.indexOf('logs/'));
        const allGreen = runs.every((r) => r.status === 'green');
        const anyRed = runs.some((r) => r.status === 'red');
        const passed = runs.reduce((n, r) => n + r.passed, 0);
        const failed = runs.reduce((n, r) => n + r.failed, 0);
        return {
          status: allGreen ? 'green' : anyRed ? 'red' : 'error',
          summary: `${allGreen ? 'GREEN' : anyRed ? 'RED' : 'ERROR'} ${runs.length} file(s): ${passed} passed, ${failed} failed`,
          compact: runs.map((r) => describeRun(r, rel(r.logPath))).join('\n'),
          raw: runs.map((r) => `$ node --test ${r.file}\n${r.raw}`).join('\n'),
        };
      },
    }),
    defineTool({
      name: 'run_checks',
      description: 'Run every API standards check.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, ctx) => {
        const report = await ctx.runStandards();
        const v = report.verdict;
        return {
          status: v.status === 'pass' ? 'pass' : v.status === 'fail' ? 'fail' : 'unproven',
          summary: `standards ${v.status.toUpperCase()} ${v.percent}% (${v.passing}/${v.applicable} rules)`,
          compact: formatStandards(report, { onlyFailures: true }),
          raw: formatStandards(report),
        };
      },
    }),
    defineTool({
      name: 'finish',
      description: 'Request completion; the harness runs every gate.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
      // The engine intercepts finish and runs the completion gates; this body is never the decider.
      run: () => ({ status: 'refused', summary: 'finish is handled by the engine' }),
    }),
  ];
}
