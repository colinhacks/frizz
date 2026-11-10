import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"

// The ops strip's LIVE COUNTER endpoint. Handlers are lazy — each reads only the context fields it
// touches — but `createRouter` itself resolves a few roots and controllers up front, so the stub
// carries those and nothing more. This procedure's own dependency is one method: `backgroundShell`.
function harness(shells: Record<string, { outputFile?: string; state: "running" | "done" }>) {
  const ctx = {
    project: { dir: tmpdir(), stateDir: tmpdir() },
    storage: {},
    board: {},
    tailer: { backgroundShell: (_slug: string, id: string) => shells[id] },
  } as unknown as AppContext
  return createRouter(ctx)
}

const SLUG = "counter-thread"

// A task's output file as the harness names it, `…/tasks/<task id>.output`: the only shape read.
function taskOutput(dir: string, taskId: string) {
  mkdirSync(join(dir, "tasks"), { recursive: true })
  return join(dir, "tasks", `${taskId}.output`)
}

test("the activity endpoint counts each named shell's output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-activity-"))
  try {
    const busy = taskOutput(dir, "busy")
    const silent = taskOutput(dir, "silent")
    writeFileSync(busy, "one\ntwo\nthree\n")
    writeFileSync(silent, "")
    const router = harness({
      busy: { outputFile: busy, state: "running" },
      silent: { outputFile: silent, state: "running" },
    })
    assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["busy", "silent"] } }), {
      shells: [
        { id: "busy", lines: 3, running: true },
        // ZERO, not null: the file exists and is empty, which is the wedged-watcher reading the whole
        // counter exists to surface.
        { id: "silent", lines: 0, running: true },
      ],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The window between a shell's `tool_use` (its row appears) and its launch ack (which names the output
// path). Reporting the shell as ABSENT here read as "nothing on this strip is running", the client
// stopped polling, and the counter never arrived for the rest of that view's life.
test("a shell whose launch ack has not landed reports lines:null and STAYS running", async () => {
  const router = harness({ pending: { state: "running" } })
  assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["pending"] } }), {
    shells: [{ id: "pending", lines: null, running: true }],
  })
})

test("a shell the tailer no longer knows is omitted — it is gone, not pending", async () => {
  const router = harness({})
  assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["retired"] } }), { shells: [] })
})

test("a settled shell still reports its final count, marked not-running so the poll can stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-activity-done-"))
  try {
    const path = taskOutput(dir, "done")
    writeFileSync(path, "finished\n")
    const router = harness({ done: { outputFile: path, state: "done" } })
    assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["done"] } }), {
      shells: [{ id: "done", lines: 1, running: false }],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The path a shell row carries began as text in a tool result, and a tail cache written by an older
// build can still hold one that was never checked. So the two readers ask again, and a path that is not
// a task's own regular output file is neither counted nor shown: not a file elsewhere on the machine,
// and not a link a repository shipped under `tasks/`.
test("a shell whose recorded path is not a task's own output file is never read: not counted, not shown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-activity-foreign-"))
  try {
    const secret = join(dir, "identity.key")
    writeFileSync(secret, "PRIVATE\nKEY\n")
    const linked = taskOutput(dir, "linked")
    symlinkSync(secret, linked)
    const router = harness({
      foreign: { outputFile: secret, state: "running" },
      linked: { outputFile: linked, state: "running" },
    })
    assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["foreign", "linked"] } }), {
      shells: [
        { id: "foreign", lines: null, running: true },
        { id: "linked", lines: null, running: true },
      ],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
