// The loop: call the model through a driver, gate every tool call with pre/post hooks, feed back
// compact results, and stop only when the harness's own completion gates are green.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { formatStandards, runStandards } from './checker.ts';
import { baselineKickoff, baselineSystem, DISPATCH_TOOL, jitKickoff, jitSystem, jitToolSpecs, renderJit, renderRaw, type HistItem } from './context.ts';
import { gateWrite, isTestFile, newGateState, normalizeRel, WRITE_TOOLS } from './gates.ts';
import { loadRegistry } from './registry.ts';
import { runTestFile } from './runner.ts';
import type { HookDecision, ModelRequest, ToolContext, ToolDef, ToolOutput, ToolSpec } from './sdk.ts';
import { ship, type ShipResult } from './ship.ts';
import { loadTask, outputDir } from './task.ts';
import { coreTools } from './tools.ts';
import { ensureDir, estimateTokens, hashFiles, listFilesRec, loadConfig, OUT_ROOT, REPO_ROOT, sha256, writeText } from './util.ts';

export type RunOptions = {
  taskPath: string;
  driverId: string;
  mode: 'jit' | 'baseline';
  ship: boolean;
  push: boolean;
  maxTurns?: number;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
};

export type TurnTokens = {
  turn: number;
  actualInputTokens: number;
  actualInputTokensEstimated: number;
  baselineInputTokensEstimated: number;
  outputTokens: number;
  tools: string[];
};

export type GateResult = { id: string; status: 'pass' | 'fail' | 'unproven'; detail: string };

export type RunReport = {
  runId: string;
  task: string;
  taskFile: string;
  mode: 'jit' | 'baseline';
  driver: string;
  model: string | undefined;
  verdict: 'green' | 'red' | 'unproven' | 'error';
  reason: string;
  turns: number;
  gates: GateResult[];
  standards: string;
  hooks: { pass: number; block: number; record: number; blockedBy: Record<string, number> };
  observedRed: { source: string; unlockedBy: string }[];
  hashes: { taskFile: string; hooks: string; checks: string; core: string; drivers: string };
  ship: ShipResult | undefined;
  paths: { logs: string; tokens: string; report: string; workspace: string };
};

const MAX_OUTPUT_TOKENS = 8000;

export const newRunId = (task: string, driver: string, mode: string): string =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${task}-${driver}-${mode}-${Math.random().toString(36).slice(2, 8)}`;

function hashOf(globs: string[]): string {
  const files = globs.flatMap((g) => listFilesRec(join(REPO_ROOT, g)).map((f) => join(g, f)));
  return hashFiles(REPO_ROOT, files.filter((f) => f.endsWith('.ts') || f.endsWith('.json')));
}

export function governanceHashes(taskFile: string): RunReport['hashes'] {
  return {
    taskFile: sha256(readFileSync(taskFile, 'utf8')),
    hooks: hashOf(['plugins/hooks']) + ':' + sha256(readFileSync(join(REPO_ROOT, 'src/core/gates.ts'), 'utf8')).slice(0, 16),
    checks: hashOf(['plugins/rules', 'plugins/validators']),
    core: hashOf(['src/core']),
    drivers: hashOf(['drivers']),
  };
}

export async function runTask(opts: RunOptions): Promise<RunReport> {
  const config = loadConfig();
  const reg = await loadRegistry();
  const say = (s: string): void => {
    if (opts.quiet !== true) process.stdout.write(`${s}\n`);
  };

  const driverDef = reg.drivers.get(opts.driverId);
  if (driverDef === undefined) throw new Error(`unknown driver '${opts.driverId}'. Registered: ${[...reg.drivers.keys()].join(', ')}`);
  const taskFile = resolve(opts.taskPath);
  const { task, info, text: taskText } = loadTask(taskFile, [...reg.drivers.keys()]);
  const driver = driverDef.create(opts.env ?? process.env);

  const runId = newRunId(task.name, opts.driverId, opts.mode);
  const logDir = join(OUT_ROOT, 'logs', runId);
  const workspace = join(REPO_ROOT, 'runs', runId, 'workspace');
  const tokensPath = join(OUT_ROOT, 'tokens', `${runId}.json`);
  const reportPath = join(OUT_ROOT, 'reports', `${runId}.json`);
  ensureDir(logDir);

  // Workspace: greenfield starts from the harness scaffold; brownfield from a copy of the repo.
  if (task.mode === 'greenfield') cpSync(join(REPO_ROOT, 'context', 'scaffold'), workspace, { recursive: true });
  else {
    const src = resolve(REPO_ROOT, task.repo);
    if (!existsSync(src)) throw new Error(`brownfield repo not found: ${task.repo}`);
    cpSync(src, workspace, { recursive: true, filter: (p) => !p.includes('node_modules') });
  }
  const initialFiles = listFilesRec(workspace);
  const initialText = new Map(initialFiles.map((f) => [f, readFileSync(join(workspace, f), 'utf8')]));
  const state = newGateState(initialFiles);
  let logSeq = 0;
  const nextLogPath = (label: string): string => join(logDir, `${String(++logSeq).padStart(3, '0')}-${label}.log`);
  const relLog = (p: string): string => relative(REPO_ROOT, p);

  const ctx: ToolContext = {
    workspace,
    task: info,
    mode: opts.mode,
    repoRoot: REPO_ROOT,
    listFiles: () => listFilesRec(workspace),
    readText: (rel) => {
      const p = join(workspace, rel);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    },
    initialText: (rel) => initialText.get(rel),
    runStandards: (o) => runStandards(workspace, { task: info, ...(o?.fastOnly === true ? { fastOnly: true } : {}) }),
  };

  // Brownfield regression baseline: the existing tests must be green before the change.
  const preexistingTests = initialFiles.filter(isTestFile);
  const gates: GateResult[] = [];
  if (task.mode === 'brownfield') {
    const before = await Promise.all(preexistingTests.map((f) => runTestFile(workspace, f, nextLogPath(`pre-${f.replace(/[/.]/g, '_')}`))));
    const red = before.filter((r) => r.status !== 'green');
    gates.push({
      id: 'regression-baseline',
      status: before.length === 0 ? 'unproven' : red.length === 0 ? 'pass' : 'unproven',
      detail: before.length === 0 ? 'no existing tests' : red.length === 0 ? `${before.length} existing test files green before the change` : `existing tests already red: ${red.map((r) => r.file).join(', ')}`,
    });
    say(`[harness] regression baseline: ${gates[0]?.detail ?? ''}`);
  }

  const tools = new Map<string, ToolDef>();
  for (const t of coreTools({ task, state, logDir, readFileMaxLines: config.readFileMaxLines, nextLogPath })) tools.set(t.name, t);
  for (const [name, t] of reg.tools) if (!tools.has(name)) tools.set(name, t);
  const toolSpecs: ToolSpec[] = [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const jitTools = jitToolSpecs(toolSpecs, task.mode);

  const systemJit = jitSystem();
  const systemBase = baselineSystem(initialFiles.map((rel) => ({ rel, text: initialText.get(rel) ?? '' })));
  const history: HistItem[] = [{ kind: 'user', jit: jitKickoff(task), raw: baselineKickoff(task, taskText) }];
  const turns: TurnTokens[] = [];
  const hookLog: unknown[] = [];
  const hookCounts = { pass: 0, block: 0, record: 0, blockedBy: {} as Record<string, number> };
  const transcript: unknown[] = [];
  let model: string | undefined;
  let finished: { green: boolean; gates: GateResult[]; standards: string } | undefined;
  let verdictReason = '';
  let errored = false;
  let idleTurns = 0;
  const maxTurns = opts.maxTurns ?? config.maxTurns;

  const record = (gate: string, tool: string, d: HookDecision, args: Record<string, unknown>): void => {
    hookCounts[d.decision]++;
    if (d.decision === 'block') hookCounts.blockedBy[gate] = (hookCounts.blockedBy[gate] ?? 0) + 1;
    hookLog.push({ turn: turns.length, gate, tool, path: args['path'], decision: d.decision, feedback: d.feedback });
  };

  const finishGates = async (): Promise<{ green: boolean; gates: GateResult[]; standards: string; out: ToolOutput }> => {
    const g: GateResult[] = [];
    const testFiles = listFilesRec(workspace).filter(isTestFile);
    const runs = await Promise.all(testFiles.map((f) => runTestFile(workspace, f, nextLogPath(`finish-${f.replace(/[/.]/g, '_')}`))));
    const notGreen = runs.filter((r) => r.status !== 'green');
    g.push({
      id: 'tests',
      status: runs.length === 0 ? 'unproven' : notGreen.length === 0 ? 'pass' : 'fail',
      detail: runs.length === 0 ? 'no test files' : notGreen.length === 0 ? `${runs.reduce((n, r) => n + r.passed, 0)} tests green in ${runs.length} files` : notGreen.map((r) => `${r.file}: ${r.status} ${r.firstFailure}`).join('; '),
    });
    if (task.mode === 'brownfield') {
      const regressed = runs.filter((r) => preexistingTests.includes(r.file) && r.status !== 'green');
      const missing = preexistingTests.filter((f) => !testFiles.includes(f));
      g.push({
        id: 'regression',
        status: regressed.length === 0 && missing.length === 0 ? 'pass' : 'fail',
        detail: regressed.length === 0 && missing.length === 0 ? `${preexistingTests.length} pre-existing test files still green` : `regressed: ${[...regressed.map((r) => r.file), ...missing].join(', ')}`,
      });
    }
    const sources = [...state.written].filter((f) => f.startsWith('src/'));
    const unproven = sources.filter((s) => !state.unlockedBy.has(s));
    g.push({
      id: 'observed-red',
      status: sources.length === 0 ? 'fail' : unproven.length === 0 ? 'pass' : 'fail',
      detail: sources.length === 0 ? 'no source file was changed' : unproven.length === 0 ? `${sources.length} source files each unlocked by an observed-red test` : `no observed red for ${unproven.join(', ')}`,
    });
    const report = await runStandards(workspace, { task: info });
    const standards = formatStandards(report);
    writeText(join(logDir, 'standards-latest.txt'), standards);
    g.push({ id: 'standards', status: report.verdict.status, detail: `${report.verdict.percent}% (${report.verdict.passing}/${report.verdict.applicable} rules)` });
    const green = g.every((x) => x.status === 'pass');
    const lines = g.map((x) => `${x.status.toUpperCase().padEnd(8)} ${x.id}: ${x.detail}`);
    const failing = formatStandards(report, { onlyFailures: true, perFile: true });
    return {
      green,
      gates: g,
      standards,
      out: {
        status: green ? 'pass' : 'refused',
        summary: green ? 'FINISH ACCEPTED: all gates green' : `FINISH REFUSED: ${g.filter((x) => x.status !== 'pass').map((x) => x.id).join(', ')}`,
        compact: `${green ? 'FINISH ACCEPTED' : 'FINISH REFUSED'}\n${lines.join('\n')}${green ? '' : `\n${failing}`}`,
        raw: `${lines.join('\n')}\n\n${standards}`,
      },
    };
  };

  say(`[harness] run ${runId}`);
  say(`[harness] driver=${opts.driverId} mode=${opts.mode} task=${task.name}`);
  say(`[harness] tools: ${[...tools.keys()].join(', ')}`);
  say(`[harness] rules: ${reg.rules.map((r) => r.id).join(', ')}; hooks: ${reg.hooks.map((h) => h.id).join(', ')}`);

  for (let turn = 1; turn <= maxTurns && finished === undefined; turn++) {
    const jitReq: ModelRequest = {
      system: systemJit,
      messages: renderJit(history, config.compaction.keepRecentToolResults, config.compaction.elideArgsOverChars),
      tools: jitTools,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    const baseReq: ModelRequest = { system: systemBase, messages: renderRaw(history), tools: toolSpecs, maxOutputTokens: MAX_OUTPUT_TOKENS };
    const sent = opts.mode === 'jit' ? jitReq : baseReq;
    let resp;
    try {
      resp = await driver.run(sent);
    } catch (err) {
      verdictReason = `driver error: ${err instanceof Error ? err.message : String(err)}`;
      errored = true;
      say(`[harness] ${verdictReason}`);
      break;
    }
    model = resp.model ?? model;
    turns.push({
      turn,
      actualInputTokens: resp.usage.inputTokens,
      actualInputTokensEstimated: estimateTokens(JSON.stringify(sent)),
      baselineInputTokensEstimated: estimateTokens(JSON.stringify(baseReq)),
      outputTokens: resp.usage.outputTokens,
      tools: resp.toolCalls.map((c) => c.name),
    });
    history.push({ kind: 'assistant', text: resp.text, calls: resp.toolCalls });

    if (resp.toolCalls.length === 0) {
      idleTurns++;
      transcript.push({ turn, text: resp.text, calls: [] });
      if (idleTurns >= 3) {
        verdictReason = 'model stopped calling tools before the gates were green';
        break;
      }
      const nudge = 'No tool was called. Only the harness decides completion: continue with tools, and call finish when you believe every gate is green.';
      history.push({ kind: 'user', jit: nudge, raw: nudge });
      continue;
    }
    idleTurns = 0;

    const results: Extract<HistItem, { kind: 'tool' }>['results'] = [];
    for (const wire of resp.toolCalls) {
      // use_tool is only a transport for deferred schemas: hooks and gates see the real tool.
      const call = wire.name === DISPATCH_TOOL && typeof wire.args['name'] === 'string'
        ? { id: wire.id, name: wire.args['name'], args: typeof wire.args['args'] === 'object' && wire.args['args'] !== null ? (wire.args['args'] as Record<string, unknown>) : {} }
        : wire;
      const def = tools.get(call.name);
      let out: ToolOutput;
      const feedback: string[] = [];
      if (def === undefined) out = { status: 'error', summary: `unknown tool '${call.name}'` };
      else {
        let blocked: string | undefined;
        if (WRITE_TOOLS.has(call.name)) {
          const content = typeof call.args['content'] === 'string' ? call.args['content'] : typeof call.args['replace'] === 'string' ? call.args['replace'] : '';
          const d = gateWrite(normalizeRel(call.args['path']), content, state, task, listFilesRec(workspace).filter(isTestFile));
          record(d.gate, call.name, d, call.args);
          if (d.decision === 'block') blocked = d.feedback ?? `BLOCKED ${d.gate}`;
        }
        for (const h of reg.hooks.filter((x) => x.phase === 'pre' && (x.tools === '*' || x.tools.includes(call.name)))) {
          if (blocked !== undefined) break;
          const d = await h.run({ phase: 'pre', tool: call.name, args: call.args, ctx });
          record(h.id, call.name, d, call.args);
          if (d.decision === 'block') blocked = d.feedback ?? `BLOCKED ${h.id}`;
          else if (d.feedback !== undefined) feedback.push(d.feedback);
        }
        if (blocked !== undefined) out = { status: 'blocked', summary: blocked };
        else if (call.name === 'finish') {
          const f = await finishGates();
          out = f.out;
          if (f.green) finished = f;
          else gates.splice(task.mode === 'brownfield' ? 1 : 0, Infinity, ...f.gates);
        } else {
          try {
            out = await def.run(call.args, ctx);
          } catch (err) {
            out = { status: 'error', summary: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}` };
          }
          for (const h of reg.hooks.filter((x) => x.phase === 'post' && (x.tools === '*' || x.tools.includes(call.name)))) {
            const d = await h.run({ phase: 'post', tool: call.name, args: call.args, output: out, ctx });
            record(h.id, call.name, d, call.args);
            if (d.feedback !== undefined) feedback.push(d.feedback);
          }
        }
      }
      let jit = out.compact ?? out.summary;
      if (feedback.length > 0) jit = `${jit}\n${feedback.join('\n')}`;
      const raw = `${out.raw ?? out.compact ?? out.summary}${feedback.length > 0 ? `\n${feedback.join('\n')}` : ''}`;
      if (out.raw !== undefined && out.raw.length > jit.length) {
        const p = nextLogPath(`tool-${call.name}`);
        writeText(p, out.raw);
        if (!jit.includes('log: ')) jit = `${jit}\nlog: ${relLog(p)}`;
      }
      results.push({ callId: wire.id, name: wire.name, summary: out.summary, jit, raw });
      transcript.push({ turn, tool: call.name, path: call.args['path'], status: out.status, summary: out.summary, feedback });
      say(`[turn ${String(turn).padStart(2)}] ${call.name}${typeof call.args['path'] === 'string' ? ` ${call.args['path']}` : ''} → ${out.summary}${feedback.length > 0 ? ` | ${feedback.map((f) => f.split('\n')[0]).join(' | ')}` : ''}`);
    }
    history.push({ kind: 'tool', results });
  }

  if (finished !== undefined) gates.splice(task.mode === 'brownfield' ? 1 : 0, Infinity, ...finished.gates);
  else if (verdictReason === '') verdictReason = `turn budget (${maxTurns}) exhausted before finish was accepted`;
  const green = finished !== undefined && gates.every((g) => g.status === 'pass');
  const standards = finished?.standards ?? formatStandards(await runStandards(workspace, { task: info }));
  writeText(join(logDir, 'standards.txt'), standards);

  let shipResult: ShipResult | undefined;
  if (opts.ship) {
    shipResult = await ship({
      runId,
      task,
      info,
      driverId: opts.driverId,
      workspace,
      green,
      push: opts.push,
      config,
      gateSummary: gates.map((g) => `${g.id}: ${g.status} (${g.detail})`),
    });
    say(`[harness] ship: ${shipResult.status}${shipResult.branch !== undefined ? ` ${shipResult.branch}` : ''}${shipResult.reason !== undefined ? ` (${shipResult.reason})` : ''}`);
  }

  const verdict: RunReport['verdict'] = errored ? 'error' : green ? 'green' : gates.some((g) => g.status === 'fail') || finished === undefined ? 'red' : 'unproven';
  const report: RunReport = {
    runId,
    task: task.name,
    taskFile: relative(REPO_ROOT, taskFile),
    mode: opts.mode,
    driver: opts.driverId,
    model,
    verdict,
    reason: green ? 'all gates green' : verdictReason || 'gates not green',
    turns: turns.length,
    gates,
    standards,
    hooks: hookCounts,
    observedRed: [...state.unlockedBy].map(([source, unlockedBy]) => ({ source, unlockedBy })),
    hashes: governanceHashes(taskFile),
    ship: shipResult,
    paths: { logs: relLog(logDir), tokens: relLog(tokensPath), report: relLog(reportPath), workspace: relLog(workspace) },
  };

  const sum = (k: keyof TurnTokens): number => turns.reduce((n, t) => n + (typeof t[k] === 'number' ? t[k] : 0), 0);
  const actualEst = sum('actualInputTokensEstimated');
  const baseEst = sum('baselineInputTokensEstimated');
  const tokenReport = {
    runId,
    task: task.name,
    driver: opts.driverId,
    model,
    mode: opts.mode,
    contextFetchers: opts.mode === 'jit',
    compaction: opts.mode === 'jit',
    estimator: 'ceil(chars/4) over the serialized request (system + messages + tool specs), applied identically to both columns',
    baseline: 'same conversation rendered with context fetchers and compaction disabled: standards, references and every workspace file front-loaded; raw tool output; no compaction',
    turns,
    totals: {
      turns: turns.length,
      actualInputTokens: sum('actualInputTokens'),
      actualInputTokensEstimated: actualEst,
      baselineInputTokensEstimated: baseEst,
      outputTokens: sum('outputTokens'),
    },
    reductionPercent: baseEst === 0 ? 0 : Math.round((1 - actualEst / baseEst) * 1000) / 10,
    systemPromptTokens: { jit: estimateTokens(systemJit), baseline: estimateTokens(systemBase) },
    verdict,
  };
  writeText(tokensPath, `${JSON.stringify(tokenReport, null, 2)}\n`);
  writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeText(join(logDir, 'hooks.jsonl'), hookLog.map((h) => JSON.stringify(h)).join('\n') + '\n');
  writeText(join(logDir, 'transcript.jsonl'), transcript.map((t) => JSON.stringify(t)).join('\n') + '\n');
  writeText(join(logDir, 'summary.txt'), summarize(report, tokenReport.reductionPercent, outputDir(task)));
  say(summarize(report, tokenReport.reductionPercent, outputDir(task)));
  return report;
}

export function summarize(r: RunReport, reduction: number, dest: string): string {
  return [
    '',
    `verdict    ${r.verdict.toUpperCase()}  (${r.reason})`,
    ...r.gates.map((g) => `gate       ${g.status.toUpperCase().padEnd(8)} ${g.id}: ${g.detail}`),
    `hooks      ${r.hooks.pass} pass, ${r.hooks.block} blocked, ${r.hooks.record} recorded  ${JSON.stringify(r.hooks.blockedBy)}`,
    `tokens     ${reduction}% fewer input tokens than baseline → ${r.paths.tokens}`,
    `ship       ${r.ship === undefined ? 'not requested' : `${r.ship.status}${r.ship.branch !== undefined ? ` ${r.ship.branch} → ${dest}` : ''}; push ${r.ship.push}; PR ${r.ship.pullRequest}${r.ship.reason !== undefined ? ` (${r.ship.reason})` : ''}`}`,
    `report     ${r.paths.report}`,
    `logs       ${r.paths.logs}`,
    '',
  ].join('\n');
}
