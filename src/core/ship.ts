// The harness ships; the model never does. Shipping happens in a temporary git worktree on a new
// feature branch, only after every gate is green, and re-checks standards on the exact tree it
// commits. Protected branches are refused; nothing is ever force-pushed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCheckContext } from './apimodel.ts';
import { runStandards } from './checker.ts';
import { extractContract, SNAPSHOT_FILE } from './contract.ts';
import type { TaskInfo } from './sdk.ts';
import { outputDir, type Task } from './task.ts';
import { ensureDir, listFilesRec, matchesAny, REPO_ROOT, writeText, type HarnessConfig } from './util.ts';

export type ShipResult = {
  status: 'committed' | 'pushed' | 'refused' | 'unproven' | 'skipped';
  branch?: string;
  commit?: string;
  push: 'done' | 'skipped' | 'unproven';
  pullRequest: string;
  steps: string[];
  reason?: string;
};

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
}

export async function ship(opts: {
  runId: string;
  task: Task;
  info: TaskInfo;
  driverId: string;
  workspace: string;
  green: boolean;
  push: boolean;
  config: HarnessConfig;
  gateSummary: string[];
}): Promise<ShipResult> {
  const steps: string[] = [];
  const base = { push: 'skipped' as const, pullRequest: 'not opened', steps };
  if (!opts.green) return { ...base, status: 'refused', reason: 'gates are not green: no commit on red' };

  const top = git(['rev-parse', '--show-toplevel'], REPO_ROOT);
  if (!top.ok) return { ...base, status: 'unproven', reason: 'not a git repository' };
  if (!git(['rev-parse', '--verify', 'HEAD'], REPO_ROOT).ok) return { ...base, status: 'unproven', reason: 'repository has no commits to branch from' };

  const branch = `${opts.config.branchPrefix}${opts.task.name}-${opts.driverId}-${opts.runId.slice(-6)}`;
  if (matchesAny(branch, opts.config.protectedBranches)) return { ...base, status: 'refused', reason: `branch ${branch} is protected` };
  if (git(['rev-parse', '--verify', `refs/heads/${branch}`], REPO_ROOT).ok) return { ...base, status: 'refused', reason: `branch ${branch} already exists` };

  const wt = join(REPO_ROOT, 'runs', opts.runId, 'ship');
  const add = git(['worktree', 'add', '-b', branch, wt, 'HEAD'], REPO_ROOT);
  if (!add.ok) return { ...base, status: 'unproven', reason: `git worktree add failed: ${add.out}` };
  steps.push(`branch ${branch} created in a temporary worktree`);
  try {
    const dest = join(wt, outputDir(opts.task));
    for (const rel of listFilesRec(opts.workspace)) {
      const to = join(dest, rel);
      ensureDir(dirname(to));
      copyFileSync(join(opts.workspace, rel), to);
    }
    writeText(join(dest, SNAPSHOT_FILE), `${JSON.stringify(extractContract(buildCheckContext(dest, opts.info)), null, 2)}\n`);
    steps.push(`copied workspace to ${outputDir(opts.task)} and wrote ${SNAPSHOT_FILE}`);

    const recheck = await runStandards(dest, { task: opts.info });
    if (recheck.verdict.status !== 'pass') {
      return { ...base, status: 'refused', branch, reason: `standards re-check on the shipped tree is ${recheck.verdict.status}: no commit on red` };
    }
    steps.push(`standards re-checked on the shipped tree: ${recheck.verdict.percent}%`);

    if (!git(['add', '--', outputDir(opts.task)], wt).ok) return { ...base, status: 'unproven', branch, reason: 'git add failed' };
    const message = [`harness: ${opts.task.name} (${opts.task.mode})`, '', `run ${opts.runId}`, ...opts.gateSummary.map((g) => `- ${g}`)].join('\n');
    const identity = git(['config', 'user.email'], wt).ok ? [] : ['-c', 'user.name=ts-api-harness', '-c', 'user.email=harness@localhost'];
    const commit = git([...identity, 'commit', '-q', '-m', message], wt);
    if (!commit.ok) return { ...base, status: 'unproven', branch, reason: `git commit failed: ${commit.out}` };
    const sha = git(['rev-parse', 'HEAD'], wt).out;
    steps.push(`committed ${sha.slice(0, 10)} on ${branch}`);
    const patch = git(['format-patch', '-1', '--stdout', sha], wt);
    if (patch.ok) {
      writeText(join(REPO_ROOT, 'reports', `${opts.runId}.patch`), `${patch.out}\n`);
      steps.push(`patch written to reports/${opts.runId}.patch`);
    }

    if (!opts.push) return { ...base, status: 'committed', branch, commit: sha, reason: 'push disabled (--no-push)' };
    if (!git(['remote', 'get-url', 'origin'], wt).ok) {
      return { status: 'committed', branch, commit: sha, push: 'unproven', pullRequest: 'UNPROVEN: no origin remote', steps, reason: 'no origin remote configured' };
    }
    const pushed = git(['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], wt);
    if (!pushed.ok) return { status: 'committed', branch, commit: sha, push: 'unproven', pullRequest: 'UNPROVEN: push failed', steps, reason: `push failed: ${pushed.out}` };
    steps.push(`pushed ${branch} to origin`);
    if (!hasCommand('gh')) return { status: 'pushed', branch, commit: sha, push: 'done', pullRequest: 'UNPROVEN: gh CLI not installed', steps };
    const pr = spawnSync('gh', ['pr', 'create', '--head', branch, '--title', `harness: ${opts.task.name}`, '--body', `${message}\n\nOpened by the harness ship step after every gate was green.`], { cwd: wt, encoding: 'utf8' });
    const url = `${pr.stdout ?? ''}`.trim();
    if (pr.status !== 0) return { status: 'pushed', branch, commit: sha, push: 'done', pullRequest: `UNPROVEN: gh pr create failed: ${`${pr.stderr ?? ''}`.trim().slice(0, 200)}`, steps };
    steps.push(`opened pull request ${url}`);
    return { status: 'pushed', branch, commit: sha, push: 'done', pullRequest: url, steps };
  } finally {
    git(['worktree', 'remove', '--force', wt], REPO_ROOT);
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  }
}
