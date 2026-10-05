// The harness's own test runner. Red and green are what this process observed, never what
// the model claimed.
import { spawn } from 'node:child_process';
import { writeText } from './util.ts';

export type TestRun = {
  file: string;
  status: 'red' | 'green' | 'error';
  passed: number;
  failed: number;
  firstFailure: string;
  logPath: string;
  raw: string;
  ms: number;
};

function count(log: string, label: string): number {
  const m = new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(log);
  return m === null ? 0 : Number(m[1]);
}

function firstFailure(log: string): string {
  const lines = log.split('\n');
  const idx = lines.findIndex((l) => /^\s*✖ /.test(l) && !/^\s*✖ failing tests:/.test(l));
  if (idx === -1) {
    const err = lines.find((l) => /Error|error:/.test(l));
    return (err ?? lines.slice(-3).join(' ')).trim().slice(0, 300);
  }
  const block = lines.slice(idx, idx + 12).map((l) => l.trim()).filter((l) => l.length > 0);
  const name = block[0] ?? '';
  const why = block.find((l) => /^(error|AssertionError|Error|TypeError|SyntaxError|expected|actual|\+|-|ERR_)/.test(l) || /Error/.test(l)) ?? block[1] ?? '';
  return `${name} — ${why}`.slice(0, 300);
}

export function runTestFile(cwd: string, file: string, logPath: string, timeoutMs = 60_000): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT leaks in when the harness itself runs under node --test; it would change the
    // child's reporting protocol, so the runner always starts from a clean test context.
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], { cwd, env: { ...env, NODE_ENV: 'test' } });
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (log += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeText(logPath, log);
      const passed = count(log, 'pass');
      const failed = count(log, 'fail');
      const tests = count(log, 'tests');
      // node reports a file with no tests as one passing "test" named after the file; only named
      // test results count. A run that executed no tests proves nothing: it is an error, never green.
      const named = log.split('\n').filter((l) => /^\s*[✔✖] /.test(l) && !l.includes(`${file} (`) && !/✖ failing tests:/.test(l)).length;
      const status: TestRun['status'] = code === 0 ? (named > 0 ? 'green' : 'error') : failed > 0 || tests === 0 ? 'red' : 'error';
      resolve({ file, status, passed, failed, firstFailure: code === 0 ? '' : firstFailure(log), logPath, raw: log, ms: Date.now() - started });
    });
  });
}
