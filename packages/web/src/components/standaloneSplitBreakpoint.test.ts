import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
// Imported from lib/sheet.ts, not from the page: importing the page pulls a `.css` through its
// component tree, which node cannot load. The two width constants that govern this morph live together
// there anyway — the drawer's own base width and the width the fullscreen page splits at.
import { SHEET_BASE_WIDTH, SPLIT_MIN_PX } from "../lib/sheet.ts"
import type { CSSProperties } from "react"
import { layoutVars, THREAD_WIDTH_PX } from "../lib/fullLayout.ts"
import { parseStoredPrefs } from "../lib/prefs.ts"

// WHERE /full BECOMES TWO COLUMNS IS ONE NUMBER, AND IT LIVES IN TWO PLACES.
//
// The layout switch is a Tailwind variant, so its width is a CSS custom property; the file-click gate
// is a `matchMedia`, so its width is a TypeScript constant. Nothing makes them agree except a person
// remembering, and for a while nobody did: the layout split at `md` (768) while the viewer gated at
// 1000, which left a 232px band where the file rail was on screen but clicking a file still fell back
// to the overlay drawer. That is the seam this file exists to hold shut.

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
// The page's lengths live in lib/fullLayout.ts (beside the rail's width), which the page and the board's
// pane both read, since the page itself is a lazy chunk (components/lazySurfaces.tsx).
const page = readFileSync(new URL("./StandaloneThreadPage.tsx", import.meta.url), "utf8")

test("the CSS breakpoint and the file-click gate are the SAME width", () => {
  const declared = css.match(/--breakpoint-split:\s*(\d+)px/)
  assert.ok(declared, "styles.css must declare --breakpoint-split, which draws the `split:` variant")
  assert.equal(
    Number(declared[1]),
    SPLIT_MIN_PX,
    "the width the layout splits at and the width a file click starts using the side pane must be one number",
  )
})

test("below the split, the fullscreen column is the DRAWER's width at the default thread width", () => {
  // This is what makes the expand a pure translate rather than a rescale: the board's drawer and the
  // fullscreen column are the same size, so the shared-element morph has no size to animate. It is
  // also what the maintainer asked after on 2026-09-02 ("the chat column widths are always the same
  // in both views?"). Above the split the 50/50 rule takes the column down to half the page — 600 at
  // the 1200 it was specified for — so the two agree again only from 1440 up. That divergence is the
  // 50/50 rule working as instructed, not a drift, which is why only the NARROW half is pinned here.
  // A wider Thread width setting (2026-11-18) raises the column's cap and not the drawer's, so the
  // morph rescales for whoever picks one; the default is what holds the two together.
  assert.equal(THREAD_WIDTH_PX.standard, SHEET_BASE_WIDTH, "Standard is the drawer's own base width, not a copy of the number")
  assert.equal(parseStoredPrefs(null).threadWidth, "standard", "and Standard is what a browser with no choice gets")
  assert.equal(SHEET_BASE_WIDTH, 720)
  for (const px of Object.values(THREAD_WIDTH_PX)) {
    assert.equal(layoutVars(px)["--full-thread-narrow" as keyof CSSProperties], `min(${px}px, 100%)`, "the single-column width is the cap itself, under the page")
  }
})

test("the split is drawn by the `split:` variant alone — no stray `md:` on the layout row", () => {
  // A leftover `md:` would silently reintroduce the 768 cliff, where the column fell from 720px to
  // 384px on one pixel of resize and sat beside a 340px rail reading "Nothing running, watched or
  // edited yet". Scoped to the layout vars so an unrelated `md:` elsewhere in the file is not caught.
  for (const varName of ["--full-gutter", "--full-thread", "--full-pane"]) {
    const uses = page.match(new RegExp(String.raw`md:[\w-]*\[var\(` + varName + String.raw`\)\]|md:block[^"]*` + varName, "g"))
    assert.equal(uses, null, `${varName} must be gated by \`split:\`, never \`md:\` — found ${uses?.join(", ")}`)
  }
  assert.ok(page.includes("split:w-[var(--full-thread)]"), "the wide column is behind `split:`")
  assert.ok(page.includes("split:block"), "the rail/pane region is behind `split:`")
})
