// Standard 03b: the real compiler, with the API's own tsconfig. Not run → UNPROVEN, never green.
import { defineRule, ruleResult } from '../../src/core/sdk.ts';

export default defineRule({
  id: 'tsc-strict',
  description: 'tsc --noEmit passes under the strict tsconfig',
  slow: true,
  async run(ctx) {
    const r = await ctx.tsc();
    if (!r.ran) {
      return { status: 'unproven', passed: 0, total: 0, unit: 'errors', files: [], findings: [], note: r.reason ?? 'tsc did not run' };
    }
    const files = ctx.files.map((f) => f.rel);
    return { ...ruleResult({ unit: 'errors', total: files.length, files, findings: r.errors, failedUnits: new Set(r.errors.map((e) => e.file)).size }), status: r.errors.length > 0 ? 'fail' : 'pass' };
  },
});
