# Design note: a harness for TypeScript REST APIs

## 1. Architecture

```
task file ──► engine loop (src/core/engine.ts) ──► driver.run(neutral request) ──► model
                 │  ▲                                   (drivers/claude.ts, drivers/openai.ts)
                 │  └── compact tool results + hook feedback
                 ▼
   for every tool call:  core pre-gates ─► plugin pre-hooks ─► tool ─► plugin post-hooks
                          path-guard          protect-existing-tests     standards-on-write
                          harness-owned
                          secret-guard
                          scope-guard (brownfield)
                          observed-red
                 ▼
   finish ─► completion gates (run by the harness, never the model):
             tests green · regression green (brownfield) · observed-red ledger · standards 100%
                 ▼
   ship (src/core/ship.ts): temp git worktree → feature branch → standards re-check on the
             exact tree → commit → push / PR when a remote exists
```

**Deterministic (code):** workspace setup (the scaffold or a copy of the existing repo), the
harness-owned library (`src/lib/**`: `defineRoute`, problem+json, pagination, idempotency), test
runs, red/green observation, `tsc`, every standards rule, the route contract, scope, compaction,
token accounting and git. **The model decides:** how to break down the task, what the tests
assert, how to write schemas, stores and handlers, and how to respond to BLOCKED/FAIL feedback.

A source file under `src/` is refused until a mapped test (`test/<resource>*.test.ts`, or a
`testMap` in the task) has been run **by the harness runner** and failed *at its current
version*. Editing the test again invalidates that observation. "Done" means `finish` was
accepted, which the engine decides only after its own gates pass. The model never commits.

## 2. Driver abstraction

```ts
interface ModelDriver { readonly id: string; run(req: ModelRequest): Promise<ModelResponse> }
ModelRequest  = { system, messages: Message[], tools: ToolSpec[] (plain JSON Schema), maxOutputTokens }
Message       = user{text} | assistant{text, toolCalls[{id,name,args}]} | tool{results[{callId,name,content}]}
ModelResponse = { text, toolCalls, stop: 'tools'|'end'|'length', usage{inputTokens,outputTokens} }
```

Each adapter (about 60 lines) owns everything vendor-shaped: endpoints, auth headers,
`tool_use`/`tool_result` blocks vs `tool_calls`/`role:"tool"`, `input_schema` vs
`{type:"function"}`, JSON-string arguments, stop-reason and usage field names, and retries.
**Refused to leak:** provider names, model ids, wire shapes and env-var names never appear in
`tasks/`, `src/core/`, `plugins/` or `context/`. `scripts/lint-agnostic.ts` enforces this in
`npm run lint`. The task loader also rejects any task file that names a registered driver.
Drivers are discovered from `drivers/`, so a third provider is one new file.

## 3. Token budget

The measured numbers below come from `reports/EVIDENCE.md` and the files under `tokens/`. Every
run writes `tokens/<run>.json` with, per turn, the provider-reported input tokens, an estimate of
the request actually sent, and an estimate of the **same conversation rendered with context
fetchers and compaction disabled**. That last one is the shadow baseline. Both estimates use
`ceil(chars/4)`, so the ratio compares like with like. `--with-baseline` also runs the task
separately in baseline mode on the same driver and attaches that run's provider-reported tokens
(`measuredBaseline`).

users-api on the Claude driver, 13 turns (per-turn table: `harness tokens --file tokens/…-users-api-claude-jit-4f0zp1.json`):

| | turn 1 | turn 7 | turn 13 | total |
|---|---|---|---|---|
| baseline (shadow) | 6,429 | 9,494 | 12,157 | 121,806 |
| actual (JIT) | 632 | 807 | 917 | 10,916 |

Measured baseline run: 122,188 vs 11,156 provider-reported input tokens, a **90.9%** reduction.
The other three runs measured 90.6%, 91.4% and 91.1%.

What earned it:
1. **JIT context fetchers.** A 138-token system prompt replaces a 5.4–7.6k-token front-load of
   the standards, the references and every workspace file. `get_task`, `get_scope`, `read_file`
   (line slices), `get_reference(topic)` and `contract_diff` fetch only what the next step needs.
2. **Compact tool returns.** Each tool returns a summary, a compact form and a raw form. Only the
   compact form reaches the model; raw test logs, tsc output and full reports go to `logs/<run>/`
   and are referenced by path.
3. **Compaction that keeps context until it is used.** Results fetched since the model's last
   action (write, edit, test run, finish) stay verbatim. Before that, a 1,200-token budget keeps
   the newest exchanges verbatim. Older turns collapse to one deduplicated digest line each, and
   executed arguments over 200 characters (file bodies) are elided because they are on disk. The
   task and scope are pinned verbatim for the whole run.
4. **Export-surface reads.** A plain `read_file` of a harness-owned file returns declarations
   without bodies: `http.ts` goes from 6,703 to 1,969 characters. A line range returns the bodies.
5. **JIT tool schemas.** Four tools ship with full schemas (chosen by mode). The rest sit in a
   one-line catalog behind a `use_tool` dispatcher. The engine unwraps it, so hooks still see the
   real tool name.

**Live results miss the target.** Four live runs (both tasks, both providers) finished green
at 78–85% against the shadow baseline. A separately measured baseline run of the brownfield task
on Claude finished in 5 turns and 86,995 input tokens; the JIT run took 10 turns and 54,006, only
**37.9%** less in total, even though each JIT request was 69% smaller on average (peak 9.7k vs 19.9k).
Front-loading saves a model the turns it otherwise spends fetching. The context-window footprint
per request shrinks a lot; total spend shrinks much less.

Live runs also found two compaction bugs the scripted stand-in hid. Dropping everything but the
last exchange made Claude re-fetch the task for 40 turns. Eliding its own writes immediately made
it rewrite the same files five times; that run *looked* better (90.8%) only because thrashing grew
the baseline. The current policy pins the task, scope and a one-page conventions sheet, keeps
context until the model acts on it, and keeps the latest action visible.

## 4. Extension points

| add a… | drop a file into | uses | appears in |
|---|---|---|---|
| tool | `plugins/tools/*.ts` | `defineTool` | the next run's tool list; `harness plugins` |
| linter rule | `plugins/rules/*.ts` | `defineRule` | `harness check`, the finish gate, the per-write hook |
| ORM validator | `plugins/validators/*.ts` | `defineValidator` | same as rules, with kind `validator` |
| hook | `plugins/hooks/*.ts` | `defineHook` (pre/post, block/record/pass) | every matching tool call |
| driver | `drivers/*.ts` | `defineDriver` | `--driver <id>` |

You can also list modules anywhere in `plugins/registry.json`. Rules get a parsed model of the
API: TypeScript ASTs, extracted `defineRoute` routes, schema field resolution and a memoised
`tsc` run. They return findings with a file and line, which the checker prints as one line per
rule per file. **Core is `src/core/`.** `npm run grader-sim` performs the three grader additions
in a scratch clone and shows `git diff --stat` touching only plugin files and the registry entry
(`reports/grader-sim.txt`).

## 5. Honesty boundary

**Proven by the harness on every run:** a mapped test was observed red before each source edit;
all tests are green when finishing; pre-existing tests are still green and were not shrunk; tsc
reports zero errors under strict + `noUncheckedIndexedAccess`; every rule passes with locations;
the route surface matches the task and snapshot; standards are re-checked on the exact tree being
committed.

**UNPROVEN, labelled as such:**
- Live runs (OpenRouter) cover both tasks on both providers, all green, and one live ship that
  opened PR #2. The 90% token target is UNMET live (78–85% shadow, 37.9% measured).
- Turn budgets matter: one live OpenAI run went RED at 40 turns and passed at 60.
- Push and pull request are proven once: the ship step opened
  [PR #1](https://github.com/SAPNA-SHAMS/ts-api-harness/pull/1). The earlier evidence runs predate
  the remote and stopped at local feature-branch commits plus `reports/<run>.patch`.
- `contract-drift` reports UNPROVEN when an API has neither a snapshot nor a task to compare
  against.
- A test file that executes no tests is never green. A rule that crashes, or a plugin that fails
  to load, is UNPROVEN and blocks a 100% verdict.

**Still needs a human:** whether the tests assert the *right* behaviour (they are proven to run
red then green, not to be complete); business semantics of status codes beyond the conventions;
the security of handlers beyond secret scanning; and merging the pull request. Static rules
recognise this harness's `defineRoute` convention: code that bypasses it is flagged, but
semantically equivalent hand-rolled routing is not understood.

## Original addition: the declared-surface (contract-drift) gate

sf-harness gates *how* code is written. This gate fixes *what* surface the code may expose. The
route contract (methods, paths, success status, error statuses, body fields with optionality,
response fields) is extracted statically and compared:
- **Greenfield:** against the task's behaviours. A missing route or an undeclared extra route fails.
- **Brownfield:** against `contract.snapshot.json`, written by the ship step at the last ship.
  Removed routes, changed success statuses, removed response fields and newly required body fields
  are breaking and fail unless the task lists them in `change.allowBreaking`. Added routes must be
  declared in `change.adds`.

The gate runs as `plugins/rules/contract-drift.ts`, inside `harness check`, the finish gate and
the ship re-check. The model can inspect it with `contract_diff`. Two smaller additions also
ship: **protect-existing-tests** (brownfield tests may grow but never shrink) and the
**`use_tool` schema catalog** (§3).
