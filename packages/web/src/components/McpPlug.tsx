import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plug } from "lucide-react"
import { useSnapshot } from "valtio"
import type { McpServerReading, McpSignInState, McpTarget } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { useReadAndAnswerHost } from "../api/supervisorStatus.ts"
import { prefs } from "../lib/prefs.ts"
import { PRIMER } from "../lib/primer.ts"
import { PLUG_GLYPH, PLUG_MARK } from "../lib/iconRhythm.ts"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"

// THE PLUG: the MCP servers of the agent a prompt box talks to, and their sign-ins. It stands beside that
// box's model chip (AgentMarks.tsx), since the servers it lists are the selected agent's.
// A thread's box asks about the thread (its live session when one runs, else what its next session would
// get); the new-thread box asks about the agent its model chip picks. The server decides where a reading
// comes from (packages/server/src/mcp-status.ts).
//
// QUIET BY DEFAULT. The plug is a plain icon like the paperclip across from it, and it carries one signal: a
// small yellow dot when a server needs a sign-in that the operator has not chosen to ignore. Ignoring is
// per agent and per browser (lib/prefs.ts `mcpIgnored`), and lasts until that server's state changes.
//
// The design was settled on a mockup sheet with the maintainer (2026-10-19): one-line rows with a GitHub
// Actions mark (green check, yellow dot, red X — octicons, not lucide's circled marks), a divider between
// rows, compact Ignore / Sign in buttons, and the sign-in card that opens inside the row.

/** How often an OPEN menu re-reads, so a sign-in finished in another tab shows without a click. */
const OPEN_REFRESH_MS = 3_000
/** How long a reading stays fresh while the menu is closed: the dot is a nudge, not a live gauge, and a
 *  Claude reading may cost the server a probe session (claude-mcp-probe.ts). */
const CLOSED_STALE_MS = 5 * 60 * 1000
const ATTEMPT_POLL_MS = 1_500

export function mcpTargetKey(target: McpTarget): string {
  return "slug" in target ? `thread:${target.slug}` : `new:${target.backend}:${target.model ?? ""}`
}

const ignoreKey = (backend: string, server: string) => `${backend}:${server}`

export function McpPlug(props: { target: McpTarget; side: "top" | "bottom" }) {
  // Its readings can start a probe and its sign-ins are this machine's, so a read-and-answer session has no plug.
  return useReadAndAnswerHost() ? null : <LocalMcpPlug {...props} />
}

function LocalMcpPlug({ target, side }: { target: McpTarget; side: "top" | "bottom" }) {
  const [open, setOpen] = useState(false)
  const key = mcpTargetKey(target)
  const status = useQuery({
    queryKey: ["mcpStatus", key],
    queryFn: () => rpc.mcpStatus(target),
    staleTime: open ? 0 : CLOSED_STALE_MS,
    refetchInterval: open ? OPEN_REFRESH_MS : false,
    retry: false,
  })
  const { mcpIgnored } = useSnapshot(prefs)
  const backend = status.data?.backend
  const servers = status.data?.servers

  // An ignore lasts until the server's state changes: drop the entries whose server has moved on (or gone).
  useEffect(() => {
    if (!backend || !servers) return
    const states = new Map(servers.map((server) => [ignoreKey(backend, server.name), server.state]))
    for (const [entry, ignoredAt] of Object.entries(prefs.mcpIgnored)) {
      if (!entry.startsWith(`${backend}:`)) continue
      if (states.get(entry) !== ignoredAt) delete prefs.mcpIgnored[entry]
    }
  }, [backend, servers])

  const isIgnored = (server: McpServerReading) => backend !== undefined && mcpIgnored[ignoreKey(backend, server.name)] === server.state
  const attention = (servers ?? []).some((server) => server.state === "needs-auth" && !isIgnored(server))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-mcp-plug
          data-mcp-attention={attention ? "true" : "false"}
          aria-label={attention ? "MCP servers, a server needs sign-in" : "MCP servers"}
          title={attention ? "MCP servers · needs sign-in" : "MCP servers"}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          // The paperclip's square, hover fill and tone, and held in its hover state while the menu is open,
          // like a pressed toolbar button.
          className={PLUG_MARK}
        >
          <Plug {...PLUG_GLYPH} aria-hidden />
          {attention && (
            <span
              aria-hidden
              data-mcp-attention-dot
              // In the lower right, a corner the plug's diagonal leaves empty.
              className="absolute bottom-[4px] right-[4px] h-[6px] w-[6px] rounded-full"
              style={{ background: PRIMER.fgAttention, boxShadow: "0 0 0 2px var(--color-bg)" }}
            />
          )}
        </button>
      </PopoverAnchor>
      <PopoverContent
        // From the plug's left edge, so the menu stays over the box. Which way it opens is the box's to say.
        side={side}
        align="start"
        data-mcp-menu
        className="w-[min(380px,calc(100vw-1.5rem))] overflow-hidden text-[12px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <McpMenu target={target} status={status} isIgnored={isIgnored} />
      </PopoverContent>
    </Popover>
  )
}

function McpMenu({ target, status, isIgnored }: {
  target: McpTarget
  status: ReturnType<typeof useQuery<Awaited<ReturnType<typeof rpc.mcpStatus>>>>
  isIgnored: (server: McpServerReading) => boolean
}) {
  const data = status.data
  // Ignored servers go last, in their own order; everything else keeps the agent's order.
  const rows = useMemo(() => {
    if (!data) return []
    const live = data.servers.filter((server) => !isIgnored(server))
    const ignored = data.servers.filter((server) => isIgnored(server))
    return [...live.map((server) => ({ server, ignored: false })), ...ignored.map((server) => ({ server, ignored: true }))]
  }, [data, isIgnored])

  let body: React.ReactNode
  if (!data && status.isPending) {
    body = <MenuNote><Loader2 size={12} className="mr-1.5 inline-block animate-spin align-[-2px]" />Checking MCP servers…</MenuNote>
  } else if (!data) {
    body = <MenuNote>Couldn’t read MCP servers. {status.error instanceof Error ? status.error.message : ""}</MenuNote>
  } else if (!data.supported) {
    body = <MenuNote>{data.agent} doesn’t support MCP status introspection.</MenuNote>
  } else if (data.note) {
    body = <MenuNote>{data.note}</MenuNote>
  } else if (data.servers.length === 0) {
    body = <MenuNote>{data.agent} has no MCP servers configured.</MenuNote>
  } else {
    body = (
      <div data-mcp-list>
        {rows.map(({ server, ignored }) => (
          <McpRow key={server.name} target={target} backend={data.backend} server={server} ignored={ignored} onSettled={() => void status.refetch()} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="border-b border-border px-[13px] pb-[8px] pt-[9px] text-[12px] font-medium text-fg">MCP servers</div>
      {body}
    </div>
  )
}

function MenuNote({ children }: { children: React.ReactNode }) {
  return <div className="px-[13px] pb-[13px] pt-[12px] text-[12px] leading-normal text-muted">{children}</div>
}

// ---- one server ------------------------------------------------------------------------------------

interface Attempt { id: string; authUrl?: string }

function McpRow({ target, backend, server, ignored, onSettled }: {
  target: McpTarget
  backend: string
  server: McpServerReading
  ignored: boolean
  onSettled: () => void
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const poll = useQuery({
    queryKey: ["mcpSignIn", attempt?.id],
    queryFn: () => rpc.mcpSignInPoll({ attemptId: attempt!.id }),
    enabled: attempt !== null,
    refetchInterval: (query) => (query.state.data && query.state.data.state !== "waiting" ? false : ATTEMPT_POLL_MS),
    retry: false,
  })
  const attemptState: McpSignInState | undefined = poll.data?.state
  useEffect(() => {
    if (!attempt || !attemptState || attemptState === "waiting") return
    if (attemptState === "done") {
      setAttempt(null)
      setError(null)
      // Every box reading this agent may have just lost its dot.
      void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] })
      onSettled()
    } else if (attemptState !== "cancelled") {
      setAttempt(null)
      setError(attemptState === "expired" ? "The sign-in timed out. Start it again." : (poll.data?.error ?? "The sign-in didn’t finish."))
    }
  }, [attempt, attemptState, poll.data?.error, queryClient, onSettled])

  const signIn = async () => {
    setError(null)
    setStarting(true)
    // Opened NOW, inside the click, and pointed at the provider once the server answers: a tab opened after
    // an await is a popup the browser blocks.
    const tab = window.open("", "_blank")
    try {
      const started = await rpc.mcpSignIn({ target, server: server.name })
      if (started.authUrl) {
        if (tab) { tab.opener = null; tab.location.href = started.authUrl }
        else window.open(started.authUrl, "_blank", "noopener")
        setAttempt({ id: started.attemptId, authUrl: started.authUrl })
      } else {
        tab?.close()
        setAttempt({ id: started.attemptId })
      }
    } catch (failure) {
      tab?.close()
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setStarting(false)
    }
  }

  const cancel = () => {
    if (attempt) void rpc.mcpSignInCancel({ attemptId: attempt.id }).catch(() => {})
    setAttempt(null)
  }

  const ignore = () => { prefs.mcpIgnored[ignoreKey(backend, server.name)] = server.state }
  const unignore = () => { delete prefs.mcpIgnored[ignoreKey(backend, server.name)] }

  let right: React.ReactNode
  if (attempt) right = <button type="button" className="mcp-btn mcp-btn-ghost" onClick={cancel}>Cancel</button>
  else if (server.state === "needs-auth") {
    right = (
      <span className="inline-flex items-center gap-[2px]">
        {ignored
          ? <button type="button" className="mcp-btn mcp-btn-ghost" onClick={unignore}>Unignore</button>
          : <button type="button" className="mcp-btn mcp-btn-ghost" onClick={ignore}>Ignore</button>}
        <button type="button" className={`mcp-btn ${ignored ? "" : "mcp-btn-primary"}`} onClick={() => void signIn()} disabled={starting}>
          {starting ? "Opening…" : "Sign in"}
        </button>
      </span>
    )
  } else if (server.tools !== undefined) {
    right = <span className="text-[11px] text-muted">{server.tools} {server.tools === 1 ? "tool" : "tools"}</span>
  } else {
    right = <span className="text-[11px] text-muted">{STATE_WORD[server.state]}</span>
  }

  return (
    <div
      data-mcp-row={server.name}
      data-mcp-state={server.state}
      data-mcp-ignored={ignored ? "true" : undefined}
      title={`${ignored ? "Ignored — " : ""}${STATE_WORD[server.state]}${server.error ? `: ${server.error}` : ""}`}
      className="mcp-row"
    >
      <div className={`mcp-name ${ignored ? "mcp-name-ignored" : ""}`}>
        <StatusMark state={server.state} dim={ignored} />
        {server.name}
      </div>
      {right}
      {attempt && <SignInCard attempt={attempt} server={server.name} />}
      {error && !attempt && <div className="mcp-row-error">{error}</div>}
    </div>
  )
}

const STATE_WORD: Record<McpServerReading["state"], string> = {
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  pending: "Connecting",
  disabled: "Disabled",
}

function SignInCard({ attempt, server }: { attempt: Attempt; server: string }) {
  const [pasted, setPasted] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const finish = async () => {
    if (!pasted.trim()) { input.current?.focus(); return }
    setBusy(true)
    setNote(null)
    try {
      await rpc.mcpSignInFinish({ attemptId: attempt.id, callbackUrl: pasted.trim() })
      setNote("Delivered. Finishing…")
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mcp-signin" data-mcp-signin>
      <div className="flex items-center gap-[7px] text-[12px] text-fg">
        <Loader2 size={14} strokeWidth={2} className="shrink-0 animate-spin text-muted" aria-hidden />
        Waiting for {server}
      </div>
      {attempt.authUrl && (
        <div className="mcp-signin-sub">
          The sign-in page opened in a new tab.{" "}
          <a href={attempt.authUrl} target="_blank" rel="noopener noreferrer" className="text-fg underline underline-offset-2">Open it again</a>
        </div>
      )}
      <div className="mcp-signin-sub mt-2">On another device? Finish there, then paste the address its last page landed on:</div>
      <form className="mcp-signin-paste" onSubmit={(event) => { event.preventDefault(); void finish() }}>
        <input
          ref={input}
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="http://localhost:…/callback?code=…"
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="mcp-btn" disabled={busy}>Finish</button>
      </form>
      {note && <div className="mcp-signin-sub mt-1.5">{note}</div>}
    </div>
  )
}

// ---- the marks -------------------------------------------------------------------------------------

// GitHub Actions' own marks — octicons `check`, `dot-fill` and `x` (16px grid) — in Primer's GLYPH
// colours (lib/primer.ts: a bare mark takes fg*, never the bg*Emphasis fill). Not lucide's circled set:
// the maintainer asked for "a green check mark that looks like the results of GitHub Actions. It's not
// inside of a circle" (2026-10-19). Vertical placement is in styles.css `.mcp-mark`.
const OCTICON: Record<"check" | "dot" | "x", string> = {
  check: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
  dot: "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
  x: "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
}

function StatusMark({ state, dim }: { state: McpServerReading["state"]; dim?: boolean }) {
  const glyph = state === "connected" ? "check" : state === "failed" ? "x" : "dot"
  const color = state === "connected" ? PRIMER.fgSuccess : state === "failed" ? PRIMER.fgDanger : state === "needs-auth" ? PRIMER.fgAttention : "var(--color-muted)"
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      data-mcp-mark={glyph}
      className={`mcp-mark mcp-mark-${glyph}`}
      style={{ color, opacity: dim ? 0.4 : undefined }}
    >
      <path d={OCTICON[glyph]} fill="currentColor" />
    </svg>
  )
}
