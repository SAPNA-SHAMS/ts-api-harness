import { SEO_UA, basicAuth, isProd, locs, parseSeoTags } from "./seo-utils";

// React hydration mismatches (#418/#423/#425) are thrown by the site, not by the check under test.
// Log them and keep going so raw-vs-rendered checks can still compare; any other app error still fails.
Cypress.on("uncaught:exception", (err) => {
  if (/Minified React error #(418|423|425)\b|Hydration failed|hydrating/i.test(err.message)) {
    Cypress.log({ name: "hydration", message: err.message.split("\n")[0] });
    return false;
  }
  return undefined;
});

// On live (production) only GET and HEAD are allowed. On dev/beta any method is allowed.
const ALLOWED_METHODS = ["GET", "HEAD"];

// cy.seoRequest(url, opts)
// Fetches raw HTML or headers; never fails on 404/500 so the test can assert the status itself.
// Change from WIP: basic auth is only sent to the host under test, never to a canonical on another host.
Cypress.Commands.add("seoRequest", (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  if (isProd() && !ALLOWED_METHODS.includes(method)) {
    throw new Error(`Write blocked on production: ${method} ${url}`);
  }
  return cy.request({
    url,
    failOnStatusCode: false,
    auth: basicAuth(url),
    ...opts,
    method,
    headers: { "User-Agent": SEO_UA, ...(opts.headers || {}) },
  });
});

// cy.parseSeoTags(html) — chainable wrapper around parseSeoTags()
Cypress.Commands.add("parseSeoTags", (html) => cy.wrap(parseSeoTags(html), { log: false }));

// cy.sitemapUrls() — every page URL in /sitemap.xml, following child sitemaps one level deep and
// any child that is itself an index. Yields [{ url, sitemap }].
Cypress.Commands.add("sitemapUrls", () => {
  const out = [];
  const visit = (sm, depth) =>
    cy.seoRequest(sm, { log: false }).then((res) => {
      expect(res.status, `${sm} status`).to.eq(200);
      locs(res.body).forEach((u) => {
        if (/\.xml(\.gz)?$/.test(u) && depth < 3) visit(u, depth + 1);
        else out.push({ url: u, sitemap: sm });
      });
    });
  visit("/sitemap.xml", 0);
  return cy.then(() => out);
});
