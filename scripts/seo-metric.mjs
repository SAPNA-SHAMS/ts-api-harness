// Metric reader for the SEO backlog items: how many spec checks for <item> are automated AND
// passing on beta. Runs Cypress (module API) against a generated config; never touches live.
//   node scripts/seo-metric.mjs <item> [suiteDir]
// suiteDir defaults to examples/sf-seo-suite/cypress, falling back to the WIP if it does not exist.
// Last line of output is the passing count (the harness reads the last number).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Cypress/Electron chatter goes to stderr and would land after our count in the harness log.
// Re-run ourselves with stderr captured to a file so the count is always the last line out.
import { spawnSync } from 'node:child_process';
if (!process.env.SEO_METRIC_CHILD) {
  const errLog = join(ROOT, 'runs', `seo-metric-stderr-${Date.now()}.log`);
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  const r = spawnSync(process.execPath, [import.meta.filename, ...process.argv.slice(2)],
    { env: { ...process.env, SEO_METRIC_CHILD: '1' }, stdio: ['ignore', 'inherit', 'pipe'] });
  writeFileSync(errLog, r.stderr ?? '');
  if (r.status !== 0) console.log(`metric reader failed (exit ${r.status}); stderr in ${errLog}\n${String(r.stderr ?? '').trim().split('\n').slice(-5).join('\n')}`);
  process.exit(r.status ?? 1);
}
// Credentials: environment first, else the git-ignored .env.local (KEY=VALUE lines). Never committed.
if (existsSync(join(ROOT, '.env.local'))) {
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(AUTH_USER|AUTH_PASS)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const BETA = 'https://sf-beta.softwarefndr.com';
const item = process.argv[2];
const checklist = JSON.parse(readFileSync(join(ROOT, 'docs/seo-checklist.json'), 'utf8'))[item];
if (!checklist) { console.error(`unknown item ${item}`); process.exit(2); }
const ids = Object.keys(checklist);

const suite = resolve(process.argv[3] ?? (existsSync(join(ROOT, 'examples/sf-seo-suite/cypress'))
  ? join(ROOT, 'examples/sf-seo-suite/cypress') : join(ROOT, 'examples/sf-automation-seo-wip/cypress')));
const base = process.env.SEO_BASE_URL ?? BETA;
if (!/^https:\/\/sf-beta\.softwarefndr\.com\/?$/.test(base)) { console.error(`refusing base URL ${base}: beta only`); process.exit(2); }

// Use the target repo's installed Cypress read-only; nothing is written there.
const req = createRequire(join(homedir(), 'Projects/SoftwareFinder-Automation/package.json'));
const cypress = req('cypress');

const work = join(ROOT, 'runs', `seo-metric-${item}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const support = join(work, 'support.js');
writeFileSync(support, `import ${JSON.stringify(join(suite, 'support/seo/seo-commands.js'))};\n`);

const e2e = {
  baseUrl: base, specPattern: join(suite, 'e2e/**/*.cy.{js,ts}'), supportFile: support,
  fixturesFolder: join(suite, 'fixtures'), video: false, screenshotOnRunFailure: false,
  retries: 0, defaultCommandTimeout: 10000,
};
writeFileSync(join(work, 'cypress.config.cjs'), `module.exports = { e2e: ${JSON.stringify(e2e, null, 2)} };\n`);
delete process.env.ELECTRON_RUN_AS_NODE; // set inside VS Code; breaks the Cypress binary
const res = await cypress.run({
  project: work,
  configFile: join(work, 'cypress.config.cjs'),
  quiet: true,
  browser: 'electron',
  env: { ENVIRONMENT: 'beta', AUTH_USER: process.env.AUTH_USER ?? '', AUTH_PASS: process.env.AUTH_PASS ?? '' },
});
if (res.status === 'failed') { console.error(`cypress could not run: ${res.message}`); process.exit(3); }

const results = new Map(); // id -> passed?
const states = new Map();  // id -> { state, err } for anything not passed
for (const run of res.runs ?? []) for (const t of run.tests ?? []) {
  const title = t.title.at(-1);
  const id = title.match(/^(\d+\.\d+)\s/)?.[1];
  if (!id || !ids.includes(id)) continue;
  results.set(id, (results.get(id) ?? true) && t.state === 'passed');
  if (t.state !== 'passed') states.set(id, { state: t.state, err: (t.displayError ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 400) });
}
const label = (id) => results.get(id) === true ? 'PASS' : !results.has(id) ? 'NONE' : states.get(id)?.state === 'pending' ? 'SKIP' : 'FAIL';
const lines = ids.map((id) => `${label(id)}  ${id}  ${checklist[id]}${states.get(id)?.err ? `\n        ${states.get(id).err}` : ''}`);
const passing = ids.filter((id) => results.get(id) === true).length;
// A 5xx from beta (e.g. Cloudflare 521, origin down) is an outage, not a defect. Refuse to report
// a number taken during one: the harness then records UNPROVEN instead of a false low reading.
const outage = [...states].filter(([, s]) => /(expected|→)\s*5\d\d\b/.test(s.err ?? '')).map(([id]) => id);
if (outage.length) {
  console.log(lines.join('\n'));
  console.log(`UNPROVEN: beta answered 5xx during ${outage.join(', ')}; not a reading. Re-run when beta is up.`);
  process.exit(4);
}
writeFileSync(join(work, 'checks.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`suite ${suite}\nbase ${base}\n${item}: ${passing}/${ids.length} spec checks automated and passing on beta`);
console.log(passing);
