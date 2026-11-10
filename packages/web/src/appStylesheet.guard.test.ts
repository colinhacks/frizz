import assert from "node:assert/strict"
import { globSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { test } from "node:test"

// app.css is styles.css compiled without the classes only a fixture or a test spells (its header has
// the measurement: 246,129 bytes with them, 205,564 without). Three things keep that true, and none of
// them fails loudly when it stops: the app importing that file, the file naming every kind of
// non-app source that lives in src/, and the fixtures staying on the full sheet.

const web = join(import.meta.dirname, "..")
const src = import.meta.dirname
const appCss = readFileSync(join(src, "app.css"), "utf8")

/** Each `@source not` line as where it looks (`src` at any depth, or the package root) and the name ending it refuses. */
const refused = [...appCss.matchAll(/^@source not "([^"]+)";$/gm)].map(([, pattern]) => {
  const deep = /^\.\/\*\*\/\*([^*/]+)$/.exec(pattern)
  if (deep) return { where: "src" as const, ending: deep[1] }
  const root = /^\.\.\/\*([^*/]+)$/.exec(pattern)
  if (root) return { where: "root" as const, ending: root[1] }
  throw new Error(`app.css refuses "${pattern}", a shape this test cannot read; teach it the shape`)
})
const refuses = (where: "src" | "root", name: string) => refused.some((entry) => entry.where === where && name.endsWith(entry.ending))

test("the app is compiled from app.css, and app.css is styles.css and its exclusions only", () => {
  const main = readFileSync(join(src, "main.tsx"), "utf8")
  assert.match(main, /^import "\.\/app\.css"$/m)
  assert.doesNotMatch(main, /import "\.\/styles\.css"/, "main.tsx imports the full sheet again, with every fixture's classes")
  const lines = appCss.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => line.trim() !== "")
  assert.equal(lines[0], '@import "./styles.css";')
  assert.ok(lines.slice(1).every((line) => line.startsWith("@source not ")), "a rule or a utility belongs in styles.css, where a fixture gets it too")
  assert.ok(refused.length > 0)
})

test("every fixture, mockup, kit and test under src is out of the app's stylesheet", () => {
  // The names non-app source goes by here. A new family (a `*-playground.tsx`, a `*.stories.tsx`) has to
  // be added to app.css and to this pattern together, or its classes ship to every user again.
  const notApp = /fixture|mockup|-kit\.|\.test\./
  const files = globSync("**/*.{ts,tsx}", { cwd: src }).filter((file) => notApp.test(basename(file)))
  assert.ok(files.length > 100, `found only ${files.length} fixture and test files; the glob is wrong`)
  assert.deepEqual(files.filter((file) => !refuses("src", basename(file))), [], "scanned for classes, though the app never draws it")

  // Each fixture's page sits beside index.html, the one page the app is built from.
  const pages = readdirSync(web).filter((name) => name.endsWith(".html") && name !== "index.html")
  assert.ok(pages.length > 100, `found only ${pages.length} fixture pages`)
  assert.deepEqual(pages.filter((name) => !refuses("root", name)), [])
})

test("nothing the app is made of is refused, and no fixture is compiled from app.css", () => {
  // The other direction: an exclusion wide enough to catch app source drops classes the app draws.
  const app = globSync("**/*.{ts,tsx}", { cwd: src }).filter((file) => !/fixture|mockup|-kit\.|\.test\./.test(basename(file)))
  assert.ok(app.length > 200)
  assert.deepEqual(app.filter((file) => refuses("src", basename(file))), [])
  assert.equal(refuses("root", "index.html"), false)

  // A fixture compiled from app.css would lose every class only it spells, and its test would measure that.
  const onAppSheet = globSync("**/*.{ts,tsx}", { cwd: src })
    .filter((file) => file !== "main.tsx" && !file.endsWith(".test.ts"))
    .filter((file) => /import\s+["'][^"']*\/app\.css["']/.test(readFileSync(join(src, file), "utf8")))
  assert.deepEqual(onAppSheet, [])
})
