import type { AccountBackend } from "@frizz/shared"

// The exact CLI command that (re-)authenticates each provider, surfaced in the sign-in modal for the
// user to run in their own terminal. frizz is browser-attached and can't host the interactive
// browser-OAuth flow itself, so the honest affordance is the copyable command plus a re-check — not a
// button that pretends to log in. Verified against `claude auth --help` / `codex login --help`.
export const SIGN_IN_COMMAND: Record<AccountBackend, string> = {
  claude: "claude auth login",
  codex: "codex login",
}

// Human label for each backend, for sign-in copy ("You're signed out of Claude").
export const PROVIDER_LABEL: Record<AccountBackend, string> = {
  claude: "Claude",
  codex: "Codex",
}

// The toast over a dispatch whose runtime is coming down, from what runtimes.ts reports. Undefined for
// everything but the download itself: resolving the package takes a moment and needs no words.
export function runtimeDownloadNote(backend: AccountBackend, progress: string | undefined): string | undefined {
  if (!progress?.startsWith("downloading")) return undefined
  const label = backend === "claude" ? "Claude Code" : "Codex"
  const detail = progress.slice("downloading".length).replace(/^[, ]+/u, "")
  return detail ? `Downloading ${label}: ${detail}` : `Downloading ${label}…`
}

// `/login` and `/logout` are FRIZZ-OWNED aliases for the typed provider account actions — they are
// intercepted at the composer submit boundary and NEVER sent to a thread as prompt text (a leading
// slash is not a stable provider command transport: live input is pasted into a TUI while a dead
// session resumes with the text as a positional prompt). Only the complete, exact input counts;
// "/login please" or any other "/word" remains an ordinary prompt — frizz does not confiscate syntax
// it cannot prove is a command.
export function parseAccountAlias(text: string): "login" | "logout" | null {
  const t = text.trim()
  if (t === "/login") return "login"
  if (t === "/logout") return "logout"
  return null
}
