// Coverage check for an SEO item: every spec id in docs/seo-checklist.json[<item>] has exactly one
// Cypress test titled "<id> ..." in examples/sf-seo-suite, no test uses an id outside the item's
// list for its sections, and no test is skipped (.skip / xit). Static; does not hit any site.
//   node scripts/seo-coverage.mjs <item>      exit 0 = fully covered
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const item = process.argv[2];
const ids = Object.keys(JSON.parse(readFileSync(join(ROOT, 'docs/seo-checklist.json'), 'utf8'))[item] ?? {});
if (!ids.length) { console.log(`unknown item ${item}`); process.exit(2); }
const sections = new Set(ids.map((i) => i.split('.')[0]));
const dir = join(ROOT, 'examples/sf-seo-suite/cypress/e2e/seo');

const found = new Map(); const problems = [];
const walk = (d) => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.cy.js') ? [join(d, e.name)] : []) : [];
for (const f of walk(dir)) {
  const src = readFileSync(f, 'utf8');
  if (/\b(it|describe)\.skip\(|\bxit\(|\bit\.only\(/.test(src)) problems.push(`${f}: skip/only is not allowed`);
  for (const m of src.matchAll(/\bit\(\s*["'`](\d+\.\d+)\s/g)) {
    const id = m[1];
    if (!sections.has(id.split('.')[0])) continue;
    if (!ids.includes(id)) problems.push(`${id} in ${f} is not a spec id for ${item}`);
    found.set(id, (found.get(id) ?? 0) + 1);
  }
}
const missing = ids.filter((i) => !found.has(i));
const dupes = [...found].filter(([, n]) => n > 1).map(([i]) => i);
if (missing.length) problems.push(`missing tests for: ${missing.join(', ')}`);
if (dupes.length) problems.push(`duplicate ids: ${dupes.join(', ')}`);
console.log(`${item}: ${ids.length - missing.length}/${ids.length} spec ids have a test`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('coverage complete');
