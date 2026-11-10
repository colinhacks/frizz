import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// A RENDER ERROR STAYS IN THE SURFACE THAT THREW (ErrorBoundary.tsx). These pin the wiring, because the
// wiring is what was lost: on 2026-11-09 the one-thread pane replaced the queue, the queue's boundary
// stayed behind around a view nothing mounted any more, and a throw in the pane's thread reached the
// router, which drew its own page for developers over the whole window. The behaviour is checked in a
// real browser by ErrorBoundary.e2e.test.ts on a fixture; a fixture mounts its own copy of the wiring,
// so it cannot see a surface that forgot its boundary. These read the surfaces themselves.

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")
const boundary = (mount: string) => new RegExp(`<ErrorBoundary label="this thread" resetKeys=\\{\\[slug\\]\\}>\\s*<${mount}\\b`)

test("the pane and the full-screen page each catch their own thread's render error, and reset on another thread", () => {
  assert.match(read("./ThreadPane.tsx"), boundary("ThreadView"), "the pane's thread view sits in a boundary keyed on its slug")
  assert.match(read("./StandaloneThreadPage.tsx"), boundary("ThreadViewSurface"), "and so does the full-screen page's")
  // The drawer's is around the whole layer, with the sheet as its fallback.
  assert.match(read("./DrawerStack.tsx"), /<ErrorBoundary\s+key=\{d\.id\}\s+label="this drawer"/)
})

test("every top-level route names an errorElement, so the router's own error page is never drawn", () => {
  const routes = read("../routes.tsx")
  const table = routes.slice(routes.indexOf("export const router = createBrowserRouter(["))
  const topLevel = table.split("\n").filter((line) => /^  \{ path: /.test(line))
  assert.ok(topLevel.length >= 4, "the thread's own pages are top-level routes")
  for (const line of topLevel) assert.match(line, /, errorElement \},$/, line.trim())
  assert.match(table, /\n    element: <RootLayout \/>,\n    errorElement,\n/, "and the layout route, which holds every other page")
  // Nothing at the top level is left out: each top-level entry is one of the lines above, or the layout.
  assert.equal((table.match(/^  \{/gm) ?? []).length, topLevel.length + 1)
})
