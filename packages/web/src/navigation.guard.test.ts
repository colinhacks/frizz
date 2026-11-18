import assert from "node:assert/strict"
import test from "node:test"
import { globSync, readFileSync } from "node:fs"

// The page moves itself in one place: lib/navigation.ts, which goes through the gate index.html defines
// (`frizzNavigate`), which stops a page that keeps reloading itself. A direct `location.reload()` anywhere
// else is a move nothing counts, and one of those reloaded a board every two seconds for as long as it was
// open (2026-11-18). Another window's location (`tab.location.href = …`, a popup) is not this page's.

const src = new URL(".", import.meta.url).pathname
const GATED = "lib/navigation.ts"

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")

/** This page's location, reached bare or through one of the names it goes by. */
const OWN = String.raw`(?<![\w$.])(?<!(?:const|let|var)\s+)(?:(?:window|self|globalThis|document|top)\s*\.\s*)?location`
const MOVES = [
  new RegExp(String.raw`${OWN}\s*\.\s*(?:reload|replace|assign)\s*\(`),
  new RegExp(String.raw`${OWN}(?:\s*\.\s*href)?\s*=(?!=)`),
  /(?<![\w$.])history\s*\.\s*go\s*\(\s*0?\s*\)/,
]

test("nothing in the app moves the page but lib/navigation.ts", () => {
  const files = globSync("**/*.{ts,tsx}", { cwd: src }).filter((file) => !/\.(test|e2e)\.tsx?$|\.e2e\.test\.tsx?$/.test(file) && file !== GATED)
  assert.ok(files.length > 100, "the scan found the app")
  const offenders = files.flatMap((file) =>
    stripComments(readFileSync(`${src}/${file}`, "utf8"))
      .split("\n")
      .flatMap((line, index) => (MOVES.some((move) => move.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  )
  assert.deepEqual(offenders, [], "move the page with navigate() from lib/navigation.ts, which the gate counts")
})

test("the scan catches every way of moving the page, and leaves another window alone", () => {
  for (const line of ["location.reload()", "window.location.replace(x)", "location.assign(x)", "location.href = x", "window.location = x", "document.location.href=x", "history.go(0)", "self.location.reload()"]) {
    assert.ok(MOVES.some((move) => move.test(line)), line)
  }
  for (const line of ["tab.location.href = url", "location.href === x", "const href = location.href", "location.pathname", "popup.location.replace(x)", "const location = useLocation()"]) {
    assert.ok(!MOVES.some((move) => move.test(line)), line)
  }
})

test("index.html defines the gate before the app loads, and the watchdog moves only through it", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  assert.ok(html.indexOf("window.frizzNavigate =") < html.indexOf('<script type="module"'), "the gate exists before main.tsx runs")
  // The gate's own three moves and its Reload button's; the watchdog after it reloads through frizzNavigate.
  const watchdog = html.slice(html.indexOf('addEventListener("error"'))
  assert.equal([...html.matchAll(/location\.(?:reload|replace|assign)\(/g)].length, 4)
  assert.equal([...watchdog.matchAll(/location\.(?:reload|replace|assign)\(/g)].length, 0)
})
