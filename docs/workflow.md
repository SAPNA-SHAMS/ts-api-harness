# Workflow — Sapna Shams

> **Sapna — check every line marked _(confirm)_.** These were drafted from what this repo and
> the A02 session show, not from you. Anything untrue scores against you; rewrite it in your words.

I am QA and code owner for Software Finder's automation (`SoftwareFinder-Automation`, Cypress 14,
JavaScript). My current backlog is the SEO Cypress suite in *SEO_Cypress_Automation_Spec_v2*.

## How work reaches me
A spec document from the SEO side (SEO_Cypress_Automation_Spec_v2), revised as the audit changes,
and the manual audit doc it mirrors. The rule in that spec is "manual first, then Cypress": a
check is only automated after someone has verified it by hand. _(confirm: also Slack / Jira? which first?)_

## Where I lose time
1. **The spec moves under me.** v2 dropped checks the WIP already had (heading hierarchy,
   WebSite/SearchAction) and added ones it lacked; I paused two items in this assignment because
   "doc needs updation". _(confirm)_
2. **Environment setup, not tests.** Beta needs basic auth; running inside VS Code breaks the
   Cypress binary (`ELECTRON_RUN_AS_NODE`); the first metric run scored 3/33 purely on 401s. _(confirm)_
3. **Re-running the whole suite against beta to check one section.** _(confirm)_

## What I repeat
Pointing Cypress at beta with the right env and auth; numbering tests to match the spec section;
counting "how many spec checks pass" by hand for the audit; writing the same PR description. _(confirm)_

## What breaks
- **Tests drift from the spec numbering** (WIP 2.4–2.9 did not match spec 2.4–2.10). → checklist ids + coverage check.
- **Fixtures that silently break a spec rule** (comparison and blogPost were the same URL). → contract evidence + sample-urls fixed. _(confirm: twice?)_
- **Credentials and live as defaults** (target repo's `cypress.config.js` defaults `AUTH_PASS` and `ENVIRONMENT=live`). → metric reader is beta-only; auth sent only to the host under test.
- **Calling a check done because it was written, not because it ran on beta.** → metric counts only tests that ran and passed; skipped production-only checks count as not passing.

## The three backlog items
Stakeholder for all three: **Hamza Malik**. Owner: SEO / Website QA (Sapna Shams). Metric: spec
checks automated and passing on beta, read by `scripts/seo-metric.mjs`, before vs after merge.
- `seo-indexability` — §2, 10 checks — before 6/10
- `seo-headers-urls` — §3 security headers + §4 URL structure, 13 checks — before 6/13
- `seo-metadata-headings` — §5 metadata + §6 headings, 10 checks — before 4/10

`seo-page-basics` (§2–6 as one item, PR #3) was split into these three. `seo-content-signals`
(§7–11) and `seo-policy-regressions` (§12–17) are paused until the spec doc is updated.

## Gate by gate
| habit or failure | mechanism | file |
|---|---|---|
| problem statement before any source edit; missing fields named | hook (PreToolUse, exit 2) | [hooks/problem_gate.py](../hooks/problem_gate.py) |
| stakeholder yes in a typed transcript turn, after the proposal of the *current* contract text | hook (Stop, `decision: block`) + re-checked on every source edit | [hooks/contract_gate.py](../hooks/contract_gate.py) |
| Signed line and metric values never hand-typed | hook (contract edits diffed) | [hooks/problem_gate.py](../hooks/problem_gate.py) `check_contract_edit` |
| metric read before the change and after a human merge, before close | check | [checks/check_outcome.py](../checks/check_outcome.py) via `./item close` |
| test seen failing before a non-test source edit | hook + command | `problem_gate.py` + `./item red` |
| green proof is a rerun of the same red command | command | `./item green` |
| agent never pushes or opens/merges PRs | hook (Bash, before) | `problem_gate.py` `check_bash` |
| a shell command can't do what an Edit would be refused (judged by what changed, then put back) | hook (Bash, after) | [hooks/bash_effects.py](../hooks/bash_effects.py) |
| "done" means coverage went up, not just that the site number moved | check | `Coverage:` line + [checks/check_outcome.py](../checks/check_outcome.py) |
| ship only from `item/<slug>`, PR body built from the contract | command | `./item ship` in [scripts/item.py](../scripts/item.py) |
| the agent can't edit the gates, settings or ledger | hook (harness-owned + records) | `problem_gate.py`, `harness.a02.json` |
| tests numbered to the spec; every spec id has exactly one test; no `.skip`/`.only` | check | [scripts/seo-coverage.mjs](../scripts/seo-coverage.mjs) (the red/green command) |
| "done" = ran and passed on beta, never "written"; skipped counts as not passing | check | [scripts/seo-metric.mjs](../scripts/seo-metric.mjs) (the contract's `Read:`) |
| beta only, never live; auth only to the host under test | check + code | `seo-metric.mjs` base-URL refusal; `basicAuth()` in `examples/sf-seo-suite/cypress/support/seo/seo-utils.js` |
| spec check list is the source of truth, split per item | data | [docs/seo-checklist.json](seo-checklist.json) |

### Known holes (say them before a grader finds them)
- Shell commands are judged by their effect on this repo's working tree. Writes outside the repo
  (e.g. into the target repo) are not seen.
- The transcript can't prove *who* typed the yes, only that a person typed it in a user turn and
  that it names the item. The stakeholder has to type it in the session themselves.
- `.harness/state.json` (active item) is per-checkout and git-ignored. The ledger under `items/` is the evidence.
