# Learnings — Assignment 02

Written from the ledger (`items/*/ledger.jsonl`), the transcript and git history, not from memory.

## What the harness caught
- **Building without a stakeholder.** My first instruction named the stakeholder as `<name>`. The problem-statement gate refused every source edit and named the missing field, instead of letting the suite get built against nobody's yes.
- **Scope drift, twice, before any code.** Hamza's/Sapna's replies to the first proposal were clarifications, not a yes ("dropped means skip automation", "JavaScript should be used"). Each changed the contract text, which changed its hash, so the earlier proposal could no longer be signed. The yes landed on the third version, the one that was actually built.
- **A meaningless baseline.** The first metric read ran without beta credentials and scored 3/33 because every request got a 401. The reader printed the failures; the number was never recorded. The recorded "before" (16/33) came after credentials were in `.env.local`.
- **Real beta defects** the suite now reports (and the contract says stay red): beta serves G2's robots.txt, sample pages are `index,follow`, no CSP, camera/microphone unrestricted, 29 uppercase sitemap slugs, category title `"acc"`, pricing page without a meta description, "- Page 2" H1 suffix only after hydration.
- **A committed secret in the target repo**: `SoftwareFinder-Automation/cypress.config.js` has a basic-auth password as a default and `ENVIRONMENT` defaulting to `"live"`. Not fixed (out of scope, and the repo is not to be edited); reported.

## What it got wrong
- **The Bash guard is a regex and misfires constantly.** It refused: `2>/dev/null` (read as a write), a `>` inside a quoted string, any command containing `node` or `python3` next to a source path, a `git commit -m` whose message contained `>` and the words `./item` / `hooks`, and a `grep` for `Stakeholder: <name>`. It also resolves relative paths against the repo even after `cd`. Every misfire cost a retry; none caught a real write. Meanwhile `git checkout <branch> -- <path>` writes files and is not inspected at all.
- **The Stop gate deadlocks on a field only a human can fill.** With the contract missing the stakeholder name, Stop blocked with "finish it" — but the agent cannot finish it without inventing a name. Result: about fifteen identical blocked stops until the person pressed Esc and typed the name.
- **`./item metric` read the last line of stdout+stderr combined.** Cypress writes to stderr, so the count was never the last line and a valid read was rejected as UNPROVEN. Worked around in `scripts/seo-metric.mjs` (stderr to its own log); `item.py` still has the bug.
- **The yes cannot prove who typed it.** "yes go ahead. hamza malik" was typed into Sapna's session. The gate records it as Hamza's; nothing verifies that.
- **The metric can stay flat while the work is done.** `seo-metadata-headings` read 4/10 before (WIP) and 4/10 on the finished suite: different checks pass, the count is the same, because beta's metadata really is broken ("acc" title, missing description, H1 suffix only after hydration). "Checks passing on beta" mixes two things — coverage and site health. Coverage is proven separately (`seo-coverage.mjs`, 10/10); the metric should have been split into those two numbers.
- **Beta itself was flaky.** One preview of `seo-indexability` scored 5/10 because Cloudflare returned 521 (origin down) for three checks that passed an hour earlier. The reader does not distinguish an outage from a defect; a read taken during an outage would be recorded as real.
- **`git checkout <branch> -- <path>` bypasses the source gate.** Used here only after the yes and the red run were recorded, so nothing was skipped — but the gate did not check it.
- **Before/after on the WIP compares ids, not meaning.** The WIP numbered §2 differently (WIP 2.4 = robots policy, spec 2.4 = canonical raw vs rendered), so the "before" counts id matches.

## What I removed
- The WIP's §6.1 heading-hierarchy test (not in spec v2) and WIP 7.4 WebSite/SearchAction (not in v2; belongs to the paused item).
- A single 33-check item (`seo-page-basics`, PR #3). It was split into three items so each could carry its own contract, yes, red run, PR and metric. PR #3 is superseded.
- Basic-auth on every `cy.request`: the WIP sent beta credentials to any host, including the live canonical. Auth now goes only to the host under test.

## Fixed after submission (branch a02/gate-fixes, after tag a02-submission)
Applied by a human: the agent wrote the patch in a scratch worktree because the gates forbid it from editing hooks/, checks/ or item.py.
- **Bash is judged by effect.** The regex is gone. `problem_gate.py` snapshots dirty files before every Bash call; the new PostToolUse hook `hooks/bash_effects.py` diffs afterwards and puts back any protected file the command changed against the gates (including `git checkout <branch> -- <path>`). Only irreversible commands (push, PR create/merge, `reset --hard`, `clean -f`) are refused up front. Reads, `2>/dev/null`, `node -e`, quoted `>` no longer misfire (tested).
- **No Stop loop on human-only fields.** Missing Stakeholder/Problem → HOLD (stop allowed, nothing unlocked) instead of block.
- **The yes must name what it approves** — the slug or the proposal id. "approved go ahead" alone no longer signs; the Stop gate says why. Still not proof of identity (see next).
- **Coverage separated from site health.** Optional `Coverage:` contract line; `./item metric` reads it with the metric; `./item close` requires coverage to rise. For the SEO items: 0 → 10/10 coverage vs 4 → 4 beta health.
- **`./item metric` parses stdout only**; **`./item pause`** added; **the SEO metric refuses to report during a 5xx outage** (UNPROVEN instead of a false low).
- Tests: 31 (19 original + 12 regressions).

## What I would add next
1. (done, see above) effect-based Bash gate; HOLD on human-only fields; stdout-only metric parse; `pause`.
2. Effects outside the repo (a command writing to ~/Projects/SoftwareFinder-Automation) are not seen by the git diff; a read-only mount or a second snapshot root would close that.
3. Proposal via a channel the stakeholder owns (Slack reply / PR approval by their GitHub login) so the yes is attributable.
5. The two paused items (`seo-content-signals` §7–11, `seo-policy-regressions` §12–17) once the spec doc is updated.
