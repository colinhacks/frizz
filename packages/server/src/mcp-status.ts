// The prompt box's MCP menu, server side: which agent a box talks to, where its MCP servers' state comes
// from, and the sign-in attempts it starts. One per project, like everything else in AppContext.
//
// WHERE A READING COMES FROM:
//   - a Claude thread whose broker daemon is running → that daemon (`mcp-status`): the thread's real state,
//     including a server it lost mid-session.
//   - a Claude thread with no running daemon, an older daemon, or the new-thread box → the project's MCP
//     probe (backend/claude-mcp-probe.ts): what the thread's next session would get. The token store is
//     shared by every Claude session on the machine, so that verdict is the one the next session gets.
//   - Codex, thread or not → the project's app-server (`mcpServerStatus/list`): its MCP config and its
//     credentials are the app-server's, not a thread's.
//   - an ACP agent → nothing to read; the protocol has no MCP status.
//
// SIGN-IN. Starting one returns the provider's page; the agent's CLI listens on `localhost` for the
// browser's return trip and finishes the sign-in itself. This module watches for it to land (Claude: the
// probe's status turns `connected`; Codex: its `oauthLogin/completed` notification) and then makes the
// running threads pick the token up (Claude: reconnect fan-out through the bridge; Codex: a config
// reload). From another device the return trip cannot reach this machine, so the human pastes the address
// the browser landed on and `finish` delivers it to the listener — but ONLY to the loopback port this
// attempt's own redirect named, so the paste box can never be pointed at anything else.
import { randomUUID } from "node:crypto"
import type { Backend, McpServerReading, McpSignInPollResult, McpSignInResult, McpSignInState, McpStatusResult, McpTarget } from "@frizz/shared"
import { acpAgentIdFromModel } from "@frizz/shared"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { ClaudeMcpServerReading } from "./backend/claude-agent-sdk-protocol.ts"
import type { ClaudeMcpProbe } from "./backend/claude-mcp-probe.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import { FRIZZ_MCP } from "./backend/types.ts"

// How long a sign-in may wait on the human before the menu calls it expired. Generous: it spans finding
// the tab, a password manager, a 2FA prompt.
const ATTEMPT_TTL_MS = 10 * 60 * 1000
// How often a Claude attempt asks the probe whether its server has connected.
const WATCH_MS = 1_500
// A settled attempt is kept this long so a poll that arrives late still reads its outcome.
const SETTLED_KEEP_MS = 10 * 60 * 1000

const CLAUDE_SIGNED_OUT = "Claude Code isn’t signed in on this machine, so its MCP servers can’t be read."
const CODEX_UNAVAILABLE = "Codex isn’t available on this server, so its MCP servers can’t be read."

// A state of the machine, not a failure: `status` answers it as the menu's note (every prompt box asks on
// page load, so throwing it made every page on a machine without a Claude login log a 500), while a
// sign-in click still rejects with it.
class McpUnavailable extends Error {}

export interface McpServiceDeps {
  getSession(slug: string): { backend?: string; claude_runtime?: string | null; session_id: string; model?: string | null } | undefined
  claudeBroker?: ClaudeAgentBrokerBridge
  codexAppServer?: CodexAppServerBridge
  /** The project's Claude MCP probe, created on first use. */
  claudeProbe(): ClaudeMcpProbe
  /**
   * Is Claude Code signed in on this machine? The probe is a real Claude Code process, and it starts only
   * when this says yes — the same condition a Claude dispatch needs. That is what keeps one from ever
   * running under a sandbox `HOME` (an ad-hoc stack, an e2e test), where Claude Code's keychain writes
   * raise macOS's "Keychain Not Found" dialog: a sandbox carries no Claude login (CLAUDE.md).
   */
  claudeSignedIn(): Promise<boolean>
  /** An ACP agent's display name, from its id. */
  acpAgentLabel(id: string): string | undefined
  now?: () => number
  /** Tests inject a fake transport for the paste-back delivery. */
  fetch?: typeof fetch
}

export interface McpService {
  status(target: McpTarget): Promise<McpStatusResult>
  signIn(target: McpTarget, server: string): Promise<McpSignInResult>
  poll(attemptId: string): McpSignInPollResult
  finish(attemptId: string, callbackUrl: string): Promise<McpSignInPollResult>
  cancel(attemptId: string): McpSignInPollResult
  close(): Promise<void>
}

interface Resolved {
  backend: Backend
  agent: string
  /** Set for a thread: the slug and its provider session id. */
  thread?: { slug: string; sessionId: string; brokered: boolean }
}

interface Attempt {
  id: string
  backend: "claude" | "codex"
  server: string
  state: McpSignInState
  error?: string
  /** The loopback port the provider will redirect to — the one port `finish` may deliver to. */
  redirectPort?: number
  loginId?: string
  expiresAt: number
  settledAt?: number
  timer?: NodeJS.Timeout
  unsubscribe?: () => void
}

const toReading = (row: { name: string; status: McpServerReading["state"]; tools?: number; error?: string; remote?: boolean }): McpServerReading => ({
  name: row.name,
  state: row.status,
  ...(row.tools !== undefined ? { tools: row.tools } : {}),
  ...(row.error ? { error: row.error.slice(0, 2000) } : {}),
  ...(row.remote !== undefined ? { remote: row.remote } : {}),
})

// Frizz's own server is part of every worker's mount and never needs anything from the human; listing it
// would only make every menu one row longer.
const withoutFrizz = <T extends { name: string }>(rows: T[]): T[] => rows.filter((row) => row.name !== FRIZZ_MCP.name)

/** The port of an authorization URL's `redirect_uri`, when that redirect is a loopback address. */
export function loopbackRedirectPort(authUrl: string | undefined): number | undefined {
  if (!authUrl) return undefined
  try {
    const redirect = new URL(new URL(authUrl).searchParams.get("redirect_uri") ?? "")
    if (redirect.protocol !== "http:" || !isLoopbackHost(redirect.hostname)) return undefined
    const port = Number(redirect.port)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

const isLoopbackHost = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"

export function createMcpService(deps: McpServiceDeps): McpService {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetch ?? fetch
  const attempts = new Map<string, Attempt>()

  // The sign-in check runs `security` on macOS, so its answer is reused for a minute.
  let signedIn: { at: number; answer: Promise<boolean> } | undefined
  const probe = async (): Promise<ClaudeMcpProbe> => {
    if (!signedIn || now() - signedIn.at > 60_000) signedIn = { at: now(), answer: deps.claudeSignedIn().catch(() => false) }
    if (!(await signedIn.answer)) throw new McpUnavailable(CLAUDE_SIGNED_OUT)
    return deps.claudeProbe()
  }

  const resolve = (target: McpTarget): Resolved => {
    if ("slug" in target) {
      const row = deps.getSession(target.slug)
      if (!row) throw new Error(`thread ${target.slug} has no session to read MCP servers from`)
      const backend: Backend = row.backend === "codex" || row.backend === "acp" || row.backend === "opencode" ? row.backend : "claude"
      return {
        backend,
        agent: agentLabel(backend, row.model ?? undefined),
        thread: { slug: target.slug, sessionId: row.session_id, brokered: row.claude_runtime === "broker" },
      }
    }
    return { backend: target.backend, agent: agentLabel(target.backend, target.model) }
  }

  const agentLabel = (backend: Backend, model: string | undefined): string => {
    if (backend === "codex") return "Codex"
    if (backend === "claude") return "Claude Code"
    if (backend === "opencode") return "OpenCode"
    const id = acpAgentIdFromModel(model)
    return (id && deps.acpAgentLabel(id)) || "This agent"
  }

  const claudeServers = async (resolved: Resolved): Promise<ClaudeMcpServerReading[]> => {
    if (resolved.thread?.brokered && deps.claudeBroker) {
      try {
        return withoutFrizz(await deps.claudeBroker.mcpServerStatus({ threadSlug: resolved.thread.slug, sessionId: resolved.thread.sessionId }))
      } catch {
        // No running daemon, or one older than mcp-v1: fall through to what its next session would get.
      }
    }
    return withoutFrizz(await (await probe()).status())
  }

  const settle = (attempt: Attempt, state: McpSignInState, error?: string): void => {
    if (attempt.state !== "waiting") return
    attempt.state = state
    if (error) attempt.error = error.slice(0, 2000)
    attempt.settledAt = now()
    clearInterval(attempt.timer)
    attempt.unsubscribe?.()
    if (attempt.backend === "claude") {
      try { deps.claudeProbe().release(attempt.server) } catch {}
    }
    if (state === "done") {
      // The sign-in saved a token the running sessions do not know about yet.
      if (attempt.backend === "claude") void deps.claudeBroker?.reconnectMcpServerEverywhere(attempt.server).catch(() => 0)
      else void deps.codexAppServer?.reloadMcpServers().catch(() => {})
    }
  }

  const sweep = (): void => {
    const at = now()
    for (const [id, attempt] of attempts) {
      if (attempt.state === "waiting" && at >= attempt.expiresAt) settle(attempt, "expired")
      if (attempt.settledAt !== undefined && at - attempt.settledAt > SETTLED_KEEP_MS) attempts.delete(id)
    }
  }

  const attemptOf = (attemptId: string): Attempt => {
    sweep()
    const attempt = attempts.get(attemptId)
    if (!attempt) throw new Error("That sign-in is no longer known; start it again")
    return attempt
  }

  const view = (attempt: Attempt): McpSignInPollResult => ({ state: attempt.state, ...(attempt.error ? { error: attempt.error } : {}) })

  return {
    async status(target) {
      const resolved = resolve(target)
      if (resolved.backend === "acp" || resolved.backend === "opencode") return { backend: resolved.backend, agent: resolved.agent, supported: false, servers: [] }
      if (resolved.backend === "codex") {
        if (!deps.codexAppServer) return { backend: "codex", agent: resolved.agent, supported: true, servers: [], note: CODEX_UNAVAILABLE }
        const rows = withoutFrizz(await deps.codexAppServer.listMcpServers())
        return { backend: "codex", agent: resolved.agent, supported: true, servers: rows.map(toReading) }
      }
      try {
        return { backend: "claude", agent: resolved.agent, supported: true, servers: (await claudeServers(resolved)).map(toReading) }
      } catch (error) {
        if (error instanceof McpUnavailable) return { backend: "claude", agent: resolved.agent, supported: true, servers: [], note: error.message }
        throw error
      }
    },

    async signIn(target, server) {
      sweep()
      const resolved = resolve(target)
      if (resolved.backend === "acp" || resolved.backend === "opencode") throw new Error(`${resolved.agent} doesn't support MCP sign-in from Frizz`)
      // One live attempt per server: a second click reuses it rather than racing two listeners.
      for (const attempt of attempts.values()) {
        if (attempt.state === "waiting" && attempt.server === server && attempt.backend === resolved.backend) {
          settle(attempt, "cancelled")
        }
      }
      const attempt: Attempt = { id: randomUUID(), backend: resolved.backend, server, state: "waiting", expiresAt: now() + ATTEMPT_TTL_MS }
      if (resolved.backend === "codex") {
        if (!deps.codexAppServer) throw new McpUnavailable(CODEX_UNAVAILABLE)
        // Subscribe BEFORE starting, so a completion that lands immediately is not missed.
        attempt.unsubscribe = deps.codexAppServer.onMcpOAuthCompleted((event) => {
          if (event.name !== server) return
          if (attempt.loginId && event.loginId && event.loginId !== attempt.loginId) return
          settle(attempt, event.success ? "done" : "failed", event.error)
        })
        try {
          const started = await deps.codexAppServer.startMcpOAuthLogin(server)
          attempt.loginId = started.loginId
          attempt.redirectPort = loopbackRedirectPort(started.authUrl)
          attempts.set(attempt.id, attempt)
          return { attemptId: attempt.id, authUrl: started.authUrl, state: attempt.state }
        } catch (error) {
          attempt.unsubscribe()
          throw error
        }
      }
      const claude = await probe()
      const started = await claude.authenticate(server)
      attempt.redirectPort = started.callbackPort ?? loopbackRedirectPort(started.authUrl)
      attempts.set(attempt.id, attempt)
      // The CLI finishes the sign-in on its own and reconnects the server; watch the probe for that.
      attempt.timer = setInterval(() => {
        if (attempt.state !== "waiting") return
        if (now() >= attempt.expiresAt) { settle(attempt, "expired"); return }
        void claude.serverStatus(server).then((row) => {
          if (row?.status === "connected") settle(attempt, "done")
        }, () => {})
      }, WATCH_MS)
      attempt.timer.unref?.()
      return { attemptId: attempt.id, ...(started.authUrl ? { authUrl: started.authUrl } : {}), state: attempt.state }
    },

    poll(attemptId) {
      return view(attemptOf(attemptId))
    },

    async finish(attemptId, callbackUrl) {
      const attempt = attemptOf(attemptId)
      if (attempt.state !== "waiting") return view(attempt)
      let url: URL
      try { url = new URL(callbackUrl) } catch { throw new Error("That isn't an address. Paste the whole address from the browser's address bar.") }
      if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
        throw new Error("That isn't the sign-in's return address. It starts with http://localhost.")
      }
      if (attempt.redirectPort === undefined || Number(url.port) !== attempt.redirectPort) {
        throw new Error("That address is from a different sign-in. Start this one again and paste the address it lands on.")
      }
      // Delivered on 127.0.0.1 first: a CLI listening on IPv4 alone refuses `localhost` when it resolves to ::1.
      const candidates = [new URL(url), new URL(url)]
      candidates[0].hostname = "127.0.0.1"
      candidates[1].hostname = "[::1]"
      let lastError: unknown
      for (const candidate of candidates) {
        try {
          const response = await fetchImpl(candidate, { redirect: "manual", signal: AbortSignal.timeout(15_000) })
          await response.body?.cancel().catch(() => {})
          if (response.status >= 400) throw new Error(`the sign-in listener answered ${response.status}`)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError) throw new Error(`Couldn't deliver it: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
      // The listener has the code; the watcher (Claude) or the notification (Codex) settles the attempt.
      return view(attempt)
    },

    cancel(attemptId) {
      const attempt = attemptOf(attemptId)
      settle(attempt, "cancelled")
      return view(attempt)
    },

    async close() {
      for (const attempt of attempts.values()) settle(attempt, "cancelled")
      attempts.clear()
    },
  }
}
