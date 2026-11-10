// An ARCHIVED thread's ```done fence travels on the board as its body's head (shared fence-head.ts), and
// the whole body is one per-thread read away (router `threadRegisteredDone`). A live thread's fence, and
// any ```awaiting fence, is carried whole. Built on a real storage, tailer and board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyBoardDelta, doneFenceBodyHead, type BoardSnapshot, type ServerEvent } from "@frizz/shared"
import { createBoard, registeredDoneFence } from "./board.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer } from "./tailer.ts"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"

const T0 = Date.now() - 60 * 60_000
const at = (second: number) => new Date(T0 + second * 1000).toISOString()
const prompt = (second: number) => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: "go" } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })

const LEDGER = "title: Resolver cache keyed on the normalized id\n---\n**Fixed** the resolver cache.\n\n- keyed on the normalized id\n- a test that fails without it\n\nLanded on `main` as abc123."
const FENCED = "Work.\n\n```done\n## Landed\nThe cache fix.\n\n- one\n- two\n```"
const AWAITING = "Work.\n\n```awaiting\nWaiting on CI for the fix.\n\nIt takes a while.\n```"

function sessionRow(slug: string, over: Partial<SessionRow>): SessionRow {
  return { slug, session_id: `${slug}-sid`, thread_name: `frizz-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: at(3), title_auto: 1, title: `Thread ${slug}`, state: "archived", meta: null, seen_at: null, transcript_id: null, ...over }
}

async function withBoard(run: (h: { board: BoardSnapshot; events: ServerEvent[]; rebuild: () => Promise<BoardSnapshot>; storage: ReturnType<typeof createStorage> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "frizz-archived-fence-"))
  const dir = join(root, "project")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: root, cwdSlug: "fixture" }
  const storage = createStorage(join(root, "ui.db"), "p")
  const thread = (slug: string, lines: string[], over: Partial<SessionRow>) => {
    const row = sessionRow(slug, over)
    storage.upsertSession(row)
    storage.setBackend(slug, "claude")
    writeFileSync(join(logDir, `${row.session_id}.jsonl`), lines.map((line) => line + "\n").join(""))
  }
  thread("registered-archived", [prompt(1), reply(3, "All done.")], { state: "archived" })
  storage.markThreadDone("registered-archived", LEDGER, T0 + 10_000)
  thread("registered-open", [prompt(1), reply(3, "All done.")], { state: "open" })
  storage.markThreadDone("registered-open", LEDGER, T0 + 10_000)
  thread("fenced-archived", [prompt(1), reply(3, FENCED)], { state: "archived" })
  thread("awaiting-archived", [prompt(1), reply(3, AWAITING)], { state: "archived" })
  const tailer = createTailer({ project, storage, bus: new Bus(), onChange: () => {}, sessionLogDir: logDir, now: () => T0 + 120_000, brokerDaemonAlive: () => false, shellAlive: () => true })
  for (let i = 0; i < 200 && !storage.allSessions().every((row) => tailer.get(row.slug)); i++) tailer.tick()
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((event) => { events.push(event) })
  const board = createBoard(project, storage, bus, tailer, "fence-boot", {
    now: () => T0 + 120_000,
    claudeBrokerDaemonAlive: () => false,
    subscribe: (async () => ({ unsubscribe: async () => {} })) as never,
  })
  try {
    await run({ board: await board.rebuild(), events, rebuild: () => board.rebuild(), storage })
  } finally {
    await board.stop()
    tailer.stop()
    storage.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const byId = (b: BoardSnapshot, id: string) => b.threads.find((t) => t.id === id)!

test("an archived thread's registered done carries its body's head on the board, and its whole length", async () => {
  await withBoard(async ({ board, storage }) => {
    const whole = registeredDoneFence(storage.getThreadDone("registered-archived"), undefined)!
    const fence = byId(board, "registered-archived").lastFence!
    assert.equal(fence.kind, "done")
    assert.equal(fence.registered, true)
    assert.deepEqual(fence.hints, whole.hints, "the title hint is kept")
    assert.equal(fence.body, "**Fixed** the resolver cache.\n\n-")
    assert.equal(fence.body, doneFenceBodyHead(whole.body))
    assert.equal(fence.bodyElided, whole.body.length)
    // …and what `threadRegisteredDone` answers (router.ts) is the whole body the board cut.
    assert.ok(whole.body.length > fence.body.length && whole.body.includes("Landed on `main`"))
  })
})

test("an open thread's registered done, and any awaiting fence, are carried whole", async () => {
  await withBoard(async ({ board }) => {
    const open = byId(board, "registered-open").lastFence!
    assert.equal(open.bodyElided, undefined)
    assert.match(open.body, /Landed on `main` as abc123\.$/)
    const awaiting = byId(board, "awaiting-archived").lastFence!
    assert.equal(awaiting.kind, "awaiting")
    assert.equal(awaiting.bodyElided, undefined)
    assert.match(awaiting.body, /It takes a while\./)
  })
})

test("an archived thread's fenced done is cut too: the transcript draws its card from the message", async () => {
  await withBoard(async ({ board }) => {
    const fence = byId(board, "fenced-archived").lastFence!
    assert.equal(fence.kind, "done")
    assert.equal(fence.registered, undefined)
    assert.equal(fence.body, "## Landed\nT", "the heading mark and its line: what the phone's Done row reads")
    assert.ok(fence.bodyElided! > fence.body.length)
  })
})

test("reopening and re-archiving moves the fence between whole and head, and the deltas say so", async () => {
  await withBoard(async ({ board: keyframe, events, rebuild, storage }) => {
    const client: BoardSnapshot = JSON.parse(JSON.stringify(keyframe))
    storage.setState("registered-archived", "open")
    const reopened = await rebuild()
    assert.equal(byId(reopened, "registered-archived").lastFence!.bodyElided, undefined)
    assert.match(byId(reopened, "registered-archived").lastFence!.body, /Landed on `main`/)
    storage.setState("registered-archived", "archived")
    const archived = await rebuild()
    assert.equal(byId(archived, "registered-archived").lastFence!.body, "**Fixed** the resolver cache.\n\n-")
    for (const event of events) if (event.type === "board-delta") applyBoardDelta(client, event)
    assert.deepEqual(JSON.parse(JSON.stringify(byId(client, "registered-archived"))), JSON.parse(JSON.stringify(byId(archived, "registered-archived"))))
  })
})

test("threadRegisteredDone answers the whole body the board cut, and null for a thread with none", async () => {
  await withBoard(async ({ board, storage }) => {
    const ctx = {
      project: { dir: "/nowhere", id: "p", name: "fixture", label: "fixture", stateDir: "/nowhere", cwdSlug: "fixture" },
      storage,
      board: { snapshot: async () => board },
      tailer: { get: () => undefined },
      scheduler: { kick: () => {} },
      getSettings: () => ({}),
    } as unknown as AppContext
    const router = createRouter(ctx)
    const { body } = await router.threadRegisteredDone.handler({ input: { slug: "registered-archived" } })
    const cut = byId(board, "registered-archived").lastFence!
    assert.equal(body!.length, cut.bodyElided)
    assert.equal(doneFenceBodyHead(body!), cut.body)
    assert.equal(body, registeredDoneFence(storage.getThreadDone("registered-archived"), undefined)!.body)
    assert.doesNotMatch(body!, /^title:/, "the title is the fence's hint, not the card's first line")
    assert.deepEqual(await router.threadRegisteredDone.handler({ input: { slug: "fenced-archived" } }), { body: null })
  })
})
