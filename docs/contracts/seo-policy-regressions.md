# docs/contracts/seo-policy-regressions.md

Problem: Spec v2 §12–17 (analytics/tag manager, AEO, GEO, AI crawler policy, sitemap health, regressions for fixes shipped in October 2026) have no Cypress coverage. Evidence: no WIP spec for any of §12–17; §17 fixes were verified manually on production in October 2026 and nothing keeps them from regressing; robots.txt is never fetched by the crawl harness.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §12–17 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: ____   after: ____
Read: node scripts/seo-metric.mjs seo-policy-regressions
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN every one of the 39 checks in docs/seo-checklist.json "seo-policy-regressions" has a test titled with its id, and each passes or fails naming the URL, bot or ID
Scenario: WHEN an October 2026 fix regresses on beta (e.g. ?page=999 returns 200) THEN the matching 17.x test fails naming the URL
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- no Cypress automation for the checks in spec "Dropped from the Cypress suite" (the Node crawl harness already covers them): sitemap fetch/XML parse/child recursion, per-URL non200 > 3 gate, /undefined/ in sitemap, indexable URL missing from sitemap
- GSC, CrUX, AI Overview tracking, backlinks, brand mentions, log analysis (spec "Not automated in Cypress")
- deciding the AI-crawler policy itself (fixtures/ai-crawler-policy.json records a decision someone else makes)
Signed: ← recorded by hooks/contract_gate.py from the stakeholder's typed yes, never typed by hand
