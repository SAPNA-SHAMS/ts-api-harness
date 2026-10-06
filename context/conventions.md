# Conventions sheet (everything needed to write a governed API; topics have fuller examples)
Files: src/<res>/schema.ts, src/<res>/store.ts, src/<res>/routes.ts, src/app.ts, test/<res>.test.ts. src/lib/** and test/helpers.ts are harness-owned: import only.
schema.ts: `import { z } from 'zod'; import { PageQuery, pageOf } from '../lib/pagination.ts';`
  `export const Widget = z.object({ id: z.uuid(), name: z.string().min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }); export type Widget = z.infer<typeof Widget>;`
  WidgetCreate / WidgetUpdate = z.object({...}).strict() (update fields .optional()); WidgetIdParams = z.object({ id: z.uuid() }).strict(); ListWidgetsQuery = PageQuery; WidgetPage = pageOf(Widget).
  Types are only z.infer<...>; no interface or object type literals. Field types: z.string(), z.email(), z.number().int(), z.number(), z.boolean(), z.iso.datetime().
store.ts: class with `readonly #items = new Map<string, Widget>()`; list(cursor, limit) returns paginate([...values], cursor, limit) from ../lib/pagination.ts;
  missing → `throw problem(404, 'not-found', 'Widget not found', detail)`; uniqueness → `throw problem(409, 'conflict', 'Widget already exists', detail)` (problem from ../lib/problem.ts). Never `!`, never `any`, never `throw new Error`.
routes.ts: `export function widgetRoutes(store: WidgetStore): Route[] { return [defineRoute({...}), ...] }` with defineRoute, NoBody, NoParams, type Route from ../lib/http.ts. Each route declares method, path, status, errors, params, query, body, response, handler:
  GET /v1/widgets      status 200 errors [422]           params NoParams query ListWidgetsQuery body NoBody response WidgetPage  handler ({ query }) => store.list(query.cursor, query.limit)
  GET /v1/widgets/:id  status 200 errors [404, 422]      params WidgetIdParams query NoParams body NoBody response Widget
  POST /v1/widgets     status 201 idempotent: true errors [409, 422] params NoParams query NoParams body WidgetCreate response Widget
  PATCH /v1/widgets/:id status 200 errors [404, 409, 422] body WidgetUpdate response Widget
  DELETE /v1/widgets/:id status 204 errors [404, 422] body NoBody response NoBody handler async ({ params }) => { store.remove(params.id); }
  Every declared error status must be raised by some problem(<status>, ...); 422/409 for validation, malformed JSON, cursor and Idempotency-Key are raised by src/lib.
app.ts: `export function buildApp(): Server { return createApp([...widgetRoutes(new WidgetStore())]); }` (createApp from ./lib/http.ts, type Server from node:http).
tests: node:test + node:assert/strict; `import { call, field, start } from './helpers.ts'`; before(async () => ({ base, server } = await start())); after(() => server?.close());
  call(base, method, path, body?, idempotencyKey?) → { status, type, json }; POST needs an Idempotency-Key of 8+ chars; assert error responses have type 'application/problem+json'.
