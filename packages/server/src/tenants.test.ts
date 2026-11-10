import assert from "node:assert/strict"
import { test } from "node:test"
import type { AppContext, ContextOptions } from "./context.ts"
import type { Project } from "./project.ts"
import { captureLogRecords } from "./logging.ts"
import { createTenantMap } from "./tenants.ts"

function project(id: string, name = id): Project {
  return { dir: `/repos/${name}`, id, name, label: name, stateDir: `/state/${id}`, cwdSlug: `-repos-${name}` }
}

/** A context whose closeable parts record the order they were stopped in. */
function fakeContext(stopped: string[], overrides: Partial<Record<string, () => unknown>> = {}): AppContext {
  const mark = (n: string, fn?: () => unknown) => () => { stopped.push(n); return fn?.() }
  return {
    tailer: { stop: mark("tailer", overrides.tailer) },
    stopSubscriptions: mark("subscriptions", overrides.subscriptions),
    scheduler: { stop: mark("scheduler", overrides.scheduler) },
    board: { stop: mark("board", overrides.board) },
    codexAppServer: { shutdown: mark("bridge", overrides.bridge) },
    storage: { close: mark("storage", overrides.storage) },
  } as unknown as AppContext
}

test("activate opens a project once, and a second activate returns the same context", async () => {
  const stopped: string[] = []
  let built = 0
  const tenants = createTenantMap({ createContext: async () => { built++; return fakeContext(stopped) } })
  const a = await tenants.activate(project("p1"))
  const b = await tenants.activate(project("p1"))
  assert.ok(a)
  assert.equal(a, b, "the same context, not a second one over the same SQLite file")
  assert.equal(built, 1)
  assert.equal(tenants.active().length, 1)
})

// An attempt that fails before its first await has settled before it is recorded as in flight. It must
// not stay recorded, or every later activate of that project is handed the same failure.
test("a project that fails to open before anything is awaited can be opened again", async () => {
  let built = 0
  const errors: string[] = []
  const tenants = createTenantMap({
    createContext: () => {
      if (++built === 1) throw new Error("state dir is not readable")
      return Promise.resolve(fakeContext([]))
    },
    onError: (_project, error) => errors.push((error as Error).message),
  })
  assert.equal(await tenants.activate(project("p1")), undefined)
  assert.deepEqual(errors, ["state dir is not readable"])
  assert.ok(await tenants.activate(project("p1")))
  assert.equal(built, 2)
})

// Two viewers opening one project at the same instant must not race two contexts onto one database.
test("concurrent activations of one project build exactly one context", async () => {
  let built = 0
  const tenants = createTenantMap({
    createContext: async () => {
      built++
      await new Promise((r) => setTimeout(r, 5))
      return fakeContext([])
    },
  })
  const [a, b, c] = await Promise.all([
    tenants.activate(project("p1")),
    tenants.activate(project("p1")),
    tenants.activate(project("p1")),
  ])
  assert.equal(built, 1)
  assert.equal(a, b)
  assert.equal(b, c)
})

// A checkout renamed in the terminal keeps its id, so the registry hands the same id in at a new path.
// The context built at the old path would spawn every worker into a directory that is gone.
test("activating an open project at a different dir closes it and reopens it there", async () => {
  const stopped: string[] = []
  const built: string[] = []
  const tenants = createTenantMap({
    createContext: async ({ project }) => { built.push(project!.dir); return fakeContext(stopped) },
  })
  const before = await tenants.activate(project("p1", "hypergres"))
  const after = await tenants.activate(project("p1", "porg"))
  assert.ok(before && after)
  assert.notEqual(before, after, "a fresh context, built at the new path")
  assert.deepEqual(built, ["/repos/hypergres", "/repos/porg"])
  assert.equal(stopped.at(-1), "storage", "the old context was closed in the barrier's order")
  assert.equal(tenants.active().length, 1)
  assert.equal(tenants.active()[0].project.dir, "/repos/porg")
  assert.equal(await tenants.activate(project("p1", "porg")), after, "and the same path is a no-op again")
})

test("concurrent activations of a moved project build exactly one new context", async () => {
  let built = 0
  const tenants = createTenantMap({
    createContext: async () => {
      built++
      await new Promise((r) => setTimeout(r, 5))
      return fakeContext([])
    },
  })
  await tenants.activate(project("p1", "old"))
  const [a, b] = await Promise.all([tenants.activate(project("p1", "new")), tenants.activate(project("p1", "new"))])
  assert.equal(built, 2)
  assert.equal(a, b)
})

test("several projects are open at once and addressed by id", async () => {
  const tenants = createTenantMap({ createContext: async () => fakeContext([]) })
  await tenants.activate(project("p1", "frizz"))
  await tenants.activate(project("p2", "nub"))
  assert.equal(tenants.active().length, 2)
  assert.ok(tenants.get("p1"))
  assert.ok(tenants.get("p2"))
  assert.equal(tenants.get("nope"), undefined)
})

// THE POINT OF THE SEAM: one project that will not open is one dead card, not an outage.
test("a project that fails to open is reported, and the others keep serving", async () => {
  const failures: string[] = []
  const tenants = createTenantMap({
    createContext: async ({ project: p }) => {
      if (p?.id === "broken") throw new Error("ui.db is corrupt")
      return fakeContext([])
    },
    onError: (p, error) => failures.push(`${p.id}: ${(error as Error).message}`),
  })

  assert.ok(await tenants.activate(project("healthy")))
  const broken = await tenants.activate(project("broken"))

  assert.equal(broken, undefined, "activate reports rather than throwing")
  assert.deepEqual(failures, ["broken: ui.db is corrupt"])
  assert.equal(tenants.active().length, 1, "the healthy project is untouched")
  assert.ok(tenants.get("healthy"))
  // …and it can be retried once whatever was wrong is fixed.
  assert.equal(tenants.get("broken"), undefined)
})

test("deactivate stops one project's resources in the barrier's order, leaving the rest", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({ createContext: async () => fakeContext(stopped) })
  await tenants.activate(project("p1"))
  await tenants.activate(project("p2"))

  assert.equal(await tenants.deactivate("p1"), true)
  assert.deepEqual(stopped, [
    "tailer", "subscriptions", "scheduler", "board", "bridge", "storage",
  ])
  assert.equal(tenants.get("p1"), undefined)
  assert.ok(tenants.get("p2"), "the other project is still serving")
  assert.equal(await tenants.deactivate("p1"), false, "idempotent")
})

// The server gives up its claim on a project here, and a second server may open it the moment it does,
// so it has to come after the scheduler and storage — never while this one could still fire a timer.
test("afterDeactivate runs once the project's subsystems are closed, and a throw in it is reported", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({
    createContext: async () => fakeContext(stopped),
    afterDeactivate: (closed) => {
      stopped.push(`released ${closed.id}`)
      throw new Error("disk full")
    },
  })
  await tenants.activate(project("p1"))
  assert.equal(await tenants.deactivate("p1"), true)
  assert.deepEqual(stopped, ["tailer", "subscriptions", "scheduler", "board", "bridge", "storage", "released p1"])
})

// Storage is the handle that actually has to be released; a stuck subsystem before it must not strand it.
test("a subsystem that throws on close does not strand the ones after it", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({
    createContext: async () => fakeContext(stopped, { scheduler: () => { throw new Error("wedged") } }),
  })
  await tenants.activate(project("p1"))
  await tenants.deactivate("p1")
  assert.ok(stopped.includes("storage"), "storage still closed after an earlier phase threw")
  assert.deepEqual(stopped.slice(-2), ["bridge", "storage"])
})

test("a half-failed deactivate still removes the project from the map", async () => {
  const tenants = createTenantMap({
    createContext: async () => fakeContext([], { storage: () => { throw new Error("busy") } }),
  })
  await tenants.activate(project("p1"))
  await tenants.deactivate("p1")
  assert.equal(tenants.get("p1"), undefined, "never reachable again once its storage has been closed")
})

test("closeAll drains every project", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({ createContext: async () => fakeContext(stopped) })
  await tenants.activate(project("p1"))
  await tenants.activate(project("p2"))
  await tenants.closeAll()
  assert.equal(tenants.active().length, 0)
  assert.equal(stopped.filter((s) => s === "storage").length, 2)
})

// One project's scheduler finishing a tick used to hold up every project behind it, all on one six-second
// bound. Each scheduler here settles only once EVERY project's has been asked to stop, so closing them
// one after another never finishes.
test("closeAll closes the projects at once, each in its own order, and leaves the one it is told to", { timeout: 10_000 }, async () => {
  const ids = ["p1", "p2", "p3", "p4", "p5"]
  const stopped: string[] = []
  let asked = 0
  let everyoneAsked!: () => void
  const all = new Promise<void>((resolve) => { everyoneAsked = resolve })
  const built: string[] = []
  const tenants = createTenantMap({
    createContext: async (opts) => {
      const id = opts.project!.id
      built.push(id)
      const log: string[] = []
      const ctx = fakeContext(log, { scheduler: () => { if (++asked === ids.length - 1) everyoneAsked(); return all } })
      // Each project's own steps, tagged, in the one shared list.
      log.push = (...names: string[]) => stopped.push(...names.map((name) => `${id}:${name}`))
      return ctx
    },
  })
  for (const id of ids) await tenants.activate(project(id))
  await tenants.closeAll({ except: "p1" })
  assert.deepEqual(tenants.active().map((entry) => entry.project.id), ["p1"], "the launching project is the barrier's own to close")
  for (const id of ids.slice(1)) {
    assert.deepEqual(stopped.filter((step) => step.startsWith(`${id}:`)), ["tailer", "subscriptions", "scheduler", "board", "bridge", "storage"].map((step) => `${id}:${step}`))
  }
  assert.equal(stopped.filter((step) => step.startsWith("p1:")).length, 0)
  // Every scheduler was asked before any project went on to its board.
  assert.ok(stopped.lastIndexOf("p5:scheduler") < stopped.findIndex((step) => step.endsWith(":board")))
})

// A step that never returns leaves no record unless it is said while it is stuck: the process is ended
// with the step still running. And the projects beside it close regardless.
test("a project's step that is slow to close is named while it is stuck, and holds up no other project", { timeout: 10_000 }, async () => {
  const stopped: string[] = []
  let release!: () => void
  const wedged = new Promise<void>((resolve) => { release = resolve })
  const tenants = createTenantMap({
    slowCloseMs: 30,
    createContext: async (opts) => {
      const id = opts.project!.id
      const log: string[] = []
      const ctx = fakeContext(log, id === "p1" ? { board: () => wedged } : {})
      log.push = (...names: string[]) => stopped.push(...names.map((name) => `${id}:${name}`))
      return ctx
    },
  })
  await tenants.activate(project("p1", "slow-one"))
  await tenants.activate(project("p2", "quick-one"))
  const log = captureLogRecords()
  try {
    const closing = tenants.closeAll()
    const said = () => log.records.filter((record) => record.scope === "tenants")
    for (let i = 0; i < 200 && said().length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(said().map((record) => [record.level, record.message]), [["warn", "project slow-one: board has not closed after 30ms"]])
    assert.ok(stopped.includes("p2:storage"), "the project beside it has closed its storage meanwhile")
    assert.ok(!stopped.includes("p1:storage"), "and the slow one has not closed a database its board may still be using")
    release()
    await closing
    assert.equal(stopped.at(-1), "p1:storage")
    assert.equal(said().length, 2)
    // The stuck step leads, slowest first. On a loaded machine another step can cross the 1ms it takes to
    // be listed at all (`board 43ms, transports 3ms`, in a whole-suite run at load 44), so any that
    // follow are allowed.
    assert.match(said()[1]!.message, /^project slow-one took \d+ms to close: board \d+ms(, [a-z-]+ \d+ms)*$/)
    assert.ok(!log.messages().some((message) => message.includes("quick-one")), "a project that closed at once is not mentioned")
  } finally {
    log.restore()
  }
})

// An activated project that never starts its producers is a STATIC board: the RPC reads storage
// directly so its threads render, which is exactly what makes the omission look like it works.
test("activating a project starts its producers, and a producer that throws is reported not thrown", async () => {
  const started: string[] = []
  const ctxFor = (name: string) => ({ project: { id: name, name } }) as never
  const reported: string[] = []
  const map = createTenantMap({
    createContext: (opts) => ctxFor((opts.project as { id: string }).id),
    startProducers: async (ctx) => {
      const id = (ctx as unknown as { project: { id: string } }).project.id
      if (id === "bad") throw new Error("tailer would not start")
      started.push(id)
    },
    onError: (project) => reported.push(project.id),
  })

  assert.ok(await map.activate({ id: "good", name: "good" } as never))
  assert.deepEqual(started, ["good"], "the producers ran for the project that opened")

  assert.equal(await map.activate({ id: "bad", name: "bad" } as never), undefined)
  assert.deepEqual(reported, ["bad"], "the failure came back through the seam")
  assert.ok(map.get("good"), "and the project already serving is untouched")
  await map.closeAll()
})

// A tenant's options are copied by descriptor: `claudeBin` is a getter because the Claude Code a server
// runs can move while it serves (claude-float.ts), and a spread would freeze it at the tenant's opening.
test("a tenant's context reads the live Claude Code, not the one it opened with", async () => {
  let bin = "/runtimes/claude/2.1.321/claude"
  let seen: ContextOptions | undefined
  const tenants = createTenantMap({
    createContext: async (opts) => { seen = opts; return fakeContext([]) },
    contextOptions: { get claudeBin() { return bin } },
  })
  await tenants.activate(project("p1"))
  assert.equal(seen?.project?.id, "p1")
  assert.equal(seen?.claudeBin, "/runtimes/claude/2.1.321/claude")
  bin = "/runtimes/claude/2.1.322/claude"
  assert.equal(seen?.claudeBin, "/runtimes/claude/2.1.322/claude")
})
