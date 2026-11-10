// The Claude session broker DAEMON: a detached process that owns one Claude Agent SDK session and
// relays it over a local socket. This is the piece Claude Code doesn't ship (codex's app-server is
// the same shape): the session OUTLIVES frizz, so frizz reconnects to the LIVE session after a restart
// instead of cold resume-from-disk, while keeping structured TYPED control (no TUI scraping, no PTY,
// no terminal of any kind — stream-json over pipes). The SDK stays as this daemon's implementation detail; frizz speaks a
// small typed socket protocol (claude-broker-client.ts), never the SDK directly.
//
// Wire protocol — newline-delimited JSON frames:
//   frizz -> broker:  {t:"input", message, requestId?} | {t:"permission", requestId, decision} | {t:"interrupt", sendNow?: {messageId?}} | {t:"set-mode", mode}
//                  | {t:"cancel-input", requestId, id} | {t:"stop-task", requestId, taskId}
//                  | {t:"reload-plugins", requestId} | {t:"rename", requestId, description} | {t:"list-skills", requestId}
//                  | {t:"mcp-status", requestId} | {t:"mcp-reconnect", requestId, name}
//   broker -> frizz:  {t:"hello", sessionId, generation} | {t:"event", event} | {t:"permission-request", requestId, request} | {t:"diagnostic", diagnostic}
//                  | {t:"permission-withdrawn", requestId}   (a request frizz was shown that nothing can answer any more)
//                  | {t:"input-result", requestId, error?}   (only for an input that carried a requestId)
//                  | {t:"cancel-result", requestId, cancelled, error?} | {t:"stop-result", requestId, error?}
//                  | {t:"reload-result", requestId, reloaded?, error?} | {t:"rename-result", requestId, title?, error?} | {t:"skills-result", requestId, skills?, error?}
//                  | {t:"mcp-status-result", requestId, servers?, error?} | {t:"mcp-reconnect-result", requestId, error?}
//
// Control actions that make a user-visible promise are REQUEST/RESPONSE pairs: `cancel-input` carries
// the CLI's verdict about whether a message will still run, and `stop-task` returns only after the SDK
// accepted or rejected the task stop. "We wrote a socket frame" is not either answer. Since
// `input-ack-v1` the same holds for an input: see CLAUDE_BROKER_CAPABILITY_INPUT_ACK.
//
// Lifecycle mirrors codex-app-server-daemon.ts (record-after-listen, owner-checked cleanup, idle
// exit, reachability self-collection). The recovered session-broker daemon's NAIVE unconditional
// cleanup is exactly the corpse-deletes-successor bug this guards against.
import net from "node:net"
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createClaudeQueryFactory, sanitizeProviderChildEnvironment } from "./claude-agent-sdk.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import { leaseRuntime } from "../runtime-lease.ts"
import { projectMcpServers, workerMcpServers, type StdioMcpServer, type WorkerMcpServers } from "./project-mcp-servers.ts"
import { lazyMcpEnabled, startLazyMcpHost, type LazyMcpHost } from "./lazy-mcp-host.ts"
import { frizzRoots } from "../frizz-paths.ts"
import { BROKER_DISALLOWED_TOOLS, claudeCompactionWindowOf } from "./types.ts"
import { socketPathOwnership } from "./socket-ownership.ts"
import { selfProcessStart } from "./daemon-identity.ts"
import { createClaudeBrokerDiagnosticWriter, createClaudeBrokerExitWriter, type ClaudeBrokerExitReason } from "./claude-broker-diagnostics.ts"
import { claudeClosureFingerprint, claudePluginSyncEnabled, createClaudePluginSync } from "./claude-plugin-sync.ts"
import { recordObservedClaudeQuota } from "./claude-quota-observed.ts"
import { CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_INPUT_ACK, CLAUDE_BROKER_CAPABILITY_LIST_SKILLS, CLAUDE_BROKER_CAPABILITY_MCP, CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS, CLAUDE_BROKER_CAPABILITY_RENAME, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX } from "./claude-agent-sdk-protocol.ts"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerConfig {
  socketPath: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudePermissionMode
  /** Allowlisted keys only — the SDK validates and rejects anything else. */
  env: Record<string, string>
  /** Appended to Claude's default system prompt — carries the frizz worker contract. */
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the session from its on-disk transcript instead of starting a fresh one. Set when a
   *  follow-up cold-starts a daemon after the previous one died (the live-daemon reconnect never forks). */
  resume?: boolean
  /** The frizz WORKER ENVIRONMENT — the SDK equivalents of the argv path's --plugin-dir/--mcp-config
   *  injection. Without these a broker worker is bare: no frizz sub-agent profiles, no frizz MCP,
   *  no cc-worker hooks. `pluginDir` loads the local cc-worker plugin; `mcpServers`/`allowedTools` mount + pre-approve
   *  the MCP servers; `workerEnv` carries the per-thread frizz vars the plugin hooks gate on (FRIZZ_THREAD,
   *  FRIZZ_PERM_DIR) — merged into the SDK env AFTER the ambient allowlist. */
  pluginDir?: string
  mcpServers?: WorkerMcpServers
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** The operator's launch prefix for Claude, already split into words: the CLI starts as
   *  `<prefix…> <claude> …`. Fixed at fork like everything else here. Absent ⇒ the SDK's own spawn. */
  launchPrefix?: string[]
  /** When set, the daemon writes a discovery record here after its socket is listening. */
  recordPath?: string
  /** When set, the daemon appends its OWN lifecycle/stderr diagnostics here, synchronously. This is
   *  how a crash survives: relaying to an attached client loses every death that happens while frizz is
   *  detached (a restart), and an in-memory backlog dies with the process it is recording. */
  diagnosticLogPath?: string
  /** Stable identity of THIS app-server process — unchanged across frizz restarts, new only when the
   *  session itself is re-forked. Lets frizz tell whether in-flight work survived a reconnect. */
  generation?: string
}

export interface BrokerRecord {
  daemonPid: number
  /** The daemon's own exact start marker, where the platform has one (daemon-identity.ts). With
   *  `createdAt` it is how a teardown tells this daemon from whatever later holds its pid. */
  processStart?: string
  socketPath: string
  sessionId: string
  generation: string
  createdAt: string
  capabilities?: string[]
  /** The auto-compact ceiling this daemon's worker environment actually carries
   *  (CLAUDE_CODE_AUTO_COMPACT_WINDOW), echoed onto the record because it is a FORK-TIME property: a
   *  daemon keeps the value it was forked with while Settings moves on underneath it, and after a frizz
   *  restart the record is the only thing left that remembers which value that was. Read by the bridge
   *  to give the board a denominator the session genuinely runs under. Absent ⇒ nothing was set, or the
   *  daemon predates this field. */
  compactionWindow?: number
}

// What THIS daemon build understands, stamped into its record so the bridge can tell an old surviving
// daemon from a current one. The constant itself lives in the PROTOCOL module, not here: this file is
// also the detached daemon's process entry point and throws at module scope when it is loaded as one
// without FRIZZ_CLAUDE_BROKER. In the promoted artifact every module is one bundle, so a plain `import`
// of a VALUE from here — rather than an `import type` — initializes this module inside the server
// process, where the entry-point check is satisfied by the bundle's own path and the guard fires. That
// took down the whole control plane on the artifact while dev source (separate files) stayed green.
const BROKER_CAPABILITIES = [CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS, CLAUDE_BROKER_CAPABILITY_RENAME, CLAUDE_BROKER_CAPABILITY_LIST_SKILLS, CLAUDE_BROKER_CAPABILITY_INPUT_ACK, CLAUDE_BROKER_CAPABILITY_MCP]

const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
// How long a permission request waits in this process before frizz is shown it — long enough for the
// worker's PermissionRequest hook to settle it first (see canUseTool below), short enough that a
// person never notices it on the way to a card.
const PERMISSION_SHOW_HOLD_MS = 250
const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2
// Consecutive event-stream mapping failures tolerated before the session is treated as genuinely
// broken. One bad event must not end hours of work; an endlessly throwing stream must not spin.
const EVENT_ERROR_TOLERANCE = 5

export interface RunningBroker { close: () => Promise<void>; sessionId: string; generation: string }

export interface RunClaudeBrokerOptions {
  /** Serves the project's stdio MCP servers lazily (lazy-mcp-host.ts). Absent ⇒ the CLI starts them at
   *  boot, as it does for any session — the embedded (test) form, and FRIZZ_LAZY_MCP_OFF=1. */
  lazyMcpHost?: LazyMcpHost
}

/** The project's stdio servers, handed to the lazy host and replaced by its remote mounts. A name the
 *  frizz mount takes is left alone: workerMcpServers drops it anyway, and a slot nobody can reach is noise. */
function mountLazily(project: WorkerMcpServers, frizz: WorkerMcpServers | undefined, host: LazyMcpHost | undefined, context: Parameters<LazyMcpHost["mount"]>[1]): WorkerMcpServers {
  if (!host) return project
  const stdio: Record<string, StdioMcpServer> = {}
  for (const [name, server] of Object.entries(project)) {
    if ((server.type === undefined || server.type === "stdio") && !(frizz && name in frizz)) stdio[name] = server as StdioMcpServer
  }
  return { ...project, ...host.mount(stdio, context) }
}

export function runClaudeBroker(config: ClaudeBrokerConfig, options: RunClaudeBrokerOptions = {}): RunningBroker {
  const generation = config.generation ?? randomUUID()
  let client: net.Socket | null = null
  // 20,000 frames was the only bound; see emitEvent for why bytes matter more than count.
  const MAX_BACKLOG_FRAMES = 20_000
  /** 64 MB of replay is a long detached window at the measured mean (~5 KB/frame ⇒ ~12,000 frames). */
  const MAX_BACKLOG_BYTES = 64 * 1024 * 1024
  const eventBacklog: string[] = []
  let eventBacklogBytes = 0
  // `shown` — frizz has been sent this request, so frizz has to be told if it is taken back.
  const pendingPermissions = new Map<string, { request: ClaudePermissionRequest; resolve: (d: ClaudePermissionDecision) => void; shown: boolean }>()
  let permSeq = 0
  let published = false
  let idleTimer: NodeJS.Timeout | undefined
  let strikes = 0

  const write = (sock: net.Socket, frame: unknown) => sock.write(JSON.stringify(frame) + "\n")
  const emitEvent = (event: ClaudeQueryEvent) => {
    if (client) write(client, { t: "event", event })
    else {
      // CAPPED ON BOTH AXES. The count cap alone bounds the wrong quantity: measured over 108,718 real
      // records of the maintainer's largest thread, a frame is 0.7 KB at p50 but 193 KB at p99 and
      // 568 KB at the max — so 20,000 frames is ~105 MB of backlog at the MEAN and ~500 MB at the
      // large end, per detached session. And it only fills WHILE DETACHED, which is precisely a frizz
      // restart, when several daemons are detached at once.
      const frame = JSON.stringify({ t: "event", event }) + "\n"
      eventBacklog.push(frame)
      eventBacklogBytes += Buffer.byteLength(frame)
      // Drops the OLDEST first, the same semantic the count cap already had: a reconnecting client
      // would rather have the recent story complete than the whole story truncated at the end.
      while (eventBacklog.length > MAX_BACKLOG_FRAMES || eventBacklogBytes > MAX_BACKLOG_BYTES) {
        const dropped = eventBacklog.shift()
        if (dropped === undefined) break
        eventBacklogBytes -= Buffer.byteLength(dropped)
      }
    }
  }

  const writeDiagnostic = config.diagnosticLogPath
    ? createClaudeBrokerDiagnosticWriter(config.diagnosticLogPath, { daemonPid: process.pid, generation })
    : undefined
  // WHY this daemon ended, written by the daemon on its way out. The bridge only ever observes an
  // absent record + a closed socket, which is the same picture for an idle collection, a SIGTERM, a
  // self-collection and a crash — so without this every broker death reported as the generic "the
  // thread went quiet." Same file as the diagnostics above, so the stderr that preceded a death and
  // the death itself read as one story. See ClaudeBrokerExitReason for the vocabulary.
  const writeExit = config.diagnosticLogPath
    ? createClaudeBrokerExitWriter(config.diagnosticLogPath, { daemonPid: process.pid, generation })
    : undefined

  // Tell a sweeping Frizz (runtimes.ts) that this daemon still runs out of that version directory.
  // A daemon outlives the server that forked it, so the server's own lease is not enough.
  const releaseRuntimeLease = leaseRuntime(config.executablePath, "claude-broker")
  const factory = createClaudeQueryFactory({ enabled: true, executablePath: config.executablePath })
  // The worker inherits frizz's environment minus frizz's own control plane (see worker-env.ts). The
  // frizz worker vars it DOES need (FRIZZ_THREAD, FRIZZ_PERM_DIR) ride workerEnv and are merged on
  // top — which is also what gives them THIS thread's values instead of the server's.
  const env = { ...inheritWorkerEnvironment(config.env), ...(config.workerEnv ?? {}) }
  // Keeps this session on its plugin closure as it is on disk, re-reading it between turns when it
  // moves (see claude-plugin-sync.ts): Frizz's plugin, and the project's and the operator's own
  // skills, agents, commands and installed plugins. Built BEFORE the session starts, because the
  // fingerprint it takes now is its record of what the session is about to load. PERSISTED ONLY, like
  // `input received` below: a reload is forensics, not something the operator's thread should narrate.
  const closure = {
    pluginDir: config.pluginDir,
    projectDir: config.cwd,
    // Where claude itself will look, from the environment it is about to be started with.
    configDir: env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME || homedir(), ".claude"),
  }
  const pluginSync = claudePluginSyncEnabled()
    ? createClaudePluginSync({
        fingerprint: () => claudeClosureFingerprint(closure),
        reload: () => handle.reloadPlugins(),
        log: (message) => writeDiagnostic?.({ kind: "stderr", message: `[plugin-sync] ${message}`, truncated: false }),
      })
    : undefined
  const handle = factory.start({
    cwd: config.cwd,
    session: config.resume ? { kind: "resume", sessionId: config.sessionId } : { kind: "new", sessionId: config.sessionId },
    permissionMode: config.permissionMode ?? "default",
    env,
    launchPrefix: config.launchPrefix,
    persistSession: true, // write the tailer-readable transcript JSONL
    appendSystemPrompt: config.appendSystemPrompt,
    model: config.model,
    effort: config.effort,
    pluginDir: config.pluginDir,
    // The WHOLE MCP surface of this thread, and STRICT so the CLI discovers nothing else: the project's
    // approved `.mcp.json` (and the operator's remote user-scope servers) under the frizz mount, which
    // wins a name collision. Read at every fork, not once per project, so a `.mcp.json` edit reaches the
    // next dispatch the way it reaches the next plain `claude`. project-mcp-servers.ts has the reasons.
    // Stdio servers are not started here: the lazy host stands in for each one and starts the real
    // command on the first tool call (lazy-mcp-host.ts has the measurement that motivated it).
    mcpServers: workerMcpServers(
      mountLazily(projectMcpServers(config.cwd, { env }), config.mcpServers, options.lazyMcpHost, {
        cwd: config.cwd,
        // What the CLI itself would have spawned the server with: the env the factory hands it, after
        // the same sanitizing (no inherited NODE_OPTIONS, no nub shim on PATH).
        env: sanitizeProviderChildEnvironment(env) as Record<string, string>,
        log: (message) => writeDiagnostic?.({ kind: "stderr", message: `[lazy-mcp] ${message}`, truncated: false }),
      }),
      config.mcpServers,
    ),
    strictMcpConfig: true,
    allowedTools: config.allowedTools,
    // Claude Code's own schedulers are taken away (BROKER_DISALLOWED_TOOLS has the reason). AskUserQuestion
    // is NOT on that list, and the asymmetry with the argv path (WORKER_DISALLOWED_TOOLS →
    // `--disallowedTools=AskUserQuestion`) is DELIBERATE. That flag exists because a worker launched as
    // its own interactive `claude` process had nowhere to put the question: it opened a TUI dialog on a
    // terminal screen nobody was looking at. On this path it
    // has somewhere to go — canUseTool routes it to a real dashboard question card, the operator answers
    // it, and the chosen labels reach the model. A follow-up sent instead of an answer retires the card
    // and unwinds the tool call (see retirePendingFor in the bridge), so a parked turn is still steerable.
    disallowedTools: BROKER_DISALLOWED_TOOLS,
    canUseTool: async (request, context) => {
      const requestId = `perm-${++permSeq}`
      return await new Promise<ClaudePermissionDecision>((resolve) => {
        // Abort-aware: interrupting the turn (or the session ending) aborts the SDK's permission
        // callback, and a request left in `pendingPermissions` after that is not merely a leak — the
        // reconnect handler REPLAYS every pending request to the next frizz that attaches, which would
        // put a card in front of the operator for a tool call that no longer exists. So an abort
        // settles the waiter with a deny and drops it, exactly like an answer would.
        let settled = false
        let showTimer: NodeJS.Timeout | undefined
        const entry = { request, shown: false, resolve: (decision: ClaudePermissionDecision) => settle(decision) }
        const settle = (decision: ClaudePermissionDecision) => {
          if (settled) return
          settled = true
          clearTimeout(showTimer)
          pendingPermissions.delete(requestId)
          resolve(decision)
        }
        // THE SDK ASKS THIS CALLBACK AND RUNS THE PermissionRequest HOOKS SIDE BY SIDE, and aborts the
        // callback when a hook settles the request first. The worker's policy hook does exactly that for
        // nearly every request (cc-worker/hooks/perm-policy.mjs: approve, ~70ms), so an abort here is
        // the COMMON case, not just an interrupt. Two things follow, both measured against real claude
        // on 2026-10-10 (a bypass worker, a command Claude Code still prompts for):
        //  * frizz must be TOLD. It was not, so the card it had already journaled stayed in front of the
        //    operator until the turn ended — 23s in the measurement, Grant and Deny both dead.
        //  * frizz should not be shown the request in the first place. Hence the short hold below: a
        //    request a hook settles inside it never leaves this process, so no card flashes and nothing
        //    queues the thread. A request that outlives the hold is one a person has to answer, and
        //    250ms on the way to a human is nothing.
        const withdraw = () => {
          const wasShown = entry.shown
          settle({ behavior: "deny", message: "The turn was interrupted before this was answered." })
          if (wasShown && client) write(client, { t: "permission-withdrawn", requestId })
        }
        pendingPermissions.set(requestId, entry)
        if (context.signal.aborted) withdraw()
        else context.signal.addEventListener("abort", withdraw, { once: true })
        if (!settled) {
          showTimer = setTimeout(() => {
            if (settled || entry.shown || !client) return
            entry.shown = true
            write(client, { t: "permission-request", requestId, request })
          }, PERMISSION_SHOW_HOLD_MS)
        }
      })
    },
    // The account's plan windows, as every API response reports them to this session. Written by THIS
    // process because it is the one that sees the stream and it outlives the Frizz server; the server
    // only reads the file (claude-quota-observed.ts). Fire-and-forget: the recorder never rejects.
    onRateLimit: (info: unknown) => {
      void recordObservedClaudeQuota(info, { cacheDir: join(frizzRoots().cache, "quota-cache"), configDir: closure.configDir })
    },
    onDiagnostic: (diagnostic: ClaudeDiagnostic) => {
      // Persist FIRST, then relay. A `crashed` diagnostic is emitted with the process seconds from
      // gone, and relaying only reaches a frizz that happens to be attached right now.
      writeDiagnostic?.(diagnostic)
      if (client) write(client, { t: "diagnostic", diagnostic })
    },
  })

  // ASK Claude to name the session, once, from the dispatch prompt.
  //
  // Claude Code normally titles a session by itself on the first user message and appends an
  // `ai-title` record to the session JSONL — the record frizz's tailer folds into the board's
  // `aiTitle`, and without which the board shows "Spinning up a thread…" for 60s and then falls back
  // to a truncation of the raw dispatch prompt forever. That automatic titling is SUPPRESSED on the
  // Agent-SDK (headless) transport whenever a `SessionStart` hook is registered — and frizz's broker
  // always loads the cc-worker plugin, whose hooks.json registers SessionStart. Bisected live against
  // 2.1.220: a plugin carrying ONLY a no-op `SessionStart` hook yields NO ai-title and never even
  // dispatches the titler's API request, while the same plugin carrying only PreToolUse / PostToolUse
  // / PermissionRequest hooks titles normally. It is provider behavior frizz cannot switch off without
  // giving up the worker seeding, so the broker asks explicitly instead: the SDK's
  // `generate_session_title` control request with `persist: true` runs the SAME titler and writes the
  // SAME `ai-title` record, so nothing downstream of the JSONL changes.
  //
  // Fired on the FIRST input only, and only for a session this daemon STARTED: a resume re-attaches to
  // a transcript that already carries its title, and a follow-up must never rename the thread.
  // Deliberately not awaited by the caller (a title must never delay the turn) but tracked here so a
  // failure is a diagnostic rather than an unhandled rejection.
  let titleSeeded = config.resume === true
  const seedSessionTitle = (message: ClaudeInputMessage): void => {
    if (titleSeeded) return
    // An ADDRESSED message is a steer aimed at one running sub-agent, not this thread's opening
    // prompt. Titling the whole thread "fix the flaky assertion in the child you dispatched" would
    // name the session after a side conversation, so addressing disqualifies a message from seeding.
    if (message?.parentToolUseId) return
    const text = typeof message?.text === "string" ? message.text.trim() : ""
    if (!text) return
    titleSeeded = true
    void handle.generateSessionTitle(text).catch((error: unknown) => {
      writeDiagnostic?.({ kind: "stderr", message: `session-title request failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false })
    })
  }

  // The session ending (claude exits) tears the daemon down — there is nothing left to hold.
  // The session ending (claude exits) tears the daemon down — there is nothing left to hold. But an
  // error out of the ITERATOR is a different thing entirely and used to be conflated with it: any
  // failure mapping one event to frizz's typed shape landed in this `.catch` and killed the daemon,
  // the claude process, and every in-flight sub-agent. Live on 2026-07-27 a single control character
  // in a Bash command did exactly that to a multi-hour orchestrator thread.
  //
  // The mapper no longer throws for that case (claude-agent-sdk.ts degrades an unrepresentable tool
  // input instead), but the conflation itself was the deeper bug: losing one telemetry event must
  // never be a reason to destroy hours of an operator's work. So a mapping failure is now recorded
  // and the pump continues; only the stream genuinely ENDING tears the session down.
  // `handle` is its own async iterator (claude-agent-sdk.ts: `[Symbol.asyncIterator]() { return this }`),
  // so pulling with next() is exactly what `for await` did — it just lets ONE bad event be survivable.
  // Bounded: a stream that keeps throwing is genuinely broken, and retrying it forever would spin the
  // daemon at 100% CPU, which is a worse failure than the one being fixed.
  const pump = (async (): Promise<{ reason: ClaudeBrokerExitReason; detail?: string }> => {
    let consecutiveErrors = 0
    for (;;) {
      let next: IteratorResult<ClaudeQueryEvent>
      try {
        next = await handle.next()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeDiagnostic?.({
          kind: "stderr",
          message: `event stream error ${++consecutiveErrors}/${EVENT_ERROR_TOLERANCE} (session continues): ${message}`,
          truncated: false,
        })
        // genuinely broken → end the session, and say which of the two endings this was: a stream that
        // kept throwing is a very different post-mortem from claude simply exiting.
        if (consecutiveErrors >= EVENT_ERROR_TOLERANCE) return { reason: "session-stream-broken", detail: message }
        continue
      }
      consecutiveErrors = 0
      if (next.done) return { reason: "session-stream-ended" }
      emitEvent(next.value)
      // A `result` is the turn boundary the plugin sync waits for; anything the model or a tool
      // produced before it means a turn is running, whether an input opened it or the session did.
      if (next.value.kind === "result") pluginSync?.turnEnded()
      else if (next.value.kind === "assistant" || next.value.kind === "user") pluginSync?.turnActive()
    }
  })().then(
    (end) => shutdown(0, end.reason, end.detail),
    (error) => shutdown(0, "event-pump-failed", error instanceof Error ? error.message : String(error)),
  )

  // Never once shut down. shutdown() clears this timer and then destroys the attached client, and that
  // socket's 'close' lands a tick LATER — its handler below nulls `client` and calls back in here. Without
  // the `closed` check that re-armed a fresh, REF'D six-hour timer on a daemon already torn down. The
  // standalone daemon exits straight past it, but the embedded form (every broker in the tests) has no
  // exit: each such timer held the test process open, so claude-agent-broker.test.ts passed every test
  // and then never exited (measured 2026-10-01: twelve live `armIdle` timers once the last test ended).
  const armIdle = () => { if (client || closed) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown(0, "idle-timeout"), IDLE_EXIT_MS) }

  const server = net.createServer((sock) => {
    client = sock; clearTimeout(idleTimer)
    write(sock, { t: "hello", sessionId: handle.sessionId, generation })
    for (const [requestId, entry] of pendingPermissions) { entry.shown = true; write(sock, { t: "permission-request", requestId, request: entry.request }) }
    while (eventBacklog.length) sock.write(eventBacklog.shift()!)
    eventBacklogBytes = 0
    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue
        let msg: Record<string, unknown>; try { msg = JSON.parse(line) } catch { continue }
        if (msg.t === "input") {
          const message = msg.message as ClaudeInputMessage
          // Present only when the bridge asked for an acknowledgement (input-ack-v1). Answered on `sock`,
          // the connection that asked, for the same reason cancel-input is.
          const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined
          // Record RECEIPT, not only failure. The drop path below fires ONLY when `handle.send`
          // REJECTS; a send that simply never completes — the agent wedged before it drains stdin — is
          // identically silent, so from this log the two were indistinguishable. That cost a whole
          // investigation on 2026-07-31: a thread whose agent never produced a transcript left a
          // diagnostics file containing one `started` line and nothing else, with no way to tell whether
          // the opening prompt had ever crossed this socket. One line per input settles it forever.
          // PERSISTED ONLY, never relayed to frizz: this is forensics, not an event the operator needs,
          // and the relay channel surfaces as worker stderr. Ids and sizes only — the message TEXT is
          // the operator's content and must never land in a diagnostics file.
          writeDiagnostic?.({
            kind: "stderr",
            message: `input received: id=${message?.id ?? "?"} chars=${typeof message?.text === "string" ? message.text.length : 0}${message?.parentToolUseId ? ` addressed=${message.parentToolUseId}` : ""}`,
            truncated: false,
          })
          // NEVER swallow this. The `input` frame carried no reply (and still carries none to a bridge
          // that asks for no acknowledgement), so this catch was the only place a
          // refused send existed at all — and it threw the evidence away. frizz had already answered the
          // operator's RPC with success and opened an `enqueued` ledger item that by design never times
          // out, so the message rendered as delivered forever while the agent never saw a byte of it.
          // Measured live in _live_broker_input_drop.mts before the fix: zero diagnostics, zero errors,
          // message gone. The bridge now validates before the frame so the common refusals fail the
          // operator's own send; this reports the residue (a duplicate uuid, a full input queue, a handle
          // closing under the frame) on the same diagnostic channel every other drop site here uses.
          // The acknowledgement is sent once `handle.send` SETTLES, not on receipt: `send` is where the
          // session takes the message into its input queue or refuses it (a replayed uuid, a full
          // queue, a closing handle), so this is the one point that can tell the operator which of
          // the two happened. It settles at once — it validates and pushes, it never waits on a turn.
          //
          // HELD ONLY BEHIND A PLUGIN RELOAD, and then only for as long as that takes (bounded well inside
          // the bridge's acknowledgement deadline): an input that reaches an idle session is the moment
          // the session catches up with a plugin that moved, and the turn it opens must start after that
          // reload rather than beside it. Inputs held together are released in the order they arrived.
          const forward = (): void => void handle.send(message).then(() => {
            if (requestId) write(sock, { t: "input-result", requestId })
          }, (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error)
            if (requestId) write(sock, { t: "input-result", requestId, error: detail })
            // NAME THE MESSAGE. The prefix alone told frizz that *something* was thrown away, which is
            // one grep better than silence but still leaves the ledger unable to act: it cannot act on
            // a row it cannot identify, so a refused send sat at `enqueued` for the full hour
            // `ageDeliveries` grants a queue entry — pretending to be held by a daemon that had in fact
            // refused it. The id is the DELIVERY id frizz opened the ledger row under, so carrying it here
            // is what lets the server mark exactly that row failed, its text on screen for a retry.
            // Ids only, never the text — same rule as the `input received` line above.
            const droppedId = typeof message?.id === "string" ? ` id=${message.id}` : ""
            const diagnostic = { kind: "stderr" as const, message: `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}:${droppedId} ${detail}`, truncated: false }
            // Persist FIRST, then relay — same order and reasoning as the SDK's onDiagnostic above: a
            // drop is worth attributing even when no frizz is attached to hear it right now.
            writeDiagnostic?.(diagnostic)
            if (client) write(client, { t: "diagnostic", diagnostic })
          })
          const reloading = pluginSync?.beforeInput(!message?.parentToolUseId)
          if (reloading) void reloading.then(forward)
          else forward()
          seedSessionTitle(message)
        }
        else if (msg.t === "permission") { const e = pendingPermissions.get(msg.requestId as string); if (e) { pendingPermissions.delete(msg.requestId as string); e.resolve(msg.decision as ClaudePermissionDecision) } }
        else if (msg.t === "interrupt") {
          // `sendNow` (an object, optionally naming the message) asks the runtime to push a waiting
          // message through, which aborts the turn only when it cannot move what the turn is waiting on
          // (ClaudeInterruptOptions). A daemon older than the field reads the frame as the plain
          // interrupt it always was, so the server needs no capability gate: the fallback is the old
          // behaviour, never a lost message. The outcome is persisted for forensics — which of the two
          // a send-now turned into is otherwise invisible until someone reads the transcript.
          const sendNow = msg.sendNow && typeof msg.sendNow === "object" ? msg.sendNow as { messageId?: unknown } : undefined
          const messageId = typeof sendNow?.messageId === "string" ? sendNow.messageId : undefined
          void handle.interrupt(sendNow ? { sendNow: messageId ? { messageId } : {} } : undefined).then((receipt) => {
            if (sendNow) writeDiagnostic?.({ kind: "stderr", message: `send-now: ${receipt?.sendNow ?? "plain interrupt"}${messageId ? ` id=${messageId}` : ""}`, truncated: false })
          }, () => {})
        }
        else if (msg.t === "cancel-input") {
          // ALWAYS answer, including on failure: the caller is blocked on this reply and a silent drop
          // would be indistinguishable from a wedged daemon. `sock` rather than `client` is deliberate —
          // the answer belongs to the connection that asked, even if a reconnect has already replaced it.
          const requestId = msg.requestId as string
          const id = typeof msg.id === "string" ? msg.id : ""
          void handle.cancelInput(id).then(
            (cancelled) => write(sock, { t: "cancel-result", requestId, cancelled }),
            (error: unknown) => write(sock, { t: "cancel-result", requestId, cancelled: false, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "stop-task") {
          const requestId = msg.requestId as string
          const taskId = typeof msg.taskId === "string" ? msg.taskId : ""
          void handle.stopTask(taskId).then(
            () => write(sock, { t: "stop-result", requestId }),
            (error: unknown) => write(sock, { t: "stop-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "rename") {
          // On-demand re-title, the SDK equivalent of typing `/rename` at an interactive prompt. Same
          // request/response discipline as the other control actions: the caller is blocked on the
          // title, so a silent drop would read as a wedged daemon rather than a failed rename.
          const requestId = msg.requestId as string
          const description = typeof msg.description === "string" ? msg.description : ""
          void handle.generateSessionTitle(description).then(
            (title) => write(sock, { t: "rename-result", requestId, title }),
            (error: unknown) => write(sock, { t: "rename-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "reload-plugins") {
          // NO CURRENT SERVER SENDS THIS. It was the Reload plugins button's frame, and the button
          // went on 2026-10-11 when this daemon began reloading itself between turns (pluginSync,
          // above). It is still answered, and the capability still advertised, for an OLDER server:
          // a downgrade attaches one to this daemon, and its button would otherwise be told the
          // session "predates in-place plugin reload".
          //
          // Answers on `sock` for the same reason cancel-input does: the caller is blocked on this
          // reply, and a silent drop reads as a wedged daemon rather than a failed reload.
          const requestId = msg.requestId as string
          void handle.reloadPlugins().then(
            (reloaded) => write(sock, { t: "reload-result", requestId, reloaded }),
            (error: unknown) => write(sock, { t: "reload-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "list-skills") {
          // Same request/response discipline as reload-plugins: the composer typeahead is blocked on
          // this answer, and a silent drop reads as a wedged daemon rather than an unlistable session.
          const requestId = msg.requestId as string
          // After the plugin sync, so the composer of an idle thread lists the skills its next turn
          // will actually have, not the ones the session loaded before an update.
          void (pluginSync?.beforeRead() ?? Promise.resolve()).then(() => handle.listSkills()).then(
            (skills) => write(sock, { t: "skills-result", requestId, skills }),
            (error: unknown) => write(sock, { t: "skills-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "mcp-status") {
          // The plug menu's reading of this thread's MCP servers. Answered on `sock` like the others.
          const requestId = msg.requestId as string
          void handle.mcpServerStatus().then(
            (servers) => write(sock, { t: "mcp-status-result", requestId, servers }),
            (error: unknown) => write(sock, { t: "mcp-status-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "mcp-reconnect") {
          // A sign-in finished in another session saved the token this one was missing; reconnecting is
          // what makes the server's tools appear here without restarting the thread.
          const requestId = msg.requestId as string
          const name = typeof msg.name === "string" ? msg.name : ""
          void handle.reconnectMcpServer(name).then(
            () => write(sock, { t: "mcp-reconnect-result", requestId }),
            (error: unknown) => write(sock, { t: "mcp-reconnect-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "set-mode") void handle.setPermissionMode(msg.mode as never).catch(() => {})
      }
    })
    sock.on("close", () => { if (client === sock) { client = null; armIdle() } }) // frizz gone; the session stays alive
    sock.on("error", () => {})
  })

  // WHICH socket file this daemon bound, by identity rather than by name (socket-ownership.ts, shared
  // with the codex and ACP daemons). The name is shared: every daemon ever forked for this session binds
  // the same path, and a second one unlinks the first's file before binding its own (see the sweep
  // before `listen` below). Answers "ours" until listen succeeds — unknown ⇒ the pre-identity
  // behaviour, which assumed ours — and always on Windows, where nothing unlinks a pipe by name.
  let socketPathIsOurs: () => boolean = () => true

  const recordOwner = (): number | null => {
    if (!config.recordPath) return null
    try { return (JSON.parse(readFileSync(config.recordPath, "utf8")) as BrokerRecord).daemonPid } catch { return null }
  }
  let closed = false
  // `reason` is recorded FIRST, before any teardown: `handle.close()` below can hang on a wedged CLI,
  // and a breadcrumb that only lands after a clean teardown is missing from exactly the deaths worth
  // attributing. Best-effort by construction (createClaudeBrokerExitWriter swallows everything), so
  // this can never be what stops a shutdown.
  async function shutdown(code: number, reason: ClaudeBrokerExitReason, detail?: string): Promise<void> {
    if (closed) return; closed = true
    writeExit?.(reason, detail)
    releaseRuntimeLease()
    clearTimeout(idleTimer); clearInterval(reach)
    // Owner-checked cleanup: never delete a successor's record/socket. A corpse whose record was
    // already overwritten must leave the live daemon's socket alone.
    const owner = recordOwner()
    if (config.recordPath && owner === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    // The SOCKET is checked by inode, not by the record, and `server.close()` is gated on the same
    // answer — because closing a unix-socket server UNLINKS ITS PATH. libuv does it on close
    // (uv__pipe_close), by name, whoever's file that name leads to now. So the owner check that used to
    // guard only the explicit unlink below guarded nothing: the corpse skipped the unlink and then
    // `server.close()` performed it anyway. That is the 2026-09-30 loss on `we-ve-got-to-start-working`:
    // two daemons were forked for one session, the second took the record and the path, and when the
    // first self-collected a minute later its close deleted the SURVIVOR's socket file. The survivor ran
    // on, recorded and unreachable, and every follow-up bound a client to a path that no longer existed.
    // (Reproduced in scripts/verify-broker-resume-race.mjs.)
    //
    // So a daemon that does not own the path never closes its server: the standalone daemon exits a few
    // lines below and the OS reclaims the listening fd without touching the filesystem. Only the
    // embedded (test) form, which does not exit, is left holding an unref'd listener in that case.
    const pathIsSomeoneElses = published && process.platform !== "win32" && !socketPathIsOurs()
    if (published && !pathIsSomeoneElses && process.platform !== "win32") { try { unlinkSync(config.socketPath) } catch {} }
    try { client?.destroy() } catch {}
    try { (server as { closeAllConnections?: () => void }).closeAllConnections?.() } catch {}
    if (pathIsSomeoneElses) { try { server.unref() } catch {} }
    else { try { server.close() } catch {} }
    await handle.close().catch(() => {})
    await options.lazyMcpHost?.close().catch(() => {})
    if (config.recordPath) process.exit(code) // standalone daemon
  }

  // Reachability self-collection: if UNATTACHED and either the record no longer names this pid (a
  // successor stole it, or it vanished) or the socket path no longer leads here, strike out and exit —
  // so a claude process can't leak forever.
  //
  // The socket half is the one that was missing. A daemon whose socket FILE is gone — deleted by a
  // sibling's teardown (see shutdown), a $TMPDIR cleaner, a sweep — still owns the record, so every
  // later attach ADOPTS it and binds a client to a path nothing listens on. It was the worst possible
  // corpse: alive, recorded, and unreachable by anyone, eating every follow-up until something else
  // happened to kill it (on 2026-09-30, hibernation, eight minutes later). Collecting it hands the
  // session back to the next attach, which cold-resumes from the transcript. An ATTACHED daemon is
  // left alone either way: its connection does not need the path, and it is not undiscoverable.
  const reach = setInterval(() => {
    if (client || !config.recordPath) { strikes = 0; return }
    const owner = recordOwner()
    const socketLost = published && !socketPathIsOurs()
    if (owner === process.pid && !socketLost) { strikes = 0; return }
    // Undiscoverable and unattached. If a turn was mid-flight this is where it dies, and the reason is
    // the fingerprint of which half of discoverability went.
    if (++strikes >= REACHABILITY_STRIKES) void shutdown(0, owner === process.pid ? "self-collected-socket-lost" : "self-collected-record-reassigned")
  }, REACHABILITY_CHECK_MS)
  if (reach.unref) reach.unref()

  // A bind failure used to be an UNHANDLED 'error' event: node prints a stack and exits, and the host
  // spawns this daemon with stdio:"ignore" — so the stack goes nowhere, frizz sees only a 30s "did not
  // become ready", and the operator gets "the thread went quiet". Note the `claude` child is already
  // running by this point, so this is also the moment it leaks. Record the cause, then shut down.
  // Reachable via a swept stateDir, EACCES, a >104-byte socket path on macOS, or an EADDRINUSE race.
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error)
    writeDiagnostic?.({ kind: "lifecycle", phase: "crashed", message: `socket listen failed: ${message}` })
    void shutdown(1, "socket-listen-failed", message)
  })
  try { unlinkSync(config.socketPath) } catch {} // sweep a stale unix socket before binding
  server.listen(config.socketPath, () => {
    published = true
    socketPathIsOurs = socketPathOwnership(config.socketPath)
    if (config.recordPath) {
      const processStart = selfProcessStart()
      const record: BrokerRecord = { daemonPid: process.pid, ...(processStart ? { processStart } : {}), socketPath: config.socketPath, sessionId: config.sessionId, generation, createdAt: new Date().toISOString(), capabilities: BROKER_CAPABILITIES, compactionWindow: claudeCompactionWindowOf(config.workerEnv) }
      try { writeFileSync(config.recordPath, JSON.stringify(record), { mode: 0o600 }) } catch {}
    }
    armIdle()
  })

  return { close: async () => { await shutdown(0, "frizz-requested") }, sessionId: handle.sessionId, generation }
}

/** Was node pointed AT THIS FILE, rather than this module being imported by something else?
 *
 *  Both sides go through realpath because the two are not otherwise comparable: node resolves ESM
 *  module URLs through the real path, while `process.argv[1]` is whatever string the spawner passed.
 *  On macOS a daemon spawned under a temp dir arrives as `/var/folders/…` and reports itself as
 *  `/private/var/folders/…` — a naive URL comparison silently answers "not the entry point" there,
 *  which is precisely the artifact-vs-dev divergence class that has bitten this daemon before. */
function startedAsProcessEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

// Standalone daemon entry: `nub claude-agent-broker.ts` with config in FRIZZ_CLAUDE_BROKER.
if (process.env.FRIZZ_CLAUDE_BROKER) {
  const config = JSON.parse(process.env.FRIZZ_CLAUDE_BROKER) as ClaudeBrokerConfig
  // A signal exits IMMEDIATELY and deliberately — it must not wait on a teardown that can hang — so it
  // never reaches shutdown()'s breadcrumb and used to leave no trace whatsoever. That covers frizz's own
  // killBroker (SIGTERM), an operator `kill`, and an OS shutdown: the three most common broker deaths
  // there are. Record the cause synchronously first; the handler is registered BEFORE the broker starts
  // (so a signal during startup is still attributed) and resolves the generation lazily.
  let running: RunningBroker | undefined
  const recordExit = (reason: ClaudeBrokerExitReason, detail?: string): void => {
    if (!config.diagnosticLogPath) return
    createClaudeBrokerExitWriter(config.diagnosticLogPath, {
      daemonPid: process.pid,
      generation: running?.generation ?? config.generation ?? "",
    })(reason, detail)
  }
  // …and take this daemon's own record with it. The handler exits without the teardown that unlinks the
  // record, so an OS shutdown, a logout or an operator's `kill` left every broker's record on disk,
  // naming a pid the next boot hands to something else (daemon-identity.ts). The identity is kept in the
  // `.last` file first, as the host does when IT deletes a record, so the death can still be attributed
  // to this daemon. Only a record this process still owns: a successor may have replaced it.
  const dropOwnRecord = (): void => {
    if (!config.recordPath) return
    try {
      const text = readFileSync(config.recordPath, "utf8")
      if ((JSON.parse(text) as BrokerRecord).daemonPid !== process.pid) return
      try { writeFileSync(`${config.recordPath}.last`, text) } catch {}
      unlinkSync(config.recordPath)
    } catch { /* no record, or not ours to read: nothing to drop */ }
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      recordExit(`signal-${sig}`)
      dropOwnRecord()
      process.exit(0)
    })
  }
  // The LAST-RESORT breadcrumb, and the reason this daemon's deaths were unattributable. Every other
  // exit path here records itself; a throw that reached nobody recorded nothing, and node's default —
  // print a stack, exit 1 — writes that stack to a stdio the host set to "ignore". So the log simply
  // ended on `started`, which is byte-identical to what a SIGKILL leaves. Measured across this machine's
  // whole broker corpus 2026-08-02: 276 daemon starts against 223 recorded exits, so 53 deaths (~19%)
  // had NO attribution at all, and no way to tell an external kill from frizz's own unhandled throw.
  //
  // Deliberately preserves node's semantics rather than swallowing: record, then exit NON-ZERO, exactly
  // as an unhandled throw would have. Installing these handlers is what suppresses the default exit, so
  // the explicit process.exit(1) is load-bearing — without it a crashed daemon would LINGER, wedged and
  // unreachable, which is strictly worse than dying.
  process.on("uncaughtException", (error) => {
    recordExit("uncaught-exception", error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 2000) : String(error))
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    recordExit("unhandled-rejection", reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}`.slice(0, 2000) : String(reason))
    process.exit(1)
  })
  // The lazy MCP host has to be LISTENING before the CLI starts, because its port is in the CLI's
  // config — and a listen only reports its port on a later tick. A host that fails to start costs the
  // laziness, never the session: the broker runs without one and the CLI starts the servers itself.
  const lazyMcpHost = lazyMcpEnabled() ? startLazyMcpHost({ cacheDir: join(frizzRoots().data, "mcp-cache") }) : Promise.resolve(undefined)
  void lazyMcpHost.catch(() => undefined).then((host) => { running = runClaudeBroker(config, { lazyMcpHost: host }) })
} else if (startedAsProcessEntry()) {
  // Node was pointed AT THIS FILE and there is no configuration to broker. Exiting 0 here reports
  // success for a session that never started — the silent-death shape the detached-daemon closure
  // test exists to catch, and the reason that test has been red. Codex's daemon already fails this
  // way (readConfig throws when FRIZZ_CODEX_APP_SERVER_DAEMON is absent); match it.
  //
  // Gated on being the process ENTRY POINT, not merely on the env being absent: claude-broker-host
  // spawns `node <this file>` so argv[1] is exactly this module, while a test that IMPORTS
  // runClaudeBroker runs under the test runner's argv[1] and must keep loading cleanly.
  throw new Error("claude session broker started without FRIZZ_CLAUDE_BROKER")
}
