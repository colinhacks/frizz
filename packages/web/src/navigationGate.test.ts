import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { LAYER } from "./lib/layers.ts"
import { NAVIGATION_LEDGER_CHECK } from "../../server/src/supervisor-pages.ts"

// index.html's second inline script is the navigation gate and the boot watchdog. It runs here as written,
// against a stand-in window, so what it lets through is pinned on the shipped text rather than on a copy.
// Each `load` is one document load of the page: a fresh script over the same tab's sessionStorage.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1]?.[1]
assert.ok(script?.includes("window.frizzNavigate") && script.includes("frizz-boot-retry"), "the second inline script is the gate and the watchdog")

const ORIGIN = "https://colinhacks.frizz.sh"
type Move = { kind: "reload" | "replace" | "assign"; to?: string }

/** A stand-in element: just enough DOM for the panel the script builds. */
class Element {
  style: Record<string, string> = {}
  children: Element[] = []
  textContent = ""
  type = ""
  attributes: Record<string, string> = {}
  listeners: Record<string, () => void> = {}
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  addEventListener(type: string, listener: () => void) { this.listeners[type] = listener }
  append(...children: Element[]) { this.children.push(...children) }
  querySelector(tag: string): Element | null {
    for (const child of this.children) {
      if (child.tagName === tag.toUpperCase()) return child
      const found = child.querySelector(tag)
      if (found) return found
    }
    return null
  }
}

/** One browser tab: its sessionStorage, its clock, and what has happened to it. */
function tab() {
  const storage = new Map<string, string>()
  const state = { now: 1_800_000_000_000, active: false, moves: [] as Move[], warnings: [] as string[] }
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value), removeItem: (key: string) => void storage.delete(key) }
  /** Load the page once more. */
  const load = ({ booted = false, readyState = "interactive" } = {}) => {
    const timers: { fn: () => void; ms: number }[] = []
    const body = new Element("body")
    let onError: ((event: { target: unknown }) => void) | undefined
    const context = vm.createContext({
      addEventListener(type: string, listener: (event: { target: unknown }) => void) {
        if (type === "error") onError = listener
      },
      location: {
        origin: ORIGIN,
        reload: () => void state.moves.push({ kind: "reload" }),
        replace: (to: string) => void state.moves.push({ kind: "replace", to }),
        assign: (to: string) => void state.moves.push({ kind: "assign", to }),
      },
      sessionStorage,
      navigator: { userActivation: { get isActive() { return state.active } } },
      console: { warn: (line: string) => void state.warnings.push(line) },
      document: {
        readyState,
        visibilityState: "visible",
        documentElement: { dataset: {} },
        body,
        createElement: (tag: string) => new Element(tag.toUpperCase()),
        addEventListener() {},
      },
      setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
      clearTimeout() {},
      Date: { now: () => state.now },
    })
    context.window = context
    context.frizzBooted = booted
    vm.runInContext(script!, context)
    const panel = () => body.children.find((child) => "data-frizz-stopped" in child.attributes)
    return {
      navigate: (to: string | null, options: { replace?: boolean; reason: string } = { reason: "a test" }) =>
        (context.frizzNavigate as (to: string | null, options: { replace?: boolean; reason: string }) => boolean)(to, options),
      fail: (target: Record<string, unknown>) => onError!({ target }),
      timers,
      panel: () => {
        const shown = panel()
        return shown ? { text: shown.querySelector("p")!.textContent, button: shown.querySelector("button")!.textContent, press: shown.querySelector("button")!.listeners.click! } : null
      },
      bootFailed: () => context.frizzBootFailed === true,
    }
  }
  return { state, storage, sessionStorage, load, tick: (ms: number) => void (state.now += ms) }
}

const STOPPED = { text: "Frizz stopped reloading this page by itself.", button: "Reload" }

test("a page that reloads itself on every load stops at the sixth, and says so", () => {
  // The shape of 2026-11-18: every load found a reason to reload, and a successful boot in between
  // reset the only backoff there was. Nothing here resets on boot.
  const { state, load, tick } = tab()
  const answers: boolean[] = []
  for (let n = 0; n < 8; n++) {
    tick(1_800)
    answers.push(load({ booted: true }).navigate(null))
  }
  assert.deepEqual(answers, [true, true, true, true, true, false, false, false])
  assert.equal(state.moves.length, 5)
  const page = load({ booted: true })
  page.navigate(null)
  assert.deepEqual({ text: page.panel()?.text, button: page.panel()?.button }, STOPPED)
  assert.match(state.warnings[0]!, /Frizz stopped this page reloading by itself \(a test\): 5 automatic loads/)
})

test("a slow loop stops too: twelve in half an hour", () => {
  const { state, load, tick } = tab()
  const answers: boolean[] = []
  for (let n = 0; n < 14; n++) {
    tick(2 * 60_000)
    answers.push(load().navigate("/project/a", { replace: true, reason: "a test" }))
  }
  assert.deepEqual(answers, [...Array(12).fill(true), false, false])
  assert.deepEqual(state.moves[0], { kind: "replace", to: "/project/a" })
})

test("counted moves age out, and the window is the last minute and the last half hour", () => {
  const { load, tick } = tab()
  for (let n = 0; n < 5; n++) assert.equal(load().navigate(null), true)
  assert.equal(load().navigate(null), false, "a sixth inside the minute")
  tick(61_000)
  assert.equal(load().navigate(null), true, "the minute has passed")
  tick(31 * 60_000)
  for (let n = 0; n < 5; n++) assert.equal(load().navigate(null), true, "half an hour on, nothing is left of the first six")
})

test("a move the browser sees a click behind is never refused, and clears the count", () => {
  const { state, storage, load } = tab()
  for (let n = 0; n < 5; n++) load().navigate(null)
  assert.equal(load().navigate(null), false)
  state.active = true
  assert.equal(load().navigate("/project/b", { reason: "a click" }), true)
  assert.equal(storage.get("frizz-auto-navigations"), "[]")
  state.active = false
  for (let n = 0; n < 5; n++) assert.equal(load().navigate(null), true, "the count started again from the click")
})

test("the panel's Reload button clears the count and reloads", () => {
  const { state, storage, load } = tab()
  for (let n = 0; n < 5; n++) load().navigate(null)
  const page = load()
  assert.equal(page.navigate(null), false)
  const before = state.moves.length
  page.panel()!.press()
  assert.equal(state.moves.length, before + 1)
  assert.deepEqual(state.moves.at(-1), { kind: "reload" })
  assert.equal(storage.get("frizz-auto-navigations"), "[]")
})

test("the recovery page counts on the same ledger, with the same limits", () => {
  // The launcher's recovery page sends the reader back to the board once it answers. The two pages share
  // one count, so a board that keeps handing the reader to the recovery page and back stops too.
  const { state, sessionStorage, load, tick } = tab()
  const recovery = vm.createContext({ sessionStorage, Date: { now: () => state.now } })
  vm.runInContext(NAVIGATION_LEDGER_CHECK, recovery)
  const mayMove = () => vm.runInContext("mayMove()", recovery) as boolean
  const answers: boolean[] = []
  for (let n = 0; n < 8; n++) {
    tick(1_500)
    answers.push(n % 2 === 0 ? load().navigate(null) : mayMove())
  }
  assert.deepEqual(answers, [true, true, true, true, true, false, false, false])

  // Same answers as the gate for the same history, over a schedule that crosses both windows.
  const gate = tab()
  const solo = tab()
  const soloRecovery = vm.createContext({ sessionStorage: solo.sessionStorage, Date: { now: () => solo.state.now } })
  vm.runInContext(NAVIGATION_LEDGER_CHECK, soloRecovery)
  for (const gap of [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 70_000, 90_000, 90_000, 90_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 31 * 60_000, 1_000]) {
    gate.tick(gap)
    solo.tick(gap)
    assert.equal(vm.runInContext("mayMove()", soloRecovery), gate.load().navigate(null), `after a ${gap}ms gap`)
  }
})

test("the stopped-page panel sits on LAYER.pageStopped", () => {
  assert.deepEqual([...html.matchAll(/z-index:(\d+)/g)].map((match) => Number(match[1])), [LAYER.pageStopped])
})

test("Cloudflare's analytics beacon, refused by the page's script policy, is not a failed boot", () => {
  // The tag Cloudflare injected into colinhacks.frizz.sh on 2026-11-18.
  const beacon = { tagName: "SCRIPT", type: "module", src: "https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" }
  for (const booted of [true, false]) {
    const page = tab().load({ booted })
    page.fail(beacon)
    assert.deepEqual({ timers: page.timers.length, panel: page.panel(), failed: page.bootFailed() }, { timers: 0, panel: null, failed: false })
  }
})

test("the board's own entry module, preload or stylesheet failing before boot reloads the page through the gate", () => {
  for (const target of [
    { tagName: "SCRIPT", type: "module", src: `${ORIGIN}/assets/index-CfY9LkDX.js` },
    { tagName: "LINK", rel: "modulepreload", href: `${ORIGIN}/assets/rolldown-runtime-Bh1tDfsg.js` },
    { tagName: "LINK", rel: "stylesheet", href: `${ORIGIN}/assets/index-DQKT4FDS.css` },
  ]) {
    const { state, storage, load } = tab()
    const page = load()
    page.fail(target)
    assert.equal(page.timers.length, 1)
    assert.equal(page.panel()?.text, "Frizz didn't finish loading. This page tries again on its own.")
    page.timers[0]!.fn()
    assert.deepEqual(state.moves, [{ kind: "reload" }])
    assert.equal(JSON.parse(storage.get("frizz-auto-navigations")!).length, 1, "the watchdog's reload is counted")
  }
})

test("nothing that fails once the board has booted, or from another origin, reloads it", () => {
  const quiet = (options: { booted?: boolean; readyState?: string }, target: Record<string, unknown>) => {
    const page = tab().load(options)
    page.fail(target)
    return page.timers.length === 0 && page.panel() === null
  }
  assert.ok(quiet({ booted: true }, { tagName: "SCRIPT", type: "module", src: `${ORIGIN}/assets/index-CfY9LkDX.js` }))
  assert.ok(quiet({ booted: true }, { tagName: "LINK", rel: "modulepreload", href: `${ORIGIN}/assets/a.js` }))
  assert.ok(quiet({ readyState: "complete" }, { tagName: "LINK", rel: "stylesheet", href: `${ORIGIN}/assets/a.css` }))
  assert.ok(quiet({}, { tagName: "LINK", rel: "stylesheet", href: "https://fonts.example/a.css" }))
  // A host that merely starts with the board's name is another origin.
  assert.ok(quiet({}, { tagName: "SCRIPT", type: "module", src: `${ORIGIN}.evil.example/x.js` }))
  // An image is never part of the boot, the board's own included.
  assert.ok(quiet({}, { tagName: "IMG", src: `${ORIGIN}/_frizz/project-icon?id=x` }))
})
