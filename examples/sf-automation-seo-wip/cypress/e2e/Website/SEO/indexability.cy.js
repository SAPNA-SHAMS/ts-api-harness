import { isProd } from "../../../support/seo/seo-utils";

describe("§2 Indexability", { retries: 0 }, () => {
  let urls;
  let safelist = [];

  const basicAuth = () =>
    isProd() ? undefined : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };

  before(() => {
    cy.fixture("seo/sample-urls.json").then((data) => {
      // 'removed' is a 404 page, not part of indexability checks
      const { removed, ...rest } = data;
      urls = rest;
    });
    cy.fixture("seo/noindex-safelist.json").then((list) => (safelist = list));
  });

  // Fetches raw HTML for each sample URL and passes parsed tags to the callback
  const forEachSample = (fn) => {
    Object.entries(urls).forEach(([key, path]) => {
      cy.seoRequest(path).then((res) => {
        expect(res.status, `${key} ${path} status`).to.eq(200);
        cy.parseSeoTags(res.body).then((tags) => fn(key, path, tags, res));
      });
    });
  };

  it("2.1 canonical present exactly once in raw HTML", () => {
    forEachSample((key, path, t) => {
      expect(t.canonicals, `${key} ${path} canonical count`).to.have.length(1);
    });
  });

  it("2.2 canonical href is an absolute https:// URL", () => {
    forEachSample((key, path, t) => {
      expect(t.canonical, `${key} ${path} canonical`).to.match(/^https:\/\/[^\s]+$/);
    });
  });

  it("2.3 canonical resolves to 200 (not a redirect or 404)", () => {
    forEachSample((key, path, t) => {
      cy.seoRequest(t.canonical, { followRedirect: false }).then((res) => {
        expect(res.status, `${key} canonical ${t.canonical}`).to.eq(200);
      });
    });
  });

  it("2.4 meta robots / X-Robots-Tag matches environment policy", () => {
    const env = Cypress.env("ENVIRONMENT");
    const failures = [];
    const norm = (v) => (v || "").toLowerCase().replace(/\s/g, "");

    forEachSample((key, path, t, res) => {
      const meta = norm(t.robots);
      const header = norm(res.headers["x-robots-tag"]);
      const combined = `${meta},${header}`;

      if (isProd()) {
        // live: must NOT be noindex unless intentionally safelisted
        if (!safelist.includes(path) && combined.includes("noindex")) {
          failures.push(`${key} ${path} is noindex on live (meta="${meta}" header="${header}")`);
        }
      } else if (!(combined.includes("noindex") && combined.includes("nofollow"))) {
        // dev/beta: must be hidden from search engines
        failures.push(`${key} ${path} not noindex,nofollow on ${env} (meta="${meta}" header="${header}")`);
      }
    });

    cy.then(() => expect(failures, failures.join("\n")).to.be.empty);
  });

  it("2.5 canonical in raw HTML matches canonical in rendered DOM", () => {
    forEachSample((key, path, raw) => {
      cy.visit(path, { auth: basicAuth() });
      cy.document().then((doc) => {
        const rendered = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
        expect(rendered, `${key} ${path} rendered canonical`).to.eq(raw.canonical);
      });
    });
  });

  it("2.6 pagination page has a self-referencing canonical (not page 1)", function () {
    if (!urls.paginated) this.skip();
    cy.seoRequest(urls.paginated).then((res) => {
      expect(res.status, "paginated status").to.eq(200);
      cy.parseSeoTags(res.body).then((t) => {
        const canon = new URL(t.canonical);
        const page = new URL(urls.paginated, Cypress.config("baseUrl"));
        // compare path + query only, so a canonical pointing to the live host still counts
        expect(canon.pathname + canon.search, "paginated canonical").to.eq(page.pathname + page.search);
      });
    });
  });

  it("2.7 HTTP redirects to HTTPS with a 301", () => {
    const httpUrl = Cypress.config("baseUrl").replace(/^https:/, "http:");
    cy.seoRequest(httpUrl, { followRedirect: false }).then((res) => {
      expect(res.status, `${httpUrl} status`).to.eq(301);
      expect(res.headers.location, "redirect target").to.match(/^https:\/\//);
    });
  });

  it("2.8 www vs non-www: only one variant returns 200 without redirect", function () {
    // dev/beta hosts have no www variant, so this applies to live only
    if (!isProd()) this.skip();
    const bare = new URL(Cypress.config("baseUrl")).hostname.replace(/^www\./, "");
    const statuses = [];

    [`https://${bare}/`, `https://www.${bare}/`].forEach((u) => {
      cy.seoRequest(u, { followRedirect: false }).then((res) => statuses.push({ u, status: res.status }));
    });

    cy.then(() => {
      const summary = JSON.stringify(statuses);
      expect(statuses.filter((s) => s.status === 200), summary).to.have.length(1);
      expect(statuses.filter((s) => [301, 308].includes(s.status)), summary).to.have.length(1);
    });
  });

  it("2.9 trailing slash: one variant 200, the other redirects to it", () => {
    const path = urls.vendor.replace(/\/$/, "");
    const results = {};

    cy.seoRequest(path, { followRedirect: false }).then((r) => (results.noSlash = r));
    cy.seoRequest(`${path}/`, { followRedirect: false }).then((r) => (results.slash = r));

    cy.then(() => {
      const { noSlash, slash } = results;
      const summary = `no-slash=${noSlash.status} slash=${slash.status}`;
      const isRedirect = (s) => [301, 308].includes(s);

      if (noSlash.status === 200) {
        expect(isRedirect(slash.status), summary).to.be.true;
        expect(slash.headers.location, "slash → no-slash").to.match(new RegExp(`${path}$`));
      } else {
        expect(slash.status, summary).to.eq(200);
        expect(isRedirect(noSlash.status), summary).to.be.true;
      }
    });
  });
});
