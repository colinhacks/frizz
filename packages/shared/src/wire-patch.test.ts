import { test } from "node:test"
import assert from "node:assert/strict"
import { applyJsonPatch, applyWindowSplice, diffJson, windowSplice } from "./wire-patch.ts"

// A small deterministic PRNG, so a failure names a seed that reproduces it.
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

function randomValue(r: () => number, depth: number): unknown {
  const k = r()
  if (depth <= 0 || k < 0.35) {
    const leaf = [() => Math.floor(r() * 5), () => `s${Math.floor(r() * 4)}`, () => r() < 0.5, () => null, () => undefined, () => NaN]
    return leaf[Math.floor(r() * leaf.length)]!()
  }
  if (k < 0.65) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth - 1))
  const o: Record<string, unknown> = {}
  for (let i = 0, n = Math.floor(r() * 5); i < n; i++) o[`k${Math.floor(r() * 6)}`] = randomValue(r, depth - 1)
  return o
}

// Mutate a copy a little, the way a thread view changes between two deltas.
function nudge(r: () => number, v: unknown, depth: number): unknown {
  if (r() < 0.25 || depth <= 0) return r() < 0.5 ? v : randomValue(r, 2)
  if (Array.isArray(v)) return r() < 0.2 ? [...v, randomValue(r, 1)] : v.map((x) => nudge(r, x, depth - 1))
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = { ...(v as object) }
    for (const key of Object.keys(o)) if (r() < 0.4) o[key] = nudge(r, o[key], depth - 1)
    if (r() < 0.3) o[`k${Math.floor(r() * 8)}`] = randomValue(r, 2)
    if (r() < 0.2) delete o[Object.keys(o)[0] ?? ""]
    return o
  }
  return randomValue(r, 2)
}

const asJson = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

test("diffJson + applyJsonPatch rebuild the new value exactly as JSON, over random values", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed)
    const prev = { id: "t", body: randomValue(r, 4) }
    const nudged = nudge(r, prev, 5)
    const next = { ...(nudged && typeof nudged === "object" && !Array.isArray(nudged) ? nudged : { body: nudged }), id: "t" }
    const base = asJson(prev)
    const frozen = JSON.stringify(base)
    const ops = asJson(diffJson(prev, next)) // the ops as they cross the wire
    const rebuilt = applyJsonPatch(base, ops)
    assert.deepEqual(rebuilt, asJson(next), `seed ${seed}`)
    assert.equal(JSON.stringify(base), frozen, `seed ${seed}: the base is never written`)
  }
})

test("diffJson sends only what moved, and shares everything else with the base", () => {
  const prev = { id: "a", agents: [{ id: 1, at: "t1" }, { id: 2, at: "t1" }], title: "x", gone: 1 }
  const next = { id: "a", agents: [{ id: 1, at: "t1" }, { id: 2, at: "t2" }], title: "x", liveTool: { name: "Bash" }, gone: undefined }
  const ops = diffJson(prev, next)
  assert.deepEqual(ops, [[["agents", 1, "at"], "t2"], [["liveTool"], { name: "Bash" }], [["gone"]]])
  const rebuilt = applyJsonPatch(prev, ops) as typeof prev
  assert.equal(rebuilt.agents[0], prev.agents[0], "an untouched branch is the base's own object")
  assert.notEqual(rebuilt.agents, prev.agents)
  assert.deepEqual(diffJson(prev, { ...prev }), [], "an equal value has no edits")
})

test("applyJsonPatch refuses a patch that was not made against its base", () => {
  assert.throws(() => applyJsonPatch({ a: 1 }, [[["a", "b", "c"], 2]]))
  assert.throws(() => applyJsonPatch({ a: [1] }, [[["a", 4], 2]]))
  assert.throws(() => applyJsonPatch({ a: [1] }, [[["a", 0]]]))
})

test("windowSplice rebuilds the new window exactly, for slides, edits and replacements", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed)
    const prev = Array.from({ length: Math.floor(r() * 30) }, () => `m${Math.floor(r() * 12)}`)
    const start = Math.floor(r() * (prev.length + 1))
    const next = prev.slice(start)
    if (r() < 0.5 && next.length) next[next.length - 1] = "edited"
    for (let i = 0, n = Math.floor(r() * 4); i < n; i++) next.push(`new${i}`)
    if (r() < 0.1) next.splice(0, next.length, "unrelated")
    const splice = windowSplice(prev, next)
    assert.deepEqual(applyWindowSplice(prev, splice, next.slice(splice.keep)), next, `seed ${seed}`)
  }
  assert.deepEqual(windowSplice(["a", "b", "c"], ["b", "c", "d"]), { drop: 1, keep: 2 })
  assert.deepEqual(windowSplice(["a", "b"], ["x"]), { drop: 2, keep: 0 })
})
