// Brand-only H1 values that are not allowed (lowercase)
const BRAND_NAMES = ["software finder", "softwarefinder", "softwarefinder.com"];

describe("§6 Headings", { retries: 0 }, () => {
  const pages = []; // [{ key, path, tags }]

  const basicAuth = () =>
    Cypress.env("ENVIRONMENT") === "live"
      ? undefined
      : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };

  before(() => {
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data;
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

  it("6.1 heading hierarchy in order — no level jumps (e.g. H2 → H4)", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      tags.headings.forEach((h, i) => {
        if (i === 0) return;
        const prev = tags.headings[i - 1];
        // going deeper may only step one level at a time; going up any amount is fine
        if (h.level > prev.level + 1) {
          failures.push(`${key} ${path}: H${prev.level} "${prev.text.slice(0, 40)}" → H${h.level} "${h.text.slice(0, 40)}"`);
        }
      });
    });
    report(failures);
  });

  it("6.2 H1 not empty and not the brand name only", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      tags.h1s.forEach((h1) => {
        const t = h1.replace(/\s+/g, " ").trim();
        if (!t) failures.push(`${key} ${path}: empty H1`);
        else if (BRAND_NAMES.includes(t.toLowerCase())) failures.push(`${key} ${path}: H1 is brand only "${t}"`);
      });
    });
    report(failures);
  });

  it("6.3 headings in raw HTML, not only after hydration", () => {
    const failures = [];
    const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

    pages.forEach(({ key, path, tags }) => {
      const rawTexts = new Set(tags.headings.map((h) => norm(h.text)));

      cy.visit(path, { auth: basicAuth() });
      cy.document().then((doc) => {
        // H1 and H2 carry the SEO weight; they must already exist in the server HTML
        const rendered = [...doc.querySelectorAll("h1, h2")]
          .map((h) => ({ tag: h.tagName, text: norm(h.textContent) }))
          .filter((h) => h.text);

        const missing = rendered.filter((h) => !rawTexts.has(h.text));
        missing.forEach((h) => failures.push(`${key} ${path}: ${h.tag} "${h.text.slice(0, 50)}" only after hydration`));
      });
    });

    cy.then(() => report(failures));
  });
});
