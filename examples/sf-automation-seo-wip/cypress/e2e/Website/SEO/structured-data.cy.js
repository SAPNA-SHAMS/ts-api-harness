import { flattenJsonLd } from "../../../support/seo/seo-utils";

describe("§7 Structured data", { retries: 0 }, () => {
  const pages = []; // [{ key, path, tags, nodes }]
  let schema;

  const basicAuth = () =>
    Cypress.env("ENVIRONMENT") === "live"
      ? undefined
      : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };

  // @type can be a string or an array
  const typesOf = (node) => [].concat(node["@type"] || []);
  const findType = (nodes, types) => nodes.find((n) => typesOf(n).some((t) => types.includes(t)));
  const missingFields = (node, fields) => fields.filter((f) => node[f] == null || node[f] === "");

  before(() => {
    cy.fixture("seo/expected-schema.json").then((s) => (schema = s));
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data;
      Object.entries(rest).forEach(([key, path]) => {
        cy.seoRequest(path).then((res) => {
          expect(res.status, `${key} ${path} status`).to.eq(200);
          cy.parseSeoTags(res.body).then((tags) =>
            pages.push({ key, path, tags, nodes: flattenJsonLd(tags.jsonLd) })
          );
        });
      });
    });
  });

  const report = (failures) => expect(failures, failures.join("\n")).to.be.empty;

  it("7.1 JSON-LD blocks present in raw HTML on all sample URLs", () => {
    report(pages.filter((p) => p.tags.jsonLd.length === 0).map((p) => `${p.key} ${p.path}: no JSON-LD`));
  });

  it("7.2 each JSON-LD block parses as valid JSON", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) =>
      tags.jsonLd.forEach((b, i) => {
        if (b.error) failures.push(`${key} ${path} block #${i + 1}: ${b.error}`);
      })
    );
    report(failures);
  });

  it("7.3 homepage: Organization with name, logo, sameAs", () => {
    const home = pages.find((p) => p.key === "home");
    const org = findType(home.nodes, ["Organization"]);
    expect(org, "Organization on home").to.exist;
    const missing = missingFields(org, ["name", "logo", "sameAs"]);
    expect(missing, `Organization missing: ${missing.join(", ")}`).to.be.empty;
  });

  it("7.4 homepage: WebSite with SearchAction", () => {
    const home = pages.find((p) => p.key === "home");
    const site = findType(home.nodes, ["WebSite"]);
    expect(site, "WebSite on home").to.exist;
    const actions = [].concat(site.potentialAction || []);
    expect(actions.some((a) => typesOf(a).includes("SearchAction")), "WebSite.potentialAction SearchAction").to.be.true;
  });

  it("7.5 required types per template (JSON-LD or microdata)", () => {
    const failures = [];
    pages.forEach(({ key, path, tags, nodes }) => {
      // microdata types, e.g. itemtype="https://schema.org/BreadcrumbList"
      const microdata = [...tags.doc.querySelectorAll("[itemtype]")].map((el) =>
        el.getAttribute("itemtype").split("/").pop()
      );

      (schema.templates[key] || []).forEach((anyOf) => {
        if (!findType(nodes, anyOf) && !anyOf.some((t) => microdata.includes(t))) {
          const found = [...new Set([...nodes.flatMap(typesOf), ...microdata])].join(", ") || "none";
          failures.push(`${key} ${path}: missing ${anyOf.join(" or ")} (found: ${found})`);
        }
      });
    });
    report(failures);
  });

  it("7.5b microdata BreadcrumbList is well-formed (ListItem with name, position, item)", () => {
    const failures = [];
    pages
      .filter((p) => p.key !== "home")
      .forEach(({ key, path, tags }) => {
        const list = tags.doc.querySelector('[itemtype$="schema.org/BreadcrumbList"]');
        if (!list) return; // JSON-LD breadcrumb (if any) is covered by 7.5

        const items = [...list.querySelectorAll('[itemprop="itemListElement"][itemtype$="schema.org/ListItem"]')];
        if (!items.length) return failures.push(`${key} ${path}: BreadcrumbList has no ListItem`);

        items.forEach((li, i) => {
          const name = li.querySelector('[itemprop="name"]')?.textContent.trim();
          const position = li.querySelector('[itemprop="position"]')?.getAttribute("content");
          const item = li.querySelector('[itemprop="item"]');
          const href = item?.getAttribute("href") || item?.getAttribute("itemid") || item?.getAttribute("content");

          if (!name) failures.push(`${key} ${path}: ListItem #${i + 1} missing name`);
          if (!position) failures.push(`${key} ${path}: ListItem #${i + 1} missing position`);
          // last crumb (current page) may omit item per Google; others must link
          if (!href && i < items.length - 1) failures.push(`${key} ${path}: ListItem #${i + 1} missing item link`);
        });
      });
    report(failures);
  });

  it("7.6 vendor pages: SoftwareApplication/Product with name, description, offers", () => {
    const failures = [];
    pages
      .filter((p) => schema.vendorTemplates.includes(p.key))
      .forEach(({ key, path, nodes }) => {
        const app = findType(nodes, ["SoftwareApplication", "Product"]);
        if (!app) return failures.push(`${key} ${path}: no SoftwareApplication/Product`);
        const missing = missingFields(app, ["name", "description", "offers"]);
        if (missing.length) failures.push(`${key} ${path}: missing ${missing.join(", ")}`);
      });
    report(failures);
  });

  it("7.7 editorial pages: Article/BlogPosting with headline, author, dates, image", () => {
    const failures = [];
    pages
      .filter((p) => schema.editorialTemplates.includes(p.key))
      .forEach(({ key, path, nodes }) => {
        const art = findType(nodes, ["Article", "BlogPosting"]);
        if (!art) return failures.push(`${key} ${path}: no Article/BlogPosting`);
        const missing = missingFields(art, ["headline", "author", "datePublished", "dateModified", "image"]);
        if (missing.length) failures.push(`${key} ${path}: missing ${missing.join(", ")}`);
      });
    report(failures);
  });

  it("7.8 aggregateRating / Review only when a visible reviews block exists", function () {
    if (!schema.reviewsBlockSelector) {
      cy.log("⚠ reviewsBlockSelector not set in expected-schema.json — skipping");
      this.skip();
    }
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      const json = JSON.stringify(tags.jsonLd.map((b) => b.data));
      const hasRatingSchema = /"aggregateRating"|"@type":"Review"/.test(json);
      if (!hasRatingSchema) return;

      cy.visit(path, { auth: basicAuth() });
      cy.document().then((doc) => {
        const block = doc.querySelector(schema.reviewsBlockSelector);
        const visible = block && block.offsetParent !== null;
        if (!visible) failures.push(`${key} ${path}: rating/review schema but no visible reviews block`);
      });
    });
    cy.then(() => report(failures));
  });

  it("7.9 no @type outside expected-schema.json allowedTypes", () => {
    const failures = [];
    pages.forEach(({ key, path, tags }) => {
      // walk every nested object, not just top-level nodes
      const all = [];
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === "object") {
          typesOf(n).forEach((t) => all.push(t));
          Object.values(n).forEach(walk);
        }
      };
      tags.jsonLd.forEach((b) => walk(b.data));
      const unknown = [...new Set(all)].filter((t) => !schema.allowedTypes.includes(t));
      if (unknown.length) failures.push(`${key} ${path}: unexpected @type ${unknown.join(", ")}`);
    });
    report(failures);
  });
});
