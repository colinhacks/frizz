import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"

// THE MODEL A CLAUDE CHILD RAN, off its own transcript — for the dispatch cells whose parent record
// could not state the edition (subagent-profile.ts `observedDispatchCell`): an alias of another family
// than the parent's, a foreign agent type, a descendant's bare sidecar profile. The transcript, board
// and socket producers each ask about every such card on every read, so the answer is CACHED per path:
// a child's model does not change once it has answered, so a found one is kept for good, and a
// transcript that had none is read again only after it has grown.
//
// The TAIL first, newest record first, because that is where an answer is cheap to find: a child
// writes an assistant record within its first seconds, and every tool call after carries one too. The
// whole file only when the tail had none and the file is longer than the tail — one huge tool result
// can fill the window — and never past a bound, so a pathological file costs one capped read.
const MODEL_TAIL_BYTES = 256 * 1024
const MODEL_FULL_READ_MAX_BYTES = 32 * 1024 * 1024
const MODEL_CACHE_MAX = 1024
const observedModels = new Map<string, { size: number; model?: string }>()

function latestAssistantModel(text: string): string | undefined {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"') || !line.includes('"assistant"')) continue
    try {
      const rec = JSON.parse(line) as { type?: unknown; isApiErrorMessage?: unknown; message?: { model?: unknown } }
      if (rec.type !== "assistant" || rec.isApiErrorMessage === true) continue
      const model = typeof rec.message?.model === "string" ? rec.message.model.trim() : ""
      if (model && model !== "<synthetic>") return model
    } catch { /* the window's first line is usually cut mid-record; so is a tail still being written */ }
  }
  return undefined
}

function readTail(absPath: string, size: number, bytes: number): string {
  const fd = openSync(absPath, "r")
  try {
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    return buffer.toString("utf8", 0, read)
  } finally {
    closeSync(fd)
  }
}

/** The model id a Claude child's latest request ran on, from its own transcript, or undefined. Never throws. */
export function readObservedChildModel(absPath: string): string | undefined {
  const cached = observedModels.get(absPath)
  if (cached?.model) return cached.model
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    return undefined
  }
  if (cached && cached.size === size) return undefined
  let model: string | undefined
  try {
    model = latestAssistantModel(readTail(absPath, size, MODEL_TAIL_BYTES))
    if (!model && size > MODEL_TAIL_BYTES && size <= MODEL_FULL_READ_MAX_BYTES) model = latestAssistantModel(readFileSync(absPath, "utf8"))
  } catch {
    model = undefined
  }
  observedModels.delete(absPath)
  observedModels.set(absPath, { size, ...(model ? { model } : {}) })
  while (observedModels.size > MODEL_CACHE_MAX) {
    const oldest = observedModels.keys().next().value
    if (oldest === undefined) break
    observedModels.delete(oldest)
  }
  return model
}
