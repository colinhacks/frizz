// The server's RenameThreadInput carries the same cap. Kept here too so a pasted title cannot make the
// inline editor appear to accept text the RPC will reject.
export const THREAD_TITLE_MAX_LENGTH = 200

// Resolve an inline-edit draft to a mutation payload. Empty/whitespace and unchanged commits are
// deliberate no-ops: blur/Enter cannot erase a good title, while Escape simply never calls this.
export function threadTitleToCommit(draft: string, current: string): string | undefined {
  const title = draft.trim()
  if (!title || title === current.trim()) return undefined
  return title
}

export function manualThreadTitleSeed(current: string, slug: string): string {
  const title = current.trim()
  return !title || title === slug || title === "Untitled thread" || title === "Spinning up a thread…" ? "" : title
}

export interface AiRenameAvailability {
  show: boolean
  enabled: boolean
  label: string
}

// Claude owns the provider-side re-title; Codex and an ACP agent have no equivalent and must never be
// shown a fake affordance for one.
//
// THE GATE IS LIVENESS, NOT IDLENESS. This required `runtime === "turn-idle"` until 2026-08-26, and
// that requirement belonged to a mechanism that no longer exists: the verb used to TYPE `/rename` into
// the session's terminal and scrape the answer back, so a turn in flight (or an open permission
// prompt) owned the composer it needed. The RPC has gone through the broker's typed control channel
// since 2026-08-24 — the same request shape as reload-plugins, stop-task and interrupt, none of which
// waits for a turn to finish — so the old gate did nothing but make the button a silent no-op on
// exactly the threads you are watching (maintainer 2026-08-26: "when you click it, it currently does
// not do anything at all"). What it genuinely needs is a LIVE broker daemon to ask.
export function aiRenameAvailability(thread: {
  kind?: "session" | "legacy"
  foreign?: boolean
  backend?: "claude" | "codex" | "acp" | "opencode"
  // A Claude row dispatched before the broker became the sole transport has no control channel, and
  // the RPC refuses it outright — so it gets no button rather than one that throws. Unknown (an older
  // server's board) is read as broker: the refusal is then the RPC's to make, with its own message.
  claudeRuntime?: string
  runtime: "none" | "spawning" | "running" | "perm-prompt" | "turn-idle" | "exited"
}): AiRenameAvailability {
  if (thread.kind !== "session" || thread.foreign || thread.backend === "codex" || thread.backend === "acp" || thread.backend === "opencode") {
    return { show: false, enabled: false, label: "" }
  }
  if (thread.claudeRuntime !== undefined && thread.claudeRuntime !== "broker") {
    return { show: false, enabled: false, label: "" }
  }
  if (thread.runtime === "exited" || thread.runtime === "none") {
    return { show: true, enabled: false, label: "Resume this Claude thread to rename it with Claude" }
  }
  if (thread.runtime === "spawning") {
    return { show: true, enabled: false, label: "Rename with Claude once this thread has started" }
  }
  return { show: true, enabled: true, label: "Rename with Claude — a fresh title from the opening request" }
}
