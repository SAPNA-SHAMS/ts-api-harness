describe("§5 Metadata — title, description", { retries: 0 }, () => {
  let urls;
  let rules;
  const pages = []; // [{ key, path, tags }] filled once in before()

  before(() => {
    cy.fixture("seo/metadata-rules.json").then((r) => (rules = r));
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data;
      urls = rest;

      // fetch each unique path once and reuse it in every test
      const seen = new Set();
      Object.entries(urls).forEach(([key, path]) => {
        if (seen.has(path)) return;
        seen.add(path);
        cy.seoRequest(path).then((res) => {
          expect(res.status, `${key} ${path} status`).to.eq(200);
          cy.parseSeoTags(res.body).then((tags) => pages.push({ key, path, tags }));
        });
      });
    });
  });

  // Runs check(page) on every page and fails once with the full list of problems
  const checkAll = (check) => {
    const failures = pages
      .map((p) => {
        const problem = check(p);
        return problem ? `${p.key} ${p.path}: ${problem}` : null;
      })
      .filter(Boolean);
    expect(failures, failures.join("\n")).to.be.empty;
  };

  const minFor = (map, key) => map[key] ?? map.default;
  const isBlank = (v) => !v || ["null", "undefined"].includes(v.trim().toLowerCase());

  it("5.1 exactly one <title> in raw HTML", () => {
    checkAll(({ tags }) => (tags.titles.length === 1 ? null : `found ${tags.titles.length} <title>`));
  });

  it("5.2 title meets minimum length for its page type", () => {
    checkAll(({ key, tags }) => {
      const min = minFor(rules.titleMin, key);
      const len = (tags.title || "").length;
      return len >= min ? null : `title ${len} chars < ${min}: "${tags.title}"`;
    });
  });

  it("5.3 title present in raw HTML (not injected by JavaScript)", () => {
    checkAll(({ tags }) => (isBlank(tags.title) ? `raw title is "${tags.title}"` : null));
  });

  it("5.4 titles unique across the sample set", () => {
    const byTitle = {};
    pages.forEach(({ path, tags }) => (byTitle[tags.title] ||= []).push(path));
    const dupes = Object.entries(byTitle)
      .filter(([, paths]) => paths.length > 1)
      .map(([title, paths]) => `"${title}" used by ${paths.join(", ")}`);
    expect(dupes, dupes.join("\n")).to.be.empty;
  });

  it("5.5 exactly one meta description in raw HTML", () => {
    checkAll(({ tags }) =>
      tags.descriptions.length === 1 ? null : `found ${tags.descriptions.length} meta descriptions`
    );
  });

  it("5.6 meta description meets minimum length", () => {
    checkAll(({ key, tags }) => {
      const min = minFor(rules.descriptionMin, key);
      const len = (tags.description || "").trim().length;
      return len >= min ? null : `description ${len} chars < ${min}`;
    });
  });

  it("5.7 meta description not empty, 'null' or 'undefined'", () => {
    checkAll(({ tags }) => (isBlank(tags.description) ? `description is "${tags.description}"` : null));
  });
});
