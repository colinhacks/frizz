import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileOffThread, type OffThreadExecError } from "./off-thread-exec.ts"

test("output, stdin, cwd and env reach the child and come back", async () => {
  assert.deepEqual(await execFileOffThread("/bin/sh", ["-c", "printf out; printf err >&2"]), { stdout: "out", stderr: "err" })
  assert.equal((await execFileOffThread("/bin/cat", [], { input: "a\0b" })).stdout, "a\0b")
  assert.equal((await execFileOffThread("/bin/pwd", [], { cwd: "/" })).stdout.trim(), "/")
  assert.equal((await execFileOffThread("/bin/sh", ["-c", "printf %s \"$OFF_THREAD_PROBE\""], { env: { OFF_THREAD_PROBE: "yes" } })).stdout, "yes")
})

test("the environment this process changes later is the one a child sees", async () => {
  process.env.OFF_THREAD_LATER = "set after the worker started"
  try {
    assert.equal((await execFileOffThread("/bin/sh", ["-c", "printf %s \"$OFF_THREAD_LATER\""])).stdout, "set after the worker started")
  } finally {
    delete process.env.OFF_THREAD_LATER
  }
})

test("a failure rejects in the shape of a promisified execFile", async () => {
  const exited = await execFileOffThread("/bin/sh", ["-c", "printf partial; exit 3"]).catch((e: OffThreadExecError) => e)
  assert.ok(exited instanceof Error)
  assert.equal(exited.code, 3)
  assert.equal(exited.stdout, "partial")

  const missing = await execFileOffThread("/no/such/binary", []).catch((e: OffThreadExecError) => e)
  assert.ok(missing instanceof Error)
  assert.equal(missing.code, "ENOENT")

  const late = await execFileOffThread("/bin/sleep", ["30"], { timeout: 50 }).catch((e: OffThreadExecError) => e)
  assert.ok(late instanceof Error)
  assert.equal(late.killed, true)
})

test("starting and waiting on children leaves this thread free", async () => {
  // Negative control: the same work on this thread's `execFileSync` would hold the timer for the whole second.
  let longestGap = 0
  let last = performance.now()
  const beat = setInterval(() => {
    const now = performance.now()
    longestGap = Math.max(longestGap, now - last)
    last = now
  }, 5)
  try {
    await Promise.all(Array.from({ length: 20 }, () => execFileOffThread("/bin/sleep", ["1"])))
  } finally {
    clearInterval(beat)
  }
  assert.ok(longestGap < 500, `the timer waited ${Math.round(longestGap)}ms`)
})

test("an idle worker does not hold the process open, and a burst all comes back in order of its own promises", async () => {
  const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => execFileOffThread("/bin/echo", [String(i)])))
  assert.deepEqual(answers.map((a) => Number(a.stdout)), Array.from({ length: 50 }, (_, i) => i))
})
