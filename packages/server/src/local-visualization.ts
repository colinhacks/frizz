import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"

const MAX_FRAGMENT_BYTES = 2 * 1024 * 1024
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/
const FILE_NAME = /^[a-z0-9][a-z0-9-]{0,127}\.html$/
const DATE_PART = /^\d{2}$/
const YEAR_PART = /^\d{4}$/

const CDN_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
]
const FONT_STYLE_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.bunny.net"]
const FONT_ORIGINS = ["https://fonts.gstatic.com", "https://fonts.bunny.net"]

export type LocalVisualizationResult =
  | { status: 400 | 404 | 413 }
  | { status: 200; body: string; contentSecurityPolicy: string }

function children(path: string, pattern: RegExp): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function resolveFragment(projectDir: string, sessionId: string, file: string): string | null {
  const base = join(projectDir, ".codex", "visualizations")
  let projectReal: string
  let baseReal: string
  try {
    projectReal = realpathSync(projectDir)
    baseReal = realpathSync(base)
  } catch { return null }
  if (!isUnder(baseReal, projectReal)) return null

  for (const year of children(base, YEAR_PART)) {
    const yearDir = join(base, year)
    for (const month of children(yearDir, DATE_PART)) {
      const monthDir = join(yearDir, month)
      for (const day of children(monthDir, DATE_PART)) {
        const sessionRoot = join(baseReal, year, month, day, sessionId)
        const candidate = join(monthDir, day, sessionId, file)
        try {
          const real = realpathSync(candidate)
          if (isUnder(real, sessionRoot) && statSync(real).isFile()) return real
        } catch {
          // Search older date folders. A visualization basename can be reused across turns.
        }
      }
    }
  }
  return null
}

function wrapper(fragment: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: dark;
  --background: #0d0e10; --foreground: #e6e7e9; --card: #181b20;
  --card-foreground: #e6e7e9; --popover: #1c1f25; --popover-foreground: #e6e7e9;
  --primary: #e6e7e9; --primary-foreground: #0d0e10; --secondary: #26282d;
  --secondary-foreground: #e6e7e9; --muted: #181b20; --muted-foreground: #8b8f96;
  --accent: #26282d; --accent-foreground: #e6e7e9; --destructive: #ef6461;
  --border: #33363c; --input: #33363c; --ring: #e8b923;
  --viz-series-1: #7aa2f7; --viz-series-2: #4ac97e; --viz-series-3: #e8b923;
  --viz-series-4: #bb9af7; --viz-series-5: #f7768e; --viz-series-6: #7dcfff;
  --font-size-base: 13px;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-width: 0; overflow-x: hidden; }
body { background: transparent; color: var(--foreground); font: 400 var(--font-size-base)/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 1px; }
.text-small { font-size: max(11px, calc(var(--font-size-base) * .86)); }
.text-muted { color: var(--muted-foreground); }
.text-destructive { color: var(--destructive); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.card { border: 1px solid var(--border); border-radius: .75rem; background: var(--card); color: var(--card-foreground); padding: 1rem; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .75rem; }
.viz-row, .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; }
.viz-stat-value { font-size: 1.55em; font-weight: 500; }
.viz-badge { display: inline-flex; border-radius: 999px; background: var(--accent); color: var(--accent-foreground); padding: .15rem .5rem; }
.btn, .form-control, .form-select { border: 1px solid var(--input); border-radius: .45rem; background: var(--secondary); color: var(--secondary-foreground); font: inherit; padding: .45rem .7rem; }
.btn { cursor: pointer; }
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
.btn-ghost { background: transparent; }
.btn-block { width: 100%; }
.form-label, .form-check { display: inline-flex; align-items: center; gap: .4rem; }
.form-range { accent-color: var(--primary); }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
</style>
<script>
(() => {
  const notifyHeight = () => parent.postMessage({ type: "frizz-inline-vis-height", height: Math.ceil(document.documentElement.scrollHeight) }, "*");
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data?.type !== "frizz-inline-vis-theme" || !event.data.vars || !Number.isSafeInteger(event.data.requestId)) return;
    for (const [name, value] of Object.entries(event.data.vars)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.style.colorScheme = event.data.colorScheme === "light" ? "light" : "dark";
    requestAnimationFrame(notifyHeight);
    dispatchEvent(new CustomEvent("frizz-theme-change", { detail: { requestId: event.data.requestId, colorScheme: document.documentElement.style.colorScheme, vars: event.data.vars } }));
    parent.postMessage({ type: "frizz-inline-vis-applied", requestId: event.data.requestId }, "*");
  });
  window.openai = Object.freeze({
    sendFollowUpMessage: async () => { throw new Error("Follow-up actions are not supported in Frizz visualizations yet"); }
  });
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(notifyHeight).observe(document.body);
    notifyHeight();
    parent.postMessage({ type: "frizz-inline-vis-ready" }, "*");
  });
})();
</script>
</head>
<body>
${fragment}
</body>
</html>`
}

export function resolveLocalVisualization(projectDir: string, sessionId: string | undefined, file: string | undefined): LocalVisualizationResult {
  if (!sessionId || !file || !SESSION_ID.test(sessionId) || !FILE_NAME.test(file)) return { status: 400 }
  const path = resolveFragment(projectDir, sessionId, file)
  if (!path) return { status: 404 }
  let fragment: string
  try {
    const size = statSync(path).size
    if (size > MAX_FRAGMENT_BYTES) return { status: 413 }
    fragment = readFileSync(path, "utf8")
  } catch {
    return { status: 404 }
  }
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${CDN_ORIGINS.join(" ")}`,
    `style-src 'unsafe-inline' ${CDN_ORIGINS.join(" ")} ${FONT_STYLE_ORIGINS.join(" ")}`,
    `font-src ${FONT_ORIGINS.join(" ")}`,
    `img-src data: blob: ${CDN_ORIGINS.join(" ")}`,
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Defense in depth for direct navigation to the route: keep the generated document opaque-origin
    // and capability-limited even when it is not inside the client's sandboxed iframe.
    "sandbox allow-scripts",
  ].join("; ")
  return { status: 200, body: wrapper(fragment), contentSecurityPolicy }
}
