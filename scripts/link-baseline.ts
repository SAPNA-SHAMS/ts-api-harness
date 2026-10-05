// Attach a measured baseline run's per-turn input tokens to an actual run's token report.
// usage: node scripts/link-baseline.ts tokens/<actual>.json tokens/<baseline>.json
import { readFileSync } from 'node:fs';
import { writeText } from '../src/core/util.ts';

type T = { runId: string; mode: string; turns: { actualInputTokens: number }[]; totals: { actualInputTokens: number; turns: number }; [k: string]: unknown };
const [actualFile, baselineFile] = process.argv.slice(2);
if (actualFile === undefined || baselineFile === undefined) throw new Error('usage: link-baseline <actual.json> <baseline.json>');
const actual = JSON.parse(readFileSync(actualFile, 'utf8')) as T;
const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as T;
if (base.mode !== 'baseline') throw new Error(`${baselineFile} is not a baseline-mode run`);
actual['measuredBaseline'] = {
  runId: base.runId,
  note: 'a separate run of the same task on the same driver with context fetchers and compaction disabled; input tokens as reported by the provider endpoint',
  perTurnInputTokens: base.turns.map((t) => t.actualInputTokens),
  totalInputTokens: base.totals.actualInputTokens,
  turns: base.totals.turns,
};
actual['reductionVsMeasuredBaselinePercent'] = base.totals.actualInputTokens === 0 ? 0 : Math.round((1 - actual.totals.actualInputTokens / base.totals.actualInputTokens) * 1000) / 10;
writeText(actualFile, `${JSON.stringify(actual, null, 2)}\n`);
process.stdout.write(`[harness] measured baseline ${base.totals.actualInputTokens} vs actual ${actual.totals.actualInputTokens} provider-reported input tokens → ${String(actual['reductionVsMeasuredBaselinePercent'])}% reduction (${actualFile})\n`);
