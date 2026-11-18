// Writes sitemap.xml for frizz.sh. Vercel runs it as the build command (vercel.json), so a new page is
// in the sitemap on its first deploy with no list to edit: every deployed .html page that names its own
// <link rel="canonical"> is listed under that URL. A page without one, a page marked noindex, and
// anything .vercelignore keeps out of the deploy (og.html, mockups/) are left out.
//
//   node site/sitemap.mjs [out]   # out defaults to site/sitemap.xml, which .gitignore keeps out of git
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const site = import.meta.dirname;

const ignored = readFileSync(join(site, ".vercelignore"), "utf8")
  .split("\n")
  .map((line) => line.trim().replace(/^\/|\/$/g, ""))
  .filter((line) => line && !line.startsWith("#"));
const deployed = (path) => !ignored.some((entry) => path === entry || path.startsWith(`${entry}/`));

/** The canonical URL a page declares for itself, or null when it declares none or asks not to be indexed. */
export function canonicalOf(html) {
  for (const [meta] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/name=["']robots["']/i.test(meta) && /noindex/i.test(meta)) return null;
  }
  for (const [link] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["']canonical["']/i.test(link)) continue;
    const href = link.match(/href=["']([^"']+)["']/i)?.[1];
    if (href?.startsWith("https://")) return href;
  }
  return null;
}

export function sitemapUrls() {
  const pages = readdirSync(site, { recursive: true })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".html") && !path.split("/").some((part) => part.startsWith(".")))
    .filter(deployed);
  const urls = new Set(pages.map((path) => canonicalOf(readFileSync(join(site, path), "utf8"))).filter(Boolean));
  return [...urls].sort();
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sitemapXml(urls = sitemapUrls()) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${escape(url)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2] ?? join(site, "sitemap.xml");
  const urls = sitemapUrls();
  writeFileSync(out, sitemapXml(urls));
  console.log(`${relative(process.cwd(), out) || out}: ${urls.length} URLs`);
}
