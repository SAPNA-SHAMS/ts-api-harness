// Standard 03a: strict compiler flags, and no any / non-null assertions / ts-ignore anywhere.
import ts from 'typescript';
import { defineRule, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

export default defineRule({
  id: 'strict-types',
  description: 'strict + noUncheckedIndexedAccess; no any, no non-null assertions, no @ts-ignore',
  run(ctx) {
    const findings: Finding[] = [];
    const opts = (ctx.tsconfig?.['compilerOptions'] ?? {}) as Record<string, unknown>;
    if (ctx.tsconfig === undefined) findings.push({ file: 'tsconfig.json', line: 0, message: 'tsconfig.json missing' });
    for (const flag of ['strict', 'noUncheckedIndexedAccess']) {
      if (opts[flag] !== true) findings.push({ file: 'tsconfig.json', line: 1, message: `compilerOptions.${flag} must be true` });
    }
    const bad = new Set<string>();
    for (const f of ctx.files) {
      walk(f.sf, (n) => {
        const line = (): number => f.line(n.getStart(f.sf));
        if (n.kind === ts.SyntaxKind.AnyKeyword) findings.push({ file: f.rel, line: line(), message: "explicit 'any'" });
        if (ts.isNonNullExpression(n)) findings.push({ file: f.rel, line: line(), message: `non-null assertion '${n.getText(f.sf).slice(0, 40)}'` });
      }, ts);
      f.text.split('\n').forEach((text, i) => {
        const m = /@ts-(ignore|expect-error|nocheck)/.exec(text);
        if (m !== null) findings.push({ file: f.rel, line: i + 1, message: `@ts-${m[1] ?? ''} suppresses the type checker` });
      });
    }
    for (const x of findings) bad.add(x.file);
    return ruleResult({ unit: 'files', total: ctx.files.length, files: ctx.files.map((f) => f.rel), findings, failedUnits: bad.size });
  },
});
