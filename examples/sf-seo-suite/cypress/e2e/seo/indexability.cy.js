// §2 Indexability — spec v2 ids. Built from WIP indexability.cy.js; WIP ids 2.4–2.9 renumbered to
// spec order, staging robots.txt ownership added (2.7), www check made meaningful on beta (2.9).
import { basicAuth, isProd } from "../../support/seo/seo-utils";

describe("§2 Indexability", { retries: 0 }, () => {
  let urls;
  let safelist = [];

  before(() => {
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data; // 'removed' is a 404 page, not part of indexability
      urls = rest;
    });
    cy.fixture("seo/noindex-safelist.json").then((list) => (safelist = list));
  });

  // Fetches raw HTML for each unique sample path and passes parsed tags to fn
  const forEachSample = (fn) => {
    const seen = new Set();
    Object.entries(urls).forEach(([key, path]) => {
      if (seen.has(path)) return;
      seen.add(path);
      cy.seoRequest(path).then((res) => {
        expect(res.status, `${key} ${path} status`).to.eq(200);
        cy.parseSeoTags(res.body).then((tags) => fn(key, path, tags, res));
      });
    });
  };
  const collect = (body) => {
    const failures = [];
    body(failures);
    cy.then(() => expect(failures, failures.join("\n")).to.be.empty);
  };
  const norm = (v) => (v || "").toLowerCase().replace(/\s/g, "");

  it("2.1 canonical link element present (exactly once) in raw HTML", () => {
    collect((f) => forEachSample((key, path, t) => {
      if (t.canonicals.length !== 1) f.push(`${key} ${path}: ${t.canonicals.length} canonicals`);
    }));
  });

  it("2.2 canonical href is an absolute https:// URL", () => {
    collect((f) => forEachSample((key, path, t) => {
      if (!/^https:\/\/\S+$/.test(t.canonical || "")) f.push(`${key} ${path}: canonical "${t.canonical}"`);
    }));
  });

  it("2.3 canonical href resolves to 200 (not a redirect or 404)", () => {
    collect((f) => forEachSample((key, path, t) => {
      if (!t.canonical) return f.push(`${key} ${path}: no canonical`);
      cy.seoRequest(t.canonical, { followRedirect: false }).then((res) => {
        if (res.status !== 200) f.push(`${key} ${path}: canonical ${t.canonical} → ${res.status}`);
      });
    }));
  });

  it("2.4 canonical in raw HTML matches canonical in rendered DOM", () => {
    collect((f) => forEachSample((key, path, raw) => {
      cy.visit(path, { auth: basicAuth() });
      cy.document().then((doc) => {
        const rendered = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
        if (rendered !== raw.canonical) f.push(`${key} ${path}: raw "${raw.canonical}" vs rendered "${rendered}"`);
      });
    }));
  });

  it("2.5 pagination page has a self-referencing canonical (not page 1)", () => {
    cy.seoRequest(urls.paginated).then((res) => {
      expect(res.status, "paginated status").to.eq(200);
      cy.parseSeoTags(res.body).then((t) => {
        const canon = new URL(t.canonical);
        const page = new URL(urls.paginated, Cypress.config("baseUrl"));
        // path + query only, so a canonical pointing at the live host still counts
        expect(canon.pathname + canon.search, `${urls.paginated} canonical ${t.canonical}`).to.eq(page.pathname + page.search);
      });
    });
  });

  it("2.6 meta robots on production is not noindex unless on noindex-safelist.json", function () {
    // Production-only rule. On beta this is reported as pending (not passing), not faked.
    if (!isProd()) this.skip();
    collect((f) => forEachSample((key, path, t, res) => {
      const combined = `${norm(t.robots)},${norm(res.headers["x-robots-tag"])}`;
      if (!safelist.includes(path) && combined.includes("noindex")) f.push(`${key} ${path} is noindex on live (${combined})`);
    }));
  });

  it("2.7 staging is noindex,nofollow and serves its own robots.txt", function () {
    if (isProd()) this.skip(); // staging-only rule
    collect((f) => {
      forEachSample((key, path, t, res) => {
        const combined = `${norm(t.robots)},${norm(res.headers["x-robots-tag"])}`;
        if (!(combined.includes("noindex") && combined.includes("nofollow"))) f.push(`${key} ${path}: not noindex,nofollow (${combined})`);
      });
      cy.seoRequest("/robots.txt").then((res) => {
        const host = new URL(Cypress.config("baseUrl")).host;
        const foreign = [...res.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).filter((u) => new URL(u).host !== host);
        if (foreign.length) f.push(`robots.txt lists another site's sitemaps: ${foreign.join(", ")}`);
      });
    });
  });

  it("2.8 HTTP redirects to HTTPS with a 301", () => {
    const httpUrl = Cypress.config("baseUrl").replace(/^https:/, "http:");
    cy.seoRequest(httpUrl, { followRedirect: false }).then((res) => {
      expect(res.status, `${httpUrl} status`).to.eq(301);
      expect(res.headers.location, "redirect target").to.match(/^https:\/\//);
    });
  });

  it("2.9 www vs non-www: only one variant returns 200 without redirect", () => {
    const bare = new URL(Cypress.config("baseUrl")).hostname.replace(/^www\./, "");
    const auth = isProd() ? "" : `-u "$AUTH_USER:$AUTH_PASS"`;
    const env = { AUTH_USER: Cypress.env("AUTH_USER"), AUTH_PASS: Cypress.env("AUTH_PASS") };
    const statuses = [];
    // curl, not cy.request: a variant that does not resolve at all (beta has no www) is a valid answer
    [`https://${bare}/`, `https://www.${bare}/`].forEach((u) => {
      cy.exec(`curl -s -o /dev/null -w "%{http_code}" ${auth} ${u}`, { failOnNonZeroExit: false, env })
        .then((r) => statuses.push({ u, status: Number(r.stdout) || 0 }));
    });
    cy.then(() => {
      const summary = JSON.stringify(statuses);
      expect(statuses.filter((s) => s.status === 200), summary).to.have.length(1);
      const other = statuses.find((s) => s.status !== 200);
      expect([0, 301, 308].includes(other.status), `other variant must redirect or not exist: ${summary}`).to.be.true;
    });
  });

  it("2.10 trailing slash convention consistent — one variant redirects to the other", () => {
    const path = urls.vendor.replace(/\/$/, "");
    const r = {};
    cy.seoRequest(path, { followRedirect: false }).then((x) => (r.noSlash = x));
    cy.seoRequest(`${path}/`, { followRedirect: false }).then((x) => (r.slash = x));
    cy.then(() => {
      const summary = `${path}=${r.noSlash.status} ${path}/=${r.slash.status}`;
      const isRedirect = (s) => [301, 308].includes(s);
      if (r.noSlash.status === 200) {
        expect(isRedirect(r.slash.status), summary).to.be.true;
        expect(r.slash.headers.location, "slash → no-slash").to.match(new RegExp(`${path}$`));
      } else {
        expect(r.slash.status, summary).to.eq(200);
        expect(isRedirect(r.noSlash.status), summary).to.be.true;
      }
    });
  });
});
