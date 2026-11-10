import { SEO_UA, isProd, parseSeoTags } from "./seo-utils";

// On live (production) only GET and HEAD are allowed. On dev/beta any method is allowed.
const ALLOWED_METHODS = ["GET", "HEAD"];

// cy.seoRequest(url, opts)
// Fetches raw HTML or headers; never fails on 404/500 so the test can assert the status itself
Cypress.Commands.add("seoRequest", (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  if (isProd() && !ALLOWED_METHODS.includes(method)) {
    throw new Error(`Write blocked on production: ${method} ${url}`);
  }

  // dev and beta sit behind basic auth; live does not
  const auth = isProd()
    ? undefined
    : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };

  return cy.request({
    url,
    failOnStatusCode: false,
    auth,
    ...opts,
    method,
    headers: { "User-Agent": SEO_UA, ...(opts.headers || {}) },
  });
});

// cy.parseSeoTags(html) — chainable wrapper around parseSeoTags()
Cypress.Commands.add("parseSeoTags", (html) => cy.wrap(parseSeoTags(html), { log: false }));
