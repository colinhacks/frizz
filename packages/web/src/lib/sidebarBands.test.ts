import assert from "node:assert/strict"
import test from "node:test"
import { bandScope, DEFAULT_BAND_FOLDS, parseBandFolds, readBandFolds, resetBandFolds, setBandFolded, toggleBandFold } from "./sidebarBands.ts"

// THE RAIL'S FOLDS, REMEMBERED PER PROJECT (maintainer 2026-11-14: "we need to remember persistently per
// project which rails are collapsed. running should be default open").

function withStorage(run: (stored: Map<string, string>) => Promise<void> | void) {
  return async () => {
    const stored = new Map<string, string>()
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
        removeItem: (k: string) => void stored.delete(k),
      },
    })
    try {
      await run(stored)
    } finally {
      for (const scope of ["", "alpha", "beta", "@console"]) resetBandFolds(scope)
      if (previous) Object.defineProperty(globalThis, "localStorage", previous)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  }
}

test("Running opens by default; Snoozed, Done and External open folded", () => {
  assert.deepEqual({ ...DEFAULT_BAND_FOLDS }, { running: false, snoozed: true, inactive: true, external: true })
  assert.deepEqual(parseBandFolds(null), DEFAULT_BAND_FOLDS)
})

test("the scope is the project the URL names, the Console, or the unprefixed launching project", () => {
  assert.equal(bandScope("/project/alpha"), "alpha")
  assert.equal(bandScope("/project/alpha/status/active"), "alpha")
  assert.equal(bandScope("/console"), "@console")
  assert.equal(bandScope("/"), "")
})

test("a fold is written to this project's own key, and another project keeps its defaults", withStorage((stored) => {
  setBandFolded("running", true, "alpha")
  toggleBandFold("snoozed", "alpha")
  assert.deepEqual(JSON.parse(stored.get("frizz.sidebarBands.v1:alpha")!), { running: true, snoozed: false, inactive: true, external: true })
  assert.deepEqual(readBandFolds("beta"), DEFAULT_BAND_FOLDS)
  assert.equal(stored.has("frizz.sidebarBands.v1:beta"), false, "reading a project writes nothing")
}))

test("a reload reads each project's folds back from storage", withStorage(async (stored) => {
  setBandFolded("running", true, "alpha")
  setBandFolded("external", false, "beta")
  // A fresh copy of the module is a fresh page: nothing in memory, only what storage holds.
  const reloaded = (await import(`./sidebarBands.ts?reload=${Date.now()}`)) as typeof import("./sidebarBands.ts")
  assert.notEqual(reloaded.readBandFolds, readBandFolds, "the import is a second instance of the module")
  assert.equal(reloaded.readBandFolds("alpha").running, true)
  assert.equal(reloaded.readBandFolds("beta").external, false)
  assert.equal(reloaded.readBandFolds("beta").running, false, "beta's Running keeps the default")
  assert.equal(stored.size, 2)
}))

test("a corrupt or partial entry falls back band by band", () => {
  assert.deepEqual(parseBandFolds("{not json"), DEFAULT_BAND_FOLDS)
  assert.deepEqual(parseBandFolds("[true]"), DEFAULT_BAND_FOLDS)
  assert.deepEqual(parseBandFolds(JSON.stringify({ running: true, snoozed: "no", pinned: false })), { ...DEFAULT_BAND_FOLDS, running: true })
})
