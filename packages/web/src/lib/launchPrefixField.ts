import { type Settings } from "@frizz/shared"

// The pure half of the agent settings panel's "Launch prefix" field (AgentSettingsPopover): what an
// edit writes into the settings object, and the one-line preview of what will run. The parse itself is
// shared's `parseLaunchPrefix`, the same one the server spawns with, so the field can never accept a
// prefix the server would refuse or split it differently.

export type LaunchPrefixRuntime = "claude" | "codex"

// What follows the prefix's words in the preview: the runtime's own command, elided after its first
// word(s). Codex's prefix wraps the app-server the project's Codex threads share, not a per-thread
// worker, so its preview names that process. Joined by NO-BREAK spaces, so a preview that wraps in the
// 240px panel moves the tail down whole instead of leaving `app-server …` or a lone `…` on a line.
const RUNTIME_TAIL: Record<LaunchPrefixRuntime, string> = {
  claude: "claude\u00a0…",
  codex: "codex\u00a0app-server\u00a0…",
}

/** `settings` with `runtime`'s prefix set to `text`. A blank prefix is no prefix (the server reads it
 *  the same way), so it drops its key, and an object left empty drops too, rather than storing `""`.
 *  The other runtime's prefix is kept exactly as it was. */
export function withLaunchPrefix(settings: Settings, runtime: LaunchPrefixRuntime, text: string): Settings {
  const { [runtime]: _previous, ...others } = settings.launchPrefix ?? {}
  const next = text.trim() === "" ? others : { ...others, [runtime]: text }
  const { launchPrefix: _old, ...rest } = settings
  return Object.keys(next).length === 0 ? rest : { ...rest, launchPrefix: next }
}

// A word that would read as something else unquoted — empty, spaced, quoted or shell-looking — is shown
// in single quotes, so the preview shows the split the parser made rather than re-joining it into the
// text that was typed.
const NEEDS_QUOTES = /[\s'"\\$`|&;<>()]/u

/** The command line a prefix produces for `runtime`, for display: `op run -- claude …`. */
export function launchPrefixPreview(argv: readonly string[], runtime: LaunchPrefixRuntime): string {
  const words = argv.map((word) => (word === "" || NEEDS_QUOTES.test(word) ? `'${word.replaceAll("'", `'\\''`)}'` : word))
  return [...words, RUNTIME_TAIL[runtime]].join(" ")
}
