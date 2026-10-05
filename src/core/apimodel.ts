// Static model of a governed API: parsed sources, extracted routes and a real compiler run.
// Rules read this model; they never re-implement parsing.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { CheckContext, Finding, RouteInfo, SourceInfo, TaskInfo, TscResult } from './sdk.ts';
import { listFilesRec, REPO_ROOT } from './util.ts';

export function parseSource(rel: string, text: string): SourceInfo {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return {
    rel,
    text,
    sf,
    isLib: rel.startsWith('src/lib/'),
    isTest: rel.startsWith('test/') || rel.endsWith('.test.ts'),
    line: (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1,
  };
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
  for (const p of obj.properties) {
    if (p.name === undefined) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    if (ts.isMethodDeclaration(p)) return p;
  }
  return undefined;
}

function literalText(n: ts.Node | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return undefined;
}

function literalNumber(n: ts.Node | undefined): number | undefined {
  return n !== undefined && ts.isNumericLiteral(n) ? Number(n.text) : undefined;
}

function extractRoutes(file: SourceInfo, objectFields: CheckContext['objectFields']): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file.sf) === 'defineRoute') {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        const errorsNode = prop(arg, 'errors');
        const errors = errorsNode !== undefined && ts.isArrayLiteralExpression(errorsNode)
          ? errorsNode.elements.map((e) => literalNumber(e)).filter((n): n is number => n !== undefined)
          : [];
        const schemaText = (k: string): string | undefined => prop(arg, k)?.getText(file.sf);
        const schemas: RouteInfo['schemas'] = {};
        for (const k of ['params', 'query', 'body', 'response'] as const) {
          const t = schemaText(k);
          if (t !== undefined) schemas[k] = t;
        }
        const body = schemas.body;
        const response = schemas.response;
        routes.push({
          file,
          line: file.line(node.getStart(file.sf)),
          method: literalText(prop(arg, 'method')) ?? '?',
          path: literalText(prop(arg, 'path')) ?? '?',
          status: literalNumber(prop(arg, 'status')),
          idempotent: prop(arg, 'idempotent')?.kind === ts.SyntaxKind.TrueKeyword,
          errors,
          schemas,
          bodyFields: body === undefined ? undefined : objectFields(body),
          responseFields: response === undefined ? undefined : objectFields(response)?.map((f) => f.name),
          handler: prop(arg, 'handler'),
          node: arg,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return routes;
}

export function runTsc(root: string): Promise<TscResult> {
  const config = join(root, 'tsconfig.json');
  if (!existsSync(config)) return Promise.resolve({ ran: false, errors: [], reason: 'no tsconfig.json', log: '' });
  const tscJs = join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!existsSync(tscJs)) return Promise.resolve({ ran: false, errors: [], reason: 'typescript is not installed (run npm install)', log: '' });
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [tscJs, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd: root });
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (log += d.toString()));
    child.on('error', (err) => resolveP({ ran: false, errors: [], reason: err.message, log }));
    child.on('close', (code) => {
      const errors: Finding[] = [];
      for (const line of log.split('\n')) {
        const m = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(line.trim());
        if (m !== null) errors.push({ file: m[1] ?? '?', line: Number(m[2]), message: m[3] ?? '' });
      }
      if (code !== 0 && errors.length === 0) {
        resolveP({ ran: false, errors: [], reason: `tsc exited ${code ?? 'null'} without diagnostics`, log });
        return;
      }
      resolveP({ ran: true, errors, log });
    });
  });
}

export function buildCheckContext(root: string, task: TaskInfo | undefined): CheckContext {
  const rels = listFilesRec(root).filter((r) => r.endsWith('.ts') && !r.endsWith('.d.ts') && (r.startsWith('src/') || r.startsWith('test/')));
  const files = rels.map((rel) => parseSource(rel, readFileSync(join(root, rel), 'utf8')));
  const src = files.filter((f) => !f.isTest);
  const tests = files.filter((f) => f.isTest);

  const consts = new Map<string, string>();
  for (const f of src) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && !consts.has(n.name.text)) {
        consts.set(n.name.text, n.initializer.getText(f.sf));
      }
      ts.forEachChild(n, visit);
    };
    visit(f.sf);
  }
  const resolveConst = (name: string): string | undefined => consts.get(name);

  const objectFields = (expr: string, depth = 0): { name: string; optional: boolean }[] | undefined => {
    if (depth > 6) return undefined;
    const trimmed = expr.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      const target = resolveConst(trimmed);
      return target === undefined ? undefined : objectFields(target, depth + 1);
    }
    const pageOf = /^pageOf\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(trimmed);
    if (pageOf !== null) return [{ name: 'data', optional: false }, { name: 'nextCursor', optional: false }];
    const sf = ts.createSourceFile('expr.ts', `const __x = ${trimmed};`, ts.ScriptTarget.Latest, true);
    let fields: { name: string; optional: boolean }[] | undefined;
    const visit = (n: ts.Node): void => {
      if (fields !== undefined) return;
      if (ts.isCallExpression(n) && /\.object$/.test(n.expression.getText(sf))) {
        const arg = n.arguments[0];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          fields = arg.properties.flatMap((p) => {
            if (!ts.isPropertyAssignment(p) || p.name === undefined) return [];
            const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : p.name.getText(sf);
            const init = p.initializer.getText(sf);
            return [{ name, optional: /\.optional\(\)|\.default\(|\.nullish\(\)/.test(init) }];
          });
          const outer = n.parent;
          if (ts.isPropertyAccessExpression(outer) && outer.name.text === 'partial') fields = fields.map((f) => ({ ...f, optional: true }));
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return fields;
  };

  const routes = src.flatMap((f) => extractRoutes(f, (e) => objectFields(e)));
  const tsconfigPath = join(root, 'tsconfig.json');
  let tsconfig: Record<string, unknown> | undefined;
  if (existsSync(tsconfigPath)) {
    const parsed = ts.parseConfigFileTextToJson(tsconfigPath, readFileSync(tsconfigPath, 'utf8'));
    if (typeof parsed.config === 'object' && parsed.config !== null) tsconfig = parsed.config as Record<string, unknown>;
  }
  let tscMemo: Promise<TscResult> | undefined;
  return {
    root,
    ts,
    files,
    src,
    tests,
    routes,
    tsconfig,
    resolveConst,
    objectFields: (e) => objectFields(e),
    tsc: () => (tscMemo ??= runTsc(root)),
    task,
    readText: (rel) => {
      const p = join(root, rel);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    },
  };
}
