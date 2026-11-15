import assert from "node:assert/strict"
import { test } from "node:test"
import {
  canRestart,
  canUpdateRestart,
  frizzBuildIdentity,
  getFrizzSupervisorStatus,
  IDLE_RESTART_HOLD,
  isDevFrizzBuild,
  isPreparingUpdate,
  nextControlPlane,
  nextRestartHold,
  readyBelieved,
  requestFrizzOpenNow,
  requestFrizzRestart,
  requestFrizzUpdateRestart,
  RESTART_HOLD_DEADLINE_MS,
  restartFailureCopy,
  restartFailureOutcome,
  shouldReloadForNewBuild,
  type ControlPlane,
  type FrizzSupervisorStatus,
  type StampedSupervisorStatus,
} from "./restart.ts"

const response = (body: string, status = 200, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } })

test("restart controls negotiate an explicit JSON protocol and reject SPA HTML fallbacks", async () => {
  const html = async () => response("<!doctype html><title>Frizz</title>", 200, "text/html")
  assert.equal(await getFrizzSupervisorStatus(html as typeof fetch), null)
  await assert.rejects(requestFrizzUpdateRestart(html as typeof fetch), /unavailable/)
})

test("restart controls reject stale protocol, missing routes, and network failures", async () => {
  const stale = async () => response(JSON.stringify({ protocol: 0, state: "ready" }))
  const missing = async () => response("missing", 404, "text/plain")
  const failed = async () => { throw new Error("network down") }
  assert.equal(await getFrizzSupervisorStatus(stale as typeof fetch), null)
  assert.equal(await getFrizzSupervisorStatus(missing as typeof fetch), null)
  assert.equal(await getFrizzSupervisorStatus(failed as typeof fetch), null)
  assert.equal(canRestart(null), false)
  assert.equal(canRestart({ protocol: 1, state: "ready" }), true)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready" }), false)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready", updateRestart: true }), true)
})

test("ordinary restart remains available without the update capability", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready" }), 202)
  }
  await requestFrizzRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_frizz/control/restart")
  assert.equal(request?.init?.method, "POST")
})

test("update and restart requires an explicit supervisor capability and uses its one endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready", artifactDigest: "a".repeat(64), updateRestart: true }))
  }
  assert.equal((await getFrizzSupervisorStatus(supported as typeof fetch))?.artifactDigest, "a".repeat(64))
  assert.equal((await getFrizzSupervisorStatus(supported as typeof fetch))?.updateRestart, true)
  await requestFrizzUpdateRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_frizz/control/update-restart")
  assert.equal(request?.init?.method, "POST")

  const failure = async () => response(JSON.stringify({ protocol: 1, state: "failed", message: "candidate rejected" }), 503)
  await assert.rejects(requestFrizzUpdateRestart(failure as typeof fetch), /candidate rejected/)
})

test("supervisor status distinguishes the active server from its stable launcher", async () => {
  const split = async () => response(JSON.stringify({
    protocol: 1,
    state: "ready",
    version: "0.13.1",
    launcherVersion: "0.13.0",
    updateVersion: "0.13.2",
  }))
  assert.deepEqual(await getFrizzSupervisorStatus(split as typeof fetch), {
    protocol: 1,
    state: "ready",
    version: "0.13.1",
    launcherVersion: "0.13.0",
    updateVersion: "0.13.2",
  })
})

test("an accepted update transition is not misreported as a restart failure", async () => {
  const accepted = async () => response(JSON.stringify({ protocol: 1, state: "restarting" }), 202)
  assert.equal((await requestFrizzUpdateRestart(accepted as typeof fetch)).state, "restarting")
})

// The two conditions behind the Update-vs-Restart label. Conflating them shipped: production reported
// only the CAPABILITY, so a fully current Frizz still offered "Update Frizz" and a click reinstalled its
// own version and restarted the app for nothing.
test("the update label needs the verb wired AND a newer artifact to actually exist", () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof canUpdateRestart>[0]

  assert.equal(canUpdateRestart(status({ updateRestart: true, updateAvailable: true })), true)
  assert.equal(
    canUpdateRestart(status({ updateRestart: true, updateAvailable: false })), false,
    "already current ⇒ offer a plain Restart, never an Update that installs nothing",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: true })), true,
    "absent ⇒ assume available, so frizz-dev (which can always rebuild from source) is unchanged",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: false, updateAvailable: true })), false,
    "availability can never conjure the verb on a supervisor that cannot promote an artifact",
  )
})

// Why a field at all: the client cannot see this. `import.meta.env.DEV` is a Vite COMPILE-TIME
// constant, false in the production bundle every frizz-dev artifact serves — so the dev-only
// Restart-worker verb was eliminated from the build it exists for. The launcher answers instead.
test("a development build is only ever what the supervisor explicitly reports", async () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof isDevFrizzBuild>[0]

  assert.equal(isDevFrizzBuild(status({ dev: true })), true, "frizz-dev / pnpm dev")
  assert.equal(
    isDevFrizzBuild(status({})), false,
    "a published Frizz, and any supervisor predating the field, must never show a dev-only verb",
  )
  assert.equal(
    isDevFrizzBuild(status({ updateRestart: true })), false,
    "Update & Restart is wired in PRODUCTION too — it can never stand in for a dev signal",
  )
  assert.equal(isDevFrizzBuild(null), false, "an unreachable supervisor is not a licence to show one")

  // And it has to survive the wire, not just the predicate.
  const dev = async () => response(JSON.stringify({ protocol: 1, state: "ready", dev: true }))
  assert.equal(isDevFrizzBuild(await getFrizzSupervisorStatus(dev as typeof fetch)), true)
})

// ── Finding 1 (audit 2026-09-11): the restart hold has a deadline ────────────────────────────────────
// After a detached handoff every poll comes back null. App used to ignore those, so a successor that
// never came up left the blocking overlay on screen forever with nothing to say. The reducer below is
// what the App effect steps once per poll; this pins the clock as arithmetic.
test("the restart hold stalls after three minutes of unanswered polls, and only then", () => {
  const t0 = 1_000_000
  let hold = IDLE_RESTART_HOLD
  // The supervisor is still answering "restarting" (a durable build in progress): no silence accrues.
  hold = nextRestartHold(hold, { restarting: true, answered: true, at: t0 })
  assert.deepEqual(hold, IDLE_RESTART_HOLD)
  // The old process exits; the first null starts the clock.
  hold = nextRestartHold(hold, { restarting: true, answered: false, at: t0 + 1_000 })
  assert.equal(hold.silentSince, t0 + 1_000)
  assert.equal(hold.stalled, false)
  for (const at of [t0 + 30_000, t0 + 120_000, t0 + 1_000 + RESTART_HOLD_DEADLINE_MS - 1]) {
    hold = nextRestartHold(hold, { restarting: true, answered: false, at })
    assert.equal(hold.stalled, false, `still inside the deadline at +${at - t0}ms`)
    assert.equal(hold.silentSince, t0 + 1_000, "the clock is measured from the FIRST silent poll, not the latest")
  }
  hold = nextRestartHold(hold, { restarting: true, answered: false, at: t0 + 1_000 + RESTART_HOLD_DEADLINE_MS })
  assert.equal(hold.stalled, true)
  assert.equal(hold.silentForMs, RESTART_HOLD_DEADLINE_MS, "the overlay reads its `3m` off this, never off a clock in render")
  assert.equal(RESTART_HOLD_DEADLINE_MS, 3 * 60_000)
})

test("any protocol answer resets the hold's clock, and nothing accrues without an overlay to hold", () => {
  const stalled = nextRestartHold({ silentSince: 0, silentForMs: 0, stalled: false }, { restarting: true, answered: false, at: RESTART_HOLD_DEADLINE_MS })
  assert.equal(stalled.stalled, true)
  // A durable supervisor that comes back mid-build and says so: a slow build is not a dead board.
  assert.deepEqual(nextRestartHold(stalled, { restarting: true, answered: true, at: RESTART_HOLD_DEADLINE_MS + 500 }), IDLE_RESTART_HOLD)
  // The board is ready again (whatever the poll said): the hold is over.
  assert.deepEqual(nextRestartHold(stalled, { restarting: false, answered: true, at: RESTART_HOLD_DEADLINE_MS + 500 }), IDLE_RESTART_HOLD)
  // Null polls against a board that is NOT restarting (server down at rest) never raise the notice.
  assert.deepEqual(nextRestartHold(IDLE_RESTART_HOLD, { restarting: false, answered: false, at: 5 }), IDLE_RESTART_HOLD)
  // And after a reset, silence starts a fresh clock rather than resuming the old one.
  const again = nextRestartHold(IDLE_RESTART_HOLD, { restarting: true, answered: false, at: 9_000 })
  assert.equal(again.silentSince, 9_000)
  assert.equal(again.stalled, false)
})

// ── Finding 8: every tab reloads onto a new build, not just the one that clicked ─────────────────────
test("a ready answer from a different build than this page first saw means reload", () => {
  const ready = (over: Record<string, unknown>) => ({ protocol: 1, state: "ready", ...over }) as FrizzSupervisorStatus
  // frizz-dev's durable owner names an artifact digest; the registry launcher names a version.
  assert.equal(frizzBuildIdentity(ready({ artifactDigest: "a".repeat(64) })), "a".repeat(64))
  assert.equal(frizzBuildIdentity(ready({ version: "0.4.2" })), "0.4.2")
  assert.equal(frizzBuildIdentity(ready({ artifactDigest: "d", version: "0.4.2" })), "d", "the digest is the finer identity when both are sent")
  assert.equal(frizzBuildIdentity(ready({})), null)
  assert.equal(frizzBuildIdentity(null), null)

  assert.equal(shouldReloadForNewBuild("0.4.2", ready({ version: "0.5.0" })), true, "the other tabs' case: same server slot, new version")
  assert.equal(shouldReloadForNewBuild("0.4.2", ready({ version: "0.4.2" })), false, "an ordinary Restart keeps the build")
  assert.equal(shouldReloadForNewBuild("a".repeat(64), ready({ artifactDigest: "b".repeat(64) })), true)
  assert.equal(shouldReloadForNewBuild("0.4.2", { protocol: 1, state: "restarting", version: "0.5.0" }), false, "nothing to load until the successor is READY")
  assert.equal(shouldReloadForNewBuild("0.4.2", { protocol: 1, state: "failed", version: "0.5.0" }), false, "a successor whose board failed serves no bundle either")
  assert.equal(shouldReloadForNewBuild("0.4.2", ready({})), false, "a supervisor that stops naming builds cannot be told apart — never loop")
  assert.equal(shouldReloadForNewBuild(null, ready({ version: "0.5.0" })), false, "no first identity, no comparison")
  assert.equal(shouldReloadForNewBuild("0.4.2", null), false)
})

// ── Finding 11: "kept running the previous version" is only true when it did ────────────────────────
test("a failed answer naming the version we clicked on means the old launcher gave up; a newer one means the successor failed", () => {
  assert.deepEqual(restartFailureOutcome("0.4.2", { version: "0.4.2" }), { kind: "previous-kept" })
  assert.deepEqual(restartFailureOutcome(undefined, {}), { kind: "previous-kept" }, "frizz-dev names no version and rolls back in place")
  assert.deepEqual(restartFailureOutcome("0.4.2", { version: "0.5.0" }), { kind: "successor-failed", version: "0.5.0" })
  assert.deepEqual(restartFailureOutcome("0.4.2", {}), { kind: "successor-failed", version: undefined }, "a different answerer that names nothing is still not the one we clicked on")

  const kept = restartFailureCopy({ kind: "previous-kept" })
  assert.equal(kept.detail, "Frizz kept running the previous version, and your threads are unaffected.")
  assert.equal(kept.summary, "Frizz kept running the previous version")
  const successor = restartFailureCopy({ kind: "successor-failed", version: "0.5.0" })
  assert.equal(successor.summary, "Frizz 0.5.0 failed to start")
  assert.match(successor.detail, /^Frizz 0\.5\.0 came up but could not start its board, and the previous version is gone\./)
  assert.match(successor.detail, /npx frizz/)
  assert.doesNotMatch(successor.detail, /kept running/)
  assert.match(restartFailureCopy({ kind: "successor-failed" }).summary, /^The new version of Frizz failed to start$/)
})

// ── pullfrog on #35 (2026-09-11): only an answer requested after the ack can settle an attempt ──────
// The button raises the overlay before its POST is acked, and App held that optimism until the first
// non-"ready" answer — from ANY request, including one that was already on the wire when the operator
// clicked. Every answer now carries the instant its request started, and the attempt the instant the
// supervisor acked it; the reducer below is what App applies per answer.
const answer = (state: StampedSupervisorStatus["state"], requestedAt: number, over: Partial<StampedSupervisorStatus> = {}): StampedSupervisorStatus =>
  ({ protocol: 1, state, requestedAt, ...over })
const CLICK = 1_000
const ACK = 1_500

test("a stale failed poll started before the click does not clear the pending guard", () => {
  // The click: the overlay is up optimistically, the POST is not yet acked.
  const clicked: ControlPlane = { state: "restarting", message: null, attempt: { startedAt: CLICK, ackedAt: null } }
  // The "failed" this board was showing before the click answers a request that went out at t=900.
  const stale = answer("failed", CLICK - 100, { message: "old build never came up" })
  assert.equal(nextControlPlane(clicked, stale), clicked, "a request from before the click belongs to the world before this attempt")
  // Nothing at all speaks for the attempt while the ack instant is unknown — not even a "restarting"
  // requested after the click, because the supervisor may have served it before it accepted the POST.
  assert.equal(nextControlPlane(clicked, answer("restarting", CLICK + 200)), clicked)
  assert.equal(nextControlPlane(clicked, answer("failed", CLICK + 200)), clicked)
})

test("after the ack a ready (preparing) answer keeps the guard; restarting or failed clears it", () => {
  const acked: ControlPlane = { state: "restarting", message: null, attempt: { startedAt: CLICK, ackedAt: ACK } }
  // The launcher deliberately reports "ready" through the prepare phase — the old child is untouched.
  assert.equal(nextControlPlane(acked, answer("ready", ACK + 10, { preparing: true })), acked)
  assert.equal(nextControlPlane(acked, answer("ready", ACK + 10)), acked, "with or without the stamp")
  // A "failed" whose request started before the ack still cannot speak, even after the ack has landed.
  assert.equal(nextControlPlane(acked, answer("failed", ACK - 1)), acked)
  // The same millisecond as the ack counts: the wake the ack dispatches refetches within it.
  assert.deepEqual(nextControlPlane(acked, answer("restarting", ACK)), { state: "restarting", message: null, attempt: null })
  assert.deepEqual(
    nextControlPlane(acked, answer("failed", ACK + 40, { message: "build broke" })),
    { state: "failed", message: "build broke", attempt: null },
  )
  // With no attempt pending, every answer is simply believed — the non-pending path is unchanged.
  const believed: ControlPlane = { state: "ready", message: null, attempt: null }
  assert.deepEqual(nextControlPlane(believed, answer("failed", 5, { message: "x" })), { state: "failed", message: "x", attempt: null })
  assert.deepEqual(nextControlPlane(believed, answer("ready", 5)), believed)
})

test("retrying from failed with an old poll in flight never reloads onto the old bundle", () => {
  // The board shows the previous attempt's failure; the operator clicks Update again.
  let plane: ControlPlane = { state: "failed", message: "old build never came up", attempt: null }
  plane = { state: "restarting", message: null, attempt: { startedAt: CLICK, ackedAt: null } }
  // The pre-click "failed" poll lands first. Before: this cleared the guard for the new attempt.
  plane = nextControlPlane(plane, answer("failed", CLICK - 100, { message: "old build never came up" }))
  assert.notEqual(plane.attempt, null, "the stale failed must not settle the new attempt")
  // The POST is acked and the reload destination armed.
  plane = { ...plane, attempt: { startedAt: CLICK, ackedAt: ACK } }
  // The launcher's prepare-phase "ready": with the guard wrongly cleared, this consumed the armed
  // destination and reloaded the tab onto the OLD bundle before the handoff started.
  const preparing = answer("ready", ACK, { preparing: true, version: "1.2.3" })
  plane = nextControlPlane(plane, preparing)
  assert.equal(readyBelieved(plane, preparing), false, "a ready read under a pending attempt may not consume the destination")
  assert.equal(plane.state, "restarting", "and the overlay stays up")
  // The drain begins: the first post-ack non-"ready" answer settles the attempt.
  plane = nextControlPlane(plane, answer("restarting", ACK + 500))
  assert.equal(plane.attempt, null)
  assert.equal(readyBelieved(plane, answer("restarting", ACK + 500)), false, "restarting is never a reload")
  // The successor comes up: THIS ready is believed, and the destination may be consumed.
  const successor = answer("ready", ACK + 9_000, { version: "1.2.4" })
  plane = nextControlPlane(plane, successor)
  assert.equal(plane.state, "ready")
  assert.equal(readyBelieved(plane, successor), true)
})

// The old launcher's drain window can be shorter than one poll, so "restarting" may never be observed
// after the ack; the successor's own "ready", naming a different build, is then the first post-ack
// answer, and it must settle the attempt or the tab waits out the whole hold under an overlay while
// the new build serves (seen on the Windows run, 2026-09-11).
test("a post-ack ready naming a different build settles the attempt; the same build's ready does not", () => {
  const attempt = { startedAt: 1_000, ackedAt: 1_500, build: "npm:frizz@0.12.12" }
  const pending = { state: "restarting" as const, message: null, attempt }
  const same = { state: "ready" as const, message: undefined, requestedAt: 1_600, artifactDigest: "npm:frizz@0.12.12", version: "0.12.12" }
  const successor = { state: "ready" as const, message: undefined, requestedAt: 1_700, artifactDigest: "npm:frizz@0.12.13", version: "0.12.13" }
  assert.equal(nextControlPlane(pending, same), pending)
  assert.deepEqual(nextControlPlane(pending, successor), { state: "ready", message: null, attempt: null })
  // Before the ack even the successor's answer cannot speak for the attempt.
  const unacked = { ...pending, attempt: { ...attempt, ackedAt: null } }
  assert.equal(nextControlPlane(unacked, successor), unacked)
  // No identity recorded at the click: only a non-ready settles, as before.
  const blind = { ...pending, attempt: { startedAt: 1_000, ackedAt: 1_500 } }
  assert.equal(nextControlPlane(blind, successor), blind)
})

// An update that downloads ahead of its restart keeps the old server serving for as long as that takes —
// minutes on a slow connection — and the launcher says so with a "prepare" view (2026-11-15). The board
// has to stay usable through it: believed "ready", no overlay, writes allowed. The attempt stays held,
// so that "ready" can neither settle it nor reload the tab onto the old bundle.
test("an update downloading ahead of its restart keeps the board ready and the attempt held", () => {
  const prepare = { kind: "prepare" as const, title: "Getting 0.15.56 ready", elapsedMs: 4_000, steps: [], openNow: false }
  const attempt = { startedAt: CLICK, ackedAt: ACK, build: "npm:frizz@0.15.55" }
  // The quiet click recorded the attempt and left the board "ready"; the optimistic one raised it to "restarting".
  for (const before of ["ready", "restarting"] as const) {
    const pending: ControlPlane = { state: before, message: null, attempt }
    const downloading = answer("ready", ACK + 10, { preparing: true, version: "0.15.55", artifactDigest: "npm:frizz@0.15.55", progress: prepare })
    assert.equal(isPreparingUpdate(downloading), true)
    const plane = nextControlPlane(pending, downloading)
    assert.deepEqual(plane, { state: "ready", message: null, attempt }, `from ${before}`)
    assert.equal(readyBelieved(plane, downloading), false, "the destination is not consumed")
    // The launcher stops the old server: the attempt settles exactly as before.
    assert.deepEqual(nextControlPlane(plane, answer("restarting", ACK + 60_000)), { state: "restarting", message: null, attempt: null })
    // A failed download fails the update, the old server still serving.
    assert.deepEqual(
      nextControlPlane(plane, answer("failed", ACK + 60_000, { message: "Frizz 0.15.56 could not download its runtimes" })),
      { state: "failed", message: "Frizz 0.15.56 could not download its runtimes", attempt: null },
    )
  }
  // Before the ack nothing speaks for the attempt, a prepare view included.
  const unacked: ControlPlane = { state: "ready", message: null, attempt: { ...attempt, ackedAt: null } }
  assert.equal(nextControlPlane(unacked, answer("ready", CLICK + 10, { progress: prepare })), unacked)
  // A boot's view on "restarting" is not a prepare, and frizz-dev's bare `preparing` stamp keeps today's hold.
  assert.equal(isPreparingUpdate(answer("restarting", 1, { progress: { ...prepare, kind: "update" } })), false)
  assert.equal(isPreparingUpdate(answer("ready", 1, { preparing: true })), false)
  const devHold: ControlPlane = { state: "restarting", message: null, attempt }
  assert.equal(nextControlPlane(devHold, answer("ready", ACK + 10, { preparing: true })), devHold)
})

test("open now reports what the launcher said, and never throws", async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  const fetcher = (answerWith: Response | Error) => (async (url: string, init?: RequestInit) => {
    calls.push([url, init])
    if (answerWith instanceof Error) throw answerWith
    return answerWith
  }) as unknown as typeof fetch
  assert.deepEqual(await requestFrizzOpenNow(fetcher(response(JSON.stringify({ protocol: 1, ok: true }), 202))), { ok: true })
  assert.equal(calls[0]?.[0], "/_frizz/control/open-now")
  assert.equal(calls[0]?.[1]?.method, "POST")
  assert.deepEqual(
    await requestFrizzOpenNow(fetcher(response(JSON.stringify({ protocol: 1, ok: false, message: "the boot already finished" }), 409))),
    { ok: false, message: "the boot already finished" },
  )
  assert.deepEqual(await requestFrizzOpenNow(fetcher(response("<html>", 404, "text/html"))), { ok: false, message: "The launcher did not take the request." })
  assert.deepEqual(await requestFrizzOpenNow(fetcher(new Error("offline"))), { ok: false, message: "The launcher did not answer." })
})
