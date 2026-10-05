#!/usr/bin/env node
// harness run | check | plugins | snapshot | tokens
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCheckContext } from './apimodel.ts';
import { formatStandards, runStandards } from './checker.ts';
import { extractContract, SNAPSHOT_FILE } from './contract.ts';
import { runTask } from './engine.ts';
import { newGateState } from './gates.ts';
import { loadRegistry } from './registry.ts';
import { loadTask } from './task.ts';
import { coreTools } from './tools.ts';
import { REPO_ROOT, writeText } from './util.ts';

function flags(argv: string[]): { cmd: string; opts: Map<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const opts = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const next = rest[i + 1];
    if (inline !== undefined) opts.set(k, inline);
    else if (next !== undefined && !next.startsWith('--')) {
      opts.set(k, next);
      i++;
    } else opts.set(k, true);
  }
  return { cmd, opts };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function main(): Promise<number> {
  const { cmd, opts } = flags(process.argv.slice(2));
  const reg = await loadRegistry();

  if (cmd === 'run') {
    const task = str(opts.get('task'));
    const driver = str(opts.get('driver'));
    if (task === undefined || driver === undefined) {
      process.stderr.write(`usage: harness run --task <file> --driver <${[...reg.drivers.keys()].join('|')}> [--baseline] [--with-baseline] [--no-ship] [--no-push] [--max-turns N]\n`);
      return 2;
    }
    const maxTurnsRaw = str(opts.get('max-turns'));
    const common = { taskPath: task, driverId: driver, ...(maxTurnsRaw !== undefined ? { maxTurns: Number(maxTurnsRaw) } : {}) };
    let baselineTokensFile: string | undefined;
    if (opts.has('with-baseline')) {
      process.stdout.write('[harness] measured baseline run: context fetchers and compaction disabled\n');
      const b = await runTask({ ...common, mode: 'baseline', ship: false, push: false });
      baselineTokensFile = join(REPO_ROOT, b.paths.tokens);
    }
    const r = await runTask({ ...common, mode: opts.has('baseline') ? 'baseline' : 'jit', ship: !opts.has('no-ship'), push: !opts.has('no-push') });
    if (baselineTokensFile !== undefined) attachMeasuredBaseline(join(REPO_ROOT, r.paths.tokens), baselineTokensFile);
    return r.verdict === 'green' ? 0 : 1;
  }

  if (cmd === 'check') {
    const api = str(opts.get('api'));
    if (api === undefined) {
      process.stderr.write('usage: harness check --api <dir> [--task <file>] [--json]\n');
      return 2;
    }
    const taskPath = str(opts.get('task'));
    const info = taskPath === undefined ? undefined : loadTask(resolve(taskPath), [...reg.drivers.keys()]).info;
    const report = await runStandards(resolve(api), info === undefined ? {} : { task: info });
    process.stdout.write(opts.has('json') ? `${JSON.stringify(report, null, 2)}\n` : `${formatStandards(report)}\n`);
    return report.verdict.status === 'pass' ? 0 : 1;
  }

  if (cmd === 'plugins' || cmd === 'tools') {
    const core = coreTools({ task: undefined as never, state: newGateState([]), logDir: '', readFileMaxLines: 0, nextLogPath: () => '' });
    const lines = [
      ...core.map((t) => `tool       ${t.name.padEnd(28)} src/core/tools.ts (core)`),
      ...reg.loaded.map((p) => `${p.kind.padEnd(10)} ${p.id.padEnd(28)} ${p.file}`),
      ...reg.errors.map((e) => `ERROR      ${e}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return reg.errors.length === 0 ? 0 : 1;
  }

  if (cmd === 'snapshot') {
    const api = str(opts.get('api'));
    if (api === undefined) {
      process.stderr.write('usage: harness snapshot --api <dir>\n');
      return 2;
    }
    const contract = extractContract(buildCheckContext(resolve(api), undefined));
    writeText(join(resolve(api), SNAPSHOT_FILE), `${JSON.stringify(contract, null, 2)}\n`);
    process.stdout.write(`wrote ${SNAPSHOT_FILE} with ${contract.routes.length} routes\n`);
    return 0;
  }

  if (cmd === 'tokens') {
    const file = str(opts.get('file'));
    if (file === undefined || !existsSync(file)) {
      process.stderr.write('usage: harness tokens --file tokens/<run>.json\n');
      return 2;
    }
    const t = JSON.parse(readFileSync(file, 'utf8')) as { turns: { turn: number; actualInputTokensEstimated: number; baselineInputTokensEstimated: number }[]; reductionPercent: number };
    for (const x of t.turns) process.stdout.write(`turn ${String(x.turn).padStart(2)}  actual ${String(x.actualInputTokensEstimated).padStart(7)}  baseline ${String(x.baselineInputTokensEstimated).padStart(7)}\n`);
    process.stdout.write(`reduction ${t.reductionPercent}%\n`);
    return 0;
  }

  process.stdout.write(`harness — governs TypeScript REST API work

  harness run --task <file> --driver <${[...reg.drivers.keys()].join('|')}> [--with-baseline] [--baseline] [--no-ship] [--no-push]
  harness check --api <dir> [--task <file>] [--json]
  harness plugins                 list registered tools, rules, validators, hooks, drivers
  harness snapshot --api <dir>    write contract.snapshot.json for an existing API
  harness tokens --file <tokens/run.json>
`);
  return cmd === 'help' ? 0 : 2;
}

function attachMeasuredBaseline(actualFile: string, baselineFile: string): void {
  type T = { runId: string; turns: { actualInputTokens: number }[]; totals: { actualInputTokens: number; turns: number }; [k: string]: unknown };
  const actual = JSON.parse(readFileSync(actualFile, 'utf8')) as T;
  const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as T;
  actual['measuredBaseline'] = {
    runId: base.runId,
    note: 'a separate run of the same task on the same driver with context fetchers and compaction disabled; input tokens as reported by the driver',
    perTurnInputTokens: base.turns.map((t) => t.actualInputTokens),
    totalInputTokens: base.totals.actualInputTokens,
    turns: base.totals.turns,
  };
  actual['reductionVsMeasuredBaselinePercent'] =
    base.totals.actualInputTokens === 0 ? 0 : Math.round((1 - actual.totals.actualInputTokens / base.totals.actualInputTokens) * 1000) / 10;
  writeText(actualFile, `${JSON.stringify(actual, null, 2)}\n`);
  process.stdout.write(`[harness] measured baseline ${base.totals.actualInputTokens} vs actual ${actual.totals.actualInputTokens} input tokens → ${String(actual['reductionVsMeasuredBaselinePercent'])}% reduction (${actualFile.slice(REPO_ROOT.length + 1)})\n`);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`harness: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
