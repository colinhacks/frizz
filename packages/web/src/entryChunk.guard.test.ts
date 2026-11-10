// WHAT THE BOARD'S FIRST PAINT LOADS: nothing that only a thread, a file reader or the image viewer draws.
//
// Those are one lazy chunk (components/threadSurfaces.ts, reached through components/lazySurfaces.tsx),
// fetched once the board has painted. The chunk stays out of the entry only while NO module the entry
// reaches imports one of its members statically — one `import { X } from "./ChatView.tsx"` anywhere
// below main.tsx, for a constant or a type guard, and the bundler puts the whole transcript renderer,
// marked and highlight.js back in front of every board (measured 2026-11-10: 1,769 KB of entry, 1,205 KB
// without them). Nothing at runtime would say so; the page just gets slower. So this walks the static
// import graph from main.tsx, the way the bundler does, and names the chain that pulls one in.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SRC = dirname(fileURLToPath(import.meta.url))

/** Modules only the lazy chunk may reach, and the npm packages only they need. */
const LAZY_ONLY = [
  "components/ChatView.tsx",
  "components/TodosView.tsx",
  "components/StandaloneThreadPage.tsx",
  "components/SubAgentSheet.tsx",
  "components/ThreadDrawer.tsx",
  "components/BackgroundShellSheet.tsx",
  "components/MarkdownDrawer.tsx",
  "components/Lightbox.tsx",
  "components/MobileThreadActionsSheet.tsx",
  "components/FocusRail.tsx",
  "lib/markdown.ts",
  "lib/syntaxHighlight.ts",
  "lib/codeBlock.ts",
]
const LAZY_PACKAGES = [/^marked$/, /^highlight\.js(\/|$)/]

// Static imports and re-exports, not `import type` (erased) and not `import()` (a chunk boundary).
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g

function staticImports(file: string): string[] {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(STATIC)].map((m) => m[1]!)
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const path = resolve(dirname(from), spec)
  return existsSync(path) ? path : null
}

/** Every module main.tsx reaches statically, each with the module that first imported it. */
function entryGraph(): { reached: Map<string, string | null>; packages: Map<string, string> } {
  const main = join(SRC, "main.tsx")
  const reached = new Map<string, string | null>([[main, null]])
  const packages = new Map<string, string>()
  const queue = [main]
  while (queue.length) {
    const file = queue.shift()!
    for (const spec of staticImports(file)) {
      if (!spec.startsWith(".")) {
        if (!packages.has(spec)) packages.set(spec, file)
        continue
      }
      const next = resolveLocal(file, spec)
      if (!next || !next.startsWith(SRC) || reached.has(next) || /\.css$/.test(next)) continue
      reached.set(next, file)
      queue.push(next)
    }
  }
  return { reached, packages }
}

function chain(reached: Map<string, string | null>, file: string): string {
  const path: string[] = []
  for (let at: string | null | undefined = file; at; at = reached.get(at)) path.unshift(at.slice(SRC.length + 1))
  return path.join(" -> ")
}

test("the entry reaches none of the lazy chunk's modules statically", () => {
  const { reached } = entryGraph()
  const leaks = LAZY_ONLY.map((m) => join(SRC, m)).filter((m) => reached.has(m))
  assert.deepEqual(leaks.map((m) => chain(reached, m)), [], "import these through components/lazySurfaces.tsx, or move what you need out of them")
})

test("the entry reaches neither marked nor highlight.js statically", () => {
  const { reached, packages } = entryGraph()
  const leaks = [...packages].filter(([spec]) => LAZY_PACKAGES.some((re) => re.test(spec)))
  assert.deepEqual(leaks.map(([spec, by]) => `${chain(reached, by)} -> ${spec}`), [])
})

test("the walk sees through the seam it guards: the lazy chunk itself does reach them", () => {
  // The negative control the two above depend on. If the walker stopped following imports, they would
  // pass with every seam undone; from the chunk's own barrel, it must find the transcript renderer.
  const barrel = join(SRC, "components/threadSurfaces.ts")
  const seen = new Set([barrel])
  const queue = [barrel]
  const packages = new Set<string>()
  while (queue.length) {
    const file = queue.shift()!
    for (const spec of staticImports(file)) {
      if (!spec.startsWith(".")) { packages.add(spec); continue }
      const next = resolveLocal(file, spec)
      if (next && next.startsWith(SRC) && !seen.has(next) && !/\.css$/.test(next)) { seen.add(next); queue.push(next) }
    }
  }
  assert.ok(seen.has(join(SRC, "components/ChatView.tsx")))
  assert.ok(seen.has(join(SRC, "lib/syntaxHighlight.ts")))
  assert.ok([...packages].some((p) => p === "marked"))
})
