import { z } from "zod"
import { INTERACTION_PROTOCOL_VERSION, InteractionRequest, NOTES_FIELD_SUFFIX, PermissionMode, antigravityModelId, type InteractionField, type InteractionRequest as InteractionRequestType, type ProviderQuota, type QuotaWindow } from "@frizz/shared"
import type { AcpConfigOption, AcpRequestPermissionParams } from "./acp-types.ts"

// What `agy acp` (Google Antigravity's CLI) says beyond the Agent Client Protocol, and how each piece
// reads in Frizz's own vocabulary. Every shape here was measured against agy 1.5.12 on 2026-11-20
// (plans/antigravity-backend.md has the frames); the schemas stay open, because the CLI ships weekly.

export const ANTIGRAVITY_COMMAND = "agy"
export const ANTIGRAVITY_LABEL = "Antigravity"

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined)
const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

// ---- launch ---------------------------------------------------------------------------------------

/** `agy acp`'s arguments for a thread in `mode`. Bypass is a LAUNCH flag, not a session mode: it is the
 *  only setting that lifts the terminal sandbox, so moving a thread to or from it restarts the agent. */
export const ANTIGRAVITY_BYPASS_FLAG = "--dangerously-skip-permissions"

export function antigravityLaunchArgs(mode: PermissionMode | null | undefined): string[] {
  return mode === "bypassPermissions" ? ["acp", ANTIGRAVITY_BYPASS_FLAG] : ["acp"]
}

/** The session mode (`mode` config option) a Frizz permission mode asks for. Under the bypass flag the
 *  mode decides nothing (no call asks and no shell is sandboxed), so the session stays on `default`. */
export function antigravitySessionMode(mode: PermissionMode | null | undefined): "default" | "accept-edits" | "auto" | "plan" {
  if (mode === "acceptEdits") return "accept-edits"
  if (mode === "auto") return "auto"
  if (mode === "plan") return "plan"
  return "default"
}

/** What a thread row asks its agent to run on: the model inside its slug, its effort as the thinking
 *  level, and its permission mode. */
export function antigravityProfileOf(row: { model?: string | null; effort?: string | null; permission_mode?: string | null }): { modelId: string | null; effort: string | null; permissionMode: PermissionMode | null } {
  const mode = PermissionMode.safeParse(row.permission_mode)
  return { modelId: antigravityModelId(row.model) ?? null, effort: row.effort || null, permissionMode: mode.success ? mode.data : null }
}

// ---- config options ---------------------------------------------------------------------------------

export function antigravityOption(configOptions: readonly AcpConfigOption[] | null | undefined, id: "model" | "thought_level" | "mode"): AcpConfigOption | undefined {
  return configOptions?.find((o) => o.category === id) ?? configOptions?.find((o) => o.id === id)
}

// ---- tool calls -------------------------------------------------------------------------------------

/**
 * One of Antigravity's tool calls in the vocabulary Frizz's cards are built from (Claude's: `Bash`,
 * `Edit`, `Agent`, …), which is how OpenCode's are written too (opencode-types.ts `frizzToolShape`). A
 * tool with no counterpart keeps its own name and input and draws as a plain row.
 */
export function antigravityToolShape(name: string, rawInput: unknown): { name: string; input: Json } {
  const input = asObject(rawInput) ?? {}
  const path = asString(input.Path)
  switch (name) {
    case "run_command": return {
      name: "Bash",
      input: { command: input.CommandLine ?? "", ...(asString(input.toolSummary) ? { description: input.toolSummary } : {}), ...(input.IsDaemon === true ? { run_in_background: true } : {}) },
    }
    case "read_file": return { name: "Read", input: { file_path: path ?? "", ...(typeof input.StartLine === "number" ? { offset: input.StartLine } : {}), ...(typeof input.StartLine === "number" && typeof input.EndLine === "number" ? { limit: Math.max(1, input.EndLine - input.StartLine + 1) } : {}) } }
    case "write_file": return { name: "Write", input: { file_path: path ?? "", content: input.Content ?? "" } }
    case "edit_file": return { name: "Edit", input: { file_path: path ?? "", old_string: input.Target ?? "", new_string: input.Replacement ?? "" } }
    case "search_web": return { name: "WebSearch", input: { query: input.query ?? "" } }
    case "invoke_subagent": return {
      name: "Agent",
      input: { description: input.Role ?? "", prompt: input.Prompt ?? "", ...(asString(input.TypeName) ? { subagent_type: input.TypeName } : {}), ...(asString(input.Model) ? { model: input.Model } : {}) },
    }
    case "ask_question": return {
      name: "AskUserQuestion",
      input: {
        questions: asArray(input.questions).map((raw) => {
          const q = asObject(raw) ?? {}
          return { question: q.question ?? "", multiSelect: q.is_multi_select === true, options: asArray(q.options).map((o) => ({ label: typeof o === "string" ? o : String(asObject(o)?.label ?? "") })) }
        }),
      },
    }
    default: return { name, input }
  }
}

/** The shell command a `run_command` call would run, or undefined for any other tool. */
export function antigravityCommandLine(toolName: string | undefined, rawInput: unknown): string | undefined {
  if (toolName !== undefined && toolName !== "run_command") return undefined
  return asString(asObject(rawInput)?.CommandLine)
}

/**
 * Is this command ONE plain `frizzctl` call: bare or quoted words, and at most an inert heredoc for its
 * prose? `frizzctl` is how a worker talks to Frizz and every harness pre-approves it (Claude's
 * allowedTools, OpenCode's `shell frizzctl *` rule), so in a mode that asks before each command the
 * bridge answers these itself. Anything a shell would expand, chain or redirect is not plain, and asks.
 */
export function isPlainFrizzctlCommand(commandLine: string): boolean {
  // A shell's blanks are the space and the tab, and nothing else. `\s` and `trim()` also take a form
  // feed, a carriage return, a no-break space and a dozen more, and each of those is an ordinary
  // character to a shell: one beside a heredoc's delimiter becomes PART of the delimiter, so the shell
  // closes the heredoc on a line this check never looks at and runs what follows (reproduced in bash,
  // zsh and sh, 2026-11-20). So every blank here is spelled out, and a control character asks.
  const text = commandLine.replace(/^[ \t\n]+|[ \t\n]+$/g, "")
  const newline = text.indexOf("\n")
  const head = newline === -1 ? text : text.slice(0, newline)
  const rest = newline === -1 ? undefined : text.slice(newline + 1)
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(head) || text.includes("\u0000")) return false
  const match = /^frizzctl((?:[ \t]+(?:[A-Za-z0-9_@%+=:,.\/-]+|'[^']*'|"[^"$`\\]*"))*)(?:[ \t]+<<[ \t]*'([A-Za-z_][A-Za-z0-9_]*)')?[ \t]*$/.exec(head)
  if (!match) return false
  const delimiter = match[2]
  if (!delimiter) return rest === undefined
  if (rest === undefined) return false
  // A heredoc with a QUOTED delimiter is literal text up to the delimiter's own line; nothing follows it.
  const lines = rest.split("\n")
  const end = lines.indexOf(delimiter)
  return end !== -1 && lines.slice(end + 1).every((line) => /^[ \t]*$/.test(line))
}

/** A permission request with its tool input renamed to the keys the shared ACP card builder reads
 *  (`command`, `path`), so one builder draws both dialects' approvals. */
export function antigravityPermissionParams(params: AcpRequestPermissionParams): AcpRequestPermissionParams {
  const input = asObject(params.toolCall.rawInput)
  if (!input) return params
  const { CommandLine, Path, Content, Target, Replacement, WaitMsBeforeAsync: _wait, toolSummary: _summary, ArtifactMetadata: _artifact, ...others } = input
  const rawInput: Json = {
    ...(asString(CommandLine) ? { command: CommandLine } : {}),
    ...(asString(Path) ? { path: Path } : {}),
    ...(asString(Content) ? { content: Content } : {}),
    ...(asString(Target) ? { replace: Target } : {}),
    ...(typeof Replacement === "string" ? { with: Replacement } : {}),
    ...others,
  }
  return { ...params, toolCall: { ...params.toolCall, rawInput } }
}

// ---- questions --------------------------------------------------------------------------------------

/** `elicitation/create`: how `ask_question` reaches a client that advertised `elicitation.form`. */
export const AntigravityElicitationParams = z.object({
  sessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  mode: z.string().optional(),
  message: z.string().optional(),
  requestedSchema: z.object({ properties: z.record(z.unknown()).optional() }).passthrough().optional(),
}).passthrough()
export type AntigravityElicitationParams = z.infer<typeof AntigravityElicitationParams>

export type AntigravityElicitationResult = { action: "accept"; content: Json } | { action: "decline" } | { action: "cancel" }

/** One question of a form: its property key, whether it takes several answers, and the key of the
 *  free-text property that rides beside it (`q1_other`), when the agent offered one. */
export interface AntigravityQuestionField { key: string; multi: boolean; otherKey?: string; hasOptions: boolean }

const QUESTION_DECISIONS = [
  { id: "answer", semantic: "answer" as const, label: "Send answer", description: "Send these answers back to the agent." },
  { id: "decline", semantic: "decline" as const, label: "Decline", description: "Tell the agent nobody answered, so it decides for itself." },
]

function schemaOptions(prop: Json): Array<{ value: string; label: string }> {
  const list = prop.type === "array" ? asArray(asObject(prop.items)?.anyOf).concat(asArray(asObject(prop.items)?.oneOf)) : asArray(prop.oneOf).concat(asArray(prop.anyOf))
  const out: Array<{ value: string; label: string }> = []
  for (const raw of list) {
    const o = asObject(raw)
    const value = typeof o?.const === "string" ? o.const : typeof o?.const === "number" ? String(o.const) : undefined
    if (value === undefined || value === "") continue
    out.push({ value, label: clip(asString(o?.title) ?? value, 160) })
  }
  return out
}

/** An Antigravity question form as a Frizz question card. Null when it holds nothing answerable. */
export function buildAntigravityQuestionInteraction(
  params: AntigravityElicitationParams,
  owner: { projectId: string; threadSlug: string; sessionId: string; turnId: string; itemId: string; sessionEpoch: number; capabilityRevision: number },
  providerRequestId: string,
): { request: InteractionRequestType; fields: AntigravityQuestionField[] } | null {
  const props = params.requestedSchema?.properties ?? {}
  const keys = Object.keys(props)
  const fields: AntigravityQuestionField[] = []
  const out: InteractionField[] = []
  for (const key of keys) {
    const prop = asObject(props[key])
    if (!prop || key.endsWith("_other")) continue
    const multi = prop.type === "array"
    const options = schemaOptions(prop)
    const otherKey = asObject(props[`${key}_other`]) ? `${key}_other` : undefined
    const base = { id: key, label: clip(asString(prop.title) ?? "Question", 160), ...(asString(prop.description) ? { description: clip(prop.description as string, 4_000) } : {}), required: false, secret: false }
    fields.push({ key, multi, ...(otherKey ? { otherKey } : {}), hasOptions: options.length > 0 })
    if (options.length) {
      out.push({ ...base, input: multi ? "multi-select" : "select", options } as InteractionField)
      if (otherKey) out.push({ id: `${key}${NOTES_FIELD_SUFFIX}`, label: base.label, input: "multiline", required: false, secret: false, maxLength: 4_000 } as InteractionField)
    } else {
      out.push({ ...base, input: "multiline", maxLength: 4_000 } as InteractionField)
    }
  }
  if (!fields.length) return null
  const first = asObject(props[fields[0]!.key])
  const title = clip(fields.length === 1 ? asString(first?.title) ?? "Antigravity question" : asString(params.message) ?? "Antigravity questions", 150)
  const parsed = InteractionRequest.safeParse({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text",
    provider: { kind: "antigravity", name: ANTIGRAVITY_LABEL },
    source: { kind: "agent", id: clip(providerRequestId, 500), label: ANTIGRAVITY_LABEL },
    owner,
    providerRequestId: clip(providerRequestId, 500),
    allowedDecisions: QUESTION_DECISIONS,
    payload: { kind: "agent-question", title, fields: out },
    expiresAt: null,
  })
  return parsed.success ? { request: parsed.data, fields } : null
}

/** A card's values as the form's `content`: the picked option(s) by their `const`, and typed words in
 *  the question's `_other` property (or as the answer itself, for a question with no options). */
export function antigravityQuestionAnswer(fields: readonly AntigravityQuestionField[], values: Record<string, unknown> | undefined): Json {
  const content: Json = {}
  for (const field of fields) {
    const raw = values?.[field.key]
    const notes = values?.[`${field.key}${NOTES_FIELD_SUFFIX}`]
    const typed = typeof notes === "string" && notes.trim() ? notes.trim() : undefined
    if (!field.hasOptions) {
      if (typeof raw === "string" && raw.trim()) content[field.key] = raw.trim()
      continue
    }
    const picked = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v !== "") : typeof raw === "string" && raw ? [raw] : []
    if (field.multi) { if (picked.length) content[field.key] = picked }
    else if (picked[0]) content[field.key] = picked[0]
    if (typed && field.otherKey) content[field.otherKey] = typed
  }
  return content
}

/** What the transcript's question row shows for each question: the labels picked and the words typed. */
export function antigravityAnswerLabels(params: AntigravityElicitationParams, fields: readonly AntigravityQuestionField[], content: Json): Array<string | null> {
  const props = params.requestedSchema?.properties ?? {}
  return fields.map((field) => {
    const options = schemaOptions(asObject(props[field.key]) ?? {})
    const label = (value: unknown): string | undefined => (typeof value === "string" ? options.find((o) => o.value === value)?.label ?? value : undefined)
    const raw = content[field.key]
    const picked = (Array.isArray(raw) ? raw.map(label) : [label(raw)]).filter((v): v is string => !!v)
    const typed = field.otherKey ? asString(content[field.otherKey]) : undefined
    const all = [...picked, ...(typed ? [typed] : [])]
    return all.length ? all.join(", ") : null
  })
}

// ---- quota ------------------------------------------------------------------------------------------

/** `agy -p "/usage" --output-format json`: one group per family of models that share a limit. */
export const AntigravityUsage = z.object({
  command: z.object({
    data: z.object({
      groups: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        buckets: z.array(z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          window: z.string().optional(),
          remaining_fraction: z.number(),
          reset_time: z.string().optional(),
        }).passthrough()),
      }).passthrough()),
    }).passthrough(),
  }).passthrough(),
}).passthrough()
export type AntigravityUsage = z.infer<typeof AntigravityUsage>

// A group names its models in a sentence ("Models within this group: Gemini 3.8 Flash, …"), by the
// names the model menu lists them under, less a suffix such as "(Thinking)".
const GROUP_MODELS = /^Models within this group:\s*(.+)$/i

/** A limit's span in hours, to put a family's shorter limit first. An unfamiliar span sorts last. */
function spanHours(span: string | undefined): number {
  const counted = /^(\d+)\s*([hd])$/i.exec(span?.trim() ?? "")
  if (counted) return Number(counted[1]) * (counted[2]!.toLowerCase() === "d" ? 24 : 1)
  return ({ daily: 24, weekly: 168, monthly: 720 } as Record<string, number>)[span?.trim().toLowerCase() ?? ""] ?? 1e9
}

/**
 * The usage report as the quota Frizz's gauge reads: one window per limit, each naming the models it
 * meters by the ids a thread's slug carries ("" is the configured model, the bare slug).
 *
 * The free plan reports one weekly limit per family of models. A paid plan reports a 5h and a weekly
 * limit per family, and Gemini 4 Argon's allowance as a group of its own (measured on Google AI Pro,
 * 2026-11-20). Which models a group meters is read three ways:
 *   - its description lists them ("Models within this group: …");
 *   - failing that, it is named for the one model it meters ("Gemini 4 Argon");
 *   - a model no group names that is called after another ("Orchestrator (Argon)") is metered with that
 *     one, as the report itself files "Orchestrator (Neon)" beside Gemini 4 Neon.
 * A group that says none of this meters every model.
 */
export function antigravityQuotaFromUsage(
  usage: AntigravityUsage,
  account: { models: ReadonlyArray<{ id: string; name: string }>; defaultModel?: string; tier?: string },
): ProviderQuota {
  const groups = usage.command.data.groups
  const metered = groups.map((group): string[] | undefined => {
    const names = GROUP_MODELS.exec(group.description?.trim() ?? "")?.[1]?.split(",").map((name) => name.trim()).filter(Boolean) ?? []
    if (names.length) return account.models.filter((model) => names.some((name) => model.name === name || model.name.startsWith(`${name} `))).map((model) => model.id)
    const own = account.models.filter((model) => model.name.toLowerCase() === group.name.trim().toLowerCase()).map((model) => model.id)
    return own.length ? own : undefined
  })
  const listed = new Set(metered.flatMap((ids) => ids ?? []))
  for (const model of account.models) {
    if (listed.has(model.id)) continue
    const word = /\(([^)]+)\)\s*$/.exec(model.name)?.[1]?.toLowerCase()
    const host = word ? account.models.find((other) => listed.has(other.id) && other.name.toLowerCase().endsWith(` ${word}`)) : undefined
    if (host) for (const ids of metered) if (ids?.includes(host.id)) ids.push(model.id)
  }
  // With several limits in a family, each row is its span under the family's name, shorter span first.
  const families = groups.some((group) => group.buckets.length > 1)
  const windows: QuotaWindow[] = []
  groups.forEach((group, index) => {
    const ids = metered[index]
    const models = ids && [...ids, ...(account.defaultModel !== undefined && ids.includes(account.defaultModel) ? [""] : [])]
    // "Gemini Models" is the group's title. The row it labels sits under Antigravity's own name, beside
    // "79% left" and a reset day in a 15rem panel, so it keeps the part that tells the groups apart.
    const label = group.name.replace(/\s+models$/i, "")
    const buckets = families ? [...group.buckets].sort((a, b) => spanHours(a.window) - spanHours(b.window)) : group.buckets
    for (const bucket of buckets) {
      const span = bucket.window?.trim().toLowerCase()
      const resetsAt = bucket.reset_time ? Math.floor(Date.parse(bucket.reset_time) / 1000) : Number.NaN
      windows.push({
        key: bucket.id ?? `${group.name}-${bucket.window ?? windows.length}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        label: families && span ? span.charAt(0).toUpperCase() + span.slice(1) : label,
        usedPercent: (1 - Math.max(0, Math.min(1, bucket.remaining_fraction))) * 100,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
        ...(models ? { models } : {}),
        ...(families ? { group: label } : {}),
        ...(span ? { span } : {}),
      })
    }
  })
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: `${ANTIGRAVITY_LABEL} reported no limits` }
  // The gauge's panel prints "Antigravity · <plan> plan", so the tier's name ("Antigravity Starter Quota",
  // "Google AI Pro") gives up the words that line already says.
  const plan = account.tier?.replace(/^Antigravity\s+/i, "").replace(/\s+(quota|plan)$/i, "").trim()
  return { status: "ok", ...(plan ? { planType: plan } : {}), windows }
}

/** `_meta.antigravity.tier` on a session result: the plan the signed-in account is on. */
export function antigravityTier(result: unknown): { id?: string; name?: string } | undefined {
  const tier = asObject(asObject(asObject(asObject(result)?._meta)?.antigravity)?.tier)
  if (!tier) return undefined
  return { ...(asString(tier.id) ? { id: tier.id as string } : {}), ...(asString(tier.name) ? { name: tier.name as string } : {}) }
}
