# ts-api-harness

A model-agnostic agent **harness** (not an agent) that governs TypeScript REST API work, both
greenfield (generate a new API from a task file) and brownfield (change an existing API). It
calls a model through a driver, wraps every tool call in gates and hooks, fetches context just
in time, and ends only when its own deterministic checks are green. Then it ships to a feature
branch. The model never commits.

- **Core engine directory: `src/core/`.** Extensions never touch it (see [Extending](#extending-without-touching-core)).
- **Design note:** [docs/design.md](docs/design.md) (architecture, driver abstraction, token budget, extension points, honesty boundary).
- **Run evidence:** [reports/EVIDENCE.md](reports/EVIDENCE.md).
- **Original addition:** the declared-surface (contract-drift) gate ([below](#original-addition-declared-surface-gate)).

> **Honesty note.** The same task file has run **green on live Claude
> (`anthropic/claude-sonnet-5.5`) and live OpenAI (`openai/gpt-6.1-sol`)** through OpenRouter,
> standards 100% on both. The live token reduction is **84.4% and 87.6%, below the 90% target**.
> The earlier evidence (both tasks, both drivers, measured baselines) came from the real drivers
> talking to `test/fake-provider/`, a local wire-validating server with a scripted stand-in model.
> The ship step pushed a feature branch and opened
> [PR #1](https://github.com/SAPNA-SHAMS/ts-api-harness/pull/1) itself, after every gate was green.

## Setup

Requires Node ≥ 22.18 (runs TypeScript directly; developed on Node 24).

```bash
npm run setup                     # npm install + make ./harness executable
export ANTHROPIC_API_KEY=…        # for --driver claude
export OPENAI_API_KEY=…           # for --driver openai
# optional: HARNESS_CLAUDE_MODEL, HARNESS_OPENAI_MODEL, ANTHROPIC_BASE_URL, OPENAI_BASE_URL
```

Keys are read from the environment only. `.env*` is git-ignored, and the `secret-guard` gate
blocks key-shaped content from being written into a workspace.

## Commands

```bash
# Same task file, two providers: zero edits to task, hooks or checks between runs
./harness run --task tasks/users-api.json     --driver claude
./harness run --task tasks/users-api.json     --driver openai
./harness run --task tasks/orders-cancel.json --driver claude   # brownfield

#   --with-baseline   also run the same task/driver with fetchers+compaction off and attach it to the token report
#   --baseline        run in baseline mode only
#   --no-ship / --no-push   stop before shipping / before pushing

./harness check --api generated/users-api [--task tasks/users-api.json] [--json]   # standards report, exit 0 only at 100%
./harness plugins                          # every registered tool, rule, validator, hook, driver
./harness snapshot --api examples/orders-api   # write contract.snapshot.json for an existing API
./harness tokens --file tokens/<run>.json  # per-turn baseline vs actual

# Without keys: run the real CLI and drivers against the local wire-level provider
node scripts/offline-run.ts --task tasks/users-api.json --driver openai --with-baseline

npm test            # 39 tests: gates, 20 standards mutations, drivers, e2e grader scenarios
npm run lint        # tsc (strict) + provider-leak lint
npm run evidence    # regenerate reports/EVIDENCE.md (add `-- --live` to use real keys)
npm run grader-sim  # the three extensibility additions in a scratch clone, with git diff --stat
```

## How a run works

1. **Workspace.** Greenfield copies the harness scaffold (`context/scaffold`: tsconfig,
   `src/lib/**`, test helpers). Brownfield copies the target repo and first runs its existing
   tests to establish a regression baseline.
2. **Loop.** The model gets a 138-token system prompt and a one-line kickoff. It fetches the
   task, scope, file slices and convention topics as it needs them.
3. **Gates on every write.** These are in `src/core/gates.ts` and cannot be disabled:
   - `path-guard`: only `src/**` and `test/**` `.ts` files.
   - `harness-owned`: `src/lib/**`, `tsconfig.json` and similar are read-only, so the model
     cannot weaken strictness.
   - `secret-guard`
   - `scope-guard`: brownfield writes stay inside the change scope.
   - **`observed-red`**: a `src/` file is refused until a mapped test was run by the harness and
     failed at its current version.
4. **Plugin hooks.** `standards-on-write` (post) returns rule failures for the file just written.
   `protect-existing-tests` (pre) blocks deleting or weakening existing tests.
5. **finish.** The harness runs every test file, the brownfield regression set, the observed-red
   ledger and the full standards check. It accepts only if all are green; otherwise it refuses
   with compact reasons.
6. **Ship.** The harness, not the model, ships:
   1. Creates a temporary git worktree and a new `harness/<task>-<driver>-<id>` branch.
      Protected branches are refused.
   2. Copies the result to `generated/<task>` (greenfield) or the original repo path (brownfield).
   3. Writes `contract.snapshot.json`.
   4. Re-runs the standards check on that exact tree. There is no commit on red.
   5. Commits and writes `reports/<run>.patch`.
   6. Pushes and opens a PR via `gh`, only when an `origin` remote exists. It never force-pushes.

Brownfield output in this repository is left on its feature branch and patch file, so
`examples/orders-api` stays pristine for re-runs. Greenfield output was merged to `main` as
`generated/users-api`.

## Standards checks (each one a plugin rule)

| rule | what it inspects | unit |
|---|---|---|
| `zod-boundary` | every `defineRoute` declares params, query, body and response Zod schemas (no `z.any/unknown`); handlers never touch the raw request; no hand-written `interface`/object `type` outside `src/lib`; no `JSON.parse` or raw servers outside the lib | handlers |
| `problem-json` | the problem helper sets `application/problem+json` and all 5 fields; every `problem(...)` has a literal 4xx/5xx status and a title; no `{ error }` bodies, raw `res.writeHead/end`, or `throw new Error`; a test asserts problem+json | error paths |
| `strict-types` | `strict` and `noUncheckedIndexedAccess` on; no `any`, `!` or `@ts-ignore/expect-error/nocheck` in src or tests | files |
| `tsc-strict` | the real compiler with the API's tsconfig; not runnable → UNPROVEN | errors |
| `rest-conventions` | `/vN/` base path; plural kebab nouns; POST→201 + `idempotent`; DELETE→204; GET/PATCH/PUT→200; lists take `cursor`+`limit` and return `{data,nextCursor}`; item routes declare 404, body routes 422, idempotent routes 409; every declared status is actually raised | routes |
| `contract-drift` | declared-surface gate (below) | routes |
| `orm-users-explicit-columns` | example ORM validator: Prisma/Drizzle queries on users select explicit columns; n/a when there are no queries | queries |

Output is one line per rule per file with pass/FAIL and `file:line`, then one summary per rule,
then the verdict:

```
$ ./harness check --api generated/users-api          (full output: reports/standards-users-api.txt)
contract-drift              pass     5/5 routes
problem-json                pass     11/11 error paths
rest-conventions            pass     5/5 routes
strict-types                pass     11/11 files
tsc-strict                  pass     0 errors
zod-boundary                pass     5/5 handlers
orm-users-explicit-columns  n/a      0/0 queries  (no ORM queries on users found)
verdict                     100%     → dimension scored
```

`test/standards.test.ts` covers 20 deliberate violations. Each one is caught by the expected rule
with a location: missing or opaque schemas, raw request access, hand-written types, `{error}`
shapes, raw writes, `throw new Error`, untested problem+json, `any`, `!`, `@ts-ignore`, the
strict flag turned off, type errors, an unversioned path, a singular noun, missing pagination,
the wrong success status, a missing idempotency key, a missing 404, and a removed route.

## Model agnosticism

The engine speaks one neutral shape: `ModelDriver.run({system, messages, tools: JSON Schema})`.
`drivers/claude.ts` and `drivers/openai.ts` are the only files that know a vendor exists (see
[design §2](docs/design.md#2-driver-abstraction)). Three things enforce this:

- `npm run lint` fails on any provider name, model name, vendor tool-schema shape or provider
  env var in `tasks/`, `src/core/`, `plugins/` or `context/`.
- The task loader rejects task files that name a registered driver.
- Every run report records hashes of the task file, hooks, checks and core. The e2e test runs
  both drivers on the same task and asserts identical hashes and green verdicts for both.

## Token efficiency

Every run writes `tokens/<run>.json`:
- per turn: provider-reported input tokens, the estimated actual request, and the estimated
  baseline for the same conversation with fetchers and compaction off;
- totals and `reductionPercent`;
- with `--with-baseline`: a separately run baseline (`measuredBaseline`) and
  `reductionVsMeasuredBaselinePercent`.

Mechanisms: JIT fetchers, compact tool returns with raw logs on disk, digest compaction, elided
executed arguments, and JIT tool schemas. Numbers and per-turn tables are in
[design §3](docs/design.md#3-token-budget).

| run | model | verdict | reduction (shadow baseline) |
|---|---|---|---|
| users-api / claude, live | anthropic/claude-sonnet-5.5 | GREEN, 18 turns | **84.4%** |
| users-api / openai, live | openai/gpt-6.1-sol | GREEN, 35 turns | **87.6%** |

**The 90% target is not met with live models.** The scripted runs listed in
[reports/EVIDENCE.md](reports/EVIDENCE.md) measured 90.6–91.4% under an earlier, more aggressive
compaction policy. That policy made live Claude loop for 40 turns without writing anything, so it
was replaced (see [design §3](docs/design.md#3-token-budget)).

## Extending without touching core

The core engine is `src/core/`. Everything below is discovered at startup. Drop a file in, or
list a module in `plugins/registry.json`:

```ts
// plugins/tools/openapi-diff.ts — appears in the next run's tool list
import { defineTool } from '../../src/core/sdk.ts';
export default defineTool({ name: 'openapi_diff', description: '…', parameters: { type: 'object', properties: {} }, run: (args, ctx) => ({ status: 'ok', summary: '…' }) });

// plugins/validators/drizzle-users-select.ts — joins `harness check`, the finish gate and the per-write hook
import { defineValidator, ruleResult } from '../../src/core/sdk.ts';
export default defineValidator({ id: 'drizzle-users-select', description: '…', run: (ctx) => ruleResult({ unit: 'queries', total, files, findings: [{ file, line, message }] }) });

// plugins/rules/no-console.ts — gets its own pass/FAIL line per file with locations
import { defineRule } from '../../src/core/sdk.ts';
```

Rules receive TypeScript ASTs for every file, extracted routes, schema-field resolution and a
memoised `tsc` run. Hooks use `defineHook({ phase: 'pre' | 'post', tools, run })` and return
`pass | block | record` with feedback. A driver is one `defineDriver` file in `drivers/`.

`npm run grader-sim` does all three grader additions live in a scratch clone and prints
`git diff --stat` after each. Only the plugin file (plus `registry.json` for the manifest route)
changes, and `src/core/` is untouched. See [reports/grader-sim.txt](reports/grader-sim.txt).

## Original addition: declared-surface gate

`plugins/rules/contract-drift.ts`, built on `src/core/contract.ts`, extracts the route contract
statically and compares it:
- **Greenfield:** against the routes the task's behaviours imply. A missing route or an extra,
  undeclared route fails.
- **Brownfield:** against `contract.snapshot.json`, which the harness writes when it ships.
  Removed routes, changed success statuses, removed response fields and newly required body
  fields are breaking and fail unless the task lists them in `change.allowBreaking`. Added routes
  must be declared in `change.adds`.

It runs in `harness check`, the finish gate and the ship re-check. The model can inspect it with
the `contract_diff` tool. Also new: `protect-existing-tests`, and the `use_tool` catalog that
loads tool schemas just in time.

## Honesty boundary

- `PASS` means the harness ran the check and it passed.
- `FAIL` means it ran and failed, with a location.
- `UNPROVEN` means the check could not run. Examples: tsc missing, a crashed rule, a plugin that
  failed to load, no contract baseline, no remote, no live provider. UNPROVEN blocks a 100%
  verdict.
- `n/a` means a rule found nothing to check (e.g. no ORM queries). It is shown, never counted
  as a pass.
- A test file that runs zero tests is never green.

What a human still verifies: that the tests assert the right behaviour, business semantics,
security beyond secret scanning, and the PR merge. Details are in
[design §5](docs/design.md#5-honesty-boundary).

## Layout

```
src/core/          CORE ENGINE: engine loop, gates, tools, context/compaction, registry, checker,
                   API model (AST + tsc), contract, runner, ship, CLI, plugin SDK (sdk.ts)
drivers/           claude.ts, openai.ts (the only vendor-aware code)
plugins/           tools/, rules/, validators/, hooks/, registry.json (optional manifest)
context/           standards.md, reference/*.md (fetched JIT), scaffold/ (harness-owned lib)
tasks/             users-api.json (greenfield), orders-cancel.json (brownfield)
examples/orders-api   sample existing API (brownfield target)
generated/users-api   API generated and shipped by the harness, merged to main
logs/<run>/        transcript.jsonl, hooks.jsonl, test/tsc logs, standards.txt, summary.txt
tokens/<run>.json  token report      reports/<run>.json   run report (gates, hooks, hashes, ship)
reports/<run>.patch   shipped commit  reports/EVIDENCE.md  index of all evidence
test/              harness tests; test/fake-provider/ = offline wire-level provider + scripted stand-in
scripts/           offline-run, evidence, grader-sim, lint-agnostic, link-baseline
```
