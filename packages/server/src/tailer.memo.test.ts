// THE TELEMETRY MEMO (tailer.ts telemetryMemo). `get` hands back the SAME object while nothing about a
// thread changed, and the board keys its per-thread memo on that identity — so identity must never
// survive a change, and a value must never go stale. These pin both directions, each against a SECOND
// tailer built cold over the same storage and transcripts: it has no memo to agree with by accident,
// so its answer is what the derivation says now.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createTailer, type Tailer } from "./tailer.ts"

const at = (second: number) => new Date(Date.UTC(2026, 6, 1, 0, 0, second)).toISOString()
const prompt = (second: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: text } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })
const toolUse = (second: number, id: string, name: string, input: object) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name, id, input }] } })
const toolResult = (second: number, id: string, text: string) => JSON.stringify({ type: "user", timestamp: at(second), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } })

function row(slug: string, sessionId: string): SessionRow {
  return { slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "frizz-tele-memo-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const storage = createStorage(join(root, "ui.db"), "p")
  const clock = { ms: Date.parse(at(30)) }
  // Sub-agent transcripts' mtimes, by path; absent = the file is not there.
  const mtimes = new Map<string, number>()
  const make = (s: Storage): Tailer => createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: s,
    bus: new Bus(),
    onChange: () => {},
    sessionLogDir: logDir,
    now: () => clock.ms,
    brokerDaemonAlive: () => true,
    shellAlive: () => true,
    mtimeMs: (path) => mtimes.get(path) ?? clock.ms,
  })
  const tailer = make(storage)
  const opened: Array<{ tailer: Tailer; storage: Storage }> = []
  return {
    storage, tailer, clock, mtimes, logDir,
    thread(slug: string, lines: string[]) {
      const sessionId = `sid-${slug}`
      storage.upsertSession(row(slug, sessionId))
      storage.setBackend(slug, "claude")
      storage.setClaudeRuntime(slug, "broker")
      writeFileSync(join(logDir, `${sessionId}.jsonl`), lines.map((line) => line + "\n").join(""))
    },
    append(slug: string, line: string) {
      appendFileSync(join(logDir, `sid-${slug}.jsonl`), line + "\n")
    },
    /** What a cold tailer derives for this thread right now. */
    cold(slug: string) {
      const s = createStorage(join(root, "ui.db"), "p")
      const t = make(s)
      opened.push({ tailer: t, storage: s })
      t.tick()
      return t.get(slug)
    },
    close() {
      for (const o of opened) { o.tailer.stop(); o.storage.close() }
      tailer.stop()
      storage.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("get: the same object while nothing changed — across calls, across ticks that move nothing", () => {
  const f = fixture()
  try {
    f.thread("rested", [prompt(0), reply(2, "all done")])
    f.tailer.tick()
    const first = f.tailer.get("rested")
    assert.ok(first)
    assert.equal(f.tailer.get("rested"), first, "a second call")
    f.tailer.tick()
    f.tailer.tick()
    assert.equal(f.tailer.get("rested"), first, "ticks that read the thread and found nothing new")
    assert.equal(f.tailer.get("rested", f.storage.getSession("rested")), first, "the board's row-carrying call answers the same")
    assert.deepEqual(first, f.cold("rested"), "and it is what a cold derivation says")
  } finally { f.close() }
})

test("get: a NEW object the moment anything about the thread changed", () => {
  const f = fixture()
  try {
    f.thread("t", [prompt(0), reply(2, "first")])
    f.tailer.tick()
    const before = f.tailer.get("t")!
    f.append("t", prompt(5, "more please"))
    f.append("t", reply(7, "second"))
    f.tailer.tick()
    const after = f.tailer.get("t")!
    assert.notEqual(after, before, "a folded record is a new object")
    assert.equal(after.lastAssistant, "second")
    assert.equal(before.lastAssistant, "first", "the object handed out earlier was not edited in place")
    assert.deepEqual(after, f.cold("t"))

    // A respawn moves `spawned_at`, the one row field the derivation reads.
    f.storage.upsertSession({ ...f.storage.getSession("t")!, spawned_at: at(20) })
    assert.notEqual(f.tailer.get("t"), after, "a moved spawned_at re-derives")
  } finally { f.close() }
})

test("get: a thread with a sub-agent is re-derived on every call — the clock alone makes it stale", () => {
  const f = fixture()
  try {
    f.thread("helper", [
      prompt(0),
      toolUse(1, "toolu_ag", "Agent", { description: "Auditing the parser", run_in_background: true, subagent_type: "frizz:high" }),
      toolResult(2, "toolu_ag", "Async agent launched successfully.\nagentId: abc123\noutput_file: /tmp/tasks/abc123.output\nDo not read this file."),
      reply(3, "waiting on the audit"),
    ])
    f.mtimes.set("/tmp/tasks/abc123.output", f.clock.ms)
    f.tailer.tick()
    const fresh = f.tailer.get("helper")!
    assert.equal(fresh.subAgents[0]?.state, "running")
    assert.equal(f.tailer.get("helper"), fresh, "re-derived, equal, so the same object")

    // No tick, no record, no touch: only time passes, past the child's quiet window.
    f.clock.ms += 16 * 60_000
    const later = f.tailer.get("helper")!
    assert.equal(later.subAgents[0]?.state, "stale", "the clock moved the derivation and the memo did not hold it back")
    assert.notEqual(later, fresh)
  } finally { f.close() }
})

test("get: the codex bridge's background commands keep a CODEX thread live between ticks, and no other", () => {
  // The board builds every thread's view on every change, and a re-derivation it did not need is one per
  // thread per build. The bridge's execs are the reason a codex thread is re-derived without a tick; a
  // Claude thread can never hold one, so it must not pay for them.
  const root = mkdtempSync(join(tmpdir(), "frizz-tele-memo-codex-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const storage = createStorage(join(root, "ui.db"), "p")
  const execs = new Map<string, { processId: string; command?: string; startedAtMs: number }[]>()
  const asked: string[] = []
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    onChange: () => {},
    sessionLogDir: logDir,
    brokerDaemonAlive: () => true,
    shellAlive: () => true,
    codexBackgroundExecs: (slug) => { asked.push(slug); return execs.get(slug) ?? [] },
  })
  try {
    for (const [slug, backend] of [["claude-thread", "claude"], ["codex-thread", "codex"]] as const) {
      storage.upsertSession(row(slug, `sid-${slug}`))
      storage.setBackend(slug, backend)
      if (backend === "claude") storage.setClaudeRuntime(slug, "broker")
      else storage.setCodexRuntime(slug, "app-server")
      writeFileSync(join(logDir, `sid-${slug}.jsonl`), [prompt(0), reply(2, "resting")].map((l) => l + "\n").join(""))
    }
    tailer.tick()
    const claude = tailer.get("claude-thread")!
    asked.length = 0
    for (let i = 0; i < 5; i++) assert.equal(tailer.get("claude-thread"), claude)
    assert.deepEqual(asked, [], "five builds' worth of reads asked the bridge nothing about a Claude thread")

    // A codex command starts. Nothing on disk moves and no tick runs; the next read must show it.
    execs.set("codex-thread", [{ processId: "p1", command: "npm test", startedAtMs: Date.parse(at(3)) }])
    assert.equal(tailer.get("codex-thread")!.bgShells.length, 1, "the codex thread's new command reached the board without a tick")
  } finally {
    tailer.stop()
    storage.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("get: dismissing an op re-derives without waiting for a tick", () => {
  const f = fixture()
  try {
    f.thread("shell", [
      prompt(0),
      toolUse(1, "toolu_sh", "Bash", { command: "sleep 9999", description: "A watcher", run_in_background: true }),
      toolResult(2, "toolu_sh", "Command running in background with ID: bW. Output is being written to: /tmp/tasks/bW.output. You will be notified when it completes."),
      reply(3, "parked"),
    ])
    f.tailer.tick()
    const before = f.tailer.get("shell")!
    assert.equal(before.bgShells.length, 1)
    assert.equal(f.tailer.dismissOp!("shell", "toolu_sh"), true)
    const after = f.tailer.get("shell")!
    assert.equal(after.bgShells.length, 0)
    assert.notEqual(after, before)
  } finally { f.close() }
})
