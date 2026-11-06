import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { ACP_MODEL_PREFIX, acpAgentIdFromModel, acpModelSlug } from "@frizz/shared"

// Which ACP agents Frizz knows how to launch, and which of them this machine actually has.
//
// ACP agents are PATH-resolved, never provisioned (plans/acp-backend.md, decision 5): the operator
// installs and logs into `opencode`, `gemini`, `copilot` … with the vendor's own installer and CLI, and
// Frizz only needs to know the executable and the argument that puts it into ACP mode. The registry at
// github.com/agentclientprotocol/registry is the source for those launch shapes; the ones here are the
// agents with measurable usage in 2026 (see plans/acp-backend.md) plus the ones that share a binary
// family with them. Anything else rides `settings.acpAgents`, the same shape, and wins on id collision.
// A name on PATH is all this can check, so a name another popular tool holds stays out: Block's goose agent
// takes a `settings.acpAgents` entry, because Homebrew's `goose` is a database migration tool.

export interface AcpAgentSpec {
  /** Stable id, used as the thread's `acp_agent` column and the composer's `acp:<id>` model slug. */
  id: string
  label: string
  /** Executable name (looked up on PATH) or an absolute path. */
  command: string
  args: string[]
}

export const ACP_AGENT_CATALOGUE: readonly AcpAgentSpec[] = [
  { id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "cursor", label: "Cursor agent", command: "cursor-agent", args: ["acp"] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", args: ["--acp"] },
  { id: "copilot", label: "GitHub Copilot CLI", command: "copilot", args: ["--acp"] },
  { id: "kilo", label: "Kilo", command: "kilo", args: ["acp"] },
  { id: "qwen", label: "Qwen Code", command: "qwen", args: ["--acp"] },
  { id: "kimi", label: "Kimi CLI", command: "kimi", args: ["acp"] },
  // `grok agent stdio` is ACP over stdio (registry: `npx @xai-official/grok agent stdio`); verified
  // live 2026-09-16 against grok 1.0.13 — it mounted the probe MCP server and called its tool.
  { id: "grok", label: "Grok Build", command: "grok", args: ["agent", "stdio"] },
  // pi has no native ACP mode; `pi-acp` is its registry wrapper and takes no arguments.
  { id: "pi", label: "pi", command: "pi-acp", args: [] },
]

/** What the operator writes under `settings.acpAgents`: the spec with `args` optional. */
export type AcpAgentInput = Omit<AcpAgentSpec, "args"> & { args?: readonly string[] }

export interface ResolvedAcpAgent extends AcpAgentSpec {
  /** The absolute executable, when it was found. */
  bin?: string
}

// The `acp:<id>` model-slug grammar lives in @frizz/shared so the composer and the dispatcher cannot drift.
export { ACP_MODEL_PREFIX, acpAgentIdFromModel, acpModelSlug }

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== "win32") accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

/** Find `command` on PATH (or verify it as an absolute path). Windows also tries PATHEXT suffixes. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(command)) return isExecutableFile(command) ? command : undefined
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase())
      if (isExecutableFile(candidate)) return candidate
      if (ext && isExecutableFile(join(dir, command + ext))) return join(dir, command + ext)
    }
  }
  return undefined
}

/** The catalogue merged with the operator's own entries (theirs win on id), in catalogue order. */
export function acpAgentSpecs(custom: readonly AcpAgentInput[] | undefined): AcpAgentSpec[] {
  const byId = new Map<string, AcpAgentSpec>()
  for (const spec of ACP_AGENT_CATALOGUE) byId.set(spec.id, spec)
  for (const spec of custom ?? []) if (spec.id && spec.command) byId.set(spec.id, { ...spec, args: [...(spec.args ?? [])] })
  return [...byId.values()]
}

/** Every known agent, with `bin` set for the ones present on this machine. */
export function listAcpAgents(custom: readonly AcpAgentInput[] | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAcpAgent[] {
  return acpAgentSpecs(custom).map((spec) => {
    const bin = findOnPath(spec.command, env)
    return bin ? { ...spec, bin } : { ...spec }
  })
}

export function resolveAcpAgent(id: string, custom: readonly AcpAgentInput[] | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAcpAgent | undefined {
  const spec = acpAgentSpecs(custom).find((s) => s.id === id)
  if (!spec) return undefined
  const bin = findOnPath(spec.command, env)
  return bin ? { ...spec, bin } : { ...spec }
}
