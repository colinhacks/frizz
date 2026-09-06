// A SCHEDULED wake has to be able to start a process, not just talk to one.
//
// Every server-side thing that wakes a rested Claude thread — a fired `timer:`, a `goal`,
// a `watch_pr` event, a usage-limit auto-resume — arrives here, at `deliverClaudeBrokerWake`, and from
// here at the bridge's `followUp`, which reconnects a live daemon OR cold-resumes a dead one. Since
// hibernation (thread-hibernation.ts) the dead-daemon case is no longer rare: it is the NORMAL state of
// any thread that has rested past the prompt-cache TTL, which is most of the board most of the time.
//
// What that makes load-bearing is the fork options. A live daemon ignores them — it already carries the
// worker contract, the model and the permission mode from the process it was started as. A cold resume
// has nothing, and rebuilds all of it from exactly these arguments. So a wake that dropped one would
// look perfectly healthy against a live daemon and, against a hibernated thread, silently start a
// worker with no frizz contract, the wrong model, or the wrong permission mode.
import assert from "node:assert/strict"
import { test } from "node:test"
import { deliverClaudeBrokerWake } from "./context.ts"

function bridge() {
  const calls: Parameters<Parameters<typeof deliverClaudeBrokerWake>[0]["bridge"]["followUp"]>[0][] = []
  return { calls, followUp: async (input: (typeof calls)[number]) => void calls.push(input) }
}

const row = {
  session_id: "sess-1",
  model: "claude-opus-4-6",
  effort: "high",
  permission_mode: "bypassPermissions",
}
// The operator's Settings ask for `auto` here, so `auto` is the dispatch floor in these tests — chosen
// to differ from the row's own persisted mode, so a wake that took the wrong one is caught.
const settings = { permissionMode: "auto" as const }

test("a scheduled wake carries everything a COLD RESUME needs to rebuild the worker", async () => {
  const b = bridge()
  await deliverClaudeBrokerWake({
    bridge: b, slug: "rested-thread", cwd: process.cwd(), row, settings,
    deliveryMessage: "your timer fired",
  })
  assert.equal(b.calls.length, 1)
  const [call] = b.calls
  assert.equal(call.threadSlug, "rested-thread")
  assert.equal(call.sessionId, "sess-1")
  assert.equal(call.text, "your timer fired")
  // The three a live daemon already has and a cold-resumed one does not.
  assert.equal(call.model, "claude-opus-4-6", "the thread's model, or the resume starts on the default")
  assert.equal(call.effort, "high")
  assert.equal(call.permissionMode, "bypassPermissions", "a launch flag — unreachable after the process starts")
  assert.ok(call.appendSystemPrompt && call.appendSystemPrompt.length > 0, "the frizz worker contract is rebuilt, not inherited")
})

// The scheduler owns retry/supersede and can only do it if the failure reaches it. This is the CODEX
// bug (context.codex-wake.test.ts) asked of the claude path: it has always returned the bridge's own
// promise, and this is what keeps it that way.
test("a failing bridge REJECTS the returned promise so the scheduler can retry", async () => {
  await assert.rejects(
    deliverClaudeBrokerWake({
      bridge: { followUp: async () => { throw new Error("the session broker is unavailable") } },
      slug: "rested-thread", cwd: process.cwd(), row, settings, deliveryMessage: "your timer fired",
    }),
    /session broker is unavailable/,
  )
})

// The limit auto-resume is the one caller that asks for the daemon to be RETIRED first. Hibernation
// reaches the same end by a different route, and the two must not fight: a wake that passes
// `freshProcess` at a thread whose daemon is already gone is simply a cold resume with an extra no-op
// kill, which is why the sweep needs no coordination with the scheduler at all.
test("freshProcess rides through untouched, and defaults to absent", async () => {
  const b = bridge()
  await deliverClaudeBrokerWake({ bridge: b, slug: "s", cwd: process.cwd(), row, settings, deliveryMessage: "m" })
  assert.equal(b.calls[0].freshProcess, undefined)
  await deliverClaudeBrokerWake({ bridge: b, slug: "s", cwd: process.cwd(), row, settings, deliveryMessage: "m", freshProcess: true })
  assert.equal(b.calls[1].freshProcess, true)
})

// A row promoted from the External band by a build that stamped NO permission mode used to hand the
// bridge `undefined`, which a cold resume turns into Claude's `default` — the prompt-on-everything mode
// the worker's perm-policy hook defers call by call, so every Edit parked on a card (observed
// 2026-09-03). The follow-up RPC substitutes the dispatch floor for such a row, and a scheduled wake —
// a timer, a goal, a PR watch, a limit auto-resume — must do the same, or the legacy row converges only
// when a human happens to type at it.
test("a scheduled wake of a row with no recorded permission mode cold-resumes at the dispatch floor", async () => {
  const b = bridge()
  await deliverClaudeBrokerWake({
    bridge: b, slug: "legacy", cwd: process.cwd(), row: { ...row, permission_mode: null }, settings,
    deliveryMessage: "your timer fired",
  })
  assert.equal(b.calls[0].permissionMode, "auto", "the dispatch floor, not undefined → default")
})

// …and the row's own persisted mode always wins over that floor (the case above pins the difference).
test("a scheduled wake carries a persisted permission mode over the dispatch floor", async () => {
  const b = bridge()
  await deliverClaudeBrokerWake({ bridge: b, slug: "s", cwd: process.cwd(), row, settings, deliveryMessage: "m" })
  assert.equal(b.calls[0].permissionMode, "bypassPermissions")
})
