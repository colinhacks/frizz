// frizz.sh's sitemap is built on Vercel by site/sitemap.mjs from each page's own <link rel="canonical">,
// so a page that forgets its canonical, or copies another page's, drops out of the sitemap or lists the
// wrong URL with nothing to say so. These hold every guide and the homepage to the URL it is served at.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalOf, sitemapUrls, sitemapXml } from "../site/sitemap.mjs";

const site = join(dirname(import.meta.dirname), "site");

test("the sitemap lists the homepage and every guide under the URL it is served at", () => {
  const guides = readdirSync(join(site, "docs"))
    .filter((name) => name.endsWith(".html"))
    .map((name) => `https://frizz.sh/docs/${name.slice(0, -".html".length)}`);
  assert.deepEqual(sitemapUrls(), ["https://frizz.sh/", ...guides].sort());
});

test("pages kept out of the deploy, and pages marked noindex, stay out of the sitemap", () => {
  assert.ok(!sitemapUrls().some((url) => /og|mockups/.test(new URL(url).pathname)));
  assert.equal(canonicalOf('<meta name="robots" content="noindex" /><link rel="canonical" href="https://frizz.sh/x" />'), null);
  assert.equal(canonicalOf("<title>no canonical</title>"), null);
});

test("the sitemap is well-formed and escapes its URLs", () => {
  const xml = sitemapXml(["https://frizz.sh/a?b=1&c=2"]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<loc>https:\/\/frizz\.sh\/a\?b=1&amp;c=2<\/loc>/);
});
