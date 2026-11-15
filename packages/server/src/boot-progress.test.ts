import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  bootIsDownloading,
  bootOpenNowRequested,
  bootProgressPath,
  createBootProgressPublisher,
  readBootProgress,
  requestBootOpenNow,
  watchBootOpenNow,
} from "./boot-progress.ts"

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-boot-progress-"))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("detail merges runtime by runtime, and a runtime changing state publishes inside the rate limit", () => {
  const dir = stateDir()
  const publish = createBootProgressPublisher(dir, 60_000)
  publish("runtimes")
  publish.detail({ openNow: true, runtimes: { claude: { label: "2.1.325", state: "checking" }, codex: { label: "0.169.0", state: "checking" } } })
  publish.detail({ runtimes: { codex: { label: "0.169.0", state: "downloading", received: 1, total: 10, bytesPerSecond: 1 } } })
  let read = readBootProgress(dir)!
  assert.equal(read.pid, process.pid)
  assert.equal(read.detail?.openNow, true, "a patch keeps what an earlier one set")
  assert.equal(read.detail?.runtimes?.claude?.state, "checking", "and the other runtime")
  assert.equal(read.detail?.runtimes?.codex?.state, "downloading")
  // Same states, more bytes, inside the minute: throttled.
  const step = read.step
  publish.detail({ runtimes: { codex: { label: "0.169.0", state: "downloading", received: 5, total: 10, bytesPerSecond: 1 } } })
  read = readBootProgress(dir)!
  assert.equal(read.step, step)
  assert.equal(read.detail?.runtimes?.codex?.received, 1)
  // "ready" is never dropped by the throttle.
  publish.detail({ runtimes: { codex: { label: "0.169.0", state: "ready", fetched: true } } })
  read = readBootProgress(dir)!
  assert.equal(read.detail?.runtimes?.codex?.state, "ready")
  assert.ok(read.step > step)
})

test("nothing is published once the boot is done, so a finished boot's file never comes back", () => {
  const dir = stateDir()
  const publish = createBootProgressPublisher(dir, 0)
  publish("listen")
  publish.done()
  publish("tailer producer 1/2")
  publish.detail({ threads: { done: 1, total: 2 } })
  assert.equal(readBootProgress(dir), null)
})

test("a boot downloading a runtime is told apart from one that is merely slow", () => {
  const at = new Date().toISOString()
  assert.equal(bootIsDownloading(null), false)
  assert.equal(bootIsDownloading({ pid: 1, step: 1, phase: "runtimes", at, detail: { runtimes: { codex: { label: "x", state: "stalled" } } } }), true)
  assert.equal(bootIsDownloading({ pid: 1, step: 1, phase: "runtimes", at, detail: { runtimes: { codex: { label: "x", state: "ready" } } } }), false)
  assert.equal(bootIsDownloading({ pid: 1, step: 1, phase: "tailer producer 3/9", at }), false)
  // An older server writes only the phrase.
  assert.equal(bootIsDownloading({ pid: 1, step: 1, phase: "runtimes: codex downloading 348 MB, 41%", at }), true)
})

test("an open-now request reaches only the boot it names", async () => {
  const dir = stateDir()
  const watch = watchBootOpenNow(dir, 4242, 10)
  let heard = false
  void watch.requested.then(() => { heard = true })
  // A request left behind for an earlier boot is not this one's.
  requestBootOpenNow(dir, 1111)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(heard, false)
  assert.equal(bootOpenNowRequested(dir, 1111), true)
  requestBootOpenNow(dir, 4242)
  await watch.requested
  assert.equal(heard, true)
  assert.equal(bootOpenNowRequested(dir, 4242), false, "the boot consumes its request")
  watch.stop()
  // A malformed file reads as no request.
  writeFileSync(join(dir, "boot.open-now"), "{")
  assert.equal(bootOpenNowRequested(dir, 4242), false)
  assert.equal(bootProgressPath(dir), join(dir, "boot.progress"))
})
