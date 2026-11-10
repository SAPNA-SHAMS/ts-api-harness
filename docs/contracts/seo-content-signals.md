# docs/contracts/seo-content-signals.md

Problem: Spec v2 §7–11 (structured data, images, internal links, mobile, rendering parity) are only in the manual audit. Evidence: only §7 has WIP (and WIP 7.4 WebSite/SearchAction is not in v2); §8–11 have no Cypress spec; the crawl harness runs with --no-render, so raw-vs-rendered parity is never checked anywhere.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §7–11 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: ____   after: ____
Read: node scripts/seo-metric.mjs seo-content-signals
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN every one of the 40 checks in docs/seo-checklist.json "seo-content-signals" has a test titled with its id, and each passes or fails naming the URL and element
Scenario: WHEN a page's title, canonical, robots or H1 differs between raw HTML and the rendered DOM THEN the matching 11.x test fails showing both values
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- no Cypress automation for the checks in spec "Dropped from the Cypress suite" (the Node crawl harness already covers them): validateSd rules (offers.price/priceCurrency, aggregateRating counts, Review.reviewRating), invalid JSON-LD drop, /undefined/ in links and JSON-LD
- Rich Results Test eligibility, real-user Core Web Vitals, axe-core a11y beyond the listed basics
- fixing the site itself; CI wiring
Signed: ← recorded by hooks/contract_gate.py from the stakeholder's typed yes, never typed by hand
