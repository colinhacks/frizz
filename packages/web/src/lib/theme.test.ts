import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { getThemeSnapshot, initTheme, parseThemePreference, resolveTheme, setThemePreference, subscribeTheme } from "./theme.ts"
import { recoveryPage, unauthorizedPage } from "../../../server/src/supervisor-pages.ts"

test("theme preferences validate independently from the resolved appearance", () => {
  assert.equal(parseThemePreference("system"), "system")
  assert.equal(parseThemePreference("light"), "light")
  assert.equal(parseThemePreference("dark"), "dark")
  assert.equal(parseThemePreference("sepia"), "system")
  assert.equal(resolveTheme("system", false), "light")
  assert.equal(resolveTheme("system", true), "dark")
  assert.equal(resolveTheme("light", true), "light")
  assert.equal(resolveTheme("dark", false), "dark")
})

test("the pre-paint resolver handles stored, denied-storage, and unavailable-media inputs", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const script = [...entry.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1]
  assert.ok(script)
  const run = ({ stored, storageFails = false, systemDark = false, mediaAvailable = true }: { stored?: string | null; storageFails?: boolean; systemDark?: boolean; mediaAvailable?: boolean }) => {
    const meta = { content: "#0d0e10", setAttribute(_: string, value: string) { this.content = value } }
    const documentElement = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
    vm.runInNewContext(script, {
      localStorage: { getItem: () => { if (storageFails) throw new Error("denied"); return stored ?? null } },
      matchMedia: mediaAvailable ? () => ({ matches: systemDark }) : undefined,
      document: { documentElement, querySelector: () => meta },
    })
    return { documentElement, meta }
  }
  assert.deepEqual(run({ stored: "dark" }).documentElement.dataset, { theme: "dark" })
  assert.deepEqual(run({ storageFails: true, systemDark: true }).documentElement.dataset, { theme: "dark" })
  const noMedia = run({ storageFails: true, mediaAvailable: false })
  assert.equal(noMedia.documentElement.dataset.theme, "light")
  assert.equal(noMedia.documentElement.style.colorScheme, "light")
  assert.equal(noMedia.meta.content, "#f6f8fa")
})

test("the runtime and pre-paint resolver share the dedicated preference key and canvas values", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const runtime = readFileSync(new URL("./theme.ts", import.meta.url), "utf8")
  assert.match(entry, /frizz-theme/)
  assert.match(entry, /#f6f8fa/)
  assert.match(runtime, /THEME_STORAGE_KEY = "frizz-theme"/)
  assert.match(runtime, /LIGHT_CANVAS = "#f6f8fa"/)
})

const declarations = (css: string) => Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))

test("both palettes are complete, including OS fallback and recovery subset parity", () => {
  const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const dark = declarations(css.split(':root, :root[data-theme="dark"] {')[1]!.split("}")[0]!)
  const light = declarations(css.split(':root[data-theme="light"] {')[1]!.split("}")[0]!)
  const fallback = declarations(css.split(':root:not([data-theme]) {')[1]!.split("}")[0]!)
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort())
  assert.deepEqual(light, fallback)
  const recovery = recoveryPage("/")
  const recoveryDark = declarations(recovery.split(":root{")[1]!.split("}")[0]!)
  const recoveryLight = declarations(recovery.split(":root[data-theme=light]{")[1]!.split("}")[0]!)
  const normalize = (color: string) => color === "#fff" ? "#ffffff" : color
  for (const name of ["bg", "panel", "panel-2", "border", "border-strong", "control-border", "control-strong", "fg", "muted", "accent"]) {
    assert.equal(normalize(recoveryDark[`--${name}`]!), dark[`--frizz-${name}`], `dark ${name}`)
    assert.equal(normalize(recoveryLight[`--${name}`]!), light[`--frizz-${name}`], `light ${name}`)
  }
  assert.doesNotMatch(unauthorizedPage(), /frizz|board|agent/i)
})

test("dark palette preserves existing canvases, code, marks and indexed terminal colors", () => {
  const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const dark = declarations(css.split(':root, :root[data-theme="dark"] {')[1]!.split("}")[0]!)
  const expected = {
    "--frizz-bg": "#0d0e10", "--frizz-panel": "#131519", "--frizz-panel-2": "#181b20", "--frizz-elevated": "#1c1f25", "--frizz-inset": "#090b10",
    "--frizz-fg": "#e6e7e9", "--frizz-muted": "#8b8f96", "--frizz-accent": "#e8b923", "--frizz-user-bubble": "#d5d7da", "--frizz-user-bubble-fg": "#0d0e10",
    "--frizz-control-border": "#26282d", "--frizz-control-strong": "#33363c", "--code-kw": "#f47067", "--code-com": "#768390", "--code-gutter": "#4b4f57",
    "--gh-fg-success": "#3fb950", "--gh-fg-danger": "#f85149", "--gh-fg-done": "#ab7df8", "--gh-neutral-border": "#3d444d", "--gh-label-fg-mix": "0%",
    "--sidebar-dim-opacity": ".65", "--mobile-dim-opacity": ".6", "--row-dim-hover-opacity": ".9", "--viz-destructive": "#ef6461", "--frizz-danger-button": "var(--color-red-500)",
    "--terminal-cursor": "#ffffff", "--terminal-cursor-accent": "#000000",
  }
  for (const [name, value] of Object.entries(expected)) assert.equal(dark[name], value, name)
  const ansi = ["2e3436", "cc0000", "4e9a06", "c4a000", "3465a4", "75507b", "06989a", "d3d7cf"]
  const bright = ["555753", "ef2929", "8ae234", "fce94f", "729fcf", "ad7fa8", "34e2e2", "eeeeec"]
  for (const [index, name] of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].entries()) {
    assert.equal(dark[`--terminal-${name}`], `#${ansi[index]}`)
    assert.equal(dark[`--terminal-bright-${name}`], `#${bright[index]}`)
  }
  assert.match(css, /\.95;/, "light dimming remains readable instead of multiplying the old dark alpha")
})

test("actual startup scripts and runtime agree for the complete preference matrix", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const scripts = [entry, recoveryPage("/")].map(html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]![1]!)
  const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  for (const stored of [null, "system", "dark", "light", "invalid"]) for (const systemDark of [false, true]) for (const denied of [false, true]) for (const noMedia of [false, true]) {
    const expected = resolveTheme(parseThemePreference(denied ? null : stored), noMedia ? false : systemDark)
    for (const script of scripts) {
      const meta = { content: "", setAttribute(_: string, value: string) { this.content = value } }
      const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
      vm.runInNewContext(script, {
        localStorage: { getItem() { if (denied) throw new Error("denied"); return stored } },
        matchMedia: noMedia ? undefined : () => ({ matches: systemDark }),
        document: { documentElement: root, querySelector: () => meta },
      })
      assert.equal(root.dataset.theme, expected)
      assert.equal(root.style.colorScheme, expected)
      const palette = css.split(expected === "dark" ? ':root, :root[data-theme="dark"] {' : ':root[data-theme="light"] {')[1]!.split("}")[0]!
      assert.equal(meta.content, declarations(palette)["--frizz-bg"])
    }
  }
})

test("runtime retains memory choices, stable snapshots and one disposable listener pair", () => {
  const keys = ["window", "document", "localStorage"] as const
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  const events = new Map<string, (event: any) => void>()
  const mediaEvents = new Set<(event: { matches: boolean }) => void>()
  let stored: string | null = null
  let failedWrite = false
  let writes = 0
  const storage = { getItem: () => stored, setItem(_: string, value: string) { writes++; if (failedWrite) throw new Error("full"); stored = value } }
  const media = { matches: true, addEventListener(_: string, fn: (event: { matches: boolean }) => void) { mediaEvents.add(fn) }, removeEventListener(_: string, fn: (event: { matches: boolean }) => void) { mediaEvents.delete(fn) } }
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
  const win = { matchMedia: () => media, addEventListener(name: string, fn: (event: any) => void) { events.set(name, fn) }, removeEventListener(name: string) { events.delete(name) } }
  Object.defineProperties(globalThis, { window: { configurable: true, value: win }, document: { configurable: true, value: { documentElement: root, querySelector: () => null } }, localStorage: { configurable: true, value: storage } })
  let cleanup: (() => void) | undefined
  const notifications: string[] = []
  const unsubscribe = subscribeTheme(() => notifications.push(getThemeSnapshot().resolved))
  try {
    cleanup = initTheme()
    assert.equal(initTheme(), cleanup)
    assert.equal(mediaEvents.size, 1)
    assert.equal(events.size, 1)
    const stable = getThemeSnapshot()
    setThemePreference("system")
    assert.equal(getThemeSnapshot(), stable)
    setThemePreference("light")
    media.matches = false
    for (const listener of mediaEvents) listener(media)
    media.matches = true
    for (const listener of mediaEvents) listener(media)
    assert.equal(getThemeSnapshot().resolved, "light")
    setThemePreference("system")
    const beforeOS = writes
    media.matches = false
    for (const listener of mediaEvents) listener(media)
    assert.equal(getThemeSnapshot().resolved, "light")
    assert.equal(writes, beforeOS)
    failedWrite = true
    setThemePreference("dark")
    for (const listener of mediaEvents) listener(media)
    assert.equal(getThemeSnapshot().resolved, "dark")
    const beforeStorage = writes
    events.get("storage")!({ key: "frizz-theme", newValue: "light", storageArea: {} })
    assert.equal(getThemeSnapshot().resolved, "dark", "sessionStorage is not theme storage")
    events.get("storage")!({ key: "frizz-theme", newValue: null, storageArea: storage })
    assert.deepEqual(getThemeSnapshot(), { preference: "system", resolved: "light" })
    events.get("storage")!({ key: "frizz-theme", newValue: "dark", storageArea: storage })
    events.get("storage")!({ key: null, storageArea: storage })
    assert.deepEqual(getThemeSnapshot(), { preference: "system", resolved: "light" })
    assert.equal(writes, beforeStorage)
    assert.ok(notifications.length >= 4)
    cleanup?.()
    assert.equal(mediaEvents.size, 0)
    assert.equal(events.size, 0)
    cleanup = initTheme()
    assert.equal(mediaEvents.size, 1, "HMR can reinitialize")
  } finally {
    unsubscribe()
    cleanup?.()
    keys.forEach((key, i) => { if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!); else Reflect.deleteProperty(globalThis, key) })
  }
})
