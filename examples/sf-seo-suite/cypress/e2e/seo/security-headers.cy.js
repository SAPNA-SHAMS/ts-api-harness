// §3 Security headers — spec v2 ids (WIP numbering already matched). Change from WIP: 3.1 passes
// credentials to curl through env, not on the command line.
import { isProd } from "../../support/seo/seo-utils";

describe("§3 Security headers", { retries: 0 }, () => {
  let urls;

  before(() => {
    cy.fixture("seo/sample-urls.json").then((data) => {
      const { removed, ...rest } = data;
      urls = rest;
    });
  });

  // Requests every unique sample URL, runs check(headers, body) and fails once with every problem
  const checkAll = (check) => {
    const failures = [];
    cy.then(() => {
      [...new Set(Object.values(urls))].forEach((path) => {
        cy.seoRequest(path).then((res) => {
          const problem = check(res.headers, res.body);
          if (problem) failures.push(`${path}: ${problem}`);
        });
      });
    });
    cy.then(() => expect(failures, failures.join("\n")).to.be.empty);
  };

  it("3.1 served over HTTPS with a valid certificate", () => {
    const base = Cypress.config("baseUrl");
    expect(base, "baseUrl").to.match(/^https:\/\//);
    // curl verifies the certificate by default and exits non-zero if it is invalid
    const auth = isProd() ? "" : `-u "$AUTH_USER:$AUTH_PASS"`;
    cy.exec(`curl -sS -o /dev/null -w "%{http_code}" ${auth} ${base}`, {
      failOnNonZeroExit: false,
      env: { AUTH_USER: Cypress.env("AUTH_USER"), AUTH_PASS: Cypress.env("AUTH_PASS") },
    }).then((r) => {
      expect(r.code, `curl exit (cert error if non-zero): ${r.stderr}`).to.eq(0);
      expect(r.stdout, "status").to.eq("200");
    });
  });

  it("3.2 Strict-Transport-Security present, max-age >= 15768000", () => {
    checkAll((h) => {
      const hsts = h["strict-transport-security"];
      if (!hsts) return "HSTS missing";
      const maxAge = Number((hsts.match(/max-age=(\d+)/i) || [])[1] || 0);
      if (maxAge < 15768000) return `max-age too low (${maxAge})`;
      if (!/includesubdomains/i.test(hsts)) cy.log(`includeSubDomains not set (preferred): ${hsts}`);
      return null;
    });
  });

  it("3.3 X-Content-Type-Options = nosniff", () => {
    checkAll((h) => {
      const v = (h["x-content-type-options"] || "").toLowerCase();
      return v === "nosniff" ? null : `X-Content-Type-Options="${v}"`;
    });
  });

  it("3.4 X-Frame-Options = SAMEORIGIN or CSP frame-ancestors set", () => {
    checkAll((h) => {
      const xfo = (h["x-frame-options"] || "").toUpperCase();
      const csp = h["content-security-policy"] || "";
      return xfo === "SAMEORIGIN" || /frame-ancestors/i.test(csp) ? null : `X-Frame-Options="${xfo}" and no CSP frame-ancestors`;
    });
  });

  it("3.5 Referrer-Policy is strict-origin-when-cross-origin or another approved value", () => {
    const approved = ["strict-origin-when-cross-origin", "strict-origin", "same-origin", "no-referrer"];
    checkAll((h) => {
      const v = (h["referrer-policy"] || "").toLowerCase().trim();
      return approved.includes(v) ? null : `Referrer-Policy="${v}"`;
    });
  });

  it("3.6 Permissions-Policy present and restrictive on camera, microphone, geolocation", () => {
    checkAll((h) => {
      const pp = (h["permissions-policy"] || "").toLowerCase().replace(/\s/g, "");
      if (!pp) return "Permissions-Policy missing";
      // restrictive = () (nobody) or (self)
      const bad = ["camera", "microphone", "geolocation"].filter((f) => !new RegExp(`${f}=\\((self)?\\)`).test(pp));
      return bad.length ? `not restricted: ${bad.join(", ")} (${pp})` : null;
    });
  });

  it("3.7 Content-Security-Policy present (report-only acceptable, absence is not)", () => {
    checkAll((h) => (h["content-security-policy"] || h["content-security-policy-report-only"] ? null : "CSP missing"));
  });

  it("3.8 no mixed content: script and stylesheet URLs in raw HTML use https://", () => {
    checkAll((h, body) => {
      const doc = new DOMParser().parseFromString(body, "text/html");
      const insecure = [
        ...[...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")),
        ...[...doc.querySelectorAll('link[rel="stylesheet"][href]')].map((l) => l.getAttribute("href")),
      ].filter((u) => /^http:\/\//i.test(u));
      return insecure.length ? `insecure: ${insecure.join(", ")}` : null;
    });
  });
});
