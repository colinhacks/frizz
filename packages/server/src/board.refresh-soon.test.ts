// refreshSoon is how a tailer change reaches the board: a busy worker's events change it many times a
// second, and every refresh builds every thread's view. These pin the window — the first refresh at once,
// the rest of a burst as ONE refresh at its end — and that a refresh still due when the board stops never
// runs. The `prepare` callback is the observable: it runs exactly once per refresh that carries it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BOARD_REFRESH_MIN_MS, createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function row(slug: string): SessionRow {
  return { slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-07-01T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-refresh-soon-"))
  const project: Project = { dir, id: "project-refresh-soon", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "refresh-soon-boot")
  const refreshes = { n: 0 }
  const prepare = () => { refreshes.n++ }
  return {
    storage, board, refreshes, prepare,
    async close() {
      await board.stop()
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("refreshSoon: the first change refreshes at once, and the rest of its burst become one refresh at the window's end", async () => {
  const f = fixture()
  try {
    f.board.refreshSoon!(f.prepare)
    assert.equal(f.refreshes.n, 1, "a change after a quiet spell reaches the board in the caller's own stack")

    f.storage.upsertSession(row("late"))
    for (let i = 0; i < 20; i++) f.board.refreshSoon!(f.prepare)
    assert.equal(f.refreshes.n, 1, "the rest of the burst waits for the window")

    await wait(BOARD_REFRESH_MIN_MS + 60)
    assert.equal(f.refreshes.n, 2, "twenty changes inside the window cost one more build, not twenty")
    const { board } = await f.board.snapshotState()
    assert.ok(board.threads.some((t) => t.id === "late"), "and that build saw the latest state")

    await wait(BOARD_REFRESH_MIN_MS + 20)
    f.board.refreshSoon!(f.prepare)
    assert.equal(f.refreshes.n, 3, "once the window has passed, the next change is immediate again")
  } finally { await f.close() }
})

test("refreshSoon: a refresh still due when the board stops never runs", async () => {
  const f = fixture()
  try {
    f.board.refreshSoon!(f.prepare)
    f.board.refreshSoon!(f.prepare)
    await f.board.stop()
    await wait(BOARD_REFRESH_MIN_MS + 60)
    assert.equal(f.refreshes.n, 1, "the trailing refresh died with the board")
    f.board.refreshSoon!(f.prepare)
    assert.equal(f.refreshes.n, 1, "and a stopped board takes no new ones")
  } finally { await f.close() }
})
