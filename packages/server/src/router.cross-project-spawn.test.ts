import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { BoardSnapshot, DispatchInput } from "@frizz/shared"
import type { AuditRecord } from "./audit.ts"
import type { BoardManager } from "./board.ts"
import { Bus, Emitter } from "./bus.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { registerProject } from "./project-registry.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"

// `frizzctl spawn-thread --project` (2026-10-28). The call lands on the spawner's own project, which
// verifies the spawner, finds the named project and writes the footer naming the way back; the thread is
// then dispatched by THAT project's router, through the spawner it binds on its context
// (AppContext.threadSpawner) and the server lists per open project (activeTenants). Two real routers over
// two real storages, wired the way index.ts wires them; only each project's dispatcher is a recorder.

const NUB = "0b1f3a52-58c4-4c6e-9d0e-7f8a2b3c4d5e"
const FRIZZ = "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
const ZOD = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"

/** A sandbox home the router will actually read — see router.cross-project-steer.test.ts. */
function homeSandbox(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-cross-spawn-"))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function row(slug: string): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-28T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, permission_mode: null,
  }
}

const idleTailer = {
  get: () => ({ turn: "idle" }), foreignIds: () => [], subAgent: () => undefined,
  forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
} as unknown as Tailer

/** One project's router over its own storage, with a dispatcher and an audit log that record what they get. */
function tenant(home: string, id: string, name: string) {
  const dir = join(home, "code", name)
  mkdirSync(dir, { recursive: true })
  registerProject({ dir, id }, home)
  const project: Project = { dir, id, name, label: name, stateDir: dir, cwdSlug: name }
  const storage = createStorage(join(dir, "ui.db"), id)
  const snapshot = { threads: [] } as unknown as BoardSnapshot
  const board = { refresh: () => snapshot, snapshot: async () => snapshot } as unknown as BoardManager
  const dispatched: Array<{ input: DispatchInput; backend: unknown }> = []
  const audited: AuditRecord[] = []
  const tenants: Array<ReturnType<NonNullable<AppContext["activeTenants"]>>[number]> = []
  const ctx = {
    project, storage, board, tailer: idleTailer,
    transcriptChange: new Emitter<string[]>(),
    bus: new Bus(),
    dispatcher: {
      dispatch: async (input: DispatchInput, opts: { backend?: unknown }) => {
        dispatched.push({ input, backend: opts.backend })
        return { slug: `new-in-${name}`, sessionId: `sid-new-in-${name}` }
      },
    },
    audit: { append: (record: AuditRecord) => void audited.push(record) },
    activeTenants: () => tenants,
  } as unknown as AppContext
  const router = createRouter(ctx)
  const thread = (slug: string, title?: string) => {
    storage.upsertSession(row(slug))
    if (title) storage.setTitle(slug, title)
  }
  return { project, storage, ctx, router, dispatched, audited, tenants, thread }
}

/** Open every tenant in every other's view, the way the server's tenant map lists them. */
function serve(...all: Array<ReturnType<typeof tenant>>) {
  for (const t of all) {
    t.tenants.push(...all.map((o) => ({ project: o.project, board: o.ctx.board, storage: o.storage, threadInbox: o.ctx.threadInbox, threadSpawner: o.ctx.threadSpawner })))
  }
  return () => { for (const t of all) t.storage.close() }
}

const ask = { model: "opus", effort: "high" as const, prompt: "Bump the SDK pin to 0.3.312.", title: "Bump the SDK" }

test("a spawn naming another project is dispatched by THAT project's router, with a footer that steers back across", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  t.after(serve(frizz, nub))
  frizz.thread("audit-the-relay", "Audit the relay")

  const made = await frizz.router.spawnThread.handler({ input: { ...ask, backend: "claude", from: "audit-the-relay", project: "nub" } })

  assert.deepEqual(made, { slug: "new-in-nub", sessionId: "sid-new-in-nub", project: "nub" })
  assert.equal(frizz.dispatched.length, 0, "nothing starts on the spawner's own board")
  assert.equal(nub.dispatched.length, 1)
  const [{ input, backend }] = nub.dispatched
  assert.equal(backend, "claude")
  assert.deepEqual({ ...input, prompt: undefined }, { model: "opus", effort: "high", title: "Bump the SDK", backend: "claude", prompt: undefined })
  assert.equal(
    input.prompt,
    "Bump the SDK pin to 0.3.312.\n\n---\nSpawned by the Frizz thread `audit-the-relay`, on the `frizz` project's board. If this prompt " +
    "asks for results back, or you find something that thread must know, send it there with " +
    "`frizzctl steer audit-the-relay --project frizz --message-file <file|->`.",
  )

  // Each project's log says its own half: the request where it was made, the dispatch where it landed.
  const request = frizz.audited.find((r) => r.action === "spawnThread")
  assert.equal(request?.outcome, "ok")
  assert.equal(request?.thread, "audit-the-relay")
  assert.equal(request?.detail?.toProject, "nub")
  assert.equal(request?.detail?.spawnedIn, "nub")
  assert.equal(frizz.audited.some((r) => r.action === "dispatch"), false)
  const landed = nub.audited.find((r) => r.action === "dispatch")
  assert.equal(landed?.thread, "new-in-nub")
  assert.equal(landed?.project.id, NUB)
  assert.deepEqual(landed?.detail?.spawnedBy, { thread: "audit-the-relay", project: "frizz" })
})

test("a project named by registry id is the same project, and naming your own is an ordinary spawn here", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  t.after(serve(frizz, nub))
  frizz.thread("sender")

  const byId = await frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: NUB } })
  assert.equal(byId.project, "nub")
  assert.equal(nub.dispatched.length, 1)

  const own = await frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "frizz" } })
  assert.deepEqual(own, { slug: "new-in-frizz", sessionId: "sid-new-in-frizz" }, "no project in the receipt: the thread is beside the spawner")
  assert.equal(frizz.dispatched.length, 1)
  assert.match(frizz.dispatched[0].input.prompt, /Spawned by the Frizz thread `sender`\. .*`frizzctl steer sender --message-file <file\|->`\.$/s,
    "a same-project footer names no project, as the command's own footer does not")
})

test("a registered project nobody has opened yet is opened for the spawn, as a request to it would be", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const zod = tenant(home, ZOD, "zod")
  t.after(serve(frizz))
  t.after(() => zod.storage.close())
  frizz.thread("sender")
  const asked: string[] = []
  frizz.ctx.openProject = async (id) => {
    asked.push(id)
    frizz.tenants.push({ project: zod.project, board: zod.ctx.board, storage: zod.storage, threadInbox: zod.ctx.threadInbox, threadSpawner: zod.ctx.threadSpawner })
    return true
  }

  const made = await frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "zod" } })
  assert.deepEqual(asked, [ZOD])
  assert.equal(made.project, "zod")
  assert.equal(zod.dispatched.length, 1)

  // Open now, so a second spawn does not ask again; and one that will not open is still refused.
  await frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "zod" } })
  assert.deepEqual(asked, [ZOD])
  const nub = tenant(home, NUB, "nub")
  t.after(() => nub.storage.close())
  frizz.ctx.openProject = async () => false
  await assert.rejects(
    frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "nub" } }),
    /project `nub` is registered but not open in this Frizz/,
  )
  assert.equal(nub.dispatched.length, 0)
})

test("refusals name the fix and start nothing: an unknown caller, an unknown project, a closed one, one not ready", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  const zod = tenant(home, ZOD, "zod")
  // zod is registered but NOT open in this process: only frizz and nub are served.
  t.after(serve(frizz, nub))
  t.after(() => zod.storage.close())
  frizz.thread("sender")

  await assert.rejects(
    frizz.router.spawnThread.handler({ input: { ...ask, from: "not-a-thread", project: "nub" } }),
    /the calling thread not-a-thread is not registered in this project/,
  )
  await assert.rejects(
    frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "nope" } }),
    /no project `nope` on this machine.*the projects are .*`nub`/,
  )
  await assert.rejects(
    frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "zod" } }),
    /project `zod` is registered but not open in this Frizz.*so no thread can be started there from here/,
  )
  // Open, but its router has not bound a spawner yet (a tenant mid-activation).
  frizz.tenants.splice(frizz.tenants.findIndex((open) => open.project.id === NUB), 1, { project: nub.project, board: nub.ctx.board, storage: nub.storage })
  await assert.rejects(
    frizz.router.spawnThread.handler({ input: { ...ask, from: "sender", project: "nub" } }),
    /project `nub` is open in Frizz but not taking new threads yet; retry in a moment/,
  )

  assert.equal(frizz.dispatched.length + nub.dispatched.length + zod.dispatched.length, 0, "a refused spawn starts no thread")
  assert.deepEqual(frizz.audited.map((r) => [r.action, r.outcome]), Array(4).fill(["spawnThread", "refused"]))
})
