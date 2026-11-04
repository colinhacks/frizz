import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveFrizzMcp } from "./dispatch.ts"
import { FRIZZ_MCP } from "./backend/types.ts"

// Drives the REAL cc-worker/bin/frizz-mcp.mjs over its real stdio JSON-RPC transport (no mocks, no
// re-implementation of the protocol) and — for the tool call — against a REAL http server standing in
// for frizz's /rpc/dispatch. This is what proves the unified server actually answers as `frizz` with a
// `spawn_thread` tool, i.e. that a worker sees `mcp__frizz__spawn_thread`.

interface Rpc {
  send(msg: unknown): void
  next(id: number): Promise<any>
  kill(): void
}

// `cwd` matters: with no FRIZZ_PROJECT_ID the shim derives its project by walking UP for `.frizz/.id`,
// so a child left in this repo would address frizz's own project. Default it to an empty temp dir —
// "a worker with no stamp and no project in its tree" — and let a test that wants the walk-up ask for it.
const UNSET_FRIZZ_IDENTITY = { FRIZZ_THREAD: "", FRIZZ_THREAD_SLUG: "", FRIZZ_STATE_DIR: "", FRIZZ_PERM_DIR: "", FRIZZ_SERVER_LOCK: "", FRIZZ_PROJECT_ID: "" }

function startServer(env: Record<string, string>, cwd = mkdtempSync(join(tmpdir(), "frizz-mcp-cwd-"))): Rpc {
  const descriptor = resolveFrizzMcp("/unused")
  assert.ok(descriptor, "the packaged frizz MCP script must be resolvable")
  const child = spawn(process.execPath, [descriptor.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    // The Frizz identity of the shell running the suite is BLANKED before the test's own is laid on.
    // Run from a worker, that shell names the real server (FRIZZ_SERVER_LOCK wins over the state dir
    // a test passes), the real project and the worker's own thread, so an unblanked spawn sends every
    // test's dispatch, steer and ask to the maintainer's board — two real opus threads per run.
    env: { ...process.env, ...UNSET_FRIZZ_IDENTITY, ...env },
  })
  const pending = new Map<number, (value: any) => void>()
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  return {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    next: (id) => new Promise((resolve) => pending.set(id, resolve)),
    kill: () => child.kill(),
  }
}

test("the frizz MCP server identifies as `frizz` and exposes its worker tools", async () => {
  const rpc = startServer({ FRIZZ_STATE_DIR: mkdtempSync(join(tmpdir(), "frizz-mcp-")) })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    const init = await rpc.next(1)
    // The mounted server NAME (dispatch.ts) is what forms the tool id the worker sees; serverInfo must
    // agree with it, or the two halves of `mcp__frizz__spawn_thread` drift apart.
    assert.equal(init.result.serverInfo.name, FRIZZ_MCP.name)

    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await rpc.next(2)
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["spawn_thread", "goal", "timer", "watch_pr", "watch", "unwatch", "ask", "unask", "done", "title", "activity", "link", "unlink", "watch_issue", "secret", "steer", "watch_command", "monitor", "threads", "spawn_child"])
    assert.deepEqual(list.result.tools.find((t: { name: string }) => t.name === "link").inputSchema.required, ["label", "target"])
    assert.deepEqual(list.result.tools.find((t: { name: string }) => t.name === "unlink").inputSchema.required, ["id"])
    for (const required of ["prompt", "model", "effort"]) {
      assert.ok(list.result.tools[0].inputSchema.required.includes(required))
    }
    // `goal` requires only `action` — `prompt` and a valid `every_seconds` are required for
    // `start` alone, enforced in the handler so a lenient client cannot skip them either (asserted
    // below). It exposes NO THREAD parameter: the slug comes from the server's env, never from the
    // model, which is what stops one thread arming a loop on another.
    assert.deepEqual(list.result.tools[1].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[1].inputSchema.properties).sort(),
      ["action", "heartbeat_seconds", "post_compaction", "prompt", "stop_hook"],
    )
    // The READ action is part of the advertised surface, not just the handler — a worker only reaches for
    // what `tools/list` shows it, and writing blind is what having no read at all produced.
    assert.deepEqual(list.result.tools[1].inputSchema.properties.action.enum, ["start", "stop", "get"])
    // `timer` is the same shape of tool and takes the same care: `action` alone is required, everything
    // else depends on which action, and it too exposes NO THREAD parameter.
    assert.deepEqual(list.result.tools[2].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[2].inputSchema.properties).sort(),
      ["action", "at", "id", "in_seconds", "prompt"],
    )
    // `watch_pr` — same shape as its siblings: `action` alone is required, and NO thread parameter a
    // model could aim elsewhere.
    assert.deepEqual(list.result.tools[3].inputSchema.required, ["action"])
    assert.deepEqual(list.result.tools[3].inputSchema.properties.action.enum, ["add", "list", "drop"])
    // `for` is REQUIRED for `add` (enforced in the handler, like its siblings): a PR watcher with no
    // expiry polls forever and holds whatever thread parked on it (2026-08-15).
    assert.deepEqual(
      Object.keys(list.result.tools[3].inputSchema.properties).sort(),
      ["action", "for", "id", "target"],
    )
    // `watch` / `unwatch` — TWO VERBS, not one action-switch, because a worker reaching for `unwatch`
    // should find `unwatch` (plans/rest-by-registration.md). This surface said "NO SHELL `watch` TOOL,
    // and there never will be" until 2026-08-26: a background shell was watched through a `shells:` line
    // in the ```awaiting fence, which is a DECLARATION with the lifetime of the message carrying it, so
    // the worker had to restate every wait at every rest. Registration replaces that.
    //
    // ALL THREE ARGUMENTS ARE REQUIRED, unlike every action-switch above, where `action` alone can be:
    // there is exactly one thing this call does, and none of the three has a defensible default — `for`
    // least of all, because a duration frizz picked would be a wait nobody chose.
    assert.deepEqual(list.result.tools[4].inputSchema.required, ["kind", "target", "for"])
    assert.deepEqual(list.result.tools[4].inputSchema.properties.kind.enum, ["shell", "agent"])
    assert.deepEqual(Object.keys(list.result.tools[4].inputSchema.properties).sort(), ["for", "kind", "target"])
    assert.deepEqual(list.result.tools[5].inputSchema.required, ["id"])
    assert.deepEqual(Object.keys(list.result.tools[5].inputSchema.properties), ["id"])
    // `ask` — RETIRED (2026-10-13): a question is a ```question fence in the worker's own message. The
    // tool stays, so a worker whose contract predates the fence is taught it by the refusal, but it takes
    // nothing and its description is one line.
    assert.deepEqual(Object.keys(list.result.tools[6].inputSchema.properties), [])
    assert.ok(!list.result.tools[6].description.includes("\n"), "a retired tool's description is one line")
    assert.match(list.result.tools[6].description, /^RETIRED \(2026-10-13\)/)
    assert.deepEqual(list.result.tools[7].inputSchema.required, ["id"])
    assert.deepEqual(Object.keys(list.result.tools[7].inputSchema.properties), ["id"])
    // `done` takes the write-up and its heading, and NOTHING ELSE. Its argument list is the assertion
    // that matters: there is no `force`, and no parameter for a worker to reach for when the gate refuses
    // it — a bypass riding the gated call gets learned, and the gate degrades to a two-token tax
    // (plans/rest-by-registration.md). `title` (2026-10-13) only heads the card; it changes nothing the
    // gate reads.
    assert.deepEqual(list.result.tools[8].inputSchema.required, ["body"])
    assert.deepEqual(Object.keys(list.result.tools[8].inputSchema.properties), ["body", "title"])
    // `title` takes ONLY the name. It exposes no thread parameter for `goal`'s reason — the slug comes
    // from the server's env — so a worker can rename its own thread and no other.
    assert.deepEqual(list.result.tools[9].inputSchema.required, ["title"])
    assert.deepEqual(Object.keys(list.result.tools[9].inputSchema.properties), ["title"])
    // `activity` READS every kind of background work with the ids a fence names them by, plus the
    // `wch_…` id of any watch holding one. It takes NOTHING: there is no thread parameter and no filter,
    // because the only correct answer is "everything you have running", and a worker that has lost its
    // ids cannot be trusted to name them.
    assert.equal(list.result.tools.length, 20)
    // `monitor` (2026-11-02) — `action` alone is required, and no thread parameter, like every registry.
    assert.deepEqual(list.result.tools[17].inputSchema.required, ["action"])
    assert.deepEqual(Object.keys(list.result.tools[17].inputSchema.properties), ["action", "command", "description", "for", "id"])
    // `threads` (2026-11-03) — a READ of any board, so nothing is required, and no caller parameter at all.
    assert.equal(list.result.tools[18].name, "threads")
    assert.deepEqual(list.result.tools[18].inputSchema.required, [])
    assert.deepEqual(Object.keys(list.result.tools[18].inputSchema.properties), ["project", "all", "json"])
    assert.deepEqual(list.result.tools[10].inputSchema.required, [])
    assert.deepEqual(Object.keys(list.result.tools[10].inputSchema.properties), [])
    // `watch_issue` — the issue twin of `watch_pr`, same shape: `action` alone is required, and NO thread
    // parameter a model could aim at somebody else's thread.
    assert.deepEqual(list.result.tools[13].inputSchema.required, ["action"])
    assert.deepEqual(Object.keys(list.result.tools[13].inputSchema.properties), ["action", "target", "for", "id"])
    // `secret` — RETIRED with `ask`: a value only the human holds is a `kind: secret` question fence.
    assert.deepEqual(Object.keys(list.result.tools[14].inputSchema.properties), [])
    assert.match(list.result.tools[14].description, /^RETIRED \(2026-10-13\).*`kind: secret`/)
    // `steer` — a target, its project when that is not the caller's, and a message. NO sender parameter: the receiver is told which thread sent it,
    // so the sender comes from the env alone.
    assert.deepEqual(list.result.tools[15].inputSchema.required, ["to", "message"])
    assert.deepEqual(Object.keys(list.result.tools[15].inputSchema.properties), ["to", "project", "message"])
    // `watch_command` — the server-run check (2026-10-11). `action` alone is required, and NO thread
    // parameter: the command runs for the calling thread only, under that thread's own permission gate.
    assert.deepEqual(list.result.tools[16].inputSchema.required, ["action"])
    assert.deepEqual(Object.keys(list.result.tools[16].inputSchema.properties), ["action", "command", "every", "for", "id"])

    // An unregistered name is a protocol error, not a crash — the registry routes by name now.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_frizz_thread", arguments: {} } })
    const gone = await rpc.next(3)
    assert.match(gone.error.message, /unknown tool: spawn_frizz_thread/)
  } finally {
    rpc.kill()
  }
})

test("`spawn_thread` POSTs the real dispatch RPC and returns the thread's drawer link", async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  // No caller identity in the env (the test may itself run inside a frizz worker, which sets both).
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "", FRIZZ_THREAD: "" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } },
    })
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined)
    assert.match(call.result.content[0].text, /\[Child\]\(\/thread\/spawned-child\)/)
    assert.deepEqual(seen, [{ url: "/_frizz/rpc/dispatch", body: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } }])

    // model/effort stay REQUIRED server-side, not only in the schema — a lenient client must not be
    // able to skip the deliberate choice.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_thread", arguments: { prompt: "x" } } })
    const bad = await rpc.next(3)
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /`spawn_thread` failed: `model` is required/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// THE WAY BACK: a spawned thread starts with nothing but its prompt, so the shim names the spawner at
// the end of it — without that slug the child could not `steer` its results back even when asked to.
test("`spawn_thread` names the spawning thread at the end of the prompt, so the child can steer back", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "the-coordinator" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high" } } })
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined)
    const prompt: string = seen[0].body.prompt
    assert.ok(prompt.startsWith("do the thing\n\n---\n"), "the task comes first, untouched")
    assert.match(prompt, /Spawned by the Frizz thread `the-coordinator`/)
    assert.match(prompt, /send it there with `frizzctl steer the-coordinator --message-file <file\|->`/)
    // …and the spawner is told the child can now reach it, and how to reach the child.
    assert.match(call.result.content[0].text, /It knows your slug/)
    assert.match(call.result.content[0].text, /with `frizzctl steer spawned-child`/)
  } finally {
    rpc.kill()
    http.close()
  }
})

test("`steer` POSTs steerThread from the CALLING thread, to a slug read out of any link form", async () => {
  const seen: Array<{ url: string; body: any }> = []
  let reply: unknown = { slug: "back-up-the-mac", title: "Back up the Mac", delivery: "resting" }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: reply }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "fresh-archive-audit" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    const forms = [
      "back-up-the-mac",
      "[Back up the Mac](/thread/back-up-the-mac)",
      "http://localhost:9393/project/frizz/thread/back-up-the-mac/full",
    ]
    for (const [i, to] of forms.entries()) {
      rpc.send({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "steer", arguments: { to, message: "  The audit found 3 issues.  " } } })
      const sent = await rpc.next(10 + i)
      assert.equal(sent.result.isError, undefined, to)
      // A board URL names the thread's project as well, and that rides along; the server finds the
      // thread there even when it is not the caller's project.
      const project = to.includes("/project/") ? { project: "frizz" } : {}
      assert.deepEqual(seen.at(-1), {
        url: "/_frizz/rpc/steerThread",
        body: { from: "fresh-archive-audit", to: "back-up-the-mac", ...project, message: "The audit found 3 issues." },
      }, to)
      assert.match(sent.result.content[0].text, /Delivered to «Back up the Mac» \(`back-up-the-mac`\)/)
      assert.match(sent.result.content[0].text, /woke it/)
      assert.match(sent.result.content[0].text, /do not rest waiting for it/)
    }
    reply = { slug: "back-up-the-mac", title: "Back up the Mac", delivery: "running" }
    rpc.send({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "steer", arguments: { to: "back-up-the-mac", message: "x" } } })
    assert.match((await rpc.next(20)).result.content[0].text, /next tool boundary/)

    // ANOTHER PROJECT: `project` is passed through, and a receipt naming one links the thread there.
    reply = { slug: "bump-the-sdk", title: "Bump the SDK", delivery: "resting", project: "nub" }
    rpc.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "steer", arguments: { to: "bump-the-sdk", project: "nub", message: "x" } } })
    const across = (await rpc.next(21)).result.content[0].text
    assert.deepEqual(seen.at(-1)?.body, { from: "fresh-archive-audit", to: "bump-the-sdk", project: "nub", message: "x" })
    assert.match(across, /Delivered to «Bump the SDK» \(`bump-the-sdk`\) on the `nub` project\./)
    assert.match(across, /\[Bump the SDK\]\(\/project\/nub\/thread\/bump-the-sdk\)/)
    // A `project` that contradicts the link's is a mistake to surface, not one to pick a side of.
    const sentBefore = seen.length
    rpc.send({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "steer", arguments: { to: "http://localhost:9393/project/frizz/thread/x/full", project: "nub", message: "x" } } })
    assert.match((await rpc.next(22)).result.content[0].text, /disagrees with the link, which names project `frizz`/)
    assert.equal(seen.length, sentBefore)

    // Both arguments are refused in the HANDLER, before anything reaches the server.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "steer", arguments: { to: "  ", message: "x" } } })
    assert.match((await rpc.next(30)).result.content[0].text, /`to` is required/)
    rpc.send({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "steer", arguments: { to: "a", message: " " } } })
    assert.match((await rpc.next(31)).result.content[0].text, /`message` is required/)
    assert.equal(seen.length, before)
  } finally {
    rpc.kill()
    http.close()
  }
})

// ONE frizz serves every project on the machine, and it publishes exactly ONE `server.lock` — the
// LAUNCHING project's. A worker in any other open project therefore has to be told two things it
// cannot derive: where that lock is, and which project it is acting for. Get the first wrong and every
// frizz tool dies on ENOENT (the observed break: nub, boron and pullfrog-app workers all reported
// "could not read the frizz server lock … ENOENT", and zod, which still had a stale lock from its own
// pre-singleton server, reported "dispatch request failed" against a dead port). Get the SECOND wrong
// and it is worse than an error: an unprefixed `/_frizz/rpc/dispatch` is the LAUNCHING project by
// definition, so the worker silently spawns its thread onto somebody else's board.
test("the tools address the CALLING project's RPC, at the lock the singleton actually publishes", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  // The lock lives in the LAUNCHER's state dir; this worker's own project dir has none, exactly as on
  // a real machine — so a run that still resolved the lock from FRIZZ_STATE_DIR fails here.
  const launcherStateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-launcher-"))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-tenant-"))
  writeFileSync(join(launcherStateDir, "server.lock"), JSON.stringify({ port }))
  const projectId = "b47f4055-4262-432a-af18-ded4cbfb3071"
  const rpc = startServer({
    FRIZZ_STATE_DIR: stateDir,
    FRIZZ_SERVER_LOCK: join(launcherStateDir, "server.lock"),
    FRIZZ_PROJECT_ID: projectId,
    FRIZZ_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high" } },
    })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    // Every tool travels the same transport, so the prefix has to be on the shared path and not only
    // on spawn's: a timer armed on the launcher's board would fire into a thread that is not ours.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(3)).result.isError, undefined)
    assert.deepEqual(seen, [`/_frizz/${projectId}/rpc/dispatch`, `/_frizz/${projectId}/rpc/listOwnThreadTimers`])
  } finally {
    rpc.kill()
    http.close()
  }
})

// AN UPDATE MUST REACH A WORKER THAT IS ALREADY RUNNING.
//
// This process lives in a DETACHED daemon that outlives frizz, so anything frozen into its env at spawn
// is stale the moment "Update & Restart" moves the port — and a worker whose only address was stale lost
// every frizz tool it had, with no way back short of restarting the worker. Both facts are therefore
// re-resolved from the filesystem on EVERY call: the address from the machine-wide lock, and the project
// from the tree the worker is standing in. Neither can be frozen, and neither can be named by the model.
test("a stale address heals itself: the machine lock wins when the stamped one is dead", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port

  // The frizz root, laid out as on a real machine: `<root>/server.lock` beside `<root>/projects/<id>/`.
  const root = mkdtempSync(join(tmpdir(), "frizz-mcp-root-"))
  const stateDir = join(root, "projects", "11111111-1111-4111-8111-111111111111")
  mkdirSync(stateDir, { recursive: true })
  // What the server stamped at spawn, now pointing at a DEAD process on a port nothing serves — exactly
  // the shape zod's lock had (pid 76070, gone since Aug 1), which reported only "fetch failed".
  const stale = join(root, "projects", "22222222-2222-4222-8222-222222222222")
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, "server.lock"), JSON.stringify({ pid: 999_999, port: port + 1 }))
  // The machine address, republished by the restart that moved the port.
  writeFileSync(join(root, "server.lock"), JSON.stringify({ pid: process.pid, port }))

  const rpc = startServer({
    FRIZZ_STATE_DIR: stateDir,
    FRIZZ_SERVER_LOCK: join(stale, "server.lock"),
    FRIZZ_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    FRIZZ_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined, "a dead stamped lock must not be fatal")
    assert.deepEqual(seen, ["/_frizz/11111111-1111-4111-8111-111111111111/rpc/listOwnThreadTimers"])
  } finally {
    rpc.kill()
    http.close()
  }
})

test("with no stamp at all, the project is the one the worker is STANDING IN", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: process.pid, port }))
  // A checkout with frizz's own identity file, and the worker two directories down inside it.
  const repo = mkdtempSync(join(tmpdir(), "frizz-mcp-repo-"))
  mkdirSync(join(repo, ".frizz"), { recursive: true })
  writeFileSync(join(repo, ".frizz", ".id"), "33333333-3333-4333-8333-333333333333\n")
  const deep = join(repo, "packages", "server")
  mkdirSync(deep, { recursive: true })

  // No FRIZZ_PROJECT_ID: this is a worker spawned by a server that predates the stamp.
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" }, deep)
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    assert.deepEqual(seen, ["/_frizz/33333333-3333-4333-8333-333333333333/rpc/listOwnThreadTimers"],
      "the id walked up from cwd, not the launching project")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The stop-hook tool's whole reason to exist is that it acts on the CALLING thread, which it can only
// learn from its env — so what this pins is the slug actually reaching the RPC body, over the real
// stdio transport against a real HTTP server. A tool that armed a hook on the wrong thread (or on none)
// would look identical to the worker, and would make some OTHER thread loop forever.
test("`goal` arms and disarms the CALLING thread, identified from its env", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "keep the migration moving" } },
    })
    const armed = await rpc.next(2)
    assert.equal(armed.result.isError, undefined)
    // NAMING NO TRIGGER defaults to the rest one. A `start` with neither is a model asking to be
    // re-prompted and leaving the mechanism to us; rest is the safe reading, because it cannot talk over
    // a running turn and cannot fire on a thread that has stopped needing it.
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep the migration moving", stopHook: true, heartbeat: false, postCompaction: false },
    })
    // The reply must teach how it ENDS, or a worker only knows how to start one — and it must warn
    // about the sign-off rather than merely offering it, since that exit files the thread away.
    assert.match(armed.result.content[0].text, /Run `frizzctl goal stop` once the work it drives is finished/)
    assert.match(armed.result.content[0].text, /```done/)
    assert.match(armed.result.content[0].text, /only when there is genuinely nothing left/)

    // BOTH triggers named on a schedule-only start, and the cadence carried through as seconds.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "check the deploy", heartbeat_seconds: 600 } },
    })
    const scheduled = await rpc.next(6)
    assert.equal(scheduled.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalSeconds: 600 },
    }, "giving a cadence and nothing else means the schedule trigger alone")
    assert.match(scheduled.result.content[0].text, /every 10m/)

    rpc.send({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "keep going", stop_hook: true, heartbeat_seconds: 900 } },
    })
    await rpc.next(7)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep going", stopHook: true, heartbeat: true, postCompaction: false, intervalSeconds: 900 },
    }, "both triggers at once is the ordinary keep-this-moving case")

    // NO QUESTION HOLD TO OPT OUT OF. A `pause_on_questions` argument held every trigger while the thread
    // was waiting on the human; it and the footer switch that inverted it were deleted 2026-08-16, so a
    // caller that still passes it is refused by the tool's own strict schema rather than silently ignored.
    rpc.send({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "beat me anyway", heartbeat_seconds: 600 } },
    })
    await rpc.next(8)
    assert.equal("pauseOnQuestions" in (seen.at(-1) as { body: Record<string, unknown> }).body, false)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goal", arguments: { action: "stop" } } })
    const stopped = await rpc.next(3)
    assert.equal(stopped.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: null, stopHook: false, heartbeat: false, postCompaction: false },
    })

    // A `start` with no prompt is refused in the HANDLER, not merely by the schema.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "goal", arguments: { action: "start" } } })
    const bare = await rpc.next(4)
    assert.equal(bare.result.isError, true)
    assert.match(bare.result.content[0].text, /`prompt` is required/)
    assert.equal(seen.length, before, "and nothing was sent to the server")

    // A bogus action likewise never reaches the RPC.
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "goal", arguments: { action: "pause" } } })
    const bogus = await rpc.next(5)
    assert.equal(bogus.result.isError, true)
    assert.match(bogus.result.content[0].text, /`action` must be one of/)
    assert.equal(seen.length, before)
  } finally {
    rpc.kill()
    http.close()
  }
})

// `title` is the CONSIDERED naming pass — the one a worker makes after reading the task, replacing the
// name frizz minted from the raw prompt at spawn. What this pins is the two things a worker gets wrong
// without them: that it can only ever name its OWN thread (the slug comes from the env, never from the
// model), and that a human's rename comes back as a REPORTED refusal rather than an error, because an
// error is the one answer a model retries against a call that can never succeed.
test("`title` names the CALLING thread, and a human's own name refuses it out loud", async () => {
  const seen: Array<{ url: string; body: any }> = []
  let reply: unknown = { accepted: true, title: "Audit the Zod 4.5 docs", lockedByHuman: false }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: reply }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "is-this-true-we-should-probably" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "title", arguments: { title: "  Audit the Zod 4.5 docs  " } },
    })
    const named = await rpc.next(2)
    assert.equal(named.result.isError, undefined)
    // THE SLUG IS THE ENV'S, not the model's — the tool exposes no thread parameter at all, which is what
    // stops one worker renaming another's thread. And the title is trimmed before it goes on the wire.
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadTitle",
      body: { slug: "is-this-true-we-should-probably", title: "Audit the Zod 4.5 docs" },
    })
    assert.match(named.result.content[0].text, /now named "Audit the Zod 4\.5 docs"/)

    // A HUMAN HAS NAMED IT: not an error, and the reply says plainly not to try again.
    reply = { accepted: false, title: "Named by hand", lockedByHuman: true }
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "title", arguments: { title: "Something else" } } })
    const refused = await rpc.next(3)
    assert.equal(refused.result.isError, undefined, "a human owning the name is a correct answer, not a failure")
    assert.match(refused.result.content[0].text, /Not renamed/)
    assert.match(refused.result.content[0].text, /outranks yours/)
    assert.match(refused.result.content[0].text, /do not run this again/)

    // An empty name is refused in the HANDLER, so a whitespace-only title never reaches the server.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "title", arguments: { title: "   " } } })
    const blank = await rpc.next(4)
    assert.equal(blank.result.isError, true)
    assert.match(blank.result.content[0].text, /`title` is required/)
    assert.equal(seen.length, before, "and nothing was sent to the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The READ action. A worker that can only WRITE its goal overwrites the human's own edit
// without ever seeing it, and after a compaction cannot tell an armed thread from an unarmed one. What
// this pins is that `get` reads the row back VERBATIM (a summary of your own instruction is as blind as
// no read at all), that it mutates nothing, and that a `start` names the row it superseded.
test("`goal` reads back what is armed, and a `start` reports what it replaced", async () => {
  const armed = {
    prompt: "the human's own words, edited in the footer",
    stopHook: true,
    heartbeat: true,
    postCompaction: false,
    intervalSeconds: 600,
    armedAt: "2026-08-06T10:00:00.000Z",
    lastRestFiredAt: "2026-08-06T11:00:00.000Z",
  }
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = req.url ?? ""
      seen.push({ url, body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        result: url.endsWith("/getOwnThreadRecurringPrompt")
          ? { recurringPrompt: armed }
          : { replaced: armed },
      }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/getOwnThreadRecurringPrompt", body: { slug: "owning-thread" } })
    const text: string = got.result.content[0].text
    // VERBATIM, or the read is worthless — this is the text a worker would have to retype to restore.
    assert.ok(text.includes(armed.prompt), text)
    assert.match(text, /stop_hook/)
    // The SAME cadence form `start` prints — one formatter, so a worker cannot be told "every 10m"
    // when it arms and "every 600s" when it reads back the very same number.
    assert.match(text, /every 10m/)
    assert.match(text, /last fired 2026-08-06T11:00:00\.000Z/)
    // A trigger that is OFF must not be listed as if it were live.
    assert.doesNotMatch(text, /post_compaction/)

    // An unarmed thread reads back as an explicit "nothing", never as an empty report.
    const empty = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ result: { recurringPrompt: null } }))
      })
    })
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve))
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (empty.address() as { port: number }).port }))
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const none = await rpc.next(3)
    assert.equal(none.result.isError, undefined)
    assert.match(none.result.content[0].text, /No goal is armed/)
    empty.close()

    // …and a `start` over an existing row hands the superseded words back, so an overwrite the worker
    // did not intend is visible in the same reply rather than silently gone.
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "my own new text" } },
    })
    const replaced = await rpc.next(4)
    assert.equal(replaced.result.isError, undefined)
    assert.match(replaced.result.content[0].text, /IT REPLACED an existing goal/)
    assert.ok(replaced.result.content[0].text.includes(armed.prompt), replaced.result.content[0].text)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A frizz server older than this tool 404s the read procedure. A bare HTTP status would read to a worker
// as "nothing is armed", which is the opposite of the truth — so the refusal has to say UNKNOWN.
test("`goal` get says the state is UNKNOWN against a server that predates the read", async () => {
  const http = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("no procedure getOwnThreadRecurringPrompt")
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const stale = await rpc.next(2)
    assert.equal(stale.result.isError, true)
    assert.match(stale.result.content[0].text, /UNKNOWN/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// The ONE-OFF TIMER, over the same real transport. What this pins is the CONVERSION the tool owns: a
// worker names a delay or an instant, and exactly one representation — the exact UTC instant — reaches
// the server, so the row, the delivered trailer and the tool's own reply can never name three times.
test("`timer` resolves in_seconds/at into one exact instant and POSTs the calling thread's slug", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { id: "tmr_abc", fireAt: "2026-08-04T15:00:00.000Z", timers: [] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const before = Date.now()
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "timer", arguments: { action: "set", prompt: "re-check the deploy", in_seconds: 600 } },
    })
    const set = await rpc.next(2)
    assert.equal(set.result.isError, undefined)
    assert.equal(seen.at(-1)!.url, "/_frizz/rpc/setOwnThreadTimer")
    assert.equal(seen.at(-1)!.body.slug, "owning-thread")
    assert.equal(seen.at(-1)!.body.prompt, "re-check the deploy")
    const fired = Date.parse(seen.at(-1)!.body.fireAt)
    // The window carries a tolerance because the MCP server is a SEPARATE PROCESS, and two processes'
    // `Date.now()` are not mutually ordered. Measured on Windows Server 2022 / node 26.7.0: the server
    // stamped its instant 5ms BEHIND a `before` this process had already captured, so a window with no
    // low-side slack failed every run there. The assertion's point is the magnitude — that `in_seconds`
    // is read as seconds from now, not milliseconds, minutes, or an epoch — and a second of slack on a
    // ten-minute delay still catches every one of those.
    const SKEW_MS = 1_000
    assert.ok(
      fired >= before + 600_000 - SKEW_MS && fired <= Date.now() + 600_000 + SKEW_MS,
      `fireAt ${seen.at(-1)!.body.fireAt} must be ~10 min out`,
    )
    // The reply has to carry the id (there is no other way to cancel) and say that it fires once.
    assert.match(set.result.content[0].text, /tmr_abc/)
    assert.match(set.result.content[0].text, /ONCE/)

    // An absolute instant is normalized to the same UTC form, so a worker cannot arm a row the trailer
    // and the scheduler would print differently.
    const at = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z")
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "set", prompt: "x", at } } })
    await rpc.next(3)
    assert.equal(seen.at(-1)!.body.fireAt, new Date(Date.parse(at)).toISOString())

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    await rpc.next(4)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/listOwnThreadTimers", body: { slug: "owning-thread" } })

    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "timer", arguments: { action: "cancel", id: "tmr_abc" } } })
    await rpc.next(5)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/cancelOwnThreadTimer", body: { slug: "owning-thread", id: "tmr_abc" } })

    // …and an invented thread argument never reaches the server, exactly as for `goal`.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "timer", arguments: { action: "list", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(6)
    assert.deepEqual(seen.at(-1)!.body, { slug: "owning-thread" })
  } finally {
    rpc.kill()
    http.close()
  }
})

// Every one of these is refused in the HANDLER, before any HTTP call — the same bar the cadence gets,
// and for the same reason: a lenient client must not be able to slip a nonsense alarm past the schema.
test("`timer` refuses a bad delay, a missing/doubled instant and a missing id without contacting the server", async () => {
  const seen: unknown[] = []
  const http = createServer((_req, res) => {
    seen.push(1)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: null }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const refused = async (id: number, args: Record<string, unknown>, pattern: RegExp) => {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "timer", arguments: args } })
      const reply = await rpc.next(id)
      assert.equal(reply.result.isError, true, JSON.stringify(args))
      assert.match(reply.result.content[0].text, pattern)
    }

    await refused(2, { action: "set", prompt: "x", in_seconds: 3 }, /must be between 10 and 2592000/)
    await refused(3, { action: "set", prompt: "x", in_seconds: 99_999_999 }, /must be between 10 and 2592000/)
    await refused(4, { action: "set", prompt: "x" }, /give either `--in-seconds`/)
    await refused(5, { action: "set", prompt: "x", in_seconds: 60, at: "2026-08-04T15:00:00Z" }, /not both/)
    await refused(6, { action: "set", in_seconds: 60 }, /`prompt` is required/)
    await refused(7, { action: "set", prompt: "x", at: "2020-01-01T00:00:00Z" }, /at least 10s in the future/)
    await refused(8, { action: "set", prompt: "x", at: "next tuesday" }, /must be an ISO-8601 instant/)
    await refused(9, { action: "cancel" }, /`id` is required/)
    await refused(10, { action: "snooze" }, /`action` must be one of/)

    assert.equal(seen.length, 0, "none of them reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A model can choose the TEXT of a goal but never the THREAD. The tool takes no thread parameter,
// so the only way it could act on someone else's is if a supplied argument leaked into the body.
test("`goal` ignores any thread the caller tries to name — the slug comes from the env alone", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "p", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(2)
    assert.equal(seen.at(-1)!.body.slug, "owning-thread", "an invented slug argument must not reach the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// Without a slug the tool must FAIL rather than guess — arming one on the wrong thread is worse than
// not arming one, and a silent no-op would read to the worker as success.
test("`goal` refuses to act when its thread identity was never stamped into its env", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: 1 }))
  // FRIZZ_THREAD is the documented fallback, so both vars have to be absent for this to hold.
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "", FRIZZ_THREAD: "" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "stop" } } })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /could not tell which thread is calling/)
  } finally {
    rpc.kill()
  }
})

// The CADENCE's own validation contract. The arm/disarm test above covers the trigger combinations;
// this one covers the number, because a schedule out of range is the input a model is most likely to
// invent — and it must be refused in the HANDLER, never merely by the schema, so a lenient client
// cannot slip one past.
test("`goal` refuses a cadence out of range without contacting the server", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", heartbeat_seconds: 5 } },
    })
    const tooFast = await rpc.next(2)
    assert.equal(tooFast.result.isError, true)
    assert.match(tooFast.result.content[0].text, /must be between 60 and 86400/)

    rpc.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", heartbeat_seconds: 99999 } },
    })
    const tooSlow = await rpc.next(3)
    assert.equal(tooSlow.result.isError, true)
    assert.match(tooSlow.result.content[0].text, /must be between 60 and 86400/)

    // Explicitly switching BOTH triggers off on a `start` is not an arming at all — it is a request to
    // be re-prompted by nothing. Refused, rather than silently writing a row that can never fire.
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", stop_hook: false } },
    })
    const noTrigger = await rpc.next(4)
    assert.equal(noTrigger.result.isError, true)
    assert.match(noTrigger.result.content[0].text, /at least one is required/)

    assert.equal(seen.length, 0, "none of the three reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})




// `watch` / `unwatch` OVER THE REAL STDIO TRANSPORT, same standard as `watch_pr` above and for the same
// reason: `tools/list` proves a worker can SEE `mcp__frizz__watch`, and proves nothing about whether
// calling it reaches the right procedure with the right shape.
test("`watch` and `unwatch` register and withdraw against the CALLING thread", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const armed = { id: "wch_abc123", kind: "shell", target: "bzvtnt3ig", label: "nub --test", createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T02:00:00.000Z" }
  const replies: any[] = [
    { id: "wch_abc123", kind: "shell", target: "bzvtnt3ig", alreadyArmed: false, watches: [armed] },
    { dropped: true, watches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "watch", arguments: { kind: "shell", target: "bzvtnt3ig", for: "2h" } },
    })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_frizz/rpc/addOwnWatch", body: { slug: "watching-thread", kind: "shell", target: "bzvtnt3ig", for: "2h" } })
    assert.match(added.result.content[0].text, /Watching `bzvtnt3ig` as wch_abc123/)
    // The read-back names the WORK, not just the handle: the label is frizz's live reading of what is
    // running behind that id, so a worker listing its waits sees what they are.
    assert.match(added.result.content[0].text, /wch_abc123 {2}shell: nub --test \(bzvtnt3ig\)/)
    // And it says what happens at the expiry, because the cancel-and-re-decide is the whole mechanism
    // that stops a registration outliving the reason it was made.
    assert.match(added.result.content[0].text, /WHEN `--for` RUNS OUT the row is CANCELLED/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unwatch", arguments: { id: "wch_abc123" } } })
    const dropped = await rpc.next(3)
    assert.deepEqual(seen[1], { url: "/_frizz/rpc/dropOwnWatch", body: { slug: "watching-thread", id: "wch_abc123" } })
    assert.match(dropped.result.content[0].text, /Watch wch_abc123 dropped/)
    assert.match(dropped.result.content[0].text, /No watches are armed on this thread/)

    // THE REFUSALS, all in the HANDLER rather than only in the schema — a lenient client must not be
    // able to register a wait that names nothing, or one with no expiry, and must not look like it did.
    const before = seen.length
    for (const [id, args, pattern] of [
      [4, { kind: "shell", for: "2h" }, /`target` is required/],
      [5, { kind: "shell", target: "bzvtnt3ig" }, /`for` is required/],
      [6, { kind: "process", target: "bzvtnt3ig", for: "2h" }, /`kind` must be "shell" or "agent"/],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "watch", arguments: args } })
      const refused = await rpc.next(id)
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, pattern)
    }
    rpc.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "unwatch", arguments: {} } })
    const noId = await rpc.next(7)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)
    assert.equal(seen.length, before, "not one of the four reached the server")

    // A PR, issue or timer id handed to `unwatch` reaches the call that really withdraws it, instead of
    // dropOwnWatch reporting it "already settled" while the row stayed armed on the rail.
    replies.push({ dropped: true, watches: [] }, { dropped: true, watches: [] }, { cancelled: true, timers: [] })
    for (const [n, id, url] of [
      [8, "prw_aaa111", "/_frizz/rpc/dropOwnPrWatch"],
      [9, "isw_bbb222", "/_frizz/rpc/dropOwnPrWatch"],
      [10, "tmr_ccc333", "/_frizz/rpc/cancelOwnThreadTimer"],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "unwatch", arguments: { id } } })
      const out = await rpc.next(n)
      assert.equal(out.result.isError, undefined)
      assert.deepEqual(seen[seen.length - 1], { url, body: { slug: "watching-thread", id } })
      assert.match(out.result.content[0].text, id.startsWith("tmr_") ? /Timer tmr_ccc333 cancelled/ : new RegExp(`Watcher ${id} dropped`))
    }
  } finally {
    rpc.kill()
    http.close()
  }
})

// `ask` AND `secret` OVER THE REAL STDIO TRANSPORT (retired 2026-10-13): each answers with the fence that
// replaced it, as an ordinary result rather than an error — the call did what it is for — and neither
// reaches the server, whatever it was given. `unask` still withdraws the CALLING thread's question, by
// the worker's own id.
test("`ask` and `secret` refuse with the fence, and `unask` withdraws the calling thread's question", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [{ withdrawn: true, open: [] }]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const spec = { question: "Land the parser refactor on `main`?", kind: "question", options: [{ label: "Land it", recommended: true }, { label: "Hold it" }] }
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask", arguments: { questions: [spec] } } })
    const asked = await rpc.next(2)
    assert.equal(asked.result.isError, undefined)
    assert.match(asked.result.content[0].text, /^NOT registered — `frizzctl ask` is retired/)
    assert.match(asked.result.content[0].text, /```question\nid: settings-store\n/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secret", arguments: { question: "The npm one-time code." } } })
    const secret = await rpc.next(3)
    assert.equal(secret.result.isError, undefined)
    assert.match(secret.result.content[0].text, /^NOT registered — `frizzctl secret` is retired/)
    assert.match(secret.result.content[0].text, /kind: secret/)
    assert.equal(seen.length, 0, "a retired tool reaches no server")

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "unask", arguments: { id: "settings-store" } } })
    const withdrawn = await rpc.next(4)
    assert.deepEqual(seen[0], { url: "/_frizz/rpc/unask", body: { slug: "asking-thread", id: "settings-store" } })
    assert.match(withdrawn.result.content[0].text, /Question settings-store withdrawn/)
    assert.match(withdrawn.result.content[0].text, /Nothing else is open on this thread/)

    // The refusal lives in the HANDLER, not only in the schema.
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "unask", arguments: {} } })
    const noId = await rpc.next(5)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)
    assert.equal(seen.length, 1, "it never reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `done` OVER THE REAL STDIO TRANSPORT. The refusal is the half worth pinning end to end: it is an
// ordinary RESULT rather than an error (a gate doing its job is not a fault), and it has to name every
// blocker by the id the worker resolves it with — otherwise the next move is a guess.
test("`done` marks the CALLING thread finished, and reports a refusal as an actionable result", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { done: false, blockingQuestions: [{ id: "qst_aaa111", question: "Ship it?" }], blockingWatches: [{ id: "wch_bbb222", what: "shell: nub --test (bzvtnt3ig)" }] },
    { done: true, blockingQuestions: [], blockingWatches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "finishing-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "done", arguments: { body: "- **Fixed** the parser" } } })
    const refused = await rpc.next(2)
    assert.deepEqual(seen[0], { url: "/_frizz/rpc/markOwnDone", body: { slug: "finishing-thread", body: "- **Fixed** the parser" } })
    // NOT an isError: the call reached the server and the server answered. A thrown fault would read as
    // a broken tool and invite a retry, when what is needed is two other tool calls.
    assert.equal(refused.result.isError, undefined)
    assert.match(refused.result.content[0].text, /NOT marked done/)
    assert.match(refused.result.content[0].text, /qst_aaa111 {2}Ship it\?/)
    assert.match(refused.result.content[0].text, /wch_bbb222 {2}shell: nub --test \(bzvtnt3ig\)/)
    assert.match(refused.result.content[0].text, /There is no force flag/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "done", arguments: { body: "- **Fixed** the parser" } } })
    const marked = await rpc.next(3)
    assert.match(marked.result.content[0].text, /Marked done/)
    // Marking done is not dismissal — the card sits in the queue until the human archives it.
    assert.match(marked.result.content[0].text, /NOTHING WAS CLOSED, HIDDEN OR ARCHIVED/)

    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "done", arguments: {} } })
    const noBody = await rpc.next(4)
    assert.equal(noBody.result.isError, true)
    assert.match(noBody.result.content[0].text, /`body` is required/)
    assert.equal(seen.length, before, "it never reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `watch_pr` OVER THE REAL STDIO TRANSPORT, against a real http server standing in for frizz's RPC.
//
// This is the test the tool-list assertion above is NOT: `tools/list` proves a worker can SEE
// `mcp__frizz__watch_pr`, and proves nothing about whether calling it does anything. The handler is a
// separate body of code that has to reach the right procedure with the right shape, and this file has
// caught that exact class of break before — an MCP server that threw at import, so every `mcp__frizz__*`
// tool was dead while every unit test stayed green (a temporal dead zone, 2026-08-12).
//
// What it pins: the CALLING THREAD's slug reaches the RPC body from the env and never from the model,
// each action hits its own procedure, and the two refusals happen in the HANDLER rather than only in the
// schema — a lenient client must not be able to register a watcher that can never fire.
test("`watch_pr` registers, lists and drops against the CALLING thread", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { id: "prw_abc123", target: "acme/app#391", alreadyArmed: false, watches: [{ id: "prw_abc123", target: "acme/app#391", state: "armed", createdAt: "2026-08-14T00:00:00.000Z" }] },
    {
      watches: [{
        id: "prw_abc123", target: "acme/app#391", state: "armed", createdAt: "2026-08-14T00:00:00.000Z",
        github: { checks: "failing", running: 0, passed: 9, failed: 2, failing: ["lint", "e2e"], merge: "blocked", state: "open", polledAt: "2026-08-14T00:05:00.000Z" },
      }],
    },
    { dropped: true, watches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#391", for: "2h" } },
    })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_frizz/rpc/addOwnPrWatch", body: { slug: "watching-thread", target: "acme/app#391", for: "2h" } })
    assert.match(added.result.content[0].text, /Watching acme\/app#391 as prw_abc123/)
    // It must TELL THE WORKER THE OTHER HALF. Registering is the wait; the fence is how it comes to rest
    // and shows the human — a worker that only registers sits in the queue being asked for a handoff.
    // The spelling is the LIVE grammar's `prs:` list (YAML frontmatter, 2026-08-24), not a retired kind.
    assert.match(added.result.content[0].text, /prs: \[acme\/app#391\]/)

    // `list` carries each PR's CHECK STATE, which is the reason a worker lists at all — "where do my PRs
    // stand" answered in one call rather than one `gh` round-trip per PR.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch_pr", arguments: { action: "list" } } })
    const listed = await rpc.next(3)
    assert.equal(seen[1].url, "/_frizz/rpc/listOwnPrWatches")
    assert.deepEqual(seen[1].body, { slug: "watching-thread" })
    assert.match(listed.result.content[0].text, /checks FAILING: lint, e2e/)

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "watch_pr", arguments: { action: "drop", id: "prw_abc123" } } })
    const dropped = await rpc.next(4)
    assert.deepEqual(seen[2], { url: "/_frizz/rpc/dropOwnPrWatch", body: { slug: "watching-thread", id: "prw_abc123" } })
    assert.match(dropped.result.content[0].text, /Watcher prw_abc123 dropped/)
    assert.match(dropped.result.content[0].text, /No pull requests are watched/)

    // THE REFUSALS, both in the handler. Neither reaches the server: a call that cannot name what it
    // wants must not create a row, and must not look like it did.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add" } } })
    const noTarget = await rpc.next(5)
    assert.equal(noTarget.result.isError, true)
    assert.match(noTarget.result.content[0].text, /`target` is required/)

    rpc.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "watch_pr", arguments: { action: "drop" } } })
    const noId = await rpc.next(6)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)

    rpc.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "watch_pr", arguments: { action: "watch" } } })
    const badAction = await rpc.next(7)
    assert.equal(badAction.result.isError, true)
    assert.equal(seen.length, before, "not one of the three reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// THE CLAMP HAS TO REACH THE WORKER'S EYES, and the reply text is the only place it can. A `for` above
// the ceiling is capped rather than refused — a fat-fingered `9999d` should still watch the PR — so
// without this the worker reads "Watching …", rests, and believes it holds coverage it does not have.
test("`watch_pr` reads back the expiry it actually got, and says so when the ceiling capped it", async () => {
  const replies: any[] = [
    { id: "prw_long01", target: "acme/app#391", alreadyArmed: false, expiresAt: "2027-03-01T00:00:00.000Z", watches: [] },
    { id: "prw_cap001", target: "acme/app#392", alreadyArmed: false, expiresAt: "2027-09-02T00:00:00.000Z", clampedFrom: "9999d", watches: [] },
  ]
  const http = createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#391", for: "180d" } } })
    const long = (await rpc.next(2)).result.content[0].text
    assert.match(long, /until 2027-03-01T00:00:00\.000Z/)
    assert.doesNotMatch(long, /WAS CAPPED/, "180d is inside the ceiling — there is no news here")

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#392", for: "9999d" } } })
    const capped = (await rpc.next(3)).result.content[0].text
    assert.match(capped, /YOUR `--for 9999d` WAS CAPPED/)
    assert.match(capped, /until 2027-09-02T00:00:00\.000Z/, "…and names what it actually holds instead")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `activity` IS THE ANSWER TO "I HAVE LOST MY IDS", so what it must do is print every kind of running
// work with the exact string an ```awaiting fence names it by — and say so plainly when there is none,
// because a fence naming nothing is not a park and a worker needs to be told that rather than left to
// invent one.
test("`activity` reads all four kinds back with the ids a fence names them by", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { activity: [
        { kind: "shell", id: "bzvtnt3ig", label: "Running the suite", since: "2026-08-15T09:00:00.000Z" },
        { kind: "agent", id: "toolu_agent1", label: "Reviewing the diff", since: "2026-08-15T09:01:00.000Z" },
        { kind: "timer", id: "tmr_a1b2c3", label: "check the deploy", since: "2026-08-15T09:02:00.000Z", until: "2026-08-15T10:00:00.000Z" },
        { kind: "pr", id: "acme/app#391", label: "acme/app#391", since: "2026-08-15T09:03:00.000Z" },
      ] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "busy-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    const text = got.result.content[0].text
    // The SLUG comes from the server's env, never from the model — same rule as every sibling tool.
    assert.deepEqual(seen, [{ url: "/_frizz/rpc/listOwnThreadActivity", body: { slug: "busy-thread" } }])
    // Every id, spelled exactly as its fence line must carry it.
    for (const id of ["bzvtnt3ig", "toolu_agent1", "tmr_a1b2c3", "acme/app#391"]) {
      assert.match(text, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${id} must be readable back`)
    }
    assert.match(text, /4 things running/)
    assert.match(text, /for:/, "…and it says what else the fence needs")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The empty case is the one that has to TEACH: a worker with nothing running cannot write an awaiting
// fence at all, and must be told which terminal state it is actually in rather than parking on nothing.
test("link and unlink use the calling thread; activity reads saved destinations separately from work", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const link = { id: "lnk_abc123", kind: "file", label: "Working plan", target: "/tmp/plan.md" }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      const result = req.url?.endsWith("upsertOwnLink") ? { link }
        : req.url?.endsWith("dropOwnLink") ? { dropped: true }
          : { activity: [], links: [link] }
      res.end(JSON.stringify({ result }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-links-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "link", arguments: { label: " Working plan ", target: " /tmp/plan.md ", slug: "foreign" } } })
    const added = await rpc.next(1)
    assert.equal(added.result.isError, undefined)
    assert.match(added.result.content[0].text, /lnk_abc123/)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const activity = (await rpc.next(2)).result.content[0].text
    assert.match(activity, /Nothing is running/)
    assert.match(activity, /lnk_abc123.*file: Working plan/)
    assert.match(activity, /not running work/)
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unlink", arguments: { id: link.id, slug: "foreign" } } })
    assert.match((await rpc.next(3)).result.content[0].text, /No file was deleted/)
    assert.deepEqual(seen, [
      { url: "/_frizz/rpc/upsertOwnLink", body: { slug: "owning-thread", label: "Working plan", target: "/tmp/plan.md" } },
      { url: "/_frizz/rpc/listOwnThreadActivity", body: { slug: "owning-thread" } },
      { url: "/_frizz/rpc/dropOwnLink", body: { slug: "owning-thread", id: link.id } },
    ])
    for (const [id, name, args] of [[4, "link", { label: "Only a label" }], [5, "unlink", {}]] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
      assert.equal((await rpc.next(id)).result.isError, true)
    }
    assert.equal(seen.length, 3, "missing arguments must not contact the server")
  } finally { rpc.kill(); http.close() }
})

test("`activity` with nothing running says so, and names the terminal states that remain", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { activity: [] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "idle-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    assert.match(got.result.content[0].text, /Nothing is running on this thread/)
    assert.match(got.result.content[0].text, /```done/)
    // A question is a ```question fence since 2026-10-13, and the copy points there, not at `ask`.
    assert.match(got.result.content[0].text, /ask a ```question if you need the human/)
    assert.doesNotMatch(got.result.content[0].text, /frizzctl ask/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A RESTART WINDOW MUST NOT SILENTLY EAT A WORKER'S INTENT.
//
// This process outlives every frizz restart, so a call landing while no server is up is ordinary rather
// than exceptional. What is NOT ordinary is what used to happen next: the error said "Is frizz running?"
// — a fact about the world — and the worker read it as diagnosis rather than as "your call did nothing",
// carried on, and rested. Measured 2026-08-17 on a real thread: a `recurring_prompt start` hit exactly
// this window, and the Goal that was keeping a long autonomous effort alive simply never existed.
test("with no server up, a tool call says NOTHING WAS SAVED and to retry — not just 'is frizz running?'", async () => {
  // A state dir whose lock names a pid that cannot be alive: the shim's own liveness probe rejects it,
  // then falls through every project lock, then gives up — the exact path the real failure took.
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-nolock-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: 2147483646, port: 1 }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "orphaned-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", stop_hook: true, prompt: "KEEP GOING." } },
    })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    const text = failed.result.content[0].text
    assert.match(text, /NOTHING WAS SAVED/, "the worker must learn its OWN call had no effect")
    assert.match(text, /RETRY this exact command/, "…and what to do about it")
    assert.match(text, /do not come to rest assuming it took/, "…and the failure mode to avoid")
  } finally {
    rpc.kill()
  }
})

// A SERVER THAT COMES UP DURING THE CALL IS CAUGHT, not failed into.
//
// This is the fix for the measured stall, and it is stronger than the message above it: the retry
// GUIDANCE only works if the model complies, while this works regardless. frizz replaces its own server
// routinely and this process outlives every one of those, so a call landing in the gap is ordinary —
// failing it reports frizz's own housekeeping as the worker's problem.
test("a call landing in a restart window waits for the server instead of failing", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    seen.push(req.url ?? "")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { timers: [] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port

  // The lock starts DEAD — a pid that cannot be alive — exactly as it reads mid-restart.
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-window-"))
  const lock = join(stateDir, "server.lock")
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, port: 1 }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "restarting-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    // Fire the call while nothing is up…
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    // …then bring the server up mid-flight, the way a restart finishes.
    await new Promise((r) => setTimeout(r, 800))
    writeFileSync(lock, JSON.stringify({ pid: process.pid, port }))
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined, "the window must be invisible to the worker")
    assert.deepEqual(seen, ["/_frizz/rpc/listOwnThreadTimers"], "and the call actually lands, once")
  } finally {
    rpc.kill()
    http.close()
  }
})

// THE QUESTIONS ARE READ OUT TOO, in their own section (maintainer 2026-08-28: "Is there a way for the
// agent to read out the current set of watchers and questions?"), each by the worker's own id where it
// has one — the id `unask` takes and a reference fence names — and a legacy `qst_…` where it does not.
// They do NOT reach the ready fence (2026-10-13): no rest has to name an open question any more.
test("`activity` reads the open questions back by the worker's own ids, and keeps them out of the fence", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: {
      activity: [{ kind: "shell", id: "bzvtnt3ig", label: "Running the suite", since: "2026-08-28T09:00:00.000Z" }],
      questions: [
        { id: "qst_ab12cd34ef56", handle: "settings-store", spec: { question: "Should the settings store use SQLite or a JSON file?", kind: "question", handle: "settings-store" }, askedAt: "2026-08-28T09:05:00.000Z" },
        { id: "qst_0011223344ff", spec: { question: "Which dist-tag should 4.5.0 publish under?", kind: "question" }, askedAt: "2026-08-28T09:05:00.000Z" },
      ],
    } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const text = (await rpc.next(2)).result.content[0].text
    assert.match(text, /2 questions still owed an answer/)
    assert.match(text, /question: settings-store\n {4}Should the settings store use SQLite or a JSON file\?/)
    assert.doesNotMatch(text, /qst_ab12cd34ef56/, "a question the worker named is read back by that name")
    assert.match(text, /question: qst_0011223344ff\n/, "a legacy row has only its minted id")
    assert.match(text, /a ```question fence carrying its `id:` alone/)
    const fence = text.slice(text.indexOf("```awaiting"), text.indexOf("```\n\nDrop the lines"))
    assert.match(fence, /shells: \[bzvtnt3ig\]/)
    assert.doesNotMatch(fence, /questions:/)
    assert.match(fence, /status: working/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// Nothing RUNNING but a question open is not the terminal state the empty readout describes: telling a
// worker to end with ```done there points it straight at a call frizz will refuse.
test("`activity` with only a question open does not send the worker to ```done", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { activity: [], questions: [
      { id: "qst_ab12cd34ef56", spec: { question: "Cut 4.5.0 now?", kind: "question" }, askedAt: "2026-08-28T09:05:00.000Z" },
    ] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const text = (await rpc.next(2)).result.content[0].text
    assert.match(text, /Nothing is RUNNING on this thread/)
    assert.match(text, /1 question still owed an answer/)
    assert.match(text, /qst_ab12cd34ef56/)
    assert.doesNotMatch(text, /End with ```done/, "an open question blocks done — do not point at it")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `watch_issue` OVER THE REAL STDIO TRANSPORT (2026-09-14) — the issue twin of the `watch_pr` case above,
// against the same three RPCs: the add carries `kind: "issue"`, and `list` reads back ONLY the issues.
test("`watch_issue` registers, lists and drops against the CALLING thread, and lists only issues", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { id: "isw_abc123", target: "acme/app#7", alreadyArmed: false, expiresAt: "2026-12-13T00:00:00.000Z", watches: [{ id: "isw_abc123", target: "acme/app#7", kind: "issue", state: "armed", createdAt: "2026-09-14T00:00:00.000Z" }] },
    {
      watches: [
        { id: "prw_zzz", target: "acme/app#391", kind: "pull", state: "armed", createdAt: "2026-09-14T00:00:00.000Z" },
        { id: "isw_abc123", target: "acme/app#7", kind: "issue", state: "armed", createdAt: "2026-09-14T00:00:00.000Z", issue: { state: "open", title: "Crash on start", comments: 3, polledAt: "2026-09-14T00:05:00.000Z" } },
      ],
    },
    { dropped: true, watches: [{ id: "prw_zzz", target: "acme/app#391", kind: "pull", state: "armed", createdAt: "2026-09-14T00:00:00.000Z" }] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "watch_issue", arguments: { action: "add", target: "https://github.com/acme/app/issues/7", for: "90d" } } })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_frizz/rpc/addOwnPrWatch", body: { slug: "watching-thread", target: "https://github.com/acme/app/issues/7", for: "90d", kind: "issue" } })
    assert.match(added.result.content[0].text, /Watching issue acme\/app#7 as isw_abc123 until 2026-12-13/)
    assert.match(added.result.content[0].text, /issues: \[acme\/app#7\]/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch_issue", arguments: { action: "list" } } })
    const listed = await rpc.next(3)
    assert.equal(seen[1].url, "/_frizz/rpc/listOwnPrWatches")
    assert.match(listed.result.content[0].text, /isw_abc123  acme\/app#7  "Crash on start"  —  open, 3 comments/)
    assert.doesNotMatch(listed.result.content[0].text, /prw_zzz/, "a PR is not listed by the issue tool")

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "watch_issue", arguments: { action: "drop", id: "isw_abc123" } } })
    const dropped = await rpc.next(4)
    assert.deepEqual(seen[2], { url: "/_frizz/rpc/dropOwnPrWatch", body: { slug: "watching-thread", id: "isw_abc123" } })
    assert.match(dropped.result.content[0].text, /Watcher isw_abc123 dropped/)
    assert.match(dropped.result.content[0].text, /No issues are watched/)

    // The handler's own refusals: no `for` is refused before the server is contacted.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "watch_issue", arguments: { action: "add", target: "acme/app#7" } } })
    const noFor = await rpc.next(5)
    assert.equal(noFor.result.isError, true)
    assert.match(noFor.result.content[0].text, /`for` is required/)
    assert.equal(seen.length, before)
  } finally {
    rpc.kill()
    http.close()
  }
})
