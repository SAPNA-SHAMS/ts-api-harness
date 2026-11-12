# docs/contracts/seo-headers-urls.md

Problem: Spec v2 §3 security headers and §4 URL structure are not in the crawl harness at all, and §4 has no Cypress spec. Evidence: on beta today camera and microphone are not restricted by Permissions-Policy, there is no Content-Security-Policy, and 29 sitemap URLs carry uppercase slugs (e.g. /cybersecurity/IPinfo); none of this is caught by anything automated.
Owner: SEO / Website QA (Sapna Shams, code owner)
Stakeholder: Hamza Malik
Metric: spec §3–4 checks automated and passing on beta, per run of scripts/seo-metric.mjs   before: 6   after: 10
Read: node scripts/seo-metric.mjs seo-headers-urls
Repo: .
Scenario: WHEN the suite runs against https://sf-beta.softwarefndr.com THEN each of the 13 §3–4 checks (3.1–3.8, 4.1–4.5 in docs/seo-checklist.json) has one test titled with its id and passes or fails naming the URL and header
Scenario: WHEN a sitemap URL has uppercase, an underscore, percent-encoding, or a dotted slug not in url-safelist.json (13 legacy slugs) THEN 4.1 fails listing those URLs
Scenario: WHEN a removed URL answers 200 instead of 404 THEN 4.4 fails
Scenario: WHEN a check is red on beta because beta itself is wrong THEN it stays red and is listed, not loosened or skipped
Not included:
- any edit to ~/Projects/SoftwareFinder-Automation (the suite lives in examples/sf-seo-suite; porting it is a separate step)
- TypeScript: the suite is Cypress with JavaScript (.cy.js), matching the target repo and the WIP
- slug quality and taxonomy (stay manual per spec); changing or redirecting existing long URLs
- fixing the site itself; CI wiring and the mochawesome dashboard feed
Signed: Hamza Malik, 2026-11-10 — "approved go ahead" (transcript 5d2b9daa-6de0-4882-b7fd-b7e1250fa3d8/d8869820-ff2a-465b-b254-0477a06a79c5; recorded by hooks/contract_gate.py)
