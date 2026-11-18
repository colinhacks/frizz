import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"

// The boot watchdog is the second inline script in index.html. It runs here as written, against a stand-in
// window, so what it counts as a failed boot is pinned on the shipped text rather than on a copy.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
const watchdog = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1]?.[1]
assert.ok(watchdog?.includes("frizz-boot-retry"), "the second inline script is the boot watchdog")

const ORIGIN = "https://colinhacks.frizz.sh"

/** A page with the watchdog installed; `fail` fires the capture-phase error event a failed load raises. */
function page({ booted = false, readyState = "interactive" } = {}) {
  const timers: number[] = []
  let panels = 0
  let onError: ((event: { target: unknown }) => void) | undefined
  const element = () => ({ style: {}, append() {}, addEventListener() {} })
  const storage = new Map<string, string>()
  const context = vm.createContext({
    addEventListener(type: string, listener: (event: { target: unknown }) => void) {
      if (type === "error") onError = listener
    },
    location: { origin: ORIGIN, reload() {} },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    document: {
      readyState,
      visibilityState: "visible",
      documentElement: { dataset: {} },
      body: { append: () => panels++ },
      createElement: element,
      addEventListener() {},
    },
    setTimeout: (_: unknown, ms: number) => timers.push(ms),
    clearTimeout() {},
  })
  context.window = context
  context.frizzBooted = booted
  vm.runInContext(watchdog!, context)
  return {
    fail(target: Record<string, unknown>) {
      onError!({ target })
      return { reloads: timers.length, panels, failed: context.frizzBootFailed === true }
    },
  }
}

const quiet = { reloads: 0, panels: 0, failed: false }

test("Cloudflare's analytics beacon, refused by the page's script policy, is not a failed boot", () => {
  // The tag Cloudflare injected into colinhacks.frizz.sh on 2026-11-18. The board reloaded itself every
  // two seconds for as long as it was open, because main.tsx clears the backoff each time it boots.
  const beacon = { tagName: "SCRIPT", type: "module", src: "https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" }
  assert.deepEqual(page({ booted: true }).fail(beacon), quiet)
  // The refusal can land before the entry module has run, too.
  assert.deepEqual(page({ booted: false }).fail(beacon), quiet)
})

test("the board's own entry module, preload or stylesheet failing before boot reloads the page", () => {
  const reloading = { reloads: 1, panels: 1, failed: true }
  assert.deepEqual(page().fail({ tagName: "SCRIPT", type: "module", src: `${ORIGIN}/assets/index-CfY9LkDX.js` }), reloading)
  assert.deepEqual(page().fail({ tagName: "LINK", rel: "modulepreload", href: `${ORIGIN}/assets/rolldown-runtime-Bh1tDfsg.js` }), reloading)
  assert.deepEqual(page().fail({ tagName: "LINK", rel: "stylesheet", href: `${ORIGIN}/assets/index-DQKT4FDS.css` }), reloading)
})

test("nothing that fails once the board has booted, or from another origin, reloads it", () => {
  assert.deepEqual(page({ booted: true }).fail({ tagName: "SCRIPT", type: "module", src: `${ORIGIN}/assets/index-CfY9LkDX.js` }), quiet)
  assert.deepEqual(page({ booted: true }).fail({ tagName: "LINK", rel: "modulepreload", href: `${ORIGIN}/assets/a.js` }), quiet)
  assert.deepEqual(page({ readyState: "complete" }).fail({ tagName: "LINK", rel: "stylesheet", href: `${ORIGIN}/assets/a.css` }), quiet)
  assert.deepEqual(page().fail({ tagName: "LINK", rel: "stylesheet", href: "https://fonts.example/a.css" }), quiet)
  // A host that merely starts with the board's name is another origin.
  assert.deepEqual(page().fail({ tagName: "SCRIPT", type: "module", src: `${ORIGIN}.evil.example/x.js` }), quiet)
  // An image is never part of the boot, the board's own included.
  assert.deepEqual(page().fail({ tagName: "IMG", src: `${ORIGIN}/_frizz/project-icon?id=x` }), quiet)
})
