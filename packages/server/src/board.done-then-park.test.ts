// A worker that runs `frizzctl done` and then rests on an ```awaiting fence before the human speaks has
// taken the completion back. The row outranked the newer fence until the human next spoke, so the board
// carded a parked thread as Done and hid its steps as finished (reylo, 2026-10-22). Built on a real
// storage, tailer and board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot } from "@frizz/shared"
import { createBoard, registeredDoneFence } from "./board.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer } from "./tailer.ts"

const T0 = Date.now() - 60 * 60_000
const at = (second: number) => new Date(T0 + second * 1000).toISOString()
const prompt = (second: number) => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: "go" } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })
const STEPS = "Over to you.\n\n```awaiting\nsteps:\n  - Approve the npm sign-in\n---\nThe publish follows once it lands.\n```"

async function withBoard(run: (board: BoardSnapshot) => void) {
  const root = mkdtempSync(join(tmpdir(), "frizz-done-then-park-"))
  const dir = join(root, "project")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: root, cwdSlug: "fixture" }
  const storage = createStorage(join(root, "ui.db"), "p")
  const thread = (slug: string, lines: string[], doneAtSecond: number) => {
    const row: SessionRow = { slug, session_id: `${slug}-sid`, thread_name: `frizz-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: at(9), title_auto: 1, title: `Thread ${slug}`, state: "open", meta: null, seen_at: null, transcript_id: null }
    storage.upsertSession(row)
    storage.setBackend(slug, "claude")
    writeFileSync(join(logDir, `${row.session_id}.jsonl`), lines.map((line) => line + "\n").join(""))
    storage.markThreadDone(slug, "- **Shipped** the release.", T0 + doneAtSecond * 1000)
  }
  // Done at 5s, then a steps park at 8s, with no human message in between.
  thread("parked-after-done", [prompt(1), reply(4, "Marking it done."), reply(8, STEPS)], 5)
  // Done at 5s, and the last word before it was a park: the completion is the newer statement.
  thread("done-after-park", [prompt(1), reply(4, STEPS)], 5)
  // Done at 5s, then plain prose: nothing took it back.
  thread("prose-after-done", [prompt(1), reply(8, "Signed off.")], 5)
  // Steps handed over at 2s, answered in words at 3s, done at 5s, and the human types again at 8s: the
  // completion no longer stands, but the step it gave up on is not owed again.
  thread("typed-after-done", [prompt(1), reply(2, STEPS), prompt(3), reply(4, "Skipping the sign-in as asked."), prompt(8)], 5)
  const tailer = createTailer({ project, storage, bus: new Bus(), onChange: () => {}, sessionLogDir: logDir, now: () => T0 + 120_000, brokerDaemonAlive: () => false, shellAlive: () => true })
  for (let i = 0; i < 200 && !storage.allSessions().every((row) => tailer.get(row.slug)); i++) tailer.tick()
  const board = createBoard(project, storage, new Bus(), tailer, "done-then-park", {
    now: () => T0 + 120_000,
    claudeBrokerDaemonAlive: () => false,
    subscribe: (async () => ({ unsubscribe: async () => {} })) as never,
  })
  try {
    run(await board.rebuild())
  } finally {
    await board.stop()
    tailer.stop()
    storage.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test("an awaiting fence written after `frizzctl done` takes the completion back", async () => {
  await withBoard((board) => {
    const view = (slug: string) => board.threads.find((t) => t.id === slug)
    const parked = view("parked-after-done")
    assert.equal(parked?.lastFence?.kind, "awaiting", "the newer park is the thread's state")
    assert.deepEqual(parked?.humanTodos?.filter((t) => !t.done).map((t) => t.text), ["Approve the npm sign-in"], "and its steps are owed, not hidden as finished")
    assert.equal(view("done-after-park")?.lastFence?.kind, "done", "a park older than the completion does not")
    assert.equal(view("done-after-park")?.lastFence?.registered, true)
    assert.equal(view("prose-after-done")?.lastFence?.registered, true, "prose after the completion leaves it standing")
    const typed = view("typed-after-done")
    assert.equal(typed?.lastFence?.registered, undefined, "the human's new message spends the completion")
    assert.deepEqual(typed?.humanTodos ?? [], [], "and the step it gave up on stays given up on")
  })
})

test("registeredDoneFence: a newer awaiting instant spends the row, an older one does not", () => {
  const done = { body: "done", doneAt: Date.parse("2026-10-22T17:13:16.000Z") }
  assert.equal(registeredDoneFence(done, undefined, "2026-10-22T17:16:51.000Z"), undefined)
  assert.equal(registeredDoneFence(done, undefined, "2026-10-22T17:10:00.000Z")?.kind, "done")
  assert.equal(registeredDoneFence(done, undefined, "not-a-date")?.kind, "done", "an unreadable instant is not evidence")
})
