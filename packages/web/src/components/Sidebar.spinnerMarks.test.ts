import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@frizz/shared"
import { sessionIndicatorFor } from "./Sidebar.tsx"

// THE SPINNER IS THE FRAME, THE MARK INSIDE SAYS WHAT IS ALIVE (2026-09-20). The maintainer's rule for
// the Running band: "everything in the running rail should always have this spinner animation going —
// an empty square if the thread is actively running, a blue dot if there's a background shell, a solid,
// non-pulsing blue dot", and for a parent resting on its sub-agents "the three ellipses for the top-level
// parent agent with the spinner, and then the sub-agents can have their own spinners". A PR wait joins
// the family while its checks run (maintainer: it "should just stay in the running rail if it's actively
// waiting on checks") and drops back to the static octocat once they settle.
//
// AND SINCE 2026-10-05 AN AT-REST MARK SPINS ONLY ON A `working` REST (ThreadView.waitStatus, groups
// .restIsWorking). The dot and the octocat keep their glyphs everywhere; the frame around them moves only
// in the Running band. A queued rest stands still whatever is running behind it, and a `watching` rest
// stands still in Snoozed (maintainer 2026-10-03: a watcher "shouldn't show up as actively running").
//
// The spinner is identified by its `data-box-spinner` attribute — the one mark in the family that only the
// BoxSpinner renders — and the inner marks by lucide's stamped class or the dot's own class. Asserting
// on rendered markup rather than on element types is what pins the COMPOSITION: an ellipsis and a
// spinner both present is a different picture from either alone.

const base = {
  kind: "session",
  state: "open",
  status: "active",
  backend: "claude",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
  bgShells: [],
  watches: [],
} as unknown as ThreadView

const liveChild = [{ id: "a1", label: "review", startedAt: "2026-09-20T09:05:00.000Z", state: "running" as const }]
const liveShell = [{ label: "nub run dev", startedAt: "2026-09-20T09:02:00.000Z", state: "running" as const }]

const prWatch = (github?: Record<string, unknown>) => [{
  id: "wch_1",
  kind: "github" as const,
  target: "acme/app#391",
  state: "armed" as const,
  createdAt: "2026-09-20T09:00:00.000Z",
  ...(github ? { github: { checks: "running", running: 2, passed: 1, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "unknown", state: "open", polledAt: new Date().toISOString(), ...github } } : {}),
}]

const markup = (over: Partial<ThreadView>) => renderToStaticMarkup(sessionIndicatorFor({ ...base, ...over } as ThreadView).node)
const spins = (html: string) => html.includes("data-box-spinner")

test("own turn running: the empty spinner, nothing inside", () => {
  const html = markup({ runtime: "running" })
  assert.ok(spins(html), "the box traces")
  assert.ok(!html.includes("lucide-"), "and holds no glyph")
  assert.ok(!html.includes("frizz-rail-dot"), "and no dot")
})

test("a parent at rest with a sub-agent out: the ellipsis inside the spinner", () => {
  const html = markup({ subAgents: liveChild })
  assert.ok(spins(html), "the child's return will re-invoke it, so the box traces")
  assert.ok(html.includes("lucide-ellipsis"), "the parent itself has stopped, so the ellipsis sits inside")
  assert.equal(sessionIndicatorFor({ ...base, subAgents: liveChild } as ThreadView).tip, "At rest — waiting on its sub-agents")
})

test("a parent whose OWN turn runs keeps the empty spinner even with a child out", () => {
  const html = markup({ runtime: "running", subAgents: liveChild })
  assert.ok(spins(html))
  assert.ok(!html.includes("lucide-ellipsis"), "the ellipsis says 'at rest', and this thread is not")
})

// AN OPEN REGISTERED QUESTION ON A THREAD THAT KEPT WORKING (2026-10-08): the "?" inside the spinner,
// so the ask is visible from the rail rather than only from inside the thread.
const regQuestion = [{ id: "qst_ab12cd34", spec: { question: "Merge it?", kind: "question" as const }, askedAt: "2026-10-08T09:00:00.000Z" }]

test("running with an open question: the ? inside the spinner, outranking the sub-agent ellipsis", () => {
  const html = markup({ runtime: "running", questions: regQuestion })
  assert.ok(spins(html), "the worker kept going, so the box still traces")
  assert.ok(html.includes("frizz-rail-glyph") && html.includes(">?<"), "and the ? stands inside it")
  assert.equal(sessionIndicatorFor({ ...base, runtime: "running", questions: regQuestion } as ThreadView).tip, "Working — a question is waiting on your answer")
  const withChild = markup({ questions: regQuestion, subAgents: liveChild })
  assert.ok(spins(withChild) && withChild.includes(">?<"), "a parent resting on its sub-agents shows the ask")
  assert.ok(!withChild.includes("lucide-ellipsis"), "not the ellipsis — the ask is what the human can act on")
})

test("resting on a live background shell: the solid blue dot, inside the spinner only on a `working` rest", () => {
  const working = markup({ awaitingBackground: true, bgShells: liveShell, waitStatus: "working" })
  assert.ok(spins(working), "the work finishes by itself, so the box traces")
  assert.ok(working.includes("frizz-rail-dot"), "the dot says it is a shell")
  // The same shell behind a queued rest: the human has the thread, so nothing on its row moves.
  const queued = markup({ needsYou: true, awaitingBackground: true, bgShells: liveShell })
  assert.ok(queued.includes("frizz-rail-dot") && !spins(queued), "a queue row never spins")
  // …and behind a watcher, parked in Snoozed — fenced, and resting on a registered watch with no fence.
  const fenced = { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "23h" }, { kind: "status", value: "watching" }] }
  for (const lastFence of [fenced, undefined]) {
    const html = markup({ awaitingBackground: true, bgShells: liveShell, waitStatus: "watching", lastFence: lastFence as never })
    assert.ok(html.includes("frizz-rail-dot"), `${lastFence ? "fenced" : "unfenced"}: still the shell's mark`)
    assert.ok(!spins(html), `${lastFence ? "fenced" : "unfenced"}: still — the wait is on the world`)
    assert.ok(!html.includes("data-running-indicator"), "and it does not claim to be running")
  }
})

test("awaiting a PR: the octocat spins while checks run on a `working` rest, and stands still otherwise", () => {
  const running = markup({ needsYou: false, awaitingBackground: true, waitStatus: "working", watches: prWatch({}) as never })
  assert.ok(running.includes("lucide-github"), "GitHub's mark")
  assert.ok(spins(running), "inside the spinner while CI runs")
  // Checks running behind a QUEUED rest: the worker asked for the human, so the row stands still.
  const queued = markup({ needsYou: true, awaitingBackground: true, watches: prWatch({}) as never })
  assert.ok(queued.includes("lucide-github") && !spins(queued), "a queue row never spins, checks or no checks")
  assert.equal(sessionIndicatorFor({ ...base, needsYou: true, awaitingBackground: true, watches: prWatch({}) } as never).tip, "At rest — checks are running", "the tooltip still says the checks are going")
  // A reading nobody has renewed in an hour is not a claim about now (2026-11-06).
  const stale = prWatch({ polledAt: new Date(Date.now() - 3_600_000).toISOString() })
  assert.equal(sessionIndicatorFor({ ...base, needsYou: true, awaitingBackground: true, watches: stale } as never).tip, "At rest", "the tooltip stops saying so")
  for (const [what, github] of [
    ["passing", { checks: "passing", running: 0, passed: 3 }],
    ["failing", { checks: "failing", running: 0, failed: 1 }],
    ["merged", { checks: "running", running: 1, state: "merged" }],
  ] as const) {
    const settled = markup({ needsYou: true, watches: prWatch(github) as never })
    assert.ok(settled.includes("lucide-github"), `${what}: still GitHub's mark`)
    assert.ok(!spins(settled), `${what}: in the static box — the wait is on a person now`)
  }
  const unpolled = markup({ needsYou: true, watches: prWatch() as never })
  assert.ok(unpolled.includes("lucide-github") && !spins(unpolled), "an unpolled PR is not known to be moving")
})

test("gated CI reads `running` but does not spin — nothing moves until a maintainer approves", () => {
  const gated = markup({ needsYou: true, watches: prWatch({ running: 0, gated: 3, gating: ["Test Linux", "Test macOS", "Linters"] }) as never })
  assert.ok(gated.includes("lucide-github"))
  assert.ok(!spins(gated), "a spinner over a gate would promise motion for as long as nobody notices")
  const partlyGated = markup({ needsYou: false, awaitingBackground: true, waitStatus: "working", watches: prWatch({ running: 1, gated: 2, gating: ["Test macOS", "Linters"] }) as never })
  assert.ok(spins(partlyGated), "one live run beside the gate is real motion — the server reads it as working")
})

test("a plain rest keeps the static box with the ellipsis — no spinner, nothing of this thread is out", () => {
  const html = markup({ needsYou: true })
  assert.ok(html.includes("lucide-ellipsis"))
  assert.ok(!spins(html))
})
