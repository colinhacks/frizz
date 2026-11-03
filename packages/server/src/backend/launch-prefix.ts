// The server's reading of Settings.launchPrefix: the words each runtime's workers are started through
// (see packages/shared/src/launch-prefix.ts for what a prefix is and how it is split).
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { parseLaunchPrefix, type ProviderAuth, type Settings } from "@frizz/shared"

export type LaunchPrefixRuntime = "claude" | "codex"

const RUNTIME_LABEL: Record<LaunchPrefixRuntime, string> = { claude: "Claude Code", codex: "Codex" }

type LaunchPrefixSettings = Pick<Settings, "launchPrefix"> | undefined

/** Whether this runtime has a prefix at all. Blank text is no prefix, and a runtime with no prefix
 *  setting (an ACP agent, whose command is already the operator's own) never has one. */
export function hasLaunchPrefix(settings: LaunchPrefixSettings, runtime: string): boolean {
  if (runtime !== "claude" && runtime !== "codex") return false
  return Boolean(settings?.launchPrefix?.[runtime]?.trim())
}

/** The prefix's words, `~/` expanded against `home`. `[]` when there is none.
 *
 *  THROWS, with a sentence the operator can act on, on a prefix that does not parse or whose command
 *  cannot be found. Callers resolve it only when they are about to START a process, so a bad prefix
 *  fails that launch, loudly, and never a reattach to a worker that is already running. (The settings
 *  save refuses an unparseable one too — see setSettings — so that half is for a value written before
 *  the parser tightened, or by hand.)
 *
 *  The command is looked up HERE because nothing downstream names it correctly: a missing one reaches
 *  the Agent SDK as a spawn ENOENT, which it reports as "Claude Code executable at <claude> exists but
 *  failed to launch" — blaming the one program that was fine. `cwd` resolves a relative command
 *  (`./scripts/inject`) the way the spawn will, from the project root; `env` is the environment the
 *  spawn searches PATH in. */
export function launchPrefixArgv(
  settings: LaunchPrefixSettings,
  runtime: LaunchPrefixRuntime,
  options: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const text = settings?.launchPrefix?.[runtime]
  if (!text?.trim()) return []
  const parsed = parseLaunchPrefix(text, { home: options.home ?? homedir() })
  if (!parsed.ok) throw new Error(`The ${RUNTIME_LABEL[runtime]} launch prefix in this project's settings cannot be used: ${parsed.error}`)
  const command = parsed.argv[0]!
  if (!commandRunnable(command, options.cwd ?? process.cwd(), options.env ?? process.env)) {
    throw new Error(`The ${RUNTIME_LABEL[runtime]} launch prefix in this project's settings starts \`${command}\`, which ${command.includes("/") || isAbsolute(command) ? "is not an executable file" : "was not found on PATH"}.`)
  }
  return parsed.argv
}

// Whether spawn() could start `command`: a path is checked as given (relative to `cwd`), a bare name
// is searched for on PATH, as execvp does. Windows resolves names through PATHEXT and app execution
// aliases this cannot reproduce faithfully, so there it answers yes and leaves the verdict to spawn.
function commandRunnable(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (process.platform === "win32") return true
  const runnable = (path: string): boolean => {
    try {
      accessSync(path, fsConstants.X_OK)
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  if (command.includes("/")) return runnable(resolve(cwd, command))
  return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && runnable(join(dir, command)))
}

/** The message for a prefix the settings save must refuse, or undefined when it may be stored.
 *
 *  Only a prefix this save CHANGES is judged. Every settings write carries the whole object, so judging
 *  them all would let one stored prefix that no longer parses (a hand edit, a parser that later
 *  tightened) refuse every save of every OTHER setting — the notifications toggle included — with an
 *  error about a field the operator did not touch. That prefix still fails its own launch, loudly. */
export function launchPrefixSettingsError(settings: LaunchPrefixSettings, stored?: LaunchPrefixSettings): string | undefined {
  for (const runtime of ["claude", "codex"] as const) {
    const text = settings?.launchPrefix?.[runtime]
    if (!text?.trim() || text === stored?.launchPrefix?.[runtime]) continue
    const parsed = parseLaunchPrefix(text)
    if (!parsed.ok) return `${RUNTIME_LABEL[runtime]} launch prefix: ${parsed.error}`
  }
  return undefined
}

/** A process record's `launchPrefix` (the Codex daemon's and the native listener's both carry one),
 *  kept only when it is a non-empty list of strings. */
export function recordedLaunchPrefix(value: unknown): { launchPrefix?: string[] } {
  if (!Array.isArray(value) || value.length === 0 || !value.every((word) => typeof word === "string")) return {}
  return { launchPrefix: value as string[] }
}

/** The dispatch sign-in gate's verdict for a runtime. A runtime with a launch prefix is never gated:
 *  the prefix is the operator saying how that runtime starts, and supplying its credentials (a token
 *  proxy, `op run`, an API key in the environment) is one of the things it is for — so "no local
 *  sign-in" says nothing about whether the worker can authenticate. It reads "unknown", on which the
 *  gate fails open, and a worker that genuinely cannot sign in reports so itself. `read` is not even
 *  called then, so Claude's CLI confirmation is not run for a verdict that would be thrown away. */
export function launchPrefixAwareAuth(settings: LaunchPrefixSettings, runtime: string, read: () => Promise<ProviderAuth>): Promise<ProviderAuth> {
  return hasLaunchPrefix(settings, runtime) ? Promise.resolve("unknown") : read()
}
