// Example ORM validator: every Prisma or Drizzle query on users must select explicit columns.
// Queries are found statically; an API with no ORM queries reports n/a, not pass.
import ts from 'typescript';
import { defineValidator, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

export default defineValidator({
  id: 'orm-users-explicit-columns',
  description: 'Prisma/Drizzle queries on users select explicit columns',
  run(ctx) {
    const findings: Finding[] = [];
    let queries = 0;
    const files = new Set<string>();
    for (const f of ctx.src) {
      walk(f.sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const callee = n.expression.getText(f.sf);
        const line = f.line(n.getStart(f.sf));
        // Prisma: prisma.user.findMany({ ... }) / findFirst / findUnique
        if (/\.users?\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)$/.test(callee)) {
          queries++;
          files.add(f.rel);
          const arg = n.arguments[0];
          const hasSelect = arg !== undefined && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name?.getText(f.sf) === 'select');
          if (!hasSelect) findings.push({ file: f.rel, line, message: `${callee}(…) must pass an explicit select` });
        }
        // Drizzle: db.select().from(users) — select() with no column map
        if (/\.from$/.test(callee) && n.arguments[0]?.getText(f.sf) === 'users') {
          queries++;
          files.add(f.rel);
          const inner = n.expression;
          if (ts.isPropertyAccessExpression(inner) && ts.isCallExpression(inner.expression) && inner.expression.arguments.length === 0 && /\.select$/.test(inner.expression.expression.getText(f.sf))) {
            findings.push({ file: f.rel, line, message: 'db.select().from(users) must list explicit columns' });
          }
        }
      }, ts);
    }
    return ruleResult({ unit: 'queries', total: queries, files: [...files], findings, ...(queries === 0 ? { note: 'no ORM queries on users found' } : {}) });
  },
});
