import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

// What a real browser runs is pinned by components/offscreenPause.e2e.test.ts. These pin the parts a
// browser cannot catch going missing: the observer's bookkeeping, and that every live dot and spinner in
// the product is drawn through the one component that wires it.

type Entry = { target: FakeElement; isIntersecting: boolean }
class FakeElement {
  attrs = new Set<string>()
  toggleAttribute(name: string, on: boolean) { if (on) this.attrs.add(name); else this.attrs.delete(name) }
  removeAttribute(name: string) { this.attrs.delete(name) }
}
const observers: FakeObserver[] = []
class FakeObserver {
  observed = new Set<FakeElement>()
  constructor(readonly callback: (entries: Entry[]) => void) { observers.push(this) }
  observe(el: FakeElement) { this.observed.add(el) }
  unobserve(el: FakeElement) { this.observed.delete(el) }
}

test("one observer marks a dot off screen while it is out of view, and forgets it on unmount", async () => {
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver
  const { pauseWhileOffscreen } = await import("./offscreenPause.ts")
  const a = new FakeElement()
  const b = new FakeElement()
  const cleanupA = pauseWhileOffscreen(a as unknown as Element)
  const cleanupB = pauseWhileOffscreen(b as unknown as Element)
  assert.equal(observers.length, 1, "every dot on the page shares one observer")
  const [io] = observers
  assert.deepEqual([...io.observed], [a, b])

  io.callback([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }])
  assert.ok(a.attrs.has("data-offscreen"), "out of view: paused")
  assert.ok(!b.attrs.has("data-offscreen"), "in view: runs")
  io.callback([{ target: a, isIntersecting: true }])
  assert.ok(!a.attrs.has("data-offscreen"), "scrolled back in: runs again")

  io.callback([{ target: b, isIntersecting: false }])
  cleanupB?.()
  assert.deepEqual([...io.observed], [a], "an unmounted dot is no longer watched")
  assert.ok(!b.attrs.has("data-offscreen"), "and carries no stale mark")
  cleanupA?.()
  assert.equal(pauseWhileOffscreen(null), undefined, "React's null call is a no-op")
})

test("every live dot and box spinner in the product goes through the component that pauses it", () => {
  const components = new URL("../components/", import.meta.url)
  const sources = readdirSync(components).filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  for (const file of sources) {
    const source = readFileSync(new URL(file, components), "utf8")
    if (file !== "LiveDot.tsx") assert.doesNotMatch(source, /["`]frizz-live-dot[ "`]/, `${file} draws a live dot by hand; use <LiveDot>, which pauses it off screen`)
    assert.doesNotMatch(source, /<animate\s+attributeName/, `${file} uses SMIL, which Chrome ticks every frame on the main thread, on screen or not`)
  }
  assert.match(readFileSync(new URL("LiveDot.tsx", components), "utf8"), /ref=\{pauseWhileOffscreen\}/)
  assert.match(readFileSync(new URL("BoxSpinner.tsx", components), "utf8"), /<svg ref=\{pauseWhileOffscreen\}/)
})

test("an element marked off screen pauses every layer of the dot and the spinner's segment", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.match(css, /\.frizz-live-dot\[data-offscreen\],\s*\.frizz-live-dot\[data-offscreen\]::before,\s*\.frizz-live-dot\[data-offscreen\]::after \{\s*animation-play-state: paused;\s*\}/)
  assert.match(css, /\[data-offscreen\] \.frizz-box-spinner-lap \{\s*animation-play-state: paused;\s*\}/)
  // The spinner's lap is the SMIL animation it replaced, unchanged: 50 → 0, linear, 1.1s, forever.
  assert.match(css, /\.frizz-box-spinner-lap \{\s*animation: frizz-box-spinner-lap 1\.1s linear infinite;\s*\}/)
  assert.match(css, /@keyframes frizz-box-spinner-lap \{\s*from \{ stroke-dashoffset: 50; \}\s*to \{ stroke-dashoffset: 0; \}\s*\}/)
})
