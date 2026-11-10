import { test } from "node:test"
import assert from "node:assert/strict"
import { stepOffStaleLayerEntries } from "./backDismiss.ts"

// A history whose entries are just states, with a real popstate dispatch on every back(). Enough to
// watch the boot step-off walk; the browser half is mobileThreadBack.e2e.test.ts.
function fakeHistory(entries: unknown[]) {
  const globals = globalThis as typeof globalThis & { history?: History; window?: Window }
  const previous = { history: globals.history, window: globals.window }
  let index = entries.length - 1
  const listeners = new Set<() => void>()
  let backs = 0
  globals.window = {
    addEventListener: (type: string, fn: () => void) => { if (type === "popstate") listeners.add(fn) },
    removeEventListener: (type: string, fn: () => void) => { if (type === "popstate") listeners.delete(fn) },
  } as unknown as typeof window
  globals.history = {
    get state() { return entries[index] },
    back: () => {
      backs++
      // Async, as in a browser: the pop lands a task later.
      setTimeout(() => {
        index = Math.max(0, index - 1)
        for (const fn of [...listeners]) fn()
      }, 0)
    },
  } as unknown as History
  return {
    get index() { return index },
    get backs() { return backs },
    get listeners() { return listeners.size },
    restore: () => Object.assign(globals, previous),
  }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
const router = (idx: number) => ({ usr: null, key: `k${idx}`, idx })

test("a document that boots on a stale layer entry steps off it, and off every stale one under it", async () => {
  // board, thread, then two layers a previous document pushed (a reader over a reader): tokens from its clock.
  const h = fakeHistory([router(0), router(1), { ...router(1), frizzLayer: 5 }, { ...router(1), frizzLayer: 6 }])
  try {
    stepOffStaleLayerEntries()
    await settle()
    assert.equal(h.index, 1, "lands on the router's own thread entry")
    assert.equal(h.backs, 2)
    assert.equal(h.listeners, 0, "the walk stops listening once it is off")
  } finally {
    h.restore()
  }
})

test("a document that boots on the router's own entry does nothing", async () => {
  const h = fakeHistory([router(0), router(1)])
  try {
    stepOffStaleLayerEntries()
    await settle()
    assert.equal(h.index, 1)
    assert.equal(h.backs, 0)
    assert.equal(h.listeners, 0)
  } finally {
    h.restore()
  }
})

test("a layer token this document minted is never stepped off", async () => {
  // Every token this document mints starts from its own load-time clock, so one at or above now is live.
  const h = fakeHistory([router(0), router(1), { ...router(1), frizzLayer: Date.now() + 60_000 }])
  try {
    stepOffStaleLayerEntries()
    await settle()
    assert.equal(h.index, 2)
    assert.equal(h.backs, 0)
  } finally {
    h.restore()
  }
})
