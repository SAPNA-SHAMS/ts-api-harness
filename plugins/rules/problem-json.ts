// Standard 02: RFC 7807 errors, nothing else. Every error path is a problem(...) with a 4xx/5xx
// status and a title; nothing writes raw responses or ad-hoc { error } bodies; tests prove it.
import ts from 'typescript';
import { defineRule, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

const FIELDS = ['type', 'title', 'status', 'detail', 'instance'];

export default defineRule({
  id: 'problem-json',
  description: 'every non-2xx response is application/problem+json with type, title, status, detail, instance',
  run(ctx) {
    const findings: Finding[] = [];
    let errorPaths = 0;
    let badPaths = 0;
    const helper = ctx.src.find((f) => f.rel === 'src/lib/problem.ts');
    if (helper === undefined) findings.push({ file: 'src/lib/problem.ts', line: 0, message: 'problem helper missing' });
    else {
      if (!helper.text.includes("'application/problem+json'")) findings.push({ file: helper.rel, line: 1, message: 'problem helper does not set content-type application/problem+json' });
      for (const k of FIELDS) if (!new RegExp(`\\b${k}:`).test(helper.text)) findings.push({ file: helper.rel, line: 1, message: `problem body missing '${k}'` });
    }
    for (const f of ctx.src) {
      walk(f.sf, (n) => {
        const line = (): number => f.line(n.getStart(f.sf));
        const callee = ts.isCallExpression(n) ? n.expression.getText(f.sf) : ts.isNewExpression(n) ? n.expression.getText(f.sf) : undefined;
        if ((ts.isCallExpression(n) && callee === 'problem') || (ts.isNewExpression(n) && callee === 'HttpProblem')) {
          if (f.rel === 'src/lib/problem.ts') return;
          errorPaths++;
          const args = n.arguments ?? ts.factory.createNodeArray();
          const status = args[0];
          const title = args[2];
          const okStatus = status !== undefined && ts.isNumericLiteral(status) && Number(status.text) >= 400 && Number(status.text) <= 599;
          const okTitle = title !== undefined && (((ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) && title.text.length > 0) || ts.isTemplateExpression(title));
          if (args.length !== 4 || !okStatus || !okTitle) {
            badPaths++;
            findings.push({ file: f.rel, line: line(), message: 'problem(status, slug, title, detail) needs a literal 4xx/5xx status and a string title' });
          }
        }
        if (f.isLib) return;
        if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
          const name = n.name.getText(f.sf).replace(/['"]/g, '');
          if (name === 'error' || name === 'err') findings.push({ file: f.rel, line: line(), message: `ad-hoc '{ ${name}: … }' shape: throw problem(...) instead` });
        }
        if (ts.isPropertyAccessExpression(n) && ['writeHead', 'statusCode', 'setHeader', 'end', 'json', 'status'].includes(n.name.text)) {
          const target = n.expression.getText(f.sf);
          if (/^(res|response|reply)$/.test(target)) findings.push({ file: f.rel, line: line(), message: `raw response write '${target}.${n.name.text}' bypasses problem+json` });
        }
        if (ts.isThrowStatement(n)) {
          const e = n.expression.getText(f.sf);
          if (!/^(problem\(|new HttpProblem\()/.test(e)) findings.push({ file: f.rel, line: line(), message: `throws '${e.slice(0, 40)}': throw problem(status, slug, title, detail)` });
        }
      }, ts);
    }
    const proving = ctx.tests.filter((t) => t.text.includes('application/problem+json'));
    if (ctx.tests.length > 0 && proving.length === 0) findings.push({ file: 'test', line: 0, message: 'no test asserts an application/problem+json response' });
    if (ctx.tests.length === 0) findings.push({ file: 'test', line: 0, message: 'no tests: error paths are unproven' });
    return ruleResult({
      unit: 'error paths',
      total: errorPaths,
      files: ctx.src.map((f) => f.rel),
      findings,
      failedUnits: badPaths,
    });
  },
});
