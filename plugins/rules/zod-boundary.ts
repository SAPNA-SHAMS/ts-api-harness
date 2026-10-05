// Standard 01: Zod at every boundary. Every route declares params, query, body and response
// schemas; handlers never touch the raw request; domain types are inferred, never hand-written.
import ts from 'typescript';
import { defineRule, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

const OPAQUE = /^z\.(any|unknown|custom)\(/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export default defineRule({
  id: 'zod-boundary',
  description: 'params, query, body and response parsed by Zod; types inferred from schemas',
  run(ctx) {
    const findings: Finding[] = [];
    let badRoutes = 0;
    for (const r of ctx.routes) {
      const before = findings.length;
      const at = (message: string): void => void findings.push({ file: r.file.rel, line: r.line, message: `${r.method} ${r.path}: ${message}` });
      for (const k of ['params', 'query', 'body', 'response'] as const) {
        const s = r.schemas[k];
        if (s === undefined) at(`missing ${k} schema`);
        else if (OPAQUE.test(s.trim())) at(`${k} schema '${s}' does not validate anything`);
      }
      if (BODY_METHODS.has(r.method) && (r.schemas.body === 'NoBody' || r.schemas.body === 'z.undefined()')) at('unsafe method declares no body schema');
      if (r.handler !== undefined) {
        walk(r.handler, (n) => {
          if (ts.isIdentifier(n) && (n.text === 'req' || n.text === 'request')) {
            findings.push({ file: r.file.rel, line: r.file.line(n.getStart(r.file.sf)), message: `${r.method} ${r.path}: handler reads the raw request ('${n.text}')` });
          }
        }, ts);
      }
      if (findings.length > before) badRoutes++;
    }
    const domain = ctx.src.filter((f) => !f.isLib);
    for (const f of domain) {
      walk(f.sf, (n) => {
        const line = (): number => f.line(n.getStart(f.sf));
        if (ts.isInterfaceDeclaration(n)) findings.push({ file: f.rel, line: line(), message: `hand-written interface '${n.name.text}': infer it with z.infer<typeof Schema>` });
        if (ts.isTypeAliasDeclaration(n) && (ts.isTypeLiteralNode(n.type) || !/z\.(infer|input|output)<|typeof /.test(n.type.getText(f.sf)))) {
          findings.push({ file: f.rel, line: line(), message: `hand-written type '${n.name.text}': infer it with z.infer<typeof Schema>` });
        }
        if (ts.isCallExpression(n) && n.expression.getText(f.sf) === 'JSON.parse') findings.push({ file: f.rel, line: line(), message: 'JSON.parse outside the harness boundary: bodies are parsed by defineRoute' });
        if (ts.isCallExpression(n) && /(^|\.)createServer$/.test(n.expression.getText(f.sf))) findings.push({ file: f.rel, line: line(), message: 'raw HTTP server outside src/lib bypasses the Zod boundary' });
      }, ts);
    }
    if (ctx.routes.length === 0) findings.push({ file: 'src', line: 0, message: 'no defineRoute(...) routes found' });
    return ruleResult({
      unit: 'handlers',
      total: ctx.routes.length,
      files: domain.map((f) => f.rel),
      findings,
      failedUnits: badRoutes,
    });
  },
});
