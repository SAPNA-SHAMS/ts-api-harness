// Shows the current route contract against the shipped snapshot and the task's declared surface.
import { buildCheckContext } from '../../src/core/apimodel.ts';
import { diffContracts, extractContract, readSnapshot, routeKey } from '../../src/core/contract.ts';
import { defineTool } from '../../src/core/sdk.ts';

export default defineTool({
  name: 'contract_diff',
  description: 'Route contract vs the shipped snapshot and the task.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run(_args, ctx) {
    const current = extractContract(buildCheckContext(ctx.workspace, ctx.task));
    const snapshot = readSnapshot(ctx.workspace);
    const declared = ctx.task.expectedRoutes.map(routeKey);
    const have = new Set(current.routes.map(routeKey));
    const lines = [`routes now: ${[...have].join(', ') || '(none)'}`, `task declares: ${declared.join(', ')}`];
    const missing = declared.filter((k) => !have.has(k));
    if (missing.length > 0) lines.push(`missing: ${missing.join(', ')}`);
    if (snapshot !== undefined) for (const c of diffContracts(snapshot, current)) lines.push(`${c.breaking ? 'BREAKING' : c.kind} ${c.key}: ${c.detail}`);
    return { status: 'ok', summary: `${have.size} routes, ${missing.length} declared routes missing`, compact: lines.join('\n') };
  },
});
