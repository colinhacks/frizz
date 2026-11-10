import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app.ts"
import type { AppContext } from "./context.ts"
import {
  CALLER_HEADER,
  auditLogPathForStateDir,
  audited,
  encodeCallerStamp,
  fileAuditLog,
  settingsChange,
  type AuditLog,
  type AuditRecord,
} from "./audit.ts"
import { callerAccess } from "./remote-gate.ts"

// The audit trail exists because a stolen board session added `/private/tmp`, dispatched workers into
// it and removed it again, and nothing recorded any of it (2026-10-08). These drive the REAL app: the
// request-origin middleware, the router's procedures, and the record they leave.

const PORT = 49_311
const PROMPT = "deploy with token sk-live-THIS-MUST-NEVER-BE-LOGGED"

function capture(): AuditLog & { records: AuditRecord[] } {
  const records: AuditRecord[] = []
  return { records, append: (record) => void records.push(record) }
}

function auditApp(audit: AuditLog | undefined, dispatch: () => Promise<{ slug: string; sessionId: string }>, storage: object = {}) {
  const inert = new Proxy({}, { get: () => () => {} })
  const ctx = {
    bootId: "audit-test-boot",
    project: { id: "served-project", dir: "/repos/served", stateDir: "/state/served", cwdSlug: "-repos-served", name: "served", label: "served" },
    bus: inert,
    transcriptChange: inert,
    storage: new Proxy(storage, { get: (target, name) => (target as Record<string | symbol, unknown>)[name] ?? (() => {}) }),
    interactions: inert,
    board: inert,
    tailer: inert,
    dispatcher: { dispatch },
    backendFor: () => inert,
    scheduler: inert,
    getSettings: () => ({}),
    setSettings: (settings: unknown) => settings,
    resetSettings: () => ({}),
    audit,
  } as unknown as AppContext
  return createApp(ctx, { port: PORT })
}

function rpc(
  app: ReturnType<typeof auditApp>,
  name: string,
  input: unknown,
  headers: Record<string, string> = {},
  env?: { remoteAddress?: string },
) {
  return app.request(
    `http://127.0.0.1:${PORT}/_frizz/rpc/${name}`,
    {
      method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    },
    env,
  )
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

test("a read-and-answer dispatch never runs: the refusal names the procedure, the session and the device, and no prompt", async () => {
  const sink = capture()
  let dispatched = 0
  const app = auditApp(sink, async () => { dispatched++; return { slug: "deploy-it", sessionId: "sess-1" } })
  const stamp = encodeCallerStamp({ via: "public", remote: "127.0.0.1", host: "colin.frizz.sh", clientIp: "203.0.113.9", session: "Ab3dE9xY", access: "read-and-answer" })
  const response = await rpc(app, "dispatch", { prompt: PROMPT }, { [CALLER_HEADER]: stamp, "user-agent": IPHONE })
  assert.equal(response.status, 403)
  assert.equal(dispatched, 0)

  assert.equal(sink.records.length, 1)
  const [record] = sink.records
  assert.equal(record!.action, "remoteRefused")
  assert.equal(record!.outcome, "refused")
  assert.deepEqual(record!.detail, { procedure: "dispatch" })
  assert.deepEqual(record!.project, { id: "served-project", dir: "/repos/served" })
  assert.equal(record!.servedBy, "served-project")
  assert.deepEqual(record!.origin, {
    via: "public",
    remote: "127.0.0.1",
    host: "colin.frizz.sh",
    clientIp: "203.0.113.9",
    session: "Ab3dE9xY",
    access: "read-and-answer",
    device: "Safari on iPhone",
  })
  assert.ok(!JSON.stringify(record).includes("sk-live"), JSON.stringify(record))
})

test("a dispatch from a device with full control runs, and the record says which session asked at which level", async () => {
  const sink = capture()
  let dispatched = 0
  const app = auditApp(sink, async () => { dispatched++; return { slug: "deploy-it", sessionId: "sess-1" } })
  const stamp = encodeCallerStamp({ via: "public", remote: "127.0.0.1", host: "colin.frizz.sh", clientIp: "203.0.113.9", session: "Ab3dE9xY", access: "full" })
  const response = await rpc(app, "dispatch", { prompt: PROMPT }, { [CALLER_HEADER]: stamp, "user-agent": IPHONE })
  assert.equal(response.status, 200)
  assert.equal(dispatched, 1)
  const record = sink.records.find((one) => one.action === "dispatch")!
  assert.equal(record.outcome, "ok")
  assert.deepEqual(record.origin, { via: "public", remote: "127.0.0.1", host: "colin.frizz.sh", clientIp: "203.0.113.9", session: "Ab3dE9xY", access: "full", device: "Safari on iPhone" })
  assert.ok(!JSON.stringify(record).includes("sk-live"), JSON.stringify(record))
})

test("a dispatch from this machine records its origin, its permission mode, and the prompt only as a digest", async () => {
  const sink = capture()
  const app = auditApp(sink, async () => ({ slug: "deploy-it", sessionId: "sess-1" }), { getSession: () => ({ permission_mode: "bypassPermissions" }) })
  const stamp = encodeCallerStamp({ via: "loopback", remote: "127.0.0.1", session: null })
  const response = await rpc(app, "dispatch", { prompt: PROMPT }, { [CALLER_HEADER]: stamp, "user-agent": IPHONE })
  assert.equal(response.status, 200)

  assert.equal(sink.records.length, 1)
  const [record] = sink.records
  assert.equal(record!.action, "dispatch")
  assert.equal(record!.outcome, "ok")
  assert.equal(record!.thread, "deploy-it")
  assert.equal(record!.detail?.permissionMode, "bypassPermissions")
  assert.deepEqual(record!.project, { id: "served-project", dir: "/repos/served" })
  assert.equal(record!.origin.via, "loopback")
  assert.match(record!.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.deepEqual(record!.detail?.prompt, {
    chars: PROMPT.length,
    sha256: createHash("sha256").update(PROMPT).digest("hex"),
  })
  // The text itself is nowhere in the record — not even a fragment of the secret it carried.
  assert.ok(!JSON.stringify(record).includes("sk-live"), JSON.stringify(record))
})

test("a request no proxy stamped is recorded as direct, with the peer the server accepted", async () => {
  const sink = capture()
  const app = auditApp(sink, async () => ({ slug: "local", sessionId: "sess-2" }))
  const response = await rpc(app, "dispatch", { prompt: "hello" }, { "user-agent": "node" }, { remoteAddress: "127.0.0.1" })
  assert.equal(response.status, 200)
  assert.deepEqual(sink.records[0]!.origin, { via: "direct", remote: "127.0.0.1", session: null, device: "unknown device" })
})

// It read as `direct` until 2026-11-09, and `direct` is this machine with full control. That is the wrong
// way to fail: the proxy lives in the launcher, which updates separately from the server, so a stamp a
// newer launcher writes and this build cannot read would have made its public callers local.
test("a stamp that does not decode is not believed, and is not this machine either: it is the most limited caller", async () => {
  const sink = capture()
  let ran = false
  const app = auditApp(sink, async () => { ran = true; return { slug: "forged", sessionId: "sess-3" } })
  for (const stamp of [Buffer.from(JSON.stringify({ via: "ceo", session: "x" })).toString("base64url"), "not base64 json at all"]) {
    const response = await rpc(app, "dispatch", { prompt: "hello" }, { [CALLER_HEADER]: stamp }, { remoteAddress: "127.0.0.1" })
    assert.equal(response.status, 403, stamp)
    assert.equal(callerAccess(stamp), "read-and-answer", stamp)
  }
  assert.equal(ran, false, "nothing was dispatched")
  assert.deepEqual(sink.records.map((record) => [record.action, record.outcome]), [["remoteRefused", "refused"], ["remoteRefused", "refused"]])
  assert.deepEqual(sink.records[0]!.origin, { via: "public", remote: "127.0.0.1", session: null, access: "read-and-answer", host: "unreadable caller stamp", device: "unknown device" })
  // No stamp at all is still a caller that never passed the proxy, which is this machine.
  assert.equal(callerAccess(undefined), "local")
  assert.equal(callerAccess(""), "local")
})

test("a settings change is recorded by key, and by value only for the two keys that decide what a later action may do", () => {
  const before = { permissionMode: "auto", localFileOpener: "system", preamble: "be terse", notifications: true }
  assert.deepEqual(settingsChange(before, { ...before, permissionMode: "bypassPermissions", preamble: "PRIVATE WORDS" }), {
    changed: ["permissionMode", "preamble"],
    permissionMode: { from: "auto", to: "bypassPermissions" },
  })
  assert.deepEqual(settingsChange(before, { permissionMode: "auto", preamble: "be terse", notifications: true, launchPrefix: "nice" }), {
    changed: ["launchPrefix", "localFileOpener"],
    localFileOpener: { from: "system", to: null },
  })
  assert.deepEqual(settingsChange(before, { ...before }), { changed: [] })
  assert.ok(!JSON.stringify(settingsChange(before, { ...before, preamble: "PRIVATE WORDS" })).includes("PRIVATE"), "a value that is the operator's words is never recorded")
})

test("a refused dispatch is recorded with its error, and the caller still gets that error", async () => {
  const sink = capture()
  const app = auditApp(sink, async () => { throw new Error("Claude is signed out") })
  const response = await rpc(app, "dispatch", { prompt: "hello" })
  assert.equal(response.status, 500)
  assert.equal(((await response.json()) as { error: string }).error, "Claude is signed out")
  assert.equal(sink.records[0]!.outcome, "refused")
  assert.equal(sink.records[0]!.error, "Claude is signed out")
  assert.equal(sink.records[0]!.thread, undefined)
})

test("an audit log that cannot be written never fails the action", async () => {
  let dispatched = 0
  const broken: AuditLog = { append: () => { throw new Error("ENOSPC: no space left on device") } }
  const app = auditApp(broken, async () => { dispatched++; return { slug: "still-runs", sessionId: "sess-4" } })
  const response = await rpc(app, "dispatch", { prompt: "hello" })
  assert.equal(response.status, 200)
  assert.deepEqual(((await response.json()) as { result: unknown }).result, { slug: "still-runs", sessionId: "sess-4" })
  assert.equal(dispatched, 1)

  // Nor does a field that cannot be read, or a result describer that throws.
  const sink = capture()
  const value = await audited(sink, "projectRemove", () => { throw new Error("registry unreadable") }, () => 7, {
    onResult: () => { throw new Error("bad describer") },
  })
  assert.equal(value, 7)
  // The action is still recorded, thinner, with what went wrong in place of what could not be read.
  assert.equal(sink.records[0]!.outcome, "ok")
  assert.equal(sink.records[0]!.detail?.auditError, "bad describer")
  sink.records.length = 0
  await assert.rejects(audited(sink, "projectRemove", () => { throw new Error("registry unreadable") }, () => { throw new Error("refused") }))
  assert.equal(sink.records[0]!.outcome, "refused")
  assert.equal(sink.records[0]!.detail?.auditError, "registry unreadable")
})

test("projectAdd through the app: a refused folder is recorded as refused, an accepted one as added", async (t) => {
  // projectAdd reaches the registry through homedir(); this file runs in its own process, so a sandbox
  // HOME is contained to it (see project-teardown.test.ts homeSandbox).
  const home = mkdtempSync(join(tmpdir(), "frizz-audit-home-"))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  })
  const folder = join(home, "repo")
  mkdirSync(folder)
  const sink = capture()
  const app = auditApp(sink, async () => ({ slug: "unused", sessionId: "unused" }))
  const stamp = encodeCallerStamp({ via: "loopback", remote: "127.0.0.1", session: null })

  // The home folder is the one folder the add refuses.
  const refused = await rpc(app, "projectAdd", { path: home }, { [CALLER_HEADER]: stamp })
  assert.equal(refused.status, 500)
  const message = "The home folder cannot be a project — choose a folder inside it."
  assert.equal(((await refused.json()) as { error: string }).error, message)
  assert.equal(sink.records[0]!.action, "projectAdd")
  assert.equal(sink.records[0]!.outcome, "refused")
  assert.equal(sink.records[0]!.error, message)
  assert.deepEqual(sink.records[0]!.project, { id: null, dir: home })
  assert.equal(sink.records[0]!.origin.via, "loopback")

  const added = await rpc(app, "projectAdd", { path: folder })
  assert.equal(added.status, 200)
  const card = ((await added.json()) as { result: { id: string; path: string } }).result
  assert.equal(sink.records[1]!.outcome, "ok")
  assert.deepEqual(sink.records[1]!.project, { id: card.id, dir: card.path })
})

test("the file sink appends one JSON line per record, readable by this user alone", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-audit-file-"))
  try {
    const stateDir = join(root, "projects", "abc")
    const path = auditLogPathForStateDir(stateDir)
    assert.equal(path, join(root, "logs", "audit.jsonl"))
    const sink = fileAuditLog(path)
    const record: AuditRecord = {
      at: new Date(0).toISOString(),
      action: "projectRemove",
      outcome: "ok",
      project: { id: "abc", dir: "/repos/abc" },
      origin: { via: "internal" },
    }
    sink.append(record)
    sink.append({ ...record, outcome: "refused", error: "no" })
    const lines = readFileSync(path, "utf8").trimEnd().split("\n")
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]!), record)
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
