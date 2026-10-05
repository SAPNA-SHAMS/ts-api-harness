// What the model sees. JIT mode: a short system prompt, compact tool returns and a compacted
// history. Baseline mode: everything front-loaded, raw tool output, no compaction. The same
// conversation is rendered both ways every turn so the token report compares like with like.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ToolCall, ToolSpec } from './sdk.ts';
import type { Task } from './task.ts';
import { REPO_ROOT } from './util.ts';

export type HistItem =
  | { kind: 'user'; jit: string; raw: string }
  | { kind: 'assistant'; text: string; calls: ToolCall[] }
  | { kind: 'tool'; results: { callId: string; name: string; summary: string; jit: string; raw: string }[] };

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
  const refs = readDir(join(REPO_ROOT, 'context', 'reference')).map((r) => `## reference/${r.name}\n${r.text}`).join('\n');
  const files = workspaceFiles.map((f) => `=== ${f.rel} ===\n${f.text}`).join('\n');
  return `${PREAMBLE}\n\n# Standards\n${standards}\n\n# References\n${refs}\n\n# Workspace (every file)\n${files}`;
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
 * Compaction: turns older than the last `keepRecent` tool exchanges collapse into a progress digest
 * (one line per call: tool, target, summary) appended to the opening user message; executed
 * arguments over `elideOver` chars are elided everywhere.
 */
export function renderJit(history: HistItem[], keepRecent: number, elideOver: number): Message[] {
  const [first, ...rest] = history;
  if (first === undefined || first.kind !== 'user') return renderRaw(history);
  const toolIdx = rest.flatMap((h, i) => (h.kind === 'tool' ? [i] : []));
  const keepFrom = toolIdx.length > keepRecent ? (toolIdx[toolIdx.length - keepRecent] ?? 0) - 1 : 0;
  const start = rest[keepFrom]?.kind === 'assistant' ? keepFrom : 0;
  const digest: string[] = [];
  const summaries = new Map<string, string>();
  for (const h of rest.slice(0, start)) if (h.kind === 'tool') for (const r of h.results) summaries.set(r.callId, r.summary);
  for (const h of rest.slice(0, start)) {
    if (h.kind === 'assistant') {
      if (h.text.trim().length > 0) digest.push(`- you noted: ${h.text.trim().slice(0, 160)}`);
      for (const c of h.calls) digest.push(digestLine(c, summaries.get(c.id) ?? 'no result'));
    } else if (h.kind === 'user') digest.push(`- harness: ${h.jit.slice(0, 160)}`);
  }
  const opening = digest.length === 0 ? first.jit : `${first.jit}\n\nProgress so far (compacted by the harness; fetch details with tools):\n${digest.join('\n')}`;
  const recent = rest.slice(start).map((h): Message => {
    if (h.kind === 'user') return { role: 'user', text: h.jit };
    if (h.kind === 'assistant') return { role: 'assistant', text: h.text, toolCalls: elideArgs(h.calls, elideOver) };
    return { role: 'tool', results: h.results.map((r) => ({ callId: r.callId, name: r.name, content: r.jit })) };
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
