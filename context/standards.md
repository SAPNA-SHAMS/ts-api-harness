# API standards (enforced by `harness check`)

Each standard below is a deterministic rule in `plugins/rules/`. This document explains them; the
rules decide.

1. **zod-boundary** — every route is a `defineRoute({...})` from `src/lib/http.ts` declaring
   `params`, `query`, `body` and `response` Zod schemas. The harness lib parses all four; handlers
   never read the raw request. Types are `z.infer<typeof Schema>`; hand-written `interface` or
   object `type` declarations are rejected outside `src/lib`.
2. **problem-json** — every non-2xx response is `application/problem+json` with `type`, `title`,
   `status`, `detail`, `instance`. Handlers and stores `throw problem(status, slug, title, detail)`
   from `src/lib/problem.ts`. No `{ error: ... }` bodies, no `res.writeHead`, no `throw new Error`.
   At least one test asserts a problem+json response.
3. **strict-types** / **tsc-strict** — `strict` and `noUncheckedIndexedAccess` stay on (tsconfig is
   harness-owned). No `any`, no `!` non-null assertions, no `@ts-ignore`/`@ts-expect-error`. The
   real compiler must report zero errors across src and test.
4. **rest-conventions** — paths are `/v1/<plural-noun>[/:id]`. POST on a collection → 201 and
   `idempotent: true`; DELETE → 204; GET/PATCH/PUT → 200. Lists accept `cursor` + `limit`
   (`PageQuery`) and return `{ data, nextCursor }` (`pageOf(Item)`). Item routes declare 404;
   routes with a body declare 422; idempotent routes declare 409; lists declare 422. Every declared
   status must be raised by some `problem(<status>, …)`.
5. **contract-drift** — the route surface must equal what the task declares (greenfield) or the
   shipped `contract.snapshot.json` plus the task's declared additions (brownfield). Removing a
   route, changing a success status, removing a response field or making a body field required is
   a breaking change and fails unless the task lists it in `change.allowBreaking`.

## Layout of a governed API

```
src/lib/*            harness-owned: http.ts (defineRoute, createApp, NoBody, NoParams),
                     problem.ts (problem), pagination.ts (PageQuery, pageOf, paginate),
                     idempotency.ts
src/server.ts        harness-owned entry point; imports buildApp from src/app.ts
src/<resource>/schema.ts   Zod schemas + inferred types
src/<resource>/store.ts    in-memory store; throws problem(404|409, …)
src/<resource>/routes.ts   <resource>Routes(store): Route[] built with defineRoute
src/app.ts           export function buildApp(): Server { return createApp([...]) }
test/helpers.ts      harness-owned: start(), call(), field()
test/<resource>.test.ts    node:test suite run by the harness runner
```

## Gates you will meet

- **observed-red**: a `src/**` file can only be written after a mapped test
  (`test/<resource>*.test.ts`) was run by `run_tests` and failed at its current version.
- **harness-owned**: `src/lib/**`, `src/server.ts`, `test/helpers.ts`, `tsconfig.json`,
  `package.json`, `contract.snapshot.json` are read-only.
- **scope-guard** (brownfield): only files inside the change scope may be written.
- **protect-existing-tests** (brownfield): existing tests may not be removed or weakened.
- **finish**: the harness runs all tests, tsc and every standards rule itself. The task is done
  only when every gate is green.
