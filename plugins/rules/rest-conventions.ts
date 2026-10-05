// Standard 04: REST conventions. Plural nouns under a versioned base path, cursor pagination on
// lists, Idempotency-Key on POST, and consistent 201/204/404/409/422 usage.
import ts from 'typescript';
import { defineRule, ruleResult, walk, type Finding } from '../../src/core/sdk.ts';

const IRREGULAR_PLURALS = new Set(['people', 'children', 'data', 'media', 'criteria', 'news', 'feedback', 'inventory']);
const ALLOWED_ERRORS = new Set([400, 401, 403, 404, 409, 412, 415, 422, 429]);

function isPlural(word: string): boolean {
  if (IRREGULAR_PLURALS.has(word)) return true;
  return /^[a-z][a-z-]*[a-z]s$/.test(word) && !/(ss|us|is)$/.test(word);
}

export default defineRule({
  id: 'rest-conventions',
  description: 'plural nouns, /vN base path, cursor pagination, idempotency keys, 201/204/404/409/422',
  run(ctx) {
    const findings: Finding[] = [];
    const raised = new Set<number>();
    for (const f of ctx.src) {
      walk(f.sf, (n) => {
        if ((ts.isCallExpression(n) && n.expression.getText(f.sf) === 'problem') || (ts.isNewExpression(n) && n.expression.getText(f.sf) === 'HttpProblem')) {
          const a = n.arguments?.[0];
          if (a !== undefined && ts.isNumericLiteral(a)) raised.add(Number(a.text));
        }
      }, ts);
    }
    let badRoutes = 0;
    const seen = new Set<string>();
    for (const r of ctx.routes) {
      const before = findings.length;
      const at = (message: string): void => void findings.push({ file: r.file.rel, line: r.line, message: `${r.method} ${r.path}: ${message}` });
      const segs = r.path.split('/').filter((s) => s.length > 0);
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) at('duplicate route');
      seen.add(key);
      if (!/^v\d+$/.test(segs[0] ?? '')) at('path must start with a version segment like /v1');
      const nouns = segs.slice(1).filter((s) => !s.startsWith(':'));
      if (nouns.length === 0) at('no resource segment');
      for (const n of nouns) if (!isPlural(n)) at(`resource segment '${n}' must be a plural noun`);
      for (const s of segs) if (s.startsWith('{') || /[A-Z_]/.test(s)) at(`segment '${s}' must be lowercase kebab-case or :param`);
      const isItem = (segs[segs.length - 1] ?? '').startsWith(':');
      const expected = r.method === 'POST' && !isItem ? 201 : r.method === 'DELETE' ? 204 : 200;
      if (r.status !== expected) at(`success status must be ${expected} for ${r.method} on a ${isItem ? 'item' : 'collection'}, got ${r.status ?? 'none'}`);
      if (r.method === 'POST' && !r.idempotent) at('POST must declare idempotent: true (Idempotency-Key on unsafe retries)');
      const isList = r.method === 'GET' && !isItem;
      if (isList) {
        const q = ctx.objectFields(r.schemas.query ?? '')?.map((x) => x.name) ?? [];
        if (!q.includes('cursor') || !q.includes('limit')) at('list route must accept cursor and limit query parameters');
        const resp = r.responseFields ?? [];
        if (!resp.includes('nextCursor') || !resp.includes('data')) at('list response must be { data, nextCursor }');
        if (!r.errors.includes(422)) at('list route must declare 422 (invalid cursor/limit)');
      }
      if (isItem && !r.errors.includes(404)) at('item route must declare 404');
      if (['POST', 'PUT', 'PATCH'].includes(r.method) && !r.errors.includes(422)) at('route with a body must declare 422');
      if (r.idempotent && !r.errors.includes(409)) at('idempotent route must declare 409 (key reused with a different body)');
      for (const e of r.errors) {
        if (!ALLOWED_ERRORS.has(e)) at(`error status ${e} is not a conventional client error`);
        else if (!raised.has(e)) at(`declares ${e} but no problem(${e}, …) is raised anywhere`);
      }
      if (findings.length > before) badRoutes++;
    }
    if (ctx.routes.length === 0) findings.push({ file: 'src', line: 0, message: 'no routes found' });
    return ruleResult({ unit: 'routes', total: ctx.routes.length, files: [...new Set(ctx.routes.map((r) => r.file.rel))], findings, failedUnits: badRoutes });
  },
});
