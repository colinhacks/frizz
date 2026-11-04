// WHICH QUESTION A REUSED ID NAMES — in each message, the one it meant when that message was written.
//
// A worker's ```question id names one open question at a time: once a question is answered, withdrawn or
// dismissed its id is free, and a later fence asking under it registers a NEW row (server question-fences.ts,
// from 2026-11-04). So one name can belong to several rows over a thread's life, and every reader that
// resolved a fence by its name alone — the card a fence draws, where a question's card is placed, which rest
// claims it — took whichever row it found first. The message that asked the first question then drew the
// second one's card, or nothing at all, and the second question's card could be pulled back into the first
// question's prose.
//
// The server resolves each fence against the rows as they stood when its message was written: the newest
// row asked at or before it. This is the same rule, as the transcript can apply it: a row belongs to the
// message whose time span holds its `askedAt` (lib/questionFaults messageIndexAt — a fence in a message's
// second text block is asked later than the bubble is stamped), and a name in message `i` means the newest
// row whose message is `i` or earlier. A row older than the loaded window belongs to no loaded message and
// counts as earlier than all of them.
//
// Only names more than one row carries are annotated, on only the messages whose text mentions them, so on
// every thread that never asked an id twice this returns the messages it was given. A name with a single row
// needs nothing: every reader's first match is that row.
import { mayHoldQuestionFence, type AskedQuestion } from "@frizz/shared"
import { messageIndexAt, type FaultMessage } from "./questionFaults.ts"
import { questionNames } from "./questionShadow.ts"

/** A row a name can resolve to — open, answered, or closed without an answer — with its asking instant. */
export interface OwnedRow {
  id: string
  askedAt: string
  spec?: AskedQuestion
  handle?: string
}

export interface OwnerMessage extends FaultMessage {
  questionOwners?: ReadonlyMap<string, string>
}

/** For each message mentioning a name several rows carry, that name → the id of the row it meant there. */
export function questionOwnersByMessage(messages: readonly OwnerMessage[], rows: readonly OwnedRow[]): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>()
  if (rows.length < 2 || messages.length === 0) return out
  const byName = new Map<string, OwnedRow[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    for (const name of questionNames(row)) {
      const list = byName.get(name)
      if (list) list.push(row)
      else byName.set(name, [row])
    }
  }
  const shared = [...byName].filter(([, list]) => list.length > 1)
  if (shared.length === 0) return out
  // Each sharing row's message, oldest asked first.
  const owners = shared.map(([name, list]) => ({
    name,
    rows: list
      .map((row) => ({ id: row.id, askedMs: Date.parse(row.askedAt), at: messageIndexAt(messages, Date.parse(row.askedAt)) }))
      .sort((a, b) => a.askedMs - b.askedMs),
  }))
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.text || !(mayHoldQuestionFence(m.text) || m.text.includes("```awaiting"))) return
    const text = m.text.toLowerCase()
    for (const { name, rows: candidates } of owners) {
      if (!text.includes(name)) continue
      let owner: string | undefined
      for (const c of candidates) if (c.at <= i) owner = c.id
      if (owner === undefined) continue
      let map = out.get(i)
      if (!map) out.set(i, (map = new Map()))
      map.set(name, owner)
    }
  })
  return out
}

// One annotated copy per (message, owners), so a message's memo boundary moves only when what its names
// mean changes — not on every board push that carries the same rows again.
const annotated = new WeakMap<object, { key: string; message: unknown }>()

/** The same messages, each one that mentions a name several rows carry holding `questionOwners`. The input
 *  array itself comes back when no name is shared, which is nearly always. */
export function withQuestionOwners<M extends OwnerMessage>(messages: readonly M[], rows: readonly OwnedRow[]): readonly M[] {
  const owners = questionOwnersByMessage(messages, rows)
  if (owners.size === 0) return messages
  return messages.map((m, i) => {
    const map = owners.get(i)
    if (!map) return m
    const key = [...map].map(([name, id]) => `${name}\u0000${id}`).sort().join("\n")
    const known = annotated.get(m)
    if (known?.key === key) return known.message as M
    const message = { ...m, questionOwners: map }
    annotated.set(m, { key, message })
    return message
  })
}
