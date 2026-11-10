// LIVE PROBE: what does a RESTED broker thread's turn read as AFTER frizz restarts and reattaches to
// the surviving daemon?
//   nub packages/server/src/backend/_live_broker_restart_turn.mts
//
// Reported symptom (2026-07-30, second report): four broker threads that had come to rest hours
// earlier all rendered `runtime: "running"` — the "Working…" shimmer — on a control plane that had
// restarted at 21:09Z. Every broker thread that rested AFTER that restart read correctly. Replaying the
// live DB offline with NO runtime signal wired folded all four to `idle` (a `_probe_turn_replay.mts`
// that the unified database has since outdated, removed 2026-11-10; `git log` has it), so the fold is
// innocent and the reading can only come from the ingest's liveness map.
//
// The suspected mechanism is one expression in claude-runtime-ingest.ts:
//
//     live.set(sessionId, { turn: signal ?? prior?.turn ?? "running", … })
//
// A restart empties `live`. The FIRST event to arrive afterwards for an already-rested session carries
// no turn meaning at all (`init`, `task`, `other`) — and that `?? "running"` mints a turn reading out
// of nothing, which `resolveRuntimeTurn` then lets override the folded `idle`. Nothing ever clears it:
// the turn is long over, so no `result` is coming.
//
// This probe settles what reading cannot:
//   Q1. After a real reattach to a surviving daemon, do ANY events arrive for a rested session?
//   Q2. If they do, what does the ingest's liveness read — and what does the tailer's turn become?
//
// It prints the raw post-reattach tape first. Read the tape; PASS/FAIL is only a summary.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest, type ClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const REST_WAIT_MS = Number(process.env.PROBE_REST_MS ?? 120_000)
const WATCH_MS = Number(process.env.PROBE_WATCH_MS ?? 45_000)

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "restartturn-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "restartturn-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slug = "restartturn-live"
const sessionId = randomUUID()
const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const logDir = defaultLogDir(project)
const claudeBackend = createClaudeBackend({ claudeBin, logDir })
const backendFor = (_kind?: string): AgentBackend => claudeBackend
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)

const t0 = Date.now()
const rel = () => `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`

interface TapeEntry { at: string; phase: string; kind: string; parent: string; extra: string; liveness?: string }
const tape: TapeEntry[] = []
let phase = "pre-restart"

// One wiring, built twice: once for the "original" frizz and once for the one that comes up after the
// restart. Everything but the ingest/bridge/tailer identity is shared, exactly as it is in production
// (same state dir, same DB, same surviving daemon).
function wire(): { ingest: ClaudeRuntimeIngest; bridge: ReturnType<typeof createClaudeAgentBrokerBridge>; tailer: Tailer } {
  let tailer!: Tailer
  const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
  const bridge = createClaudeAgentBrokerBridge({
    stateDir, executablePath: claudeBin, env,
    ownedSessions: () => [{ threadSlug: slug, sessionId, cwd }],
    onEvent: (s, sid, event: ClaudeQueryEvent) => {
      const entry: TapeEntry = {
        at: rel(), phase, kind: event.kind,
        parent: (event as { parentToolUseId?: string }).parentToolUseId ?? "(main)",
        extra: event.kind === "task" ? ` phase=${event.phase} status=${event.status ?? "-"}` : "",
      }
      tape.push(entry)
      ingest.onEvent(s, sid, event)
      void ingest.drain().then(() => { entry.liveness = ingest.liveness(sid)?.turn ?? "(none)" })
    },
  })
  tailer = createTailer({
    project, storage, bus: new Bus(), backendFor,
    onChange: () => {}, paneDead: () => false,
    runtimeLiveness: (sid) => ingest.liveness(sid),
    runtimeTasks: (sid) => ingest.tasks(sid),
  })
  return { ingest, bridge, tailer }
}

// THE WORKLOAD — a worker that leaves a LIVE background op behind and rests, which is the shape every
// stuck thread on the operator's board had. A quiet rested session receives NO events after a reattach
// at all (measured: 0 over 40s), so it can never reproduce this; a session with something still
// running under it is the only one whose provider keeps emitting after the turn is over.
const PROMPT = [
  "Run this with Bash and `run_in_background: true`, description exactly `TICKER`:",
  // Chosen to OUTLIVE the restart and then FINISH inside the watch window: a background op ENDING is
  // the provider's reason to emit a turn-neutral `task` event long after the parent's turn is over.
  "`sleep 25; echo TICKER-DONE`",
  "Do NOT wait for it, do NOT poll it, do NOT read its output.",
  "The moment the tool returns, reply with exactly RESTED-OK and end your turn.",
].join("\n")

let one = wire()
let two: ReturnType<typeof wire> | undefined
try {
  await one.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  // ---- 1. wait for the thread to come to rest under the ORIGINAL frizz -------------------------
  const restDeadline = Date.now() + REST_WAIT_MS
  let restedTurn: string | undefined
  while (Date.now() < restDeadline) {
    one.tailer.tick()
    restedTurn = one.tailer.get(slug)?.turn
    if (restedTurn === "idle" && tape.some((e) => e.kind === "result")) break
    await sleep(1_000)
  }
  await one.ingest.drain()
  ok("the thread came to rest before the restart", restedTurn === "idle",
    `turn=${restedTurn} liveness=${one.ingest.liveness(sessionId)?.turn ?? "(none)"}`)

  // ---- 2. RESTART frizz, leaving the daemon running -------------------------------------------
  // close() drops the client sockets and forgets the sessions; it deliberately does NOT kill a daemon
  // (that is releaseSession's job), so this is exactly what a control-plane restart leaves behind.
  phase = "restart"
  one.tailer.stop(); one.ingest.close(); one.bridge.close()
  await sleep(2_000)

  phase = "post-restart"
  const tapeBefore = tape.length
  two = wire()
  await two.bridge.warmUp()
  console.log(`\n      reattached at ${rel()}; watching ${Math.round(WATCH_MS / 1000)}s…`)

  // ---- 3. watch what the REATTACHED frizz derives ----------------------------------------------
  const timeline: string[] = []
  const watchDeadline = Date.now() + WATCH_MS
  while (Date.now() < watchDeadline) {
    two.tailer.tick()
    const tele = two.tailer.get(slug)
    const body = `turn=${tele?.turn} liveness=${two.ingest.liveness(sessionId)?.turn ?? "(none)"} lastAssistantAt=${tele?.lastAssistantAt ?? "-"}`
    if (timeline.at(-1)?.slice(7) !== body) timeline.push(`${rel()} ${body}`)
    await sleep(1_000)
  }
  await two.ingest.drain()

  // The CONTROL for the post-reattach tape below: if the workload never produced task events in the
  // first place, "no events after the restart" proves nothing about the restart.
  const before = tape.slice(0, tapeBefore)
  console.log("\n      --- PRE-RESTART EVENT TAPE (wire order) ---")
  for (const e of before) console.log(`      ${e.at} ${e.kind.padEnd(10)} parent=${e.parent}${e.extra}  → liveness=${e.liveness ?? "-"}`)
  const teleBefore = one.tailer.get(slug)
  console.log(`      pre-restart bgShells=${JSON.stringify((teleBefore?.bgShells ?? []).map((s) => [s.label, s.state]))}`)

  const after = tape.slice(tapeBefore)
  console.log("\n      --- POST-REATTACH EVENT TAPE (wire order) ---")
  if (after.length === 0) console.log("      (no events arrived at all)")
  for (const e of after) console.log(`      ${e.at} ${e.kind.padEnd(10)} parent=${e.parent}${e.extra}  → liveness=${e.liveness ?? "-"}`)

  console.log("\n      --- POST-REATTACH TURN TIMELINE (deduped) ---")
  for (const line of timeline) console.log("      " + line)

  // ---- the questions ----
  console.log(`\n      Q1 events after reattach: ${after.length}` +
    (after.length ? ` (kinds: ${[...new Set(after.map((e) => e.kind))].join(", ")})` : ""))
  const finalTurn = two.tailer.get(slug)?.turn
  const finalLiveness = two.ingest.liveness(sessionId)?.turn ?? "(none)"
  console.log(`      Q2 final: turn=${finalTurn} liveness=${finalLiveness}`)
  // THE BUG. A restart empties the ingest, and the events that arrive afterwards for an already-rested
  // thread are the background op's ENDING — `task` frames that say nothing whatsoever about the
  // parent's turn. Before the fix each of those minted "running" out of the `?? "running"` default,
  // which resolveRuntimeTurn then let override the folded `idle`; nothing could clear it, because the
  // turn was over and no `result` was coming. On the control run all three read `liveness=running`.
  const neutral = after.filter((e) => e.kind === "task" || e.kind === "other" || e.kind === "init")
  ok("the restart's first events ARE turn-neutral ones (the shape under test reproduced)",
    neutral.length > 0, `${neutral.length} task/other/init events after the reattach`)
  ok("no turn-neutral event ever mints a turn reading",
    neutral.every((e) => e.liveness !== "running"),
    `${neutral.filter((e) => e.liveness === "running").length} of ${neutral.length} minted "running"`)
  // A completing child legitimately RE-INVOKES the worker (its `<task-notification>` is a real user
  // record and a real new turn), so a transient in-flight here is correct. What must not happen is the
  // thread being left spinning: the re-invoked turn ends, and the board comes back to rest.
  ok("the thread ends at rest, not spinning", finalTurn === "idle", `final turn=${finalTurn}`)
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { (two ?? one).bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  for (const w of [two, one]) {
    if (!w) continue
    try { w.bridge.close() } catch { /* ignore */ }
    try { w.ingest.close() } catch { /* ignore */ }
    try { w.tailer.stop() } catch { /* ignore */ }
  }
  try { storage.close() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
