// Compact diff of what changed in the workspace since the run started.
import { defineTool } from '../../src/core/sdk.ts';

export default defineTool({
  name: 'workspace_diff',
  description: 'Files changed since the run started.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run(_args, ctx) {
    const lines: string[] = [];
    const full: string[] = [];
    let changed = 0;
    for (const f of ctx.listFiles()) {
      const now = ctx.readText(f) ?? '';
      const before = ctx.initialText(f);
      if (before === now) continue;
      changed++;
      const old = new Set((before ?? '').split('\n'));
      const added = now.split('\n').filter((l) => !old.has(l));
      const cur = new Set(now.split('\n'));
      const removed = (before ?? '').split('\n').filter((l) => before !== undefined && !cur.has(l));
      lines.push(`${before === undefined ? 'A' : 'M'} ${f} +${added.length} -${removed.length}`);
      for (const l of added.slice(0, 4)) lines.push(`    + ${l.trim().slice(0, 100)}`);
      full.push(`--- ${f}\n${added.map((l) => `+ ${l}`).join('\n')}\n${removed.map((l) => `- ${l}`).join('\n')}`);
    }
    return { status: 'ok', summary: `${changed} files changed`, compact: lines.join('\n') || 'no changes', raw: full.join('\n') };
  },
});
