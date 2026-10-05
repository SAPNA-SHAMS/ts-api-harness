// Runs every registered rule and validator against an API and renders the standards report:
// one line per rule per file, then one summary line per rule, then the verdict.
import { buildCheckContext } from './apimodel.ts';
import { loadRegistry } from './registry.ts';
import type { RuleOutcome, StandardsReport, TaskInfo } from './sdk.ts';

export async function runStandards(root: string, opts: { task?: TaskInfo; fastOnly?: boolean } = {}): Promise<StandardsReport> {
  const reg = await loadRegistry();
  const ctx = buildCheckContext(root, opts.task);
  const rules: RuleOutcome[] = [];
  for (const rule of reg.rules) {
    if (opts.fastOnly === true && rule.slow === true) continue;
    try {
      const r = await rule.run(ctx);
      rules.push({ ...r, id: rule.id, kind: rule.kind, description: rule.description });
    } catch (err) {
      rules.push({
        id: rule.id,
        kind: rule.kind,
        description: rule.description,
        status: 'unproven',
        passed: 0,
        total: 0,
        unit: 'checks',
        files: [],
        findings: [],
        note: `rule crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  for (const e of reg.errors) {
    rules.push({ id: 'plugin-load', kind: 'rule', description: 'plugin failed to load', status: 'unproven', passed: 0, total: 0, unit: 'plugins', files: [], findings: [], note: e });
  }
  const applicable = rules.filter((r) => r.status !== 'n/a');
  const passing = applicable.filter((r) => r.status === 'pass').length;
  const status = applicable.some((r) => r.status === 'fail') ? 'fail' : applicable.some((r) => r.status === 'unproven') ? 'unproven' : 'pass';
  const percent = applicable.length === 0 ? 0 : Math.floor((passing / applicable.length) * 100);
  return { root, rules, verdict: { status, percent, passing, applicable: applicable.length } };
}

const pad = (s: string, n: number): string => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

export function formatStandards(report: StandardsReport, opts: { perFile?: boolean; onlyFailures?: boolean } = {}): string {
  const lines: string[] = [];
  const width = Math.max(18, ...report.rules.map((r) => r.id.length + 2));
  if (opts.perFile !== false) {
    for (const r of report.rules) {
      for (const file of r.files) {
        const fs = r.findings.filter((f) => f.file === file);
        if (fs.length === 0) {
          if (opts.onlyFailures !== true) lines.push(`${pad(r.id, width)}${pad('pass', 9)}${file}`);
        } else {
          for (const f of fs) lines.push(`${pad(r.id, width)}${pad('FAIL', 9)}${f.file}:${f.line}  ${f.message}`);
        }
      }
      for (const f of r.findings.filter((x) => !r.files.includes(x.file))) {
        lines.push(`${pad(r.id, width)}${pad('FAIL', 9)}${f.file}:${f.line}  ${f.message}`);
      }
    }
    if (lines.length > 0) lines.push('');
  }
  for (const r of report.rules) {
    if (opts.onlyFailures === true && (r.status === 'pass' || r.status === 'n/a')) continue;
    const label = r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'FAIL' : r.status === 'unproven' ? 'UNPROVEN' : 'n/a';
    const detail = r.unit === 'errors' ? `${r.findings.length} errors` : `${r.passed}/${r.total} ${r.unit}`;
    lines.push(`${pad(r.id, width)}${pad(label, 9)}${detail}${r.note !== undefined ? `  (${r.note})` : ''}`);
  }
  const v = report.verdict;
  const tail = v.status === 'pass' ? '→ dimension scored' : v.status === 'fail' ? '→ standards FAILED' : '→ UNPROVEN (a check could not run)';
  lines.push(`${pad('verdict', width)}${pad(`${v.percent}%`, 9)}${tail}`);
  return lines.join('\n');
}
