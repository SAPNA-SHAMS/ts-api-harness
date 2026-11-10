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
for (const run of res.runs ?? []) for (const t of run.tests ?? []) {
  const title = t.title.at(-1);
  const id = title.match(/^(\d+\.\d+)\s/)?.[1];
  if (!id || !ids.includes(id)) continue;
  results.set(id, (results.get(id) ?? true) && t.state === 'passed');
}
const lines = ids.map((id) => `${results.get(id) === true ? 'PASS' : results.has(id) ? 'FAIL' : 'NONE'}  ${id}  ${checklist[id]}`);
const passing = ids.filter((id) => results.get(id) === true).length;
writeFileSync(join(work, 'checks.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`suite ${suite}\nbase ${base}\n${item}: ${passing}/${ids.length} spec checks automated and passing on beta`);
console.log(passing);
