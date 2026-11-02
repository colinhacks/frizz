import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import * as layers from "./layers.ts"
import { DRAWER_DEPTH_CEILING, LAYER, drawerZ } from "./layers.ts"

// lib/layers.ts is the app's one stacking order. Its header states the three rules; this file holds the
// app to them. Every failure here was a shipped bug first (2026-11-01): a toast painted under the sign-in
// modal's scrim, the project rail lit through the Settings scrim, Settings sliding in under a thread
// drawer, and a drawer band with no ceiling. If a scan below fails on your change, move the change into
// a layer (or out of the tree) rather than widening the scan.

// ── Rule 3: the order, and the reason for each step of it ──────────────────────────────────────────

test("each layer covers what it is declared to cover", () => {
  const covers: [upper: keyof typeof LAYER, lower: keyof typeof LAYER | number, why: string][] = [
    ["chrome", 20, "the rail and the phone header sit over the page's own sticky headers (≤ 20)"],
    ["drawer", "chrome", "a drawer's scrim covers the rail and the phone header"],
    ["modal", "drawerCeiling", "Settings opened from ⌘K over a thread drawer slides in over it"],
    ["palette", "modal", "⌘K opens over Settings and the new-thread modal"],
    ["select", "palette", "a Select or menu opened inside Settings or a drawer draws over it"],
    ["dialog", "select", "a dialog opened from a menu covers the page that menu sat on"],
    ["dialogOverDialog", "dialog", "sign-in opens from inside the GitHub picker"],
    ["popover", "dialogOverDialog", "a tooltip or popover opened inside any dialog draws over it"],
    ["selectInPopover", "popover", "the agent-settings popover's Selects open over the popover"],
    ["toast", "selectInPopover", "a toast fired from inside a dialog or popover is readable over it"],
    ["restart", "toast", "the restart scrim covers the whole app"],
  ]
  for (const [upper, lower, why] of covers) {
    const below = typeof lower === "number" ? lower : LAYER[lower]
    assert.ok(LAYER[upper] > below, `${upper} (${LAYER[upper]}) must be above ${lower} (${below}): ${why}`)
  }
})

test("each layer's class string names its number", () => {
  const classes = Object.entries(layers).filter(([name]) => name.startsWith("Z_")) as [string, string][]
  const camel = (name: string) => name.slice(2).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  assert.ok(classes.length > 0)
  for (const [name, cls] of classes) {
    const key = camel(name) as keyof typeof LAYER
    assert.ok(key in LAYER, `${name} names no LAYER key (${key})`)
    assert.match(cls, /^z-(\d+|\[\d+\])$/, `${name} must be one literal z utility, so Tailwind generates it`)
    assert.equal(Number(cls.replace(/\D/g, "")), LAYER[key], `${name} is ${cls}, but LAYER.${key} is ${LAYER[key]}`)
  }
  // Every layer anything can be placed in has its class, except the drawer band, placed by drawerZ.
  const named = new Set(classes.map(([name]) => camel(name)))
  for (const key of Object.keys(LAYER)) {
    if (key === "drawer" || key === "drawerCeiling") continue
    assert.ok(named.has(key), `LAYER.${key} has no Z_ class`)
  }
})

test("the drawer band is closed: every depth steps up, and none reaches the modal layer", () => {
  let previous = drawerZ(0)
  assert.deepEqual(previous, { scrim: LAYER.drawer, panel: LAYER.drawer + 1 })
  for (let depth = 1; depth <= DRAWER_DEPTH_CEILING; depth++) {
    const z = drawerZ(depth)
    assert.ok(z.scrim > previous.panel, `depth ${depth}'s scrim must cover depth ${depth - 1}'s panel`)
    assert.equal(z.panel, z.scrim + 1)
    previous = z
  }
  assert.equal(previous.panel, LAYER.drawerCeiling)
  for (const depth of [DRAWER_DEPTH_CEILING + 1, 50, 1000, Infinity]) assert.deepEqual(drawerZ(depth), previous)
  assert.deepEqual(drawerZ(-1), drawerZ(0))
  assert.ok(DRAWER_DEPTH_CEILING >= 10, "a real stack goes a few layers deep; the band must hold far more")
})

// ── Rules 1 and 2: the source scan ─────────────────────────────────────────────────────────────────

const src = fileURLToPath(new URL("../", import.meta.url))
// What ships: tests, fixture pages and the mockup kits are their own pages, and layers.ts is the order.
const sources = new Map(
  globSync("**/*.{ts,tsx,css}", { cwd: src })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => !/\.test\.tsx?$/.test(file) && !/-fixture\.tsx?$/.test(file) && !/-mockup-kit\.tsx?$/.test(file))
    .filter((file) => file !== "lib/layers.ts")
    .map((file) => [file, stripComments(file, readFileSync(`${src}/${file}`, "utf8"))] as const),
)

// Comments may name any z-index (they explain the old bugs); only code is held to the rules. Line by line,
// not one regex over the file: `accept="image/*"` would open a "comment" that swallowed real code up to
// the next `*/`. A block comment is one that OPENS a line (`/*`, `/**`, JSX's `{/*`); a `//` comment
// follows whitespace, so the `//` of a URL is code. Blanked lines are kept, so line numbers are the file's.
function stripComments(file: string, text: string): string {
  if (file.endsWith(".css")) return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
  let inBlock = false
  return text
    .split("\n")
    .map((line) => {
      if (inBlock) {
        const end = line.indexOf("*/")
        if (end < 0) return ""
        inBlock = false
        line = line.slice(end + 2)
      }
      const open = /^\s*\{?\/\*/.exec(line)
      if (open) {
        const end = line.indexOf("*/", open[0].length)
        if (end < 0) {
          inBlock = true
          return ""
        }
        line = line.slice(end + 2)
      }
      return line.replace(/(^|\s)\/\/.*$/, "$1")
    })
    .join("\n")
}

function hits(pattern: RegExp, keep: (match: RegExpExecArray) => boolean = () => true): string[] {
  const found: string[] = []
  for (const [file, text] of sources) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      if (!keep(match)) continue
      const line = text.slice(0, match.index).split("\n").length
      found.push(`${file}:${line} ${match[0].trim()}`)
    }
  }
  return found
}

test("no z-index above 20 is written outside lib/layers.ts", () => {
  // A z utility, with or without a variant prefix (`hover:z-30`), negative or not.
  const utilities = hits(/(?<![\w-])-?z-(\d+|\[[^\]]*\])/g, (m) => !/^\d+$|^\[\d+\]$/.test(m[1]!) || Number(m[1]!.replace(/\D/g, "")) > 20)
  // A z-index in a stylesheet, or in a style string built in code.
  const declarations = hits(/z-index\s*:\s*([^;"'`\n}]+)/g, (m) => !/^-?\d+$/.test(m[1]!.trim()) || Number(m[1]!.trim()) > 20)
  assert.deepEqual(
    [...utilities, ...declarations],
    [],
    "A z-index above 20 is a layer: take it from lib/layers.ts (Z_POPOVER, Z_MODAL, …), or add the layer there with what it must cover.",
  )
})

test("an inline zIndex is a small in-surface number or a drawer layer from drawerZ", () => {
  const found = hits(/zIndex\s*[:=]\s*([^,}\n;]+)/g, (m) => {
    const value = m[1]!.trim()
    if (/^drawerZ\(/.test(value) || /^LAYER\.\w+$/.test(value)) return false
    return !/^-?\d+$/.test(value) || Number(value) > 20
  })
  assert.deepEqual(found, [], "A computed z-index escapes the order test: use drawerZ(depth) or a LAYER, or add a layer to lib/layers.ts.")
})

test("every Radix content surface is portaled", () => {
  // `<Ns.Content` left in the tree is the update-popover bug in Radix form: its z ranks only inside the
  // nearest stacking context. Each one sits inside its namespace's own `<Ns.Portal>`.
  const found: string[] = []
  for (const [file, text] of sources) {
    for (const [, ns] of text.matchAll(/<(\w+)\.Content\b/g)) {
      const contents = text.split(`<${ns}.Content`).length - 1
      const portals = text.split(`<${ns}.Portal`).length - 1
      if (portals < contents) found.push(`${file}: ${contents} <${ns}.Content, ${portals} <${ns}.Portal`)
    }
  }
  assert.deepEqual([...new Set(found)], [])
})

// Rule 4. A full-screen layer drawn over the app is a member of Radix's layer stack: a Radix dialog's
// Content, or ui/ModalSurface for one the app draws itself. Every thread drawer is a Radix dialog (a modal
// one on the phone), and a surface outside that stack loses to it whatever its z: Escape closed the drawer
// under ⌘K and Settings, and on the phone ⌘K over a drawer took no tap and no keystroke (2026-11-01).
const FULL_SCREEN_LAYERS = ["Z_MODAL", "Z_PALETTE", "Z_DIALOG", "Z_DIALOG_OVER_DIALOG"]

test("every full-screen layer is in Radix's layer stack", () => {
  const found: string[] = []
  for (const [file, text] of sources) {
    const layer = FULL_SCREEN_LAYERS.find((name) => new RegExp(`\\$\\{${name}\\}`).test(text))
    if (!layer) continue
    if (/<\w*Dialog\.Content\b|<ModalSurface\b/.test(text)) continue
    found.push(`${file} takes ${layer} outside a Radix dialog: render it through ui/ModalSurface`)
  }
  assert.deepEqual(found, [])
})

// A hand-made portal to <body> is a layer nothing ranks and nothing stacks: no z from lib/layers.ts, no
// place in Radix's stack. The two that exist are the primitives built for it.
const BODY_PORTALS_ALLOWED: Record<string, string> = {
  "components/ui/AnchoredLayer.tsx": "the anchored-panel primitive itself (rule 2)",
  "components/Tooltip.tsx": "the tooltip's hand-placed fallback: read-only text, nothing to tap or focus",
}

test("only the layer primitives portal to <body> by hand", () => {
  const found = [...sources]
    .filter(([file, text]) => /createPortal\(/.test(text) && /,\s*document\.body,?\s*\)/.test(text) && !BODY_PORTALS_ALLOWED[file])
    .map(([file]) => `${file}: use ui/ModalSurface (a full-screen layer) or ui/AnchoredLayer (a panel off a trigger)`)
  assert.deepEqual(found, [])
})

// An element placed past its own parent's edge is a popup hanging off a trigger. Left in the tree it is
// painted inside the trigger's stacking context, and the update popover (2026-10-30) and the composer's
// skills menu (2026-11-01) both went under a neighbour that way. Portal it: ui/AnchoredLayer for a
// panel placed by hand, Radix's Portal for a Radix one.
const ESCAPES = /^(top|bottom|left|right)-(full|\[calc\(100%.*)$/
// The few that hang past their parent and are not popups, each with the reason it cannot be covered.
const ESCAPES_ALLOWED: Record<string, string> = {
  // The first-run screen's "Starting thread…" card, hung under the form so the centred column does not
  // jump. That screen draws nothing else: no sidebar, no cards, no sticky header to go under.
  "components/NewThreadModal.tsx": "absolute inset-x-0 top-full mt-3",
}

test("no popup is placed past its trigger's box in the tree", () => {
  const found: string[] = []
  for (const [file, text] of sources) {
    // Each string or template literal is one class list; a variant (`before:right-full`) is not the element.
    for (const literal of text.matchAll(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g)) {
      const tokens = literal[0].slice(1, -1).split(/\s+/)
      if (!tokens.includes("absolute") || !tokens.some((token) => ESCAPES.test(token))) continue
      if (ESCAPES_ALLOWED[file] && literal[0].includes(ESCAPES_ALLOWED[file]!)) continue
      found.push(`${file}:${text.slice(0, literal.index).split("\n").length} ${literal[0]}`)
    }
  }
  assert.deepEqual(found, [], "A popup in the tree goes under its neighbours' stacking contexts: render it through ui/AnchoredLayer.")
})
