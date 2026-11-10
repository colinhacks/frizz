import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseThreadMessage, type BoardSnapshot } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Bus, Emitter } from "./bus.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { registerProject } from "./project-registry.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"

// `frizzctl steer` ACROSS PROJECTS. The call lands on the sender's own project, which verifies the sender
// and finds the target; a target in another project is delivered by THAT project's router, through the
// inbox it binds on its context (AppContext.threadInbox) and the server lists per open project
// (activeTenants). Two real routers over two real storages here, wired the way index.ts wires them, so
// what is pinned is the seam itself: the receiver's own delivery path runs, against its own rows.

const NUB = "0b1f3a52-58c4-4c6e-9d0e-7f8a2b3c4d5e"
const FRIZZ = "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
const ZOD = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"

/**
 * A sandbox home the router will actually read: target resolution reaches the registry through helpers
 * that default their `home` to `homedir()`, so the sandbox has to be `$HOME` itself or the run reads the
 * maintainer's own registry. node's runner gives each test FILE its own process.
 */
function homeSandbox(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-cross-steer-"))
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
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-26T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, permission_mode: null,
  }
}

const idleTailer = {
  get: () => ({ turn: "idle" }), foreignIds: () => [], subAgent: () => undefined,
  forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
} as unknown as Tailer

/** One project's router over its own storage, with a codex app-server stub that records what it is handed. */
function tenant(home: string, id: string, name: string) {
  const dir = join(home, "code", name)
  mkdirSync(dir, { recursive: true })
  registerProject({ dir, id }, home)
  const project: Project = { dir, id, name, label: name, stateDir: dir, cwdSlug: name }
  const storage = createStorage(join(dir, "ui.db"), id)
  const snapshot = { threads: [] } as unknown as BoardSnapshot
  const board = { refresh: () => snapshot, snapshot: async () => snapshot } as unknown as BoardManager
  const sent: Array<{ threadSlug: string; sessionId: string; text: string }> = []
  const tenants: Array<ReturnType<NonNullable<AppContext["activeTenants"]>>[number]> = []
  const ctx = {
    project, storage, board, tailer: idleTailer,
    transcriptChange: new Emitter<string[]>(),
    bus: new Bus(),
    codexAppServer: {
      binding: () => ({ state: "active", currentTurnId: null }),
      turnLiveness: () => undefined,
      resumeOwnedSession: async () => {},
      followUp: async (input: { threadSlug: string; sessionId: string; text: string }) => void sent.push(input),
    },
    activeTenants: () => tenants,
  } as unknown as AppContext
  const router = createRouter(ctx)
  const thread = (slug: string, title?: string, runs: { mode?: string; backend?: "claude" | "codex" } = {}) => {
    storage.upsertSession({ ...row(slug), permission_mode: runs.mode ?? null })
    storage.setBackend(slug, runs.backend ?? "codex")
    storage.setCodexRuntime(slug, "app-server")
    if (title) storage.setTitle(slug, title)
  }
  return { project, storage, ctx, router, sent, tenants, thread }
}

/** Open every tenant in every other's view, the way the server's tenant map lists them. */
function serve(...all: Array<ReturnType<typeof tenant>>) {
  for (const t of all) {
    t.tenants.push(...all.map((o) => ({ project: o.project, board: o.ctx.board, storage: o.storage, threadInbox: o.ctx.threadInbox })))
  }
  return () => { for (const t of all) t.storage.close() }
}

test("a bare slug that lives only in another project is delivered there, by that project's router, and names the sender's project", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  const close = serve(frizz, nub)
  t.after(close)
  frizz.thread("audit-the-relay", "Audit the relay")
  nub.thread("bump-the-sdk", "Bump the SDK")

  const receipt = await frizz.router.steerThread.handler({ input: { from: "audit-the-relay", to: "bump-the-sdk", message: "The relay needs 0.3.311." } })

  assert.deepEqual(receipt, { slug: "bump-the-sdk", title: "Bump the SDK", delivery: "resting", project: "nub" })
  assert.equal(frizz.sent.length, 0, "nothing is delivered on the sender's own board")
  assert.equal(nub.sent.length, 1)
  assert.equal(nub.sent[0].sessionId, "sid-bump-the-sdk", "the target's CURRENT session, read from its own project")
  assert.deepEqual(parseThreadMessage(nub.sent[0].text), {
    slug: "audit-the-relay", title: "Audit the relay", project: "frizz", body: "The relay needs 0.3.311.",
  })
  assert.match(nub.sent[0].text, /run `frizzctl steer audit-the-relay --project frizz`\./, "the reply is addressed back across")

  // …and the reply, sent the way the guidance says, lands back on the first project's board.
  const back = await nub.router.steerThread.handler({ input: { from: "bump-the-sdk", to: "audit-the-relay", project: "frizz", message: "Bumped." } })
  assert.equal(back.project, "frizz")
  assert.equal(frizz.sent.length, 1)
  assert.equal(parseThreadMessage(frizz.sent[0].text)?.project, "nub")
})

test("this project wins a slug both have, and `project` reaches the other one by slug or by id", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  t.after(serve(frizz, nub))
  frizz.thread("sender")
  frizz.thread("fix-tests")
  nub.thread("fix-tests")

  const local = await frizz.router.steerThread.handler({ input: { from: "sender", to: "fix-tests", message: "here" } })
  assert.equal(local.project, undefined, "the thread beside the sender, as before steer crossed projects")
  assert.equal(frizz.sent.length, 1)
  assert.equal(parseThreadMessage(frizz.sent[0].text)?.project, undefined, "a same-project message names no project")

  await frizz.router.steerThread.handler({ input: { from: "sender", to: "fix-tests", project: "nub", message: "there" } })
  await frizz.router.steerThread.handler({ input: { from: "sender", to: "fix-tests", project: NUB, message: "there, by id" } })
  assert.deepEqual(nub.sent.map((s) => parseThreadMessage(s.text)?.body), ["there", "there, by id"])

  // Naming the sender's OWN project is the local thread, and its own slug there is still itself.
  await frizz.router.steerThread.handler({ input: { from: "sender", to: "fix-tests", project: "frizz", message: "own project, named" } })
  assert.equal(frizz.sent.length, 2)
  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "sender", project: "frizz", message: "me" } }),
    /That is your own thread/,
  )
  // The same slug in ANOTHER project is a different thread, not the sender.
  nub.thread("sender")
  await frizz.router.steerThread.handler({ input: { from: "sender", to: "sender", project: "nub", message: "my namesake" } })
  assert.equal(nub.sent.at(-1)?.threadSlug, "sender")
})

test("refusals name the fix: an ambiguous slug, an unknown project, a closed one, a missing thread", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  const zod = tenant(home, ZOD, "zod")
  // zod is registered but NOT open in this process: only frizz and nub are served.
  t.after(serve(frizz, nub))
  t.after(() => zod.storage.close())
  frizz.thread("sender")
  nub.thread("shared-name")
  zod.thread("shared-name")
  const other = tenant(home, "c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e9f", "other")
  t.after(() => other.storage.close())
  other.thread("shared-name")
  frizz.tenants.push({ project: other.project, board: other.ctx.board, storage: other.storage, threadInbox: other.ctx.threadInbox })

  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "shared-name", message: "which?" } }),
    /no thread `shared-name` in this project, and 2 other projects have one \(`nub`, `other`\)\. Pass `--project <slug>`/,
  )
  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "shared-name", project: "nope", message: "x" } }),
    /no project `nope` on this machine.*the projects are .*`nub`/,
  )
  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "shared-name", project: "zod", message: "x" } }),
    /project `zod` is registered but not open in this Frizz/,
  )
  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "no-such-thread", project: "nub", message: "x" } }),
    /no thread `no-such-thread` in project `nub`/,
  )
  await assert.rejects(
    frizz.router.steerThread.handler({ input: { from: "sender", to: "no-such-thread", message: "x" } }),
    /no thread `no-such-thread` in this project or any other open one/,
  )
  assert.equal(nub.sent.length + zod.sent.length + other.sent.length + frizz.sent.length, 0, "a refused steer reaches no worker")
})

// `frizzctl steer` runs unasked in every permission mode, so it is how a thread the human narrowed can
// ask one that asks nobody to act for it. The receiver is told, where the two modes can be compared.
test("a message from a thread in a tighter mode says so to the receiver: same harness only, on this board or across", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, FRIZZ, "frizz")
  const nub = tenant(home, NUB, "nub")
  t.after(serve(frizz, nub))
  frizz.thread("narrowed", undefined, { mode: "default" })
  frizz.thread("peer", undefined, { mode: "bypassPermissions" })
  frizz.thread("open", undefined, { mode: "bypassPermissions" })
  frizz.thread("unknown")
  frizz.thread("other-harness", undefined, { mode: "default", backend: "claude" })
  nub.thread("far", undefined, { mode: "bypassPermissions" })
  const steer = async (from: string, to: string, on = frizz) => {
    await frizz.router.steerThread.handler({ input: { from, to, message: "Push the branch." } })
    return on.sent.at(-1)!.text
  }
  const mark = /That thread runs in `default` permission mode, tighter than yours \(`bypassPermissions`\)/

  assert.match(await steer("narrowed", "open"), mark)
  assert.match(await steer("narrowed", "far", nub), mark, "the sender's own project says what it runs as")
  assert.doesNotMatch(await steer("peer", "open"), /permission mode/, "equals are colleagues")
  assert.doesNotMatch(await steer("open", "narrowed"), /permission mode/, "and so is a looser sender")
  assert.doesNotMatch(await steer("unknown", "open"), /permission mode/, "a row with no recorded mode claims nothing")
  assert.doesNotMatch(await steer("other-harness", "open"), /permission mode/, "the modes of two harnesses do not compare")
})
