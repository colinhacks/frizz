import { readFileSync, statSync } from "node:fs"
import { parseCodexLine } from "./backend/codex.ts"

// THE FACTS A SUB-AGENT'S DRAWER HEADER STATES about the child itself — how full its own context is and
// when it last wrote anything — read off the child's OWN transcript, the file the drawer already
// renders. A thread's header gets these from the board's fold; a child has no fold of its own, and the
// board's sub-agent row carries neither (its `tokens` is the provider's running total of tokens SPENT,
// which is not how full the context is).
//
// Both halves follow the thread's rules, so the two headers read the same thing the same way:
//   · tokens — what the child's LAST request carried, from the API's own accounting (input + cache
//     written + cache read; see the tailer's Claude fold), or a compaction's `postTokens` when one
//     landed after it. Codex states the same reading on its token_count, window included.
//   · the window is NOT here for a Claude child: Claude names windows only on the parent session's
//     `result`, so the router asks the tailer for the row billed under `model`.

export interface SubAgentContextUsage {
  tokens: number
  /** The model the child's latest request ran on, as its transcript records it (Claude only). */
  model?: string
  /** Codex names the window on the same event; a Claude child's comes from the parent session. */
  window?: number
}

export function readSubAgentContextUsage(absPath: string, format?: "codex" | "opencode"): SubAgentContextUsage | undefined {
  let text: string
  try {
    text = readFileSync(absPath, "utf8")
  } catch {
    return undefined
  }
  if (format === "opencode") return writtenContextUsage(text)
  return format === "codex" ? codexContextUsage(text) : claudeContextUsage(text)
}

/** When the child last wrote to its transcript — the same signal the board's sub-agent row reads. */
export function readSubAgentLastActivityAt(absPath: string): string | undefined {
  try {
    return statSync(absPath).mtime.toISOString()
  } catch {
    return undefined
  }
}

// A Frizz-written transcript states it directly: its newest `context-usage` record, window included.
function writtenContextUsage(text: string): SubAgentContextUsage | undefined {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"context-usage"')) continue
    try {
      const rec = JSON.parse(line) as { kind?: unknown; tokens?: unknown; window?: unknown }
      if (rec.kind === "context-usage" && typeof rec.tokens === "number") return { tokens: rec.tokens, ...(typeof rec.window === "number" ? { window: rec.window } : {}) }
    } catch { /* a partial tail line */ }
  }
  return undefined
}

// Newest first, so a long transcript stops at its tail. Lines that cannot carry either reading are
// skipped before they are parsed: a child's transcript is mostly tool results.
export function claudeContextUsage(text: string): SubAgentContextUsage | undefined {
  const lines = text.split("\n")
  let tokens: number | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes("\"usage\"") && !line.includes("compact_boundary")) continue
    let rec: { type?: unknown; subtype?: unknown; isApiErrorMessage?: unknown; compactMetadata?: { postTokens?: unknown }; message?: { model?: unknown; usage?: Record<string, unknown> } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (tokens === undefined && rec.type === "system" && rec.subtype === "compact_boundary") {
      const post = rec.compactMetadata?.postTokens
      if (typeof post === "number" && Number.isFinite(post) && post >= 0) tokens = post
      continue
    }
    if (rec.type !== "assistant" || rec.isApiErrorMessage === true) continue
    if (tokens === undefined) {
      const usage = rec.message?.usage
      const part = (key: string): number | undefined => {
        const value = usage?.[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
      }
      const input = part("input_tokens")
      const created = part("cache_creation_input_tokens")
      const read = part("cache_read_input_tokens")
      if (input === undefined && created === undefined && read === undefined) continue
      tokens = (input ?? 0) + (created ?? 0) + (read ?? 0)
    }
    const model = typeof rec.message?.model === "string" ? rec.message.model.trim() : ""
    if (model && model !== "<synthetic>") return { tokens, model }
  }
  return tokens === undefined ? undefined : { tokens }
}

function codexContextUsage(text: string): SubAgentContextUsage | undefined {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("token_count")) continue
    for (const event of parseCodexLine(lines[i])) {
      if (event.kind === "context-usage") return { tokens: event.tokens, ...(event.window === undefined ? {} : { window: event.window }) }
    }
  }
  return undefined
}
