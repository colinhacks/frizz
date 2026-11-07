import { redactCredentialSyntax } from "../credential-redaction.ts"

// What Frizz reads off OpenCode 2's server API. Hand-rolled and deliberately narrow
// (ARCHITECTURE.md § OpenCode backend): the API is young and its generated client moves weekly, so every
// reader here takes `unknown`, keeps only the fields Frizz acts on, and treats anything it does not
// recognize as absent. An event type Frizz has never heard of is ignored, never thrown on.

export type Json = Record<string, unknown>

export function asObject(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined
}
export function asString(v: unknown): string | undefined { return typeof v === "string" ? v : undefined }
export function asNumber(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined }
export function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : [] }

/** One frame of `GET /api/event`. */
export interface OpencodeEvent { type: string; data: Json; created?: number; id?: string }

export function parseOpencodeEvent(raw: unknown): OpencodeEvent | undefined {
  const obj = asObject(raw)
  const type = asString(obj?.type)
  if (!obj || !type) return undefined
  return { type, data: asObject(obj.data) ?? {}, ...(asNumber(obj.created) !== undefined ? { created: obj.created as number } : {}), ...(asString(obj.id) ? { id: obj.id as string } : {}) }
}

export function eventSessionId(ev: OpencodeEvent): string | undefined {
  return asString(ev.data.sessionID) ?? asString(asObject(ev.data.form)?.sessionID)
}

export type OpencodeRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

const rule = (action: string, resource: string, effect: OpencodeRule["effect"]): OpencodeRule => ({ action, resource, effect })

// What every mode that asks allows anyway: reading and looking around, which `default` means on every
// other backend, the worker's question cards, and `frizzctl`, whose calls are how a worker talks to Frizz
// and which a card per timer or sign-off would make unusable. The `.env` asks are OpenCode's own, repeated
// because session rules come after an agent's and the last matching rule wins (`Permission.evaluate`).
const ASKING_RULES: readonly OpencodeRule[] = [
  rule("*", "*", "ask"),
  ...["read", "grep", "glob", "question", "subagent", "skill", "todowrite"].map((action) => rule(action, "*", "allow")),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
  rule("shell", "frizzctl", "allow"),
  rule("shell", "frizzctl *", "allow"),
]
// OpenCode denies these to every agent unless a plugin says otherwise; a session's `*` must not lift it.
const STILL_DENIED: readonly OpencodeRule[] = [rule("browser", "*", "deny"), rule("skill", "browser", "deny")]

export type OpencodeMode = "bypassPermissions" | "acceptEdits" | "default" | "plan"

/** The session rules a permission mode is. Applied at create and by `PATCH /api/session/:id`, which
 *  replaces them, and a child session takes its parent's at creation.
 *
 *  `plan` holds none on purpose: it is OpenCode's own `plan` agent, whose `edit` deny a session rule
 *  would override, because session rules are evaluated after an agent's. */
export function opencodeSessionRules(mode: OpencodeMode): OpencodeRule[] {
  switch (mode) {
    case "bypassPermissions": return [rule("*", "*", "allow"), ...STILL_DENIED]
    case "acceptEdits": return [...ASKING_RULES, rule("edit", "*", "allow"), ...STILL_DENIED]
    case "plan": return []
    default: return [...ASKING_RULES, ...STILL_DENIED]
  }
}

export function opencodeModeOf(mode: string | null | undefined): OpencodeMode {
  return mode === "acceptEdits" || mode === "default" || mode === "plan" ? mode : "bypassPermissions"
}

/** The agent a mode runs under. */
export function opencodeAgentFor(mode: OpencodeMode): "build" | "plan" { return mode === "plan" ? "plan" : "build" }

// ---- tools ------------------------------------------------------------------------------------------

function patchTargets(patchText: string): string[] {
  const out: string[] = []
  for (const m of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (m[1]) out.push(m[1].trim())
  return out
}

/** An OpenCode tool call in the vocabulary Frizz's cards and fold already read: `shell` becomes a `Bash`
 *  call with its command, `edit` an `Edit` with its diff, `subagent` an `Agent` card and `question` a
 *  settled question card. A tool Frizz has no card for keeps its own name, and draws the generic one. */
export function frizzToolShape(name: string, rawInput: unknown): { name: string; input: Json } {
  const input = asObject(rawInput) ?? {}
  const path = asString(input.path)
  switch (name) {
    case "shell": return { name: "Bash", input: { command: input.command ?? "", ...(asString(input.workdir) ? { cwd: input.workdir } : {}), ...(asString(input.description) ? { description: input.description } : {}) } }
    case "read": return { name: "Read", input: { file_path: path ?? "", ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } }
    case "write": return { name: "Write", input: { file_path: path ?? "", content: input.content ?? "" } }
    case "edit": return { name: "Edit", input: { file_path: path ?? "", old_string: input.oldString ?? "", new_string: input.newString ?? "" } }
    case "patch": {
      const targets = patchTargets(asString(input.patchText) ?? "")
      return { name: "Edit", input: { ...(targets[0] ? { file_path: targets[0] } : {}), ...(targets.length > 1 ? { files: targets } : {}), patch: input.patchText ?? "" } }
    }
    case "grep": return { name: "Grep", input: { pattern: input.pattern ?? "", ...(path ? { path } : {}), ...(input.include !== undefined ? { glob: input.include } : {}) } }
    case "glob": return { name: "Glob", input: { pattern: input.pattern ?? "", ...(path ? { path } : {}) } }
    case "webfetch": return { name: "WebFetch", input: { url: input.url ?? "" } }
    case "websearch": return { name: "WebSearch", input: { query: input.query ?? "" } }
    case "todowrite": return { name: "TodoWrite", input: { todos: input.todos ?? [] } }
    case "skill": return { name: "Skill", input: { skill: input.name ?? "" } }
    case "subagent": return { name: "Agent", input: { description: input.description ?? "", prompt: input.prompt ?? "", ...(asString(input.agent) ? { subagent_type: input.agent } : {}), ...(asString(input.model) ? { model: input.model } : {}) } }
    case "question": return {
      name: "AskUserQuestion",
      input: {
        questions: asArray(input.questions).map((raw) => {
          const q = asObject(raw) ?? {}
          return {
            question: q.question ?? "",
            ...(asString(q.header) ? { header: q.header } : {}),
            multiSelect: q.multiple === true || q.multiSelect === true,
            options: asArray(q.options).map((o) => {
              const opt = asObject(o) ?? {}
              return { label: opt.label ?? opt.value ?? "", ...(asString(opt.description) ? { description: opt.description } : {}) }
            }),
          }
        }),
      },
    }
    default: return { name, input }
  }
}

export function toolContentText(content: unknown): string {
  const parts: string[] = []
  for (const item of asArray(content)) {
    const obj = asObject(item)
    if (obj?.type === "text" && typeof obj.text === "string") parts.push(obj.text)
  }
  return parts.join("\n")
}

/** A sub-agent call's result is `<subagent sessionID=… state=…>text</subagent>`: the card shows the text. */
export function subagentResultText(text: string): string {
  const m = /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/.exec(text.trim())
  return m ? m[1]! : text
}

export function errorMessage(err: unknown): { message: string; code?: string; retryAfterMs?: number; authNeeded: boolean } {
  const obj = asObject(err)
  const type = asString(obj?.type) ?? asString(obj?.name)
  const message = asString(obj?.message) ?? asString(asObject(obj?.data)?.message) ?? (typeof err === "string" ? err : "OpenCode reported an error.")
  const authNeeded = type === "provider.auth" || /provider\.auth/.test(message)
  return { message: redactCredentialSyntax(message), ...(type ? { code: type } : {}), authNeeded, ...(asNumber(obj?.retryAfterMs) !== undefined ? { retryAfterMs: obj!.retryAfterMs as number } : {}) }
}
