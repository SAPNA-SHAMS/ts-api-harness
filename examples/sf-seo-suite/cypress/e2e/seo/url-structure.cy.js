// §4 URL structure — new (no WIP). Slug quality and taxonomy stay manual.
describe("§4 URL structure", { retries: 0 }, () => {
  let all = []; // [{ url, sitemap }]
  let safelist;
  let removed;

  before(() => {
    cy.fixture("seo/url-safelist.json").then((s) => (safelist = s));
    cy.fixture("seo/sample-urls.json").then((u) => (removed = u.removed));
    cy.sitemapUrls().then((list) => (all = list));
  });

  const report = (failures, max = 50) => {
    const head = failures.slice(0, max).join("\n") + (failures.length > max ? `\n… and ${failures.length - max} more` : "");
    expect(failures, `${failures.length} problems\n${head}`).to.be.empty;
  };

  it("4.1 sitemap URLs lowercase, no underscores, spaces or percent-encoding; dots only for safelisted legacy slugs", () => {
    expect(all.length, "sitemap URL count").to.be.greaterThan(0);
    const failures = [];
    all.forEach(({ url }) => {
      const path = new URL(url).pathname;
      if (path !== path.toLowerCase()) failures.push(`uppercase: ${url}`);
      if (/[_ ]|%[0-9a-f]{2}/i.test(path)) failures.push(`underscore/space/percent-encoding: ${url}`);
      path.split("/").filter((seg) => seg.includes(".")).forEach((seg) => {
        if (!safelist.dottedSlugs.includes(seg)) failures.push(`new dotted slug "${seg}": ${url}`);
      });
    });
    report(failures);
  });

  it("4.2 URL length: fail above 200 characters, report 100–200 (non-blocking)", () => {
    const long = all.filter(({ url }) => url.length > 200).map(({ url }) => `${url.length} chars: ${url}`);
    const warn = all.filter(({ url }) => url.length > 100 && url.length <= 200);
    cy.log(`${warn.length} URLs between 100 and 200 characters (report only; existing URLs are not changed)`);
    report(long);
  });

  it("4.3 no dynamic parameters on primary content URLs (safelist allowed)", () => {
    const failures = all
      .filter(({ url }) => new URL(url).search && !safelist.paramPaths.includes(new URL(url).pathname))
      .map(({ url, sitemap }) => `${url} (in ${sitemap})`);
    report(failures);
  });

  it("4.4 removed pages return a real 404, not 200 with a 404 template (soft-404)", () => {
    cy.seoRequest(removed).then((res) => {
      expect(res.status, `${removed} status`).to.eq(404);
    });
  });

  it("4.5 custom 404 template renders on a known removed URL", () => {
    const auth = Cypress.env("ENVIRONMENT") === "live" ? undefined : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };
    cy.visit(removed, { failOnStatusCode: false, auth });
    cy.contains(/page not found/i, { timeout: 15000 }).should("be.visible");
  });
});
