# Workflow — Sapna Shams

> **TODO (Sapna):** every `TODO` below has to be in your own words. The graders read the hooks
> next to this file, and anything here that isn't true scores against you. The gate-by-gate
> table at the bottom already points to real files.

## How work reaches me
TODO: where the SEO / site-QA work comes from (Slack? Jira? SEO team in person? GSC emails?) and
which one you act on first.

## Where I lose time
TODO: your three real stalls. Candidates from this repo's history, keep only the ones that are true:
1. Building before the ask is pinned down, then redoing it. *(01 history: the compaction policy was rewritten three times.)*
2. Waiting on a yes from the SEO side that came in chat and got lost.
3. Re-running the full Cypress SEO suite against live URLs to check one fix.

## What I repeat
TODO. Candidates: naming the branch, writing the "before" number down somewhere, pasting the
same PR description, re-running the spec to show it was red.

## What breaks
TODO: mistakes you have made at least twice. Each one needs a row in the table below.
Candidates the gates already cover:
- Calling something done without checking the number moved → outcome check.
- A test that was never seen failing (green from the start, so it proved nothing) → red-before-green.
- Writing a fix and only then finding out it wasn't what was asked → problem-statement + human-yes gates.

## The three backlog items
TODO, real items with a named stakeholder each:
- `<slug>` — owner: `<who>` — metric: `<what, window>`
- `<slug>` — owner: `<who>` — metric: `<what, window>`
- `<slug>` — owner: `<who>` — metric: `<what, window>`

## Gate by gate
| habit or failure | mechanism | file |
|---|---|---|
| problem statement before any source edit; missing fields named | hook (PreToolUse, exit 2) | [hooks/problem_gate.py](../hooks/problem_gate.py) |
| stakeholder yes in a typed transcript turn, after the proposal of the *current* contract text | hook (Stop, `decision: block`) + re-checked on every source edit | [hooks/contract_gate.py](../hooks/contract_gate.py) |
| Signed line and metric values never hand-typed | hook (contract edits diffed) | [hooks/problem_gate.py](../hooks/problem_gate.py) `check_contract_edit` |
| metric read before the change and after a human merge, before close | check | [checks/check_outcome.py](../checks/check_outcome.py) via `./item close` |
| test seen failing before a non-test source edit | hook + command | `problem_gate.py` + `./item red` |
| green proof is a rerun of the same red command | command | `./item green` |
| agent never pushes or opens/merges PRs | hook (Bash) | `problem_gate.py` `check_bash` |
| ship only from `item/<slug>`, PR body built from the contract | command | `./item ship` in [scripts/item.py](../scripts/item.py) |
| the agent can't edit the gates, settings or ledger | hook (harness-owned + records) | `problem_gate.py`, `harness.a02.json` |
| TODO: one row per item in "What breaks" that isn't covered above | | |

### Known holes (say them before a grader finds them)
- The shell guard in `check_bash` is pattern-based. A determined command (e.g. writing through an
  interpreter with a computed path) can get past it. Write/Edit tools are fully gated.
- The transcript can't prove *who* typed the yes, only that a person typed it in a user turn.
  The stakeholder has to type it in the session themselves.
- `.harness/state.json` (active item) is per-checkout and git-ignored. The ledger under `items/` is the evidence.
