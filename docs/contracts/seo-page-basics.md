# docs/contracts/seo-page-basics.md

Problem: SEO rules in spec v2 §2–6 (indexability, security headers, URL structure, metadata, headings) are checked by hand in the audit; nothing stops a regression on beta before it reaches live. Evidence: §4 has no Cypress spec at all; the WIP covers §2/3/5/6 partly, has drifted from v2 (WIP 6.1 heading-hierarchy is not in v2, v2 6.3 paginated H1 suffix is missing, staging robots.txt ownership is missing) and sample-urls.json uses one URL for both comparison and blogPost, which v2 forbids.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §2–6 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: 16   after: ____
Read: node scripts/seo-metric.mjs seo-page-basics
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN every one of the 33 checks in docs/seo-checklist.json "seo-page-basics" has a test titled with its id, and each passes or fails with the offending URL named
Scenario: WHEN beta drops a canonical, HSTS header, or the single <title> on any sample URL THEN the matching test fails naming that URL and header/tag
Scenario: WHEN the base URL is anything but beta THEN the metric reader refuses to run, and the suite allows only GET/HEAD on live
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- fixing the site itself; CI wiring and the mochawesome dashboard feed
- no Cypress automation for the checks in spec "Dropped from the Cypress suite" (the Node crawl harness already covers them): title > 60, description > 160, Open Graph / Twitter missing, single H1 / H1 in <main>, validateSd rules, /undefined/, sitemap fetch/recursion/non200 gate
Signed: Hamza Malik, 2026-11-10 — "yes go ahead. hamza malik" (transcript 5d2b9daa-6de0-4882-b7fd-b7e1250fa3d8/9412014b-a49b-4dd6-96ff-6024683030c7; recorded by hooks/contract_gate.py)
