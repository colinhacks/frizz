import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { agentSuffix, handoffLine, liveAgentCount, rowSecondLine, wakeAt } from "./mobileBoardRow.ts"

const now = Date.parse("2026-09-30T12:00:00.000Z")
const ahead = (ms: number) => new Date(now + ms).toISOString()

function thread(over: Partial<ThreadView>): ThreadView {
  return { id: "t", title: "T", runtime: "turn-idle", kind: "session", subAgents: [], watches: [], questions: [], ...over } as ThreadView
}

test("a handoff's leading bold phrase is its verdict, and markdown reads as prose", () => {
  assert.deepEqual(handoffLine("**Fixed** — the arm builds on Node 24, `e41c2a0` on main"), {
    lead: "Fixed",
    text: "— the arm builds on Node 24, e41c2a0 on main",
  })
  assert.deepEqual(handoffLine("## Waiting on CI for [#966](https://github.com/x/y/pull/966)"), { text: "Waiting on CI for #966" })
  assert.deepEqual(handoffLine("- first bullet *soft* here"), { text: "first bullet soft here" })
  assert.deepEqual(handoffLine("**Done.**"), { text: "Done." })
  // The tailer collapses newlines, so the first line ends where the next block would have started.
  assert.deepEqual(handoffLine("Landed the fix. ```done - Fixed the rounding. - Added a test. ```"), { text: "Landed the fix." })
  assert.deepEqual(handoffLine("```done - The context meter now reads codex token counts. - Tests green. ```"), { text: "The context meter now reads codex token counts." })
  assert.deepEqual(handoffLine("**Fixed** — the rail holds. - ws.ts no longer clears it."), { lead: "Fixed", text: "— the rail holds." })
  assert.deepEqual(handoffLine("First line\nsecond line"), { text: "First line" })
  assert.equal(handoffLine("   "), null)
  assert.equal(handoffLine(undefined), null)
  // An EXACT line (the server's `lastAssistantLine`) is never cut: a " - " inside it is prose.
  assert.deepEqual(handoffLine("**Fixed** — the rail holds - ws.ts no longer clears it.", true), { lead: "Fixed", text: "— the rail holds - ws.ts no longer clears it." })
})

test("a rested row reads the handoff's real first line, and the preview only when there is none", () => {
  const t = thread({
    lastAssistantLine: "**Fixed** — the arm builds on Node 24 - `e41c2a0` on main",
    lastAssistant: "**Fixed** — the arm builds on Node 24 - `e41c2a0` on main - Added a test.",
  })
  assert.deepEqual(rowSecondLine(t, "rest", false), { lead: "Fixed", text: "— the arm builds on Node 24 - e41c2a0 on main" })
  // A first line that is only a fence opener strips to nothing: the preview's approximation stands in.
  const fenced = thread({ lastAssistantLine: "```done", lastAssistant: "```done - The meter reads codex tokens. - Tests green. ```" })
  assert.deepEqual(rowSecondLine(fenced, "rest", false), { text: "The meter reads codex tokens." })
  // A done fence that opens on `title:` (2026-10-13): the row reads the worker's heading, never the
  // preview's "title: … ---", and without a title it reads the ledger's first line as before.
  const titled = thread({
    lastFence: { kind: "done", body: "- The meter reads codex tokens.\n- Tests green.", hints: [{ kind: "title", value: "Codex `token` counts in the meter" }] },
    lastAssistantLine: "```done",
    lastAssistant: "```done title: Codex `token` counts in the meter --- - The meter reads codex tokens. - Tests green. ```",
  })
  assert.deepEqual(rowSecondLine(titled, "rest", false), { text: "Codex token counts in the meter" })
  assert.deepEqual(rowSecondLine({ ...titled, lastFence: { ...titled.lastFence!, hints: [] } }, "rest", false), { text: "The meter reads codex tokens." })
})

test("an ask's line is its question, or the count when there are several", () => {
  const one = thread({ questions: [{ id: "q1", askedAt: ahead(0), spec: { question: "SQLite or a JSON file?\n\nMore context below.", kind: "question" } }] as ThreadView["questions"] })
  assert.deepEqual(rowSecondLine(one, "needs-input", false), { text: "SQLite or a JSON file?" })
  const two = thread({ questions: [
    { id: "q1", askedAt: ahead(0), spec: { question: "A?", kind: "question" } },
    { id: "q2", askedAt: ahead(0), spec: { question: "B?", kind: "question" } },
  ] as ThreadView["questions"] })
  assert.deepEqual(rowSecondLine(two, "needs-input", false), { text: "2 questions" })
  const native = thread({ pendingAsk: { questions: [{ question: "Post it?", header: "", multiSelect: false, options: [] }] } as unknown as ThreadView["pendingAsk"] })
  assert.deepEqual(rowSecondLine(native, "needs-input", false), { text: "Post it?" })
  // No question text anywhere: the handoff says what was asked.
  assert.deepEqual(rowSecondLine(thread({ humanBlocked: true, lastAssistant: "Should I merge?" }), "needs-input", false), { text: "Should I merge?" })
})

test("a running row names the call it is waiting on, labelled as the chat's working indicator labels it", () => {
  const bash = thread({ liveTool: { name: "Bash", desc: "Running the focused tests", detail: "nub --test" }, activity: "Legacy gerund", lastAssistant: "Said something" })
  assert.deepEqual(rowSecondLine(bash, "working", true), { text: "Running the focused tests" })
  // An imperative description reads as the gerund, exactly as the transcript's shimmer shows it.
  assert.deepEqual(rowSecondLine(thread({ liveTool: { name: "Bash", desc: "Run the focused tests" } }), "working", true), { text: "Running the focused tests" })
  // A call with no description is named by its target, project-relative.
  const read = thread({ liveTool: { name: "Read", detail: "/repo/.github/workflows/ci.yml" } })
  assert.deepEqual(rowSecondLine(read, "working", true, now, "/repo"), { text: "Reading .github/workflows/ci.yml" })
  // At rest the live tool says nothing, whatever the view still carries.
  assert.deepEqual(rowSecondLine(thread({ ...bash, lastAssistantLine: "Done." }), "rest", false), { text: "Done." })
})

test("a running row reads its activity, and a rested row its handoff", () => {
  const t = thread({ activity: "Running the focused tests", lastAssistant: "**Fixed** — done" })
  assert.deepEqual(rowSecondLine(t, "working", true), { text: "Running the focused tests" })
  // A session thread carries no gerund: the newest thing its agent said is the live line.
  assert.deepEqual(rowSecondLine(thread({ lastAssistant: "Measuring the payload first." }), "working", true), { text: "Measuring the payload first." })
  assert.equal(rowSecondLine(thread({}), "working", true), null)
  assert.deepEqual(rowSecondLine(t, "rest", false), { lead: "Fixed", text: "— done" })
  // Nothing written yet: the activity is better than an empty line.
  assert.deepEqual(rowSecondLine(thread({ activity: "Reading ci.yml" }), "rest", false), { text: "Reading ci.yml" })
})

// A QUIET PARK IS THE FENCE ALONE (`status: working` or `watching`, 2026-10-05), so the newest thing the
// agent said is YAML. The phone row names the wait instead — moving or parked — and the fence's own prose,
// or prose the worker wrote before it, still wins when there is any.
test("a quiet park's line names its wait, never its YAML", () => {
  const fence = { kind: "awaiting" as const, body: "", hints: [{ kind: "shell" as const, value: "bopxuo7e1" }, { kind: "status" as const, value: "working" }, { kind: "for" as const, value: "30m" }] }
  // The real shape the board sent for a worker that rested with the fence alone (stack run 2026-10-05).
  const quiet = thread({ lastFence: fence, lastAssistantLine: "```awaiting", lastAssistant: "```awaiting shells: [bopxuo7e1] status: working for: 30m ```" })
  assert.deepEqual(rowSecondLine(quiet, "background", true), { text: "Waiting on a background shell" })
  assert.deepEqual(rowSecondLine(quiet, "snoozed", false, now), { text: "Waiting on a background shell" })
  const withProse = thread({ ...quiet, lastFence: { ...fence, body: "the bench is on arm 3 of 3." } })
  assert.deepEqual(rowSecondLine(withProse, "background", true), { text: "The bench is on arm 3 of 3." })
  const said = thread({ lastFence: fence, lastAssistantLine: "Started the bench.", lastAssistant: "Started the bench. ```awaiting shells: [bopxuo7e1] status: working for: 30m ```" })
  assert.deepEqual(rowSecondLine(said, "background", true), { text: "Started the bench." })
})

test("a row resting on a monitor names it, fenced or not", () => {
  const monitor = { id: "command:t:cmw_1", kind: "command", target: "cmw_1", state: "armed", createdAt: ahead(0), command: { command: "tail -F app.log", every: "0s", expiresAt: ahead(86_400_000), runs: 0, monitor: { description: "Errors in app.log", events: 1 } } } as ThreadView["watches"][number]
  const fenced = thread({ watches: [monitor], lastFence: { kind: "awaiting", body: "", hints: [{ kind: "command", value: "cmw_1" }, { kind: "status", value: "watching" }, { kind: "for", value: "1d" }] }, lastAssistantLine: "```awaiting" })
  assert.deepEqual(rowSecondLine(fenced, "snoozed", false, now), { text: "Monitor: Errors in app.log" })
  const unfenced = thread({ watches: [monitor], lastAssistantLine: "Registered the monitor." })
  assert.deepEqual(rowSecondLine(unfenced, "monitor", false, now), { text: "Monitor: Errors in app.log" })
})

test("a parked row says who parked it, and when it wakes", () => {
  const snoozed = thread({ snoozedUntil: ahead(3 * 3_600_000), lastAssistant: "whatever" })
  assert.deepEqual(rowSecondLine(snoozed, "snoozed", false, now), { text: "Snoozed by you" })
  assert.equal(wakeAt(snoozed, now), snoozed.snoozedUntil)
  const timer = thread({
    watches: [
      { id: "w1", kind: "timer", target: "tmr_1", state: "armed", createdAt: ahead(0), timer: { fireAt: ahead(6 * 3_600_000), prompt: "p" } },
      { id: "w2", kind: "timer", target: "tmr_2", state: "armed", createdAt: ahead(0), timer: { fireAt: ahead(2 * 3_600_000), prompt: "p" } },
      { id: "w3", kind: "timer", target: "tmr_3", state: "fired", createdAt: ahead(0), timer: { fireAt: ahead(3_600_000), prompt: "p" } },
    ] as ThreadView["watches"],
  })
  assert.equal(wakeAt(timer, now), ahead(2 * 3_600_000), "the earliest ARMED timer")
  assert.equal(wakeAt(thread({}), now), undefined, "no clock, no promise")
  assert.equal(wakeAt(thread({ snoozedUntil: ahead(-60_000) }), now), undefined)
})

test("the agent count counts running children only", () => {
  const t = thread({ subAgents: [
    { id: "a", label: "a", state: "running" },
    { id: "b", label: "b", state: "running", depth: 2 },
    { id: "c", label: "c", state: "rested" },
    { id: "d", label: "d", state: "stale" },
  ] as ThreadView["subAgents"] })
  assert.equal(liveAgentCount(t), 2)
  assert.equal(agentSuffix(0), "")
  assert.equal(agentSuffix(1), "1 agent")
  assert.equal(agentSuffix(3), "3 agents")
  // A parent's working CHILD THREADS ride the same suffix: the phone draws no rows under a row.
  assert.equal(agentSuffix(1, 1), "1 agent · 1 child thread")
  assert.equal(agentSuffix(0, 2), "2 child threads")
})
