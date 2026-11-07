import { query } from "@frizz/claude-agent-sdk-runtime"
import { claudeFamilyLabel, parseClaudeWireId, type ClaudeModel, type ClaudeModelFamily } from "@frizz/shared"
import { sanitizeProviderChildEnvironment } from "./claude-agent-sdk.ts"
import { resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { isRuntimeDeferred } from "../runtime-deferral.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The Claude Code side of the model catalogue, the analogue of codex-models.ts: the picker labels a
// Claude alias with the EDITION the pinned runtime resolves it to ("Opus 5.5", "Fable 5.1"), never with
// the bare family word (maintainer 2026-09-24: "if we have the full resolved version of the model, like
// Fable 5.1 or Opus 5.5, I think we should probably just put that in the model and effort selector …
// We already do this for GPT"). Frizz keeps dispatching on the ALIAS — `claude --model opus` is what
// tracks a new Opus when the pin moves — so the alias is the value and only the label resolves.
//
// The resolution comes from the runtime itself, not a table: the SDK's `supportedModels()` answers from
// the pinned binary with a `resolvedModel` per row (measured on Claude Code 2.1.281: `opus[1m]` →
// `claude-opus-5-5[1m]`, `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5-20251001`, and Fable
// rides a `claude-fable-5-1[1m]` row). A hand-kept table would be wrong from the first pin bump that
// moved an alias, and the pins bump weekly. The probe is a control request the CLI answers locally —
// no API call, no session file — and it is memoised per executable for the server's life, because the
// pin cannot change without a restart.

/** The aliases Frizz offers, in capability order — the same order CLAUDE_THREAD_PROFILES keeps. */
export const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const satisfies readonly ClaudeModelFamily[]
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number]

// The DEGRADED answer — the bare family words — for the loading state, a probe that failed, and a
// runtime too old to answer. Everything that consumed the static picker before this module existed
// reads exactly these labels.
export const CLAUDE_MODELS_FALLBACK: ClaudeModel[] = CLAUDE_MODEL_ALIASES.map((alias) => ({ alias, label: claudeFamilyLabel(alias) }))

/** Map the runtime's `supportedModels()` rows onto Frizz's aliases. PURE and total: a row of any shape is
 *  tolerated, an alias no row resolves keeps its bare family label, and the order is Frizz's own. Exported
 *  for a fixture unit test over the real 2.1.281 answer. */
export function resolveClaudeModels(rows: readonly unknown[]): ClaudeModel[] {
  const byAlias = new Map<ClaudeModelAlias, ClaudeModel>()
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as Record<string, unknown>
    // `resolvedModel` is the canonical id behind an alias row; a row keyed on a wire id directly
    // (`claude-fable-5-1[1m]`) carries the same fact in `value`. The first row per family wins — the
    // CLI lists its default first, and every row of one family resolves the same edition.
    for (const key of ["resolvedModel", "value"] as const) {
      const candidate = row[key]
      if (typeof candidate !== "string") continue
      const parsed = parseClaudeWireId(candidate)
      if (!parsed || byAlias.has(parsed.alias)) continue
      byAlias.set(parsed.alias, { alias: parsed.alias, label: `${claudeFamilyLabel(parsed.alias)} ${parsed.edition}`, resolvedModel: parsed.resolvedModel, edition: parsed.edition })
      break
    }
  }
  return CLAUDE_MODEL_ALIASES.map((alias) => byAlias.get(alias) ?? { alias, label: claudeFamilyLabel(alias) })
}

// One probe per executable for the server's life (a resolved list), with the in-flight promise shared
// so a burst of picker mounts spawns one CLI, not one each. A FAILED probe is not memoised past a short
// backoff: the runtime may simply not be ready yet (first boot, a Defender scan on Windows), and the
// fallback labels are the honest answer meanwhile.
const PROBE_TIMEOUT_MS = 15_000
const FAILURE_BACKOFF_MS = 30_000
const resolved = new Map<string, ClaudeModel[]>()
const inFlight = new Map<string, Promise<ClaudeModel[]>>()
const failedAt = new Map<string, number>()
// The last catalogue a probe actually resolved, for the SYNCHRONOUS readers — the board's
// `modelUpgrade` and the follow-up's upgrade-at-compaction check — which cannot await a probe. One
// server runs one pinned runtime, so one slot is the whole answer; `undefined` until the first probe
// lands, and every reader treats that as "no upgrade known", never as "behind".
let lastResolved: ClaudeModel[] | undefined
// Told when a probe resolves, so a board built before it can re-derive every thread's `modelUpgrade`.
const resolvedListeners = new Set<() => void>()

export interface ReadClaudeModelsOptions {
  claudeBin?: string
  cwd?: string
  log?: (message: string) => void
}

/** The Claude models for the picker (RPC-facing): resolved labels from the pinned runtime, or the bare
 *  fallback while the probe runs or when it cannot. NEVER throws. */
export async function readClaudeModels(options: ReadClaudeModelsOptions = {}): Promise<ClaudeModel[]> {
  // Reading the catalogue starts the runtime, and one still waiting for its first thread stays unstarted.
  if (isRuntimeDeferred("claude")) return CLAUDE_MODELS_FALLBACK
  let executable: string
  try {
    executable = resolveClaudeExecutableAbsolute(options.claudeBin)
  } catch {
    return CLAUDE_MODELS_FALLBACK
  }
  const hit = resolved.get(executable)
  if (hit) return hit
  const pending = inFlight.get(executable)
  if (pending) return pending
  const failed = failedAt.get(executable)
  if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS) return CLAUDE_MODELS_FALLBACK
  const probe = probeClaudeModels(executable, options.cwd ?? process.cwd())
    .then((models) => {
      resolved.set(executable, models)
      lastResolved = models
      failedAt.delete(executable)
      for (const listener of resolvedListeners) {
        try { listener() } catch { /* a listener never fails the probe */ }
      }
      return models
    })
    .catch((err: unknown) => {
      failedAt.set(executable, Date.now())
      options.log?.(`claude models: could not read the runtime's catalogue (${err instanceof Error ? err.message : String(err)}); labelling the picker by family`)
      return CLAUDE_MODELS_FALLBACK
    })
    .finally(() => inFlight.delete(executable))
  inFlight.set(executable, probe)
  return probe
}

// Spawn the runtime through the SDK with a prompt that never arrives, ask it for its models, close it.
// Exported for the live test against the provisioned pin.
export async function probeClaudeModels(executable: string, cwd: string): Promise<ClaudeModel[]> {
  async function* never(): AsyncGenerator<never> {
    await new Promise<never>(() => {})
  }
  const q = query({
    prompt: never(),
    options: {
      cwd,
      env: sanitizeProviderChildEnvironment(inheritWorkerEnvironment()),
      pathToClaudeCodeExecutable: executable,
      persistSession: false,
      maxTurns: 0,
    },
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const rows = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the runtime did not list its models within ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)
      }),
    ])
    return resolveClaudeModels(rows)
  } finally {
    if (timer) clearTimeout(timer)
    q.close()
  }
}

/** The catalogue the pinned runtime last resolved, without waiting for one — see `lastResolved`. */
export function peekClaudeModels(): readonly ClaudeModel[] | undefined {
  return lastResolved
}

/** Subscribe to probe resolutions; returns the unsubscribe. */
export function onClaudeModelsResolved(listener: () => void): () => void {
  resolvedListeners.add(listener)
  return () => { resolvedListeners.delete(listener) }
}

/** Test seam: forget every memoised probe. */
export function resetClaudeModelsCache(): void {
  resolved.clear()
  inFlight.clear()
  failedAt.clear()
  lastResolved = undefined
}
