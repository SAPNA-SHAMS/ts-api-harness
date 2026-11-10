// §6 Headings — spec v2 ids. From WIP headings.cy.js: WIP 6.2 → 6.1, WIP 6.3 → 6.2.
// WIP 6.1 (heading hierarchy, no level jumps) is not in spec v2 and was dropped.
// 6.3 (paginated H1 page suffix in raw HTML) is new.
import { basicAuth } from "../../support/seo/seo-utils";

// Brand-only H1 values that are not allowed (lowercase)
const BRAND_NAMES = ["software finder", "softwarefinder", "softwarefinder.com"];

describe("§6 Headings", { retries: 0 }, () => {
  const pages = []; // [{ key, path, tags }]
  let paginated;

  before(() => {
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data;
      paginated = rest.paginated;
      const seen = new Set();
      Object.entries(rest).forEach(([key, path]) => {
        if (seen.has(path)) return;
        seen.add(path);
        cy.seoRequest(path).then((res) => {
          expect(res.status, `${key} ${path} status`).to.eq(200);
          cy.parseSeoTags(res.body).then((tags) => pages.push({ key, path, tags }));
        });
      });
    });
  });

  const report = (failures) => expect(failures, failures.join("\n")).to.be.empty;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

  it("6.1 H1 not empty and not the brand name only", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      if (!tags.h1s.length) failures.push(`${key} ${path}: no H1 in raw HTML`);
      tags.h1s.forEach((h1) => {
        const t = h1.replace(/\s+/g, " ").trim();
        if (!t) failures.push(`${key} ${path}: empty H1`);
        else if (BRAND_NAMES.includes(t.toLowerCase())) failures.push(`${key} ${path}: H1 is brand only "${t}"`);
      });
    });
    report(failures);
  });

  it("6.2 headings in raw HTML, not only after hydration", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      const rawTexts = new Set(tags.headings.map((h) => norm(h.text)));
      cy.visit(path, { auth: basicAuth() });
      cy.document().then((doc) => {
        // H1 and H2 carry the SEO weight; they must already exist in the server HTML
        [...doc.querySelectorAll("h1, h2")]
          .map((h) => ({ tag: h.tagName, text: norm(h.textContent) }))
          .filter((h) => h.text && !rawTexts.has(h.text))
          .forEach((h) => failures.push(`${key} ${path}: ${h.tag} "${h.text.slice(0, 50)}" only after hydration`));
      });
    });
    cy.then(() => report(failures));
  });

  it("6.3 paginated listing: page suffix in the H1 (e.g. \"- Page 2\") is in raw HTML", () => {
    const page = new URL(paginated, Cypress.config("baseUrl")).searchParams.get("page");
    const entry = pages.find((p) => p.path === paginated);
    const h1 = entry?.tags.h1s[0] ?? "";
    expect(h1, `${paginated} raw H1 "${h1}" must carry "Page ${page}"`).to.match(new RegExp(`page\\s*${page}\\b`, "i"));
  });
});
