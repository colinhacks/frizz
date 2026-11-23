// A Claude Code session that never runs a turn, kept by the server for one project so the new-thread
// box's `/` menu has something to ask before the thread it will start exists (colinhacks/frizz#79). A
// thread's own box asks that thread's live session (router `threadSkills`); this is the same question put
// to the session a new Claude thread in this project WOULD get.
//
// WHY A SESSION AND NOT A FILE SCAN. Which skills a session can invoke is Claude Code's own answer: it
// resolves the user, project and local settings, the enabled plugins, the claude.ai-synced skills and
// their precedence. A frizz-side scan of skill directories could only drift from that, which is why the
// thread menu never had one either. So the probe IS a CLI, started the way a worker is: the project's
// directory, all three setting scopes (the factory's default), the cc-worker plugin (the `frizz:*`
// skills), and the worker's environment.
//
// WHY ITS OWN SESSION. The MCP probe (claude-mcp-probe.ts) is hermetic on purpose — no settings, no
// plugins — because all it reports is servers. A skill list needs exactly what that one leaves out.
//
// WHAT IT COSTS. No prompt is ever sent, so no model turn runs: a process and ~1.5s for the first
// listing, then ~0.4s per listing, most of it `getContextUsage` for the source labels (measured
// 2026-11-22 against claude 2.1.328). It mounts no MCP server (`strictMcpConfig` with none handed over)
// and keeps no transcript.
//
// LIFETIME. Started on the first listing and closed after IDLE_MS without one. Every listing re-reads
// the skill roots from disk, so a skill written while it runs is in the next answer without a restart.
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory, type ClaudeQueryFactory, type ClaudeQueryHandle } from "./claude-agent-sdk.ts"
import type { ClaudeSkillInfo } from "./claude-agent-sdk-protocol.ts"

const IDLE_MS = 10 * 60 * 1000

export interface ClaudeSkillsProbe {
  /** The skills `/name` invokes in a new Claude thread of this project, read fresh. */
  skills(): Promise<ClaudeSkillInfo[]>
  close(): Promise<void>
}

export interface ClaudeSkillsProbeOptions {
  projectDir: string
  executablePath: string
  /** The worker environment the CLI runs with, so the settings it resolves are a worker's. */
  env: Record<string, string>
  /** The cc-worker plugin a worker loads. */
  pluginDir?: string
  /** Tests inject a fake. */
  factory?: ClaudeQueryFactory
  idleMs?: number
}

export function createClaudeSkillsProbe(options: ClaudeSkillsProbeOptions): ClaudeSkillsProbe {
  const factory = options.factory ?? createClaudeQueryFactory({ enabled: true, executablePath: options.executablePath })
  const idleMs = options.idleMs ?? IDLE_MS
  let session: ClaudeQueryHandle | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const closeSession = async (): Promise<void> => {
    const current = session
    session = undefined
    await current?.close().catch(() => {})
  }

  const touch = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { void closeSession() }, idleMs)
    idleTimer.unref?.()
  }

  // The CLI runs its SessionStart hooks when it starts, turn or no turn, and the cc-worker plugin's would
  // give this session a worker's scratch directory under `.frizz/threads/`: an empty folder per probe
  // start. It is not a worker, so it carries no thread and switches the scratchpad hook off.
  const { FRIZZ_THREAD: _thread, ...inherited } = options.env
  const env = { ...inherited, FRIZZ_SCRATCHPAD_HOOK: "off" }

  const ensure = (): ClaudeQueryHandle => {
    if (session) return session
    const handle = factory.start({
      cwd: options.projectDir,
      session: { kind: "new", sessionId: randomUUID() },
      permissionMode: "default",
      env,
      persistSession: false,
      strictMcpConfig: true,
      ...(options.pluginDir ? { pluginDir: options.pluginDir } : {}),
    })
    session = handle
    // Drain the event stream, as the MCP probe does: a session that never runs a turn still emits the odd
    // system frame. Its end (the CLI exiting) retires the session, and the next listing starts another.
    void (async () => {
      try { for await (const _event of handle) { /* nothing to read */ } } catch {}
      if (session === handle) session = undefined
    })()
    return handle
  }

  return {
    async skills() {
      touch()
      const handle = ensure()
      try {
        return await handle.reloadSkills()
      } catch (error) {
        // A session that failed once is not asked again: the next listing starts a fresh one.
        if (session === handle) await closeSession()
        throw error
      }
    },

    async close() {
      clearTimeout(idleTimer)
      await closeSession()
    },
  }
}
