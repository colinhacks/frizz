import assert from "node:assert/strict"
import { test } from "node:test"
import { lazyModule } from "./lazyModule.ts"

/** A loader that fails the first `failures` times it is asked, and counts every ask. */
function flaky(failures: number) {
  const state = { asked: 0, waited: [] as number[] }
  const load = async () => {
    state.asked++
    if (state.asked <= failures) throw new Error(`load ${state.asked} failed`)
    return { loaded: state.asked }
  }
  const wait = async (ms: number) => { state.waited.push(ms) }
  return { state, load, wait }
}

test("a module is loaded once, however many callers ask", async () => {
  const { state, load, wait } = flaky(0)
  const get = lazyModule(load, { wait })
  const [a, b] = await Promise.all([get(), get()])
  assert.equal(a, b)
  assert.equal(await get(), a)
  assert.equal(state.asked, 1)
  assert.deepEqual(state.waited, [])
})

test("a load that fails is tried once more, after the pause, for the callers already waiting", async () => {
  const { state, load, wait } = flaky(1)
  const get = lazyModule(load, { wait, retryAfterMs: 250 })
  const [a, b] = await Promise.all([get(), get()])
  assert.deepEqual(a, { loaded: 2 })
  assert.equal(a, b)
  assert.deepEqual(state.waited, [250])
  // The module that arrived is kept like any other.
  assert.equal(await get(), a)
  assert.equal(state.asked, 2)
})

test("a load that fails twice is handed to its callers and not kept", async () => {
  const { state, load, wait } = flaky(2)
  const get = lazyModule(load, { wait })
  await assert.rejects(get(), /load 2 failed/)
  assert.equal(state.asked, 2)
  // The cache this replaced (`held ??= import(…)`) answered every later caller with that same failure.
  assert.deepEqual(await get(), { loaded: 3 })
  assert.equal(state.asked, 3)
})

test("callers that arrive while a load is failing share its one retry", async () => {
  const { state, load } = flaky(1)
  let release = () => {}
  const get = lazyModule(load, { wait: () => new Promise<void>((resolve) => { release = resolve }) })
  const first = get()
  // Let the first load fail and reach its pause.
  await new Promise((resolve) => setImmediate(resolve))
  const second = get()
  assert.equal(state.asked, 1)
  release()
  assert.deepEqual(await first, { loaded: 2 })
  assert.equal(await second, await first)
  assert.equal(state.asked, 2)
})
