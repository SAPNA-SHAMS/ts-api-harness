// Harness-owned. Route definitions parse params, query and body with Zod before the handler
// runs, and parse the handler's return value with the response schema before it is sent.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { fingerprint, IdempotencyKey, IdempotencyStore } from './idempotency.ts';
import { HttpProblem, problem, sendProblem } from './problem.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Use for routes that take no body (GET, DELETE) and for 204 responses. */
export const NoBody = z.undefined();
/** Use for routes with no path parameters or no query parameters. */
export const NoParams = z.object({}).strict();

type RouteSpec<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType> = {
  method: Method;
  path: string;
  status: 200 | 201 | 204;
  idempotent?: boolean;
  errors: readonly number[];
  params: P;
  query: Q;
  body: B;
  response: R;
  handler: (input: { params: z.output<P>; query: z.output<Q>; body: z.output<B>; headers: IncomingHttpHeaders }) => HandlerResult<R>;
};

/** 204 handlers (response NoBody) return nothing; every other handler returns the response schema's input. */
type HandlerResult<R extends z.ZodType> = z.input<R> extends undefined ? Promise<void> : Promise<z.input<R>>;

export type RawInput = { params: Record<string, string>; query: Record<string, string>; body: unknown; headers: IncomingHttpHeaders };

export type Route = {
  method: Method;
  path: string;
  status: 200 | 201 | 204;
  idempotent: boolean;
  errors: readonly number[];
  handle: (raw: RawInput) => Promise<unknown>;
};

function parseOr422<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : where}: ${i.message}`).join('; ');
    throw problem(422, 'validation', `Request ${where} failed validation`, detail);
  }
  return parsed.data;
}

export function defineRoute<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType>(
  spec: RouteSpec<P, Q, B, R>,
): Route {
  return {
    method: spec.method,
    path: spec.path,
    status: spec.status,
    idempotent: spec.idempotent ?? false,
    errors: spec.errors,
    handle: async (raw) => {
      const params = parseOr422(spec.params, raw.params, 'path');
      const query = parseOr422(spec.query, raw.query, 'query');
      const body = parseOr422(spec.body, raw.body, 'body');
      const out = await spec.handler({ params, query, body, headers: raw.headers });
      return spec.response.parse(out);
    },
  };
}

function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split('/').filter((s) => s.length > 0);
  const got = path.split('/').filter((s) => s.length > 0);
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const g = got[i];
    if (w === undefined || g === undefined) return undefined;
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(g);
    else if (w !== g) return undefined;
  }
  return params;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > 1_000_000) throw problem(413, 'payload-too-large', 'Payload too large', 'Request body exceeds 1 MB');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw problem(422, 'malformed-json', 'Request body is not valid JSON', 'body: could not be parsed as JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: string | undefined): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

async function dispatch(routes: readonly Route[], idem: IdempotencyStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, url.pathname);
    if (params === undefined) continue;
    pathMatched = true;
    if (route.method !== method) continue;

    const text = await readBody(req);
    const body = parseJson(text);
    let key: string | undefined;
    const scope = `${method} ${url.pathname}`;
    const print = fingerprint(text);
    if (route.idempotent) {
      const header = req.headers['idempotency-key'];
      const parsedKey = IdempotencyKey.safeParse(Array.isArray(header) ? header[0] : header);
      if (!parsedKey.success) {
        throw problem(422, 'idempotency-key-required', 'Idempotency-Key header required', 'Idempotency-Key: header must be 8-200 characters');
      }
      key = parsedKey.data;
      const replay = idem.lookup(scope, key, print);
      if (replay !== undefined) {
        sendJson(res, replay.status, replay.body.length > 0 ? replay.body : undefined);
        return;
      }
    }
    const out = await route.handle({ params, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    const payload = route.status === 204 ? undefined : JSON.stringify(out);
    if (key !== undefined) idem.save(scope, key, { fingerprint: print, status: route.status, body: payload ?? '' });
    sendJson(res, route.status, payload);
    return;
  }
  if (pathMatched) throw problem(405, 'method-not-allowed', 'Method not allowed', `${method} is not supported on ${url.pathname}`);
  throw problem(404, 'not-found', 'Resource not found', `No route for ${method} ${url.pathname}`);
}

export function createApp(routes: readonly Route[]): Server {
  const idem = new IdempotencyStore();
  return createServer((req, res) => {
    const instance = new URL(req.url ?? '/', 'http://localhost').pathname;
    dispatch(routes, idem, req, res).catch((err: unknown) => {
      const p = err instanceof HttpProblem ? err : problem(500, 'internal', 'Internal server error', 'An unexpected error occurred');
      sendProblem(res, p, instance);
    });
  });
}
