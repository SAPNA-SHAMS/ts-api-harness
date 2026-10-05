// Run the real harness CLI against the local wire-level fake provider (no API keys needed).
// usage: node scripts/offline-run.ts --task <file> --driver <claude|openai> [any harness run flags]
// The harness process is unmodified: it only sees *_BASE_URL and a placeholder key in its env.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { planFor } from '../test/fake-provider/policy.ts';
import { startFakeProvider } from '../test/fake-provider/server.ts';
import { REPO_ROOT } from '../src/core/util.ts';

export async function offlineRun(args: string[], opts: { quiet?: boolean } = {}): Promise<{ code: number; output: string; requests: number }> {
  const taskIdx = args.indexOf('--task');
  const task = taskIdx === -1 ? undefined : args[taskIdx + 1];
  if (task === undefined) throw new Error('--task is required');
  // A fresh scripted provider per harness run so every run (baseline and actual) replays from step 0.
  let provider = await startFakeProvider(planFor(task));
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: provider.url,
    OPENAI_BASE_URL: `${provider.url}/v1`,
    ANTHROPIC_API_KEY: 'offline-replay-placeholder',
    OPENAI_API_KEY: 'offline-replay-placeholder',
  };
  const runOnce = (extra: string[]): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, 'src/core/cli.ts'), 'run', ...extra], { cwd: REPO_ROOT, env: { ...env, ANTHROPIC_BASE_URL: provider.url, OPENAI_BASE_URL: `${provider.url}/v1` } });
      let output = '';
      const onData = (d: Buffer): void => {
        output += d.toString();
        if (opts.quiet !== true) process.stdout.write(d);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => resolve({ code: code ?? 1, output }));
    });
  let requests = 0;
  let result: { code: number; output: string };
  if (args.includes('--with-baseline')) {
    // Measured baseline: same task, same driver, fetchers and compaction off, its own provider session.
    const rest = args.filter((a) => a !== '--with-baseline');
    const base = await runOnce([...rest, '--baseline', '--no-ship']);
    requests += provider.requests.length;
    await provider.close();
    provider = await startFakeProvider(planFor(task));
    const actual = await runOnce(rest);
    requests += provider.requests.length;
    const baseTokens = /tokens\s+.*→ (tokens\/\S+\.json)/.exec(base.output)?.[1];
    const actualTokens = /tokens\s+.*→ (tokens\/\S+\.json)/.exec(actual.output)?.[1];
    if (baseTokens !== undefined && actualTokens !== undefined) {
      const link = spawn(process.execPath, [join(REPO_ROOT, 'scripts/link-baseline.ts'), actualTokens, baseTokens], { cwd: REPO_ROOT, stdio: opts.quiet === true ? 'ignore' : 'inherit' });
      await new Promise((r) => link.on('close', r));
    }
    result = { code: actual.code, output: base.output + actual.output };
  } else {
    result = await runOnce(args);
    requests += provider.requests.length;
  }
  await provider.close();
  return { ...result, requests };
}

if (import.meta.main) {
  const r = await offlineRun(process.argv.slice(2));
  process.exit(r.code);
}
