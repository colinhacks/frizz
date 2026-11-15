import assert from "node:assert/strict"
import { test } from "node:test"
import type { BootProgress, BootRuntime } from "./boot-progress.ts"
import { bootView, formatElapsed, formatOf, formatRemaining, formatSpeed, formatStepDuration, runtimeDownloadChips } from "./boot-view.ts"

// The checklist the recovery page, the restart overlay and the update button all draw. Every word and
// number on those surfaces is decided here, so these tests read the view as the human would.

const NOW = 1_000_000
const MB = 1_000_000

function progress(runtimes: Partial<Record<"claude" | "codex", BootRuntime>>, phase = "runtimes", extra: Partial<NonNullable<BootProgress["detail"]>> = {}): BootProgress {
  return { pid: 1, step: 3, phase, at: new Date(NOW).toISOString(), detail: { openNow: true, runtimes, ...extra } }
}

test("durations and sizes read in the house grammar", () => {
  assert.equal(formatElapsed(24_400), "24s")
  assert.equal(formatElapsed(192_000), "3m 12s")
  assert.equal(formatElapsed(3_900_000), "1h 05m")
  assert.equal(formatRemaining(40_100), "41s", "rounded up, so it never promises early")
  assert.equal(formatRemaining(4 * 60_000 + 1), "5m")
  assert.equal(formatStepDuration(912), "900ms", "a quick stop is not `0s`")
  assert.equal(formatStepDuration(2_100), "2s")
  assert.equal(formatOf(212 * MB, 348 * MB), "212 of 348 MB")
  assert.equal(formatOf(400_000, 348 * MB), "400 KB of 348 MB")
  assert.equal(formatSpeed(480_000), "480 KB/s")
  assert.equal(formatSpeed(2_400_000), "2.4 MB/s")
})

test("an update on a slow connection: what stopped, the download with its numbers, and Open Frizz now", () => {
  const view = bootView({
    kind: "update",
    version: "0.15.56",
    startedAt: NOW - 192_000,
    now: NOW,
    stopped: { version: "0.15.55", ms: 912 },
    progress: progress({
      claude: { label: "2.1.325", state: "ready" },
      codex: { label: "0.169.0", state: "downloading", received: 212 * MB, total: 348 * MB, bytesPerSecond: 480_000 },
    }),
    platform: "darwin",
  })
  assert.equal(view.title, "Updating Frizz to 0.15.56")
  assert.equal(view.elapsedMs, 192_000)
  assert.deepEqual(view.steps.map((step) => [step.key, step.state, step.label, step.version, step.note]), [
    ["stop", "done", "Stopped", "0.15.55", "900ms"],
    ["claude", "done", "Claude Code", "2.1.325", "on this Mac"],
    ["codex", "live", "Downloading Codex", "0.169.0", "60%"],
    ["threads", "todo", "Load threads", undefined, undefined],
  ])
  const codex = view.steps.find((step) => step.key === "codex")!
  assert.equal(codex.meta, "212 of 348 MB · 480 KB/s · about 5m left")
  assert.ok(Math.abs(codex.fraction! - 212 / 348) < 1e-9)
  // 136 MB at 480 KB/s is nearly five minutes: worth offering.
  assert.equal(view.openNow, true)
  assert.equal(view.hint, "slow")
  assert.deepEqual(view.downloading, ["Codex"])
  assert.deepEqual(view.callout, {
    lead: "This connection is slow.",
    text: "Frizz can open now and finish Codex in the background. A new Codex thread waits for it; everything else works right away.",
  })
})

test("a fast download offers nothing; a stalled one does, and says the bytes are kept", () => {
  const fast = bootView({
    kind: "restart",
    startedAt: NOW - 5_000,
    now: NOW,
    stopped: { ms: 400 },
    progress: progress({ codex: { label: "0.169.0", state: "downloading", received: 300 * MB, total: 348 * MB, bytesPerSecond: 40 * MB } }),
  })
  assert.equal(fast.title, "Restarting Frizz")
  assert.equal(fast.steps[0]!.label, "Stopped the server")
  assert.equal(fast.openNow, false)
  assert.equal(fast.callout, undefined)

  const stalled = bootView({
    kind: "restart",
    startedAt: NOW - 60_000,
    now: NOW,
    progress: progress({ codex: { label: "0.169.0", state: "stalled", received: 212 * MB, total: 348 * MB, stalledForMs: 42_000 } }),
  })
  const codex = stalled.steps.find((step) => step.key === "codex")!
  assert.equal(codex.state, "stalled")
  assert.equal(codex.meta, "No data for 42s · 212 MB kept")
  assert.equal(stalled.openNow, true)
  assert.equal(stalled.hint, "stalled")
  assert.equal(stalled.callout?.lead, "The download stopped receiving data.")
})

test("once the request is made the button gives way to Opening; two downloads read as either", () => {
  const both = {
    claude: { label: "2.1.330", state: "downloading" as const, received: 10 * MB, total: 230 * MB, bytesPerSecond: 300_000 },
    codex: { label: "0.169.0", state: "downloading" as const, received: 20 * MB, total: 348 * MB, bytesPerSecond: 300_000 },
  }
  const offered = bootView({ kind: "start", startedAt: NOW - 30_000, now: NOW, progress: progress(both) })
  assert.equal(offered.title, "Starting Frizz")
  assert.equal(offered.callout?.text, "Frizz can open now and finish Claude Code and Codex in the background. A new thread on either waits for its download.")
  const opening = bootView({ kind: "start", startedAt: NOW - 30_000, now: NOW, progress: progress(both), openNowRequested: true })
  assert.equal(opening.openNow, false)
  assert.equal(opening.opening, true)
  assert.deepEqual(opening.callout, { text: "Opening Frizz. Claude Code and Codex keeps downloading in the background." })
})

test("an older server's phase string still draws a download, but is never offered Open Frizz now", () => {
  // Its file has no `detail`, so it cannot read the request: the button would do nothing.
  const view = bootView({
    kind: "update",
    version: "0.15.56",
    startedAt: NOW - 400_000,
    now: NOW,
    stopped: { version: "0.15.55", ms: 1_200 },
    progress: { pid: 1, step: 9, phase: "runtimes: codex downloading 348 MB, 41%", at: new Date(NOW).toISOString() },
  })
  const codex = view.steps.find((step) => step.key === "codex")!
  assert.equal(codex.label, "Downloading Codex")
  assert.equal(codex.note, "41%")
  assert.equal(codex.meta, "143 of 348 MB")
  assert.equal(view.openNow, false)
  assert.equal(view.callout, undefined)
})

test("past the runtimes the threads load with a count; a signed-out backend's runtime is not a step", () => {
  const view = bootView({
    kind: "restart",
    startedAt: NOW - 9_000,
    now: NOW,
    stopped: { ms: 300 },
    progress: progress({ claude: { label: "2.1.325", state: "ready", fetched: true }, codex: { label: "0.169.0", state: "deferred" } }, "tailer producer 1240/4880", { threads: { done: 1240, total: 4880 } }),
  })
  assert.deepEqual(view.steps.map((step) => step.key), ["stop", "claude", "threads"])
  assert.equal(view.steps[1]!.note, "downloaded")
  assert.deepEqual(view.steps[2], { key: "threads", label: "Loading threads", state: "live", note: "1,240 of 4,880", fraction: 1240 / 4880 })
})

test("a boot that has not written anything yet says it is starting the server", () => {
  const view = bootView({ kind: "restart", startedAt: NOW - 1_000, now: NOW, stopped: "stopping", progress: null })
  assert.deepEqual(view.steps, [{ key: "stop", label: "Stopping the server", state: "live" }, { key: "start", label: "Starting the server", state: "todo" }])
  const forked = bootView({ kind: "restart", startedAt: NOW - 1_000, now: NOW, stopped: { ms: 300 }, progress: null })
  assert.deepEqual(forked.steps.at(-1), { key: "start", label: "Starting the server", state: "live" })
})

test("an update downloading ahead of its restart: the release installing, then its runtimes", () => {
  const installing = bootView({ kind: "prepare", version: "0.15.56", startedAt: NOW - 3_000, now: NOW, progress: null, installed: false, runtimes: {} })
  assert.equal(installing.title, "Getting 0.15.56 ready")
  assert.deepEqual(installing.steps, [{ key: "release", label: "Frizz", version: "0.15.56", state: "live", note: "installing" }])
  assert.equal(installing.openNow, false, "nothing to open early: the old server is still serving")

  const downloading = bootView({
    kind: "prepare",
    version: "0.15.56",
    startedAt: NOW - 90_000,
    now: NOW,
    progress: null,
    installed: true,
    runtimes: {
      claude: { label: "2.1.325", state: "ready" },
      codex: { label: "0.169.0", state: "downloading", received: 143 * MB, total: 348 * MB, bytesPerSecond: 520_000 },
    },
    platform: "linux",
  })
  assert.deepEqual(downloading.steps.map((step) => [step.key, step.state, step.note]), [
    ["release", "done", "installed"],
    ["claude", "done", "on this machine"],
    ["codex", "live", "41%"],
  ])
  assert.equal(downloading.openNow, false)
  assert.equal(downloading.callout, undefined)
})

test("the status row's chip reads a background download as a share and a time left", () => {
  assert.deepEqual(runtimeDownloadChips({}), [])
  const chips = runtimeDownloadChips({
    codex: { backend: "codex", label: "0.169.0", state: "downloading", received: 223 * MB, total: 348 * MB, bytesPerSecond: 700_000 },
    claude: { backend: "claude", label: "2.1.330", state: "ready", received: 230 * MB, total: 230 * MB, bytesPerSecond: 0 },
  })
  assert.equal(chips.length, 1, "a download that has landed is gone")
  assert.equal(chips[0]!.name, "Codex")
  assert.equal(chips[0]!.state, "live")
  assert.equal(chips[0]!.reading, "64% · 3m")
  assert.equal(chips[0]!.detail, "Downloading Codex 0.169.0: 223 of 348 MB · 700 KB/s · about 3m left. A new Codex thread waits for it.")
  const stalled = runtimeDownloadChips({ codex: { backend: "codex", label: "0.169.0", state: "stalled", received: 223 * MB, total: 348 * MB, bytesPerSecond: 0, stalledForMs: 31_000 } })
  assert.equal(stalled[0]!.state, "stalled")
  assert.equal(stalled[0]!.reading, "stalled")
})
