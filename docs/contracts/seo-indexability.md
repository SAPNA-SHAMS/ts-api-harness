# docs/contracts/seo-indexability.md

Problem: Spec v2 §2 indexability rules are checked by hand; nothing stops beta (or a release from it) shipping a bad canonical or being indexable. Evidence: the crawl harness stores canonical but checks none of the §2 rules; the WIP numbers §2 out of spec order from 2.4 on and has no check that staging serves its own robots.txt — and beta today serves G2's robots.txt (G2 sitemaps) and index,follow on every sample page.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §2 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: 6   after: ____
Read: node scripts/seo-metric.mjs seo-indexability
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN each of the 10 §2 checks (2.1–2.10 in docs/seo-checklist.json) has one test titled with its id and passes or fails naming the URL
Scenario: WHEN beta's robots.txt lists another site's sitemaps or a sample page is not noindex,nofollow THEN 2.7 fails naming them
Scenario: WHEN a check only applies to production (2.6) THEN it is reported as skipped on beta, never as passing
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- no Cypress automation for the checks in spec "Dropped from the Cypress suite" (the Node crawl harness already covers them)
- fixing the site itself; CI wiring and the mochawesome dashboard feed
Signed: Hamza Malik, 2026-11-10 — "seo-indexability e2d5c8f96918 approved go ahead" (transcript 5d2b9daa-6de0-4882-b7fd-b7e1250fa3d8/11ea58bd-2c3e-487c-b72f-09cc6575c062; recorded by hooks/contract_gate.py)
