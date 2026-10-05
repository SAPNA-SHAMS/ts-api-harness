// Original addition: the declared-surface gate. The API's route contract must match what the task
// declares (greenfield) or the shipped snapshot plus declared additions (brownfield). Undeclared
// routes, missing routes and breaking changes fail with the route that drifted.
import { diffContracts, extractContract, readSnapshot, routeKey, SNAPSHOT_FILE } from '../../src/core/contract.ts';
import { defineRule, type Finding } from '../../src/core/sdk.ts';

export default defineRule({
  id: 'contract-drift',
  description: 'route surface matches the task declaration and the shipped contract snapshot',
  run(ctx) {
    const current = extractContract(ctx);
    const snapshot = readSnapshot(ctx.root);
    const findings: Finding[] = [];
    const where = (key: string): { file: string; line: number } => {
      const r = ctx.routes.find((x) => routeKey(x) === key);
      return r === undefined ? { file: SNAPSHOT_FILE, line: 0 } : { file: r.file.rel, line: r.line };
    };
    const expected = new Set((ctx.task?.expectedRoutes ?? []).map(routeKey));
    const allowBreaking = new Set(ctx.task?.allowBreaking ?? []);
    const files = [...new Set(ctx.routes.map((r) => r.file.rel))];

    if (snapshot === undefined) {
      if (ctx.task === undefined) {
        return { status: 'unproven', passed: 0, total: current.routes.length, unit: 'routes', files: [], findings: [], note: `no ${SNAPSHOT_FILE} and no task: nothing to compare against` };
      }
      const actual = new Set(current.routes.map(routeKey));
      for (const k of expected) if (!actual.has(k)) findings.push({ file: 'src', line: 0, message: `${k}: declared by the task but not implemented` });
      for (const k of actual) if (!expected.has(k)) findings.push({ ...where(k), message: `${k}: undeclared route (not in the task)` });
    } else {
      for (const c of diffContracts(snapshot, current)) {
        if (c.kind === 'added') {
          if (ctx.task !== undefined && !expected.has(c.key)) findings.push({ ...where(c.key), message: `${c.key}: undeclared route (task does not add it)` });
          if (ctx.task === undefined) findings.push({ ...where(c.key), message: `${c.key}: not in ${SNAPSHOT_FILE}` });
        } else if (c.breaking && !allowBreaking.has(c.key)) {
          findings.push({ ...where(c.key), message: `${c.key}: breaking change, ${c.detail}` });
        }
      }
      const actual = new Set(current.routes.map(routeKey));
      for (const k of expected) if (!actual.has(k)) findings.push({ file: 'src', line: 0, message: `${k}: declared by the task but not implemented` });
    }
    const drifted = new Set(findings.map((f) => f.message.split(':')[0]));
    const total = Math.max(current.routes.length, expected.size);
    return {
      status: findings.length > 0 ? 'fail' : total === 0 ? 'n/a' : 'pass',
      passed: Math.max(0, total - drifted.size),
      total,
      unit: 'routes',
      files,
      findings,
    };
  },
});
