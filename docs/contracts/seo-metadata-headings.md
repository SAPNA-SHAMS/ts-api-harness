# docs/contracts/seo-metadata-headings.md

Problem: Spec v2 §5 metadata and §6 headings beyond the crawl harness's length caps and single-H1 report are checked by hand. Evidence: on beta today the category title is "acc", the pricing page has no meta description, and the paginated listing's "- Page 2" H1 suffix exists only after hydration; the WIP's §6 tests a heading-hierarchy rule that is not in v2 and misses the paginated-H1 rule that is, and its sample-urls.json uses one URL for both comparison and blogPost.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §5–6 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: 4   after: 4
Read: node scripts/seo-metric.mjs seo-metadata-headings
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN each of the 10 §5–6 checks (5.1–5.7, 6.1–6.3 in docs/seo-checklist.json) has one test titled with its id and passes or fails naming the URL and tag
Scenario: WHEN a title is shorter than its page-type minimum or a description is missing, "null" or "undefined" THEN the matching 5.x test fails naming the URL and value
Scenario: WHEN an H1 or H2 appears only after hydration THEN 6.2 fails naming it
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- no Cypress automation for the checks in spec "Dropped from the Cypress suite" (title > 60, description > 160, Open Graph / Twitter missing, single H1 / H1 in <main>)
- the WIP heading-hierarchy rule (not in spec v2); fixing the site itself; CI wiring
Signed: Hamza Malik, 2026-11-10 — "approve go ahead complete the assignment" (transcript 5d2b9daa-6de0-4882-b7fd-b7e1250fa3d8/0efbb3c3-141b-416d-8c5a-c51a7b422248; recorded by hooks/contract_gate.py)
