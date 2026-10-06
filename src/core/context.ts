// What the model sees. JIT mode: a short system prompt, compact tool returns and a compacted
// history. Baseline mode: everything front-loaded, raw tool output, no compaction. The same
// conversation is rendered both ways every turn so the token report compares like with like.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ToolCall, ToolSpec } from './sdk.ts';
import type { Task } from './task.ts';
import { estimateTokens, REPO_ROOT } from './util.ts';

export type HistItem =
  | { kind: 'user'; jit: string; raw: string }
  | { kind: 'assistant'; text: string; calls: ToolCall[] }
  | { kind: 'tool'; results: { callId: string; name: string; summary: string; jit: string; raw: string; pin?: boolean }[] };

const PREAMBLE = `You work in a governed TypeScript REST API workspace. Deterministic harness gates enforce every rule; tools reply PASS, FAIL, BLOCKED, RED, GREEN or UNPROVEN with the reason.
Loop: read the task, write a failing test in test/, run_tests (the harness must observe RED), write src/, run_tests and run_checks until green, then finish. src/lib/**, src/server.ts, test/helpers.ts and config are harness-owned: import, never edit.`;

export function jitSystem(): string {
  return `${PREAMBLE}
Fetch context just in time (task, file slice, conventions topic). Output is compact; full logs are on disk at the given path.`;
}

export function jitKickoff(task: Task): string {
  return `Task '${task.name}' (${task.mode}). Start with get_task.`;
}

function readDir(dir: string): { name: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** The front-loaded prompt a harness without context fetchers would send: docs, references and the whole workspace. */
export function baselineSystem(workspaceFiles: { rel: string; text: string }[]): string {
  const standards = readFileSync(join(REPO_ROOT, 'context', 'standards.md'), 'utf8');
  const sheetPath = join(REPO_ROOT, 'context', 'conventions.md');
  const sheet = existsSync(sheetPath) ? readFileSync(sheetPath, 'utf8') : '';
  const refs = readDir(join(REPO_ROOT, 'context', 'reference')).map((r) => `## reference/${r.name}\n${r.text}`).join('\n');
  const files = workspaceFiles.map((f) => `=== ${f.rel} ===\n${f.text}`).join('\n');
  return `${PREAMBLE}\n\n# Standards\n${standards}\n\n# Conventions\n${sheet}\n\n# References\n${refs}\n\n# Workspace (every file)\n${files}`;
}

export function baselineKickoff(task: Task, taskText: string): string {
  return `Task '${task.name}' (${task.mode}). Full task file:\n${taskText}`;
}

export function renderRaw(history: HistItem[]): Message[] {
  return history.map((h): Message => {
    if (h.kind === 'user') return { role: 'user', text: h.raw };
    if (h.kind === 'assistant') return { role: 'assistant', text: h.text, toolCalls: h.calls };
    return { role: 'tool', results: h.results.map((r) => ({ callId: r.callId, name: r.name, content: r.raw })) };
  });
}

function elideArgs(calls: ToolCall[], elideOver: number): ToolCall[] {
  // A call's arguments have already been executed; large ones (file bodies) live on disk now.
  return calls.map((c) => ({
    ...c,
    args: Object.fromEntries(
      Object.entries(c.args).map(([k, v]) =>
        typeof v === 'string' && v.length > elideOver ? [k, `[${v.split('\n').length} lines, applied; read_file to view]`] : [k, v],
      ),
    ),
  }));
}

function digestLine(call: ToolCall, summary: string): string {
  const target = typeof call.args['path'] === 'string' ? ` ${call.args['path']}` : typeof call.args['topic'] === 'string' ? ` ${call.args['topic']}` : '';
  return `- ${call.name}${target} → ${summary}`;
}

/**
 * Compaction. Tool exchanges are kept verbatim from the newest backwards until `keepRecentTokens`
 * is spent (always at least the latest one), and never after the model's action before last (write,
 * edit, test run, finish), so fetched context survives until it is used and the latest action's own
 * arguments stay visible; older turns collapse into a progress digest (one line
 * per call) in the opening message. Pinned results (task, scope) stay verbatim in the opening
 * message for the whole run, latest per tool. Executed arguments over `elideOver` chars are elided.
 */
/** Tools that act on fetched context; exploration before the latest one has been consumed. */
const ACTIONS = new Set(['write_file', 'edit_file', 'run_tests', 'finish']);

export function renderJit(history: HistItem[], keepRecentTokens: number, elideOver: number): Message[] {
  const [first, ...rest] = history;
  if (first === undefined || first.kind !== 'user') return renderRaw(history);
  let start = rest.length;
  let spent = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const h = rest[i];
    if (h?.kind !== 'assistant') continue;
    const next = rest[i + 1];
    const cost = next?.kind === 'tool' ? estimateTokens(next.results.map((r) => r.jit).join('\n')) : 0;
    if (start < rest.length && spent + cost > keepRecentTokens) break;
    spent += cost;
    start = i;
  }
  if (start === rest.length) start = 0;
  // Context is kept until consumed: nothing fetched since the model's last action is compacted.
  const acted = (c: ToolCall): boolean => ACTIONS.has(c.name === DISPATCH_TOOL && typeof c.args['name'] === 'string' ? c.args['name'] : c.name);
  const actions = rest.flatMap((h, i) => (h.kind === 'assistant' && h.calls.some(acted) ? [i] : []));
  const lastAction = actions.at(-1) ?? -1;
  // Keep from the action before last: the model sees its latest action, its result, and the context that informed it.
  start = Math.min(start, actions.at(-2) ?? 0);
  const pinned = new Map<string, string>();
  for (const h of rest) if (h.kind === 'tool') for (const r of h.results) if (r.pin === true) pinned.set(r.name, r.jit);
  const digest: string[] = [];
  const summaries = new Map<string, string>();
  for (const h of rest.slice(0, start)) if (h.kind === 'tool') for (const r of h.results) summaries.set(r.callId, r.summary);
  // One line per (tool, target): repeated fetches of the same thing collapse to their latest result.
  const lines = new Map<string, string>();
  let n = 0;
  for (const h of rest.slice(0, start)) {
    if (h.kind === 'assistant') {
      if (h.text.trim().length > 0) lines.set(`note ${n++}`, `- you noted: ${h.text.trim().slice(0, 160)}`);
      for (const c of h.calls) {
        const line = digestLine(c, summaries.get(c.id) ?? 'no result');
        const key = line.slice(0, line.indexOf(' → '));
        lines.delete(key);
        lines.set(key, line);
      }
    } else if (h.kind === 'user') lines.set(`user ${n++}`, `- harness: ${h.jit.slice(0, 160)}`);
  }
  digest.push(...lines.values());
  let opening = first.jit;
  if (pinned.size > 0) opening += `\n\nPinned context (kept for the whole run; no need to fetch again):\n${[...pinned.values()].join('\n')}`;
  if (digest.length > 0) opening += `\n\nProgress so far (older turns compacted by the harness; files you wrote are on disk):\n${digest.join('\n')}`;
  const recent = rest.slice(start).map((h, j): Message => {
    if (h.kind === 'user') return { role: 'user', text: h.jit };
    // The latest action keeps its arguments, so the model can see exactly what it just wrote.
    if (h.kind === 'assistant') return { role: 'assistant', text: h.text, toolCalls: start + j >= lastAction ? h.calls : elideArgs(h.calls, elideOver) };
    return { role: 'tool', results: h.results.map((r) => ({ callId: r.callId, name: r.name, content: r.pin === true ? `[pinned in the opening message] ${r.summary}` : r.jit })) };
  });
  return [{ role: 'user', text: opening }, ...recent];
}

/**
 * Tools every step needs ship with full schemas; the rest are listed once and called through use_tool.
 * Greenfield work mostly writes whole files, brownfield work mostly edits them.
 */
export const ALWAYS_LOADED: Record<Task['mode'], string[]> = {
  greenfield: ['read_file', 'write_file', 'run_tests', 'finish'],
  brownfield: ['read_file', 'edit_file', 'run_tests', 'finish'],
};
export const DISPATCH_TOOL = 'use_tool';

function signature(t: ToolSpec): string {
  const req = new Set(t.parameters.required ?? []);
  const args = Object.entries(t.parameters.properties).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${String((v as { type?: unknown }).type ?? 'any')}`);
  return `${t.name}(${args.join(', ')}) — ${t.description.split('. ')[0]?.replace(/\.$/, '') ?? ''}`;
}

/** JIT tool schemas: full specs for the always-loaded set plus one dispatcher carrying a one-line catalog. */
export function jitToolSpecs(all: ToolSpec[], mode: Task['mode']): ToolSpec[] {
  const always = ALWAYS_LOADED[mode];
  const loaded = all.filter((t) => always.includes(t.name));
  const deferred = all.filter((t) => !always.includes(t.name));
  if (deferred.length === 0) return loaded;
  return [
    ...loaded,
    {
      name: DISPATCH_TOOL,
      description: `Call one of these tools by name with its args:\n${deferred.map(signature).join('\n')}`,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: deferred.map((t) => t.name) }, args: { type: 'object' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
}
