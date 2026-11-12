// A MESSAGE "SEND TO QUEUE" HELD IS TYPED BEFORE THE REST IT IS RELEASED INTO. The record it lands as is
// stamped at the rest, after the steps or question that rest handed the human, and the fold read it as
// the human replying past both: the thread left the queue with the steps still owed and the question no
// longer standing (2026-11-11; reylo b6731fd4 released one 89ms after the rest that asked). The router
// keeps each release's send instant (delivery-ledger noteHeldRelease), and the tailer's projection reads
// the boundary back to it. Built on a real storage, tailer and board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GithubWatchStatus, ThreadView } from "@frizz/shared"
import { GITHUB_STATUS_SETTING } from "./awaiting.ts"
import { createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { noteHeldRelease } from "./delivery-ledger.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer } from "./tailer.ts"

const T0 = Date.now() - 60 * 60_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const PR = "acme/app#391"
const STEPS = "Two things are yours.\n\n```awaiting\nprs: [acme/app#391]\nfor: 180d\nsteps:\n  - Merge the PR.\n  - Delete the old branch.\n---\nReady.\n```"
const ASK = "Which name?\n\n```question\nid: q1\nkind: choice\nquestion: Which name?\noptions:\n  - label: A\n  - label: B\n```"
const QUIET = "```awaiting\nprs: [acme/app#391]\nstatus: watching\nfor: 180d\n```"
const GREEN: GithubWatchStatus = { checks: "passing", running: 0, passed: 9, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "mergeable", state: "open", polledAt: at(0) }
const user = (minute: number, text: string, uuid: string) => JSON.stringify({ type: "user", uuid, timestamp: at(minute), message: { role: "user", content: text } })
const reply = (minute: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(minute), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })

async function view(rest: string, opts: { held: boolean; ask?: boolean; said?: string }): Promise<ThreadView> {
  const root = mkdtempSync(join(tmpdir(), "frizz-held-release-"))
  const dir = join(root, "project")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: root, cwdSlug: "fixture" }
  const storage = createStorage(join(root, "ui.db"), "p")
  const slug = "t"
  const row: SessionRow = { slug, session_id: "t-sid", thread_name: "frizz-t", spawned_at: at(-60), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at(5), title_auto: 0, title: slug, state: "open", meta: null, seen_at: null, transcript_id: null }
  storage.upsertSession(row)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  storage.armPrWatch({ id: "prw_1", slug, owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(at(0)), expiresAtMs: Date.parse(at(0)) + 180 * 86_400_000 })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: GREEN })
  if (opts.ask) storage.askThreadQuestion({ id: "q1", slug, handle: "q1", askedAtMs: Date.parse(at(2)), spec: JSON.stringify({ handle: "q1", question: "Which name?", kind: "question", options: [{ label: "A" }, { label: "B" }] }) })
  // Typed at minute 1, mid-turn, with the send menu on "Send to queue"; released at the rest, minute 2.
  if (opts.held) noteHeldRelease(storage, slug, "d-held", Date.parse(at(1)))
  writeFileSync(join(logDir, "t-sid.jsonl"), [
    user(0, `own ${PR}`, "d-first"),
    reply(2, rest),
    user(2.01, opts.said ?? "also bump the version while you are at it", "d-held"),
    reply(5, QUIET),
  ].map((line) => line + "\n").join(""))
  const tailer = createTailer({ project, storage, bus: new Bus(), onChange: () => {}, sessionLogDir: logDir, now: () => T0 + 120 * 60_000, brokerDaemonAlive: () => true, shellAlive: () => true })
  for (let i = 0; i < 200 && !tailer.get(slug); i++) tailer.tick()
  const board = createBoard(project, storage, new Bus(), tailer, "held-release", { now: () => T0 + 120 * 60_000, claudeBrokerDaemonAlive: () => true, subscribe: (async () => ({ unsubscribe: async () => {} })) as never })
  try {
    return (await board.rebuild()).threads.find((t) => t.id === slug)!
  } finally {
    await board.stop()
    tailer.stop()
    storage.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test("a held message released into a steps rest leaves the steps holding the thread in the queue", async () => {
  const held = await view(STEPS, { held: true })
  assert.equal(held.needsYou, true, "the human sent it before the steps existed")
  assert.deepEqual(held.humanTodos?.filter((t) => !t.done).map((t) => t.text), ["Merge the PR.", "Delete the old branch."])
  // The control: the same words typed AFTER the rest are a reply past it.
  const typed = await view(STEPS, { held: false })
  assert.equal(typed.needsYou, false)
})

test("a held message released into a rest that asked a question leaves the question standing", async () => {
  const held = await view(`${ASK}\n\n${QUIET}`, { held: true, ask: true })
  assert.deepEqual(held.questions?.map((q) => [q.id, q.standing]), [["q1", true]])
  assert.equal(held.needsYou, true)
  const typed = await view(`${ASK}\n\n${QUIET}`, { held: false, ask: true })
  assert.deepEqual(typed.questions?.map((q) => [q.id, q.standing]), [["q1", false]])
})

// A STEPS REPORT IS AN ANSWER, NOT TYPING (shared isHumanTypedMessage), read here through the tailer's own
// projection of the fold (stepsDoneAt), which the board's handoff rule reads.
test("through the real tailer, a partial steps report holds the thread and a full one lets the quiet park go", async () => {
  const partial = await view(STEPS, { held: false, said: "Done 1 of 2:\n- [x] Merge the PR.\n- [ ] Delete the old branch." })
  assert.equal(partial.needsYou, true, "the report said the branch is not deleted")
  assert.equal(partial.heldHandoff, true)
  const all = await view(STEPS, { held: false, said: "Done" })
  assert.equal(all.needsYou, false, "every step reported done answers the handoff")
  assert.deepEqual(all.humanTodos?.filter((t) => !t.done).map((t) => t.text), [], "and the list owes nothing")
})
