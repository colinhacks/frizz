import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { FOREGROUND_MARK_AFTER_MS, foregroundToolIsRunning, hasRunningToolIndicator, isPendingForegroundTool, isRunningOperation, liveBackgroundOperationState, runningOperations } from "../lib/operationIndicators.ts"

test("multiple simultaneous background operations get individual live indicators while terminal states do not", () => {
  const operations = [
    { label: "Inspect logs", state: "running" },
    { label: "Run regression suite", state: "running" },
    { label: "Watch CI", state: "running" },
    { label: "Tail build log", state: "running" },
    { label: "Prior investigation", state: "stale" },
    { label: "Completed build", state: "completed" },
    { label: "Failed build", state: "failed" },
    { label: "Cancelled build", state: "cancelled" },
  ]
  assert.deepEqual(runningOperations(operations).map((operation) => operation.label), ["Inspect logs", "Run regression suite", "Watch CI", "Tail build log"])
  for (const state of ["stale", "completed", "failed", "cancelled", undefined]) assert.equal(isRunningOperation(state), false)
})

test("tool disclosures pulse only while their own call is pending", () => {
  assert.equal(hasRunningToolIndicator("pending", "background"), true)
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(hasRunningToolIndicator(status), false)
  }
  assert.equal(hasRunningToolIndicator("pending", "unknown"), false)
})

// The two pending kinds are still told APART — a detached op has a real process record and marks itself
// instantly, a foreground one has only elapsed time — but they now converge on the SAME glyph, because a
// shell that is running right now is one fact to a reader (maintainer 2026-07-30).
test("a detached call marks instantly; a foreground one marks on elapsed time", () => {
  assert.equal(hasRunningToolIndicator("pending", "background"), true, "a detached op has a process to point at")
  assert.equal(hasRunningToolIndicator("pending"), false, "a foreground call is not a background job…")
  assert.equal(isPendingForegroundTool("pending"), true, "…it is the other pending kind")
  assert.equal(isPendingForegroundTool("pending", "background"), false, "a detached op is never both")

  // An orphaned Codex poll is a process frizz cannot place — it claims neither liveness nor progress.
  assert.equal(hasRunningToolIndicator("pending", "unknown"), false)
  assert.equal(isPendingForegroundTool("pending", "unknown"), false)

  for (const status of ["completed", "failed", "cancelled", undefined] as const) {
    assert.equal(isPendingForegroundTool(status), false, `${status} is not in progress`)
  }
})

// THE SPINNER IS GONE, and so is the static "finished" dot that briefly replaced the absent mark. Both
// were second opinions about liveness in a column that already has one, and both could be WRONG: the
// spinner rode the dispatch call's `pending`, which the server never clears when a task-notification
// fails to correlate, so it advertised long-dead children indefinitely (maintainer 2026-08-01: it
// "should not show up under any circumstances"; and "remove the status indicator entirely for a
// sub-agent or background shell that has completed"). This pins their ABSENCE, because the failure mode
// is somebody reintroducing a glyph that cannot go false.
test("no second liveness glyph exists — the left-hand mark is the only one", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.doesNotMatch(css, /^\.frizz-tool-spinner \{/m, "the dispatch spinner must stay removed")
  assert.doesNotMatch(css, /@keyframes frizz-tool-spin\b/, "…along with its animation")
  assert.doesNotMatch(css, /^\.frizz-live-dot-done/m, "a completed op is marked by the ABSENCE of a mark")
  // The genuinely-live glyphs remain: pulsing for running, breathing for alive-but-quiet.
  assert.match(css, /\.frizz-live-dot \{[^}]*animation: frizz-live-pulse/)
  assert.match(css, /\.frizz-live-dot-quiet \{[^}]*animation: frizz-live-breathe/)
})

// THE THRESHOLD is a noise filter: nearly every call resolves in well under a second, and marking those
// would strobe a dot for every Read and Grep in a batch.
test("a foreground call earns the mark only once it has been running long enough", () => {
  const t0 = Date.parse("2026-07-30T04:00:00.000Z")
  const at = new Date(t0).toISOString()
  const run = (elapsed: number, status: "pending" | "completed" = "pending", bg?: "background" | "unknown") =>
    foregroundToolIsRunning(status, bg, at, t0 + elapsed)

  assert.equal(run(0), false, "a call that just started draws nothing")
  assert.equal(run(FOREGROUND_MARK_AFTER_MS - 1), false, "…and still nothing a millisecond short")
  assert.equal(run(FOREGROUND_MARK_AFTER_MS), true, "at the threshold it marks")
  assert.equal(run(60_000), true, "and stays marked for as long as it runs")

  assert.equal(run(60_000, "completed"), false, "a resolved call is never live, however long it took")
  assert.equal(run(60_000, "pending", "background"), false, "a detached op goes through the other predicate")
  assert.equal(run(60_000, "pending", "unknown"), false, "an orphaned poll claims nothing")

  // No clock at all (a pre-restart server projects no message `at`): mark it. The threshold cannot be
  // evaluated, and hiding a live command is the worse failure of the two.
  assert.equal(foregroundToolIsRunning("pending", undefined, undefined, t0), true)
  assert.equal(foregroundToolIsRunning("pending", undefined, "not-a-date", t0), true)
})

test("live background telemetry overrides a completed launch wrapper without borrowing another operation's state", () => {
  const operations = [
    { label: "Watch CI", state: "running" as const },
    { label: "Tail build log", state: "stale" as const },
  ]
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Watch CI" }, operations), "running")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", detail: "Tail build log" }, operations), "stale")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Unrelated shell" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ backgroundState: "unknown", desc: "Watch CI" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ name: "Interrupt process", backgroundState: "background", detail: "session 35985" }, operations), undefined)
  // A shell the operator × killed keeps `backgroundState` (that is what keeps its card a background card
  // rather than tool-run filler) — so the label match alone would hand a relaunched "Watch CI" its
  // liveness right back. `cancelled` is dead, whatever else is running under the same description.
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Watch CI", status: "cancelled" }, operations), undefined)
  // …while a returned launch wrapper still borrows its detached watcher's state, which is the whole point.
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Watch CI", status: "completed" }, operations), "running")
})

test("reduced motion keeps live work visible as a static ring in its own hue", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  // The static ring is recolored through the same --live-dot variable as the animated dot, so a
  // reduced-motion shell keeps its blue ring and a sub-agent its accent-yellow one.
  assert.match(css, /\.frizz-live-dot \{ animation: none; background: transparent; border: 2px solid var\(--live-dot\); box-shadow: none; \}/)
})

test("running shells pulse blue and running sub-agents pulse the accent-yellow", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // A distinct blue token, kept separate from the accent.
  const palette = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  assert.match(palette, /--color-shell:\s*var\(--frizz-shell\);/)
  assert.match(palette, /--frizz-shell:\s*#4a9eff;/)
  // The live dot defaults to the accent-yellow (sub-agent) and the --shell modifier swaps in the blue.
  assert.match(css, /\.frizz-live-dot \{[^}]*--live-dot: var\(--color-accent\)/)
  assert.match(css, /\.frizz-live-dot--shell \{ --live-dot: var\(--color-shell\); \}/)
  assert.match(css, /\.frizz-live-dot--agent \{ --live-dot: var\(--color-accent\); \}/)
  // The quiet-but-alive shell dot follows the shell blue too.
  assert.match(css, /\.frizz-live-dot-quiet--shell \{ --live-dot: var\(--color-shell\); \}/)
})

test("a quiet-but-alive background shell breathes, and stays visible as a static ring under reduced motion", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // It must ANIMATE (breathe) rather than sit as a dead gray dot…
  assert.match(css, /\.frizz-live-dot-quiet \{[^}]*animation: frizz-live-breathe/)
  assert.match(css, /@keyframes frizz-live-breathe/)
  // …and degrade to a static ring (never fully disappear) when motion is reduced.
  assert.match(css, /\.frizz-live-dot-quiet \{ animation: none;[^}]*border: 1\.5px solid/)
})
