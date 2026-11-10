import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@frizz/shared"
import { MobileThreadMark } from "./MobileBoard.tsx"
import { sessionIndicatorFor } from "./Sidebar.tsx"

const base = {
  id: "demo", kind: "session", backend: "claude", status: "active", state: "open",
  runtime: "turn-idle", needsYou: true, subAgents: [],
} as unknown as ThreadView
const pr = (running: number, gated = 0) => [{
  id: "demo-pr", kind: "github", target: "example/demo#1", state: "armed",
  github: { checks: running || gated ? "running" : "passing", running, gated, state: "open" },
}] as unknown as ThreadView["watches"]
const cases: { name: string; over: Partial<ThreadView>; glyph: string; spins: boolean }[] = [
  { name: "own running turn", over: { runtime: "running", needsYou: false }, glyph: 'viewBox="0 0 15 15"', spins: true },
  { name: "spawning", over: { runtime: "spawning", needsYou: false }, glyph: 'viewBox="0 0 15 15"', spins: true },
  { name: "live child", over: { needsYou: false, subAgents: [{ id: "child", kind: "AGENT", state: "running", label: "Sample child" }] as never }, glyph: "lucide-ellipsis", spins: true },
  { name: "background shell", over: { waitStatus: "working", needsYou: false, awaitingBackground: true, bgShells: [{ state: "running" }] as never }, glyph: "frizz-rail-dot", spins: true },
  { name: "queued background shell", over: { awaitingBackground: true, bgShells: [{ state: "running" }] as never }, glyph: "frizz-rail-dot", spins: false },
  { name: "running PR checks", over: { waitStatus: "working", needsYou: false, awaitingBackground: true, watches: pr(1) }, glyph: "lucide-github", spins: true },
  { name: "settled PR checks", over: { watches: pr(0) }, glyph: "lucide-github", spins: false },
  { name: "watching PR checks", over: { needsYou: false, waitStatus: "watching", awaitingBackground: true, watches: pr(1) }, glyph: "lucide-github", spins: false },
  { name: "approval-gated checks", over: { watches: pr(0, 1) }, glyph: "lucide-github", spins: false },
  { name: "plain rest", over: {}, glyph: "lucide-ellipsis", spins: false },
  { name: "question", over: { pendingQuestion: true }, glyph: ">?</span>", spins: false },
  { name: "permission prompt", over: { runtime: "perm-prompt" }, glyph: ">?</span>", spins: false },
  { name: "stalled", over: { runtime: "exited" }, glyph: ">!</span>", spins: false },
  { name: "done", over: { lastFence: { kind: "done", body: "Done", hints: [] } }, glyph: "lucide-check", spins: false },
  { name: "archived", over: { state: "archived" }, glyph: "lucide-check", spins: false },
  { name: "operator snooze", over: { needsYou: false, snoozedUntil: "2099-01-01T00:00:00Z" }, glyph: "lucide-alarm-clock", spins: false },
  { name: "worker timer", over: { awaitingBackground: true, watches: [{ kind: "timer", state: "armed", timer: { fireAt: "2099-01-01T00:00:00Z" } }] as never }, glyph: "lucide-hourglass", spins: false },
  { name: "usage limit", over: { runtime: "exited", limitPause: { backend: "claude", autoResume: true } as never }, glyph: "lucide-hourglass", spins: false },
]
for (const { name, over, glyph, spins } of cases) {
  test(`mobile matches desktop: ${name}`, () => {
    const t = { ...base, ...over }
    const desktop = renderToStaticMarkup(sessionIndicatorFor(t).node)
    const mobile = renderToStaticMarkup(createElement(MobileThreadMark, { t }))
    // Pin mobile's delegation to the desktop renderer, not a second copy of its glyph rules.
    assert.ok(mobile.includes(desktop), "the exact desktop glyph, geometry and tone")
    assert.ok(mobile.includes(glyph), "the expected state symbol")
    assert.equal(mobile.includes("data-box-spinner"), spins, "only moving work spins")
    assert.match(mobile, /role="img" aria-label="[^"]+"/, "the state is spoken on touch devices")
  })
}

for (const name of ["background shell", "running PR checks", "worker timer"]) {
  test(`mobile label omits worker prose: ${name}`, () => {
    const over = cases.find((c) => c.name === name)!.over
    const t = { ...base, ...over, lastFence: { kind: "awaiting", body: "Read the **sample report**.\n\nThen choose a colour.", hints: [] } } as ThreadView
    const tip = sessionIndicatorFor(t).tip!
    assert.ok(tip.includes("Read the **sample report**."), "negative control: desktop popover includes prose")
    const mobile = renderToStaticMarkup(createElement(MobileThreadMark, { t }))
    assert.ok(!mobile.includes("sample report"), "the row's accessible name must not start with the whole handoff")
    assert.ok(!mobile.includes("choose a colour"))
    assert.match(mobile, /aria-label="At rest/)
  })
}

test("mobile label keeps the state and park line", () => {
  const t = { ...base, runtime: "running", needsYou: false, snoozedUntil: "2099-01-01T00:00:00Z" } as ThreadView
  const tip = sessionIndicatorFor(t).tip!
  assert.match(tip, /^Working\nSnoozed until/)
  const mobile = renderToStaticMarkup(createElement(MobileThreadMark, { t }))
  assert.ok(mobile.includes(`aria-label="${tip}"`))
})
