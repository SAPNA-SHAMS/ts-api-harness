// Post-write hook: run the fast standards rules and hand back only the findings for the file just
// written. Records; the finish gate is what refuses.
import { defineHook } from '../../src/core/sdk.ts';

export default defineHook({
  id: 'standards-on-write',
  phase: 'post',
  tools: ['write_file', 'edit_file'],
  async run({ args, output, ctx }) {
    if (output?.status !== 'ok' || typeof args['path'] !== 'string') return { decision: 'pass' };
    const path = args['path'];
    if (!path.endsWith('.ts')) return { decision: 'pass' };
    const report = await ctx.runStandards({ fastOnly: true });
    const hits = report.rules.flatMap((r) => r.findings.filter((f) => f.file === path).map((f) => `FAIL ${r.id} ${f.file}:${f.line} ${f.message}`));
    if (hits.length === 0) return { decision: 'pass' };
    return { decision: 'record', feedback: hits.slice(0, 8).join('\n') + (hits.length > 8 ? `\n… ${hits.length - 8} more` : '') };
  },
});
