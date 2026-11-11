// Shared helpers for the SEO suite. Carried over from the WIP (sf-automation-seo-wip) unchanged
// except: sameHost(), basicAuth() and sitemapUrls() are new.

// User-Agent sent on every SEO request so these hits are identifiable in server logs
export const SEO_UA = "SFCypressSEO/1.0";

// true when running against production
export const isProd = () => Cypress.env("ENVIRONMENT") === "live";

// Turns "/some-path" into a full URL using the current baseUrl
export const absUrl = (path) => new URL(path, Cypress.config("baseUrl")).href;

// true when url is on the host under test (relative URLs count as same host)
export const sameHost = (url) => new URL(url, Cypress.config("baseUrl")).host === new URL(Cypress.config("baseUrl")).host;

// Basic auth for dev/beta, only ever sent to the host under test (never to live or third parties)
export const basicAuth = (url = Cypress.config("baseUrl")) =>
  isProd() || !sameHost(url) ? undefined : { username: Cypress.env("AUTH_USER"), password: Cypress.env("AUTH_PASS") };

// Parses raw HTML and returns the SEO tags
export function parseSeoTags(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const attr = (sel, a) => doc.querySelector(sel)?.getAttribute(a) ?? null;

  // Keep invalid JSON-LD too, so tests can fail on it instead of silently dropping it
  const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
    const raw = s.textContent.trim();
    try {
      return { raw, data: JSON.parse(raw), error: null };
    } catch (e) {
      return { raw, data: null, error: e.message };
    }
  });

  return {
    doc,
    titles: [...doc.querySelectorAll("head title")].map((t) => t.textContent.trim()),
    title: doc.querySelector("head title")?.textContent.trim() ?? null,
    descriptions: [...doc.querySelectorAll('meta[name="description"]')].map((m) => m.getAttribute("content")),
    description: attr('meta[name="description"]', "content"),
    canonicals: [...doc.querySelectorAll('link[rel="canonical"]')].map((l) => l.getAttribute("href")),
    canonical: attr('link[rel="canonical"]', "href"),
    robots: attr('meta[name="robots"]', "content"),
    viewport: attr('meta[name="viewport"]', "content"),
    h1s: [...doc.querySelectorAll("h1")].map((h) => h.textContent.trim()),
    headings: [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({
      level: Number(h.tagName[1]),
      text: h.textContent.trim(),
    })),
    jsonLd,
  };
}

// Flattens JSON-LD (including @graph and arrays) into a list of objects that have an @type
export function flattenJsonLd(blocks) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n["@graph"]) walk(n["@graph"]);
      if (n["@type"]) out.push(n);
    }
  };
  blocks.filter((b) => b.data).forEach((b) => walk(b.data));
  return out;
}

// <loc> values from a sitemap XML body
export const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
