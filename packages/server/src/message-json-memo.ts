// ── Each transcript message's JSON, kept from one read of a subscribed thread to the next ────────────
// A subscribed thread is re-read on every byte the worker appends, and every read used to serialize its
// whole window twice: once to measure it (latestWindowStart's byte bound stringifies each message) and
// once to send it (app-socket's encodeTranscript). Up to 3 MB of JSON per read, several reads a second
// per busy thread, to send the one or two messages that changed. Profiled 2026-11-10 on a copy of the
// maintainer's boards with three busy workers open: those two stringify passes and the sha256 over the
// joined frame were 57% of the transcript push's CPU, the fold of the appended bytes 5%.
//
// This keeps each message's JSON, keyed by its sourceId, and serves it again only when the message is
// provably unchanged. "Provably" is a structural comparison, not a dirty flag: the fold mutates messages
// in place from a dozen sites (a tool result back-filled into its call, a queued bubble delivered, a
// background shell's terminal state), and a flag every one of them must remember to set is a flag one
// of them eventually forgets. So the memo keeps a SHADOW of each message as it was serialized — the
// same tree, with the same string and number values and the same key order — and compares the live
// message to it. Strings are immutable, so an unchanged field is the same string and compares in O(1);
// the walk allocates nothing. On a real 133-message, 981 KB window that comparison costs 0.07 ms where
// stringifying it costs 2.2 ms.
//
// The JSON a hit returns is therefore exactly `JSON.stringify(message)`: equal shadows mean equal own
// enumerable keys, in equal order, with `===` values all the way down, and JSON.stringify is a function
// of nothing else for plain data. Anything that is not plain data — a class instance, a Date, an object
// with a toJSON — is never trusted: its message is serialized afresh on every read.
//
// A memo holds what the last read used and nothing else: `rotate()` at the start of each read retires
// every entry the previous read did not touch, so it is bounded by one window. It belongs to a
// subscription (app-socket.ts keeps one per subscribed thread and drops it with the last subscriber),
// never to the retained fold, so a thread nobody watches keeps no JSON.

export interface MessageJson {
  /** Exactly `JSON.stringify(value)`. */
  json: string
  /** `Buffer.byteLength(json)`. */
  bytes: number
}

interface Variant extends MessageJson {
  shape: unknown
}

// Never equal to anything: a value whose JSON cannot be read off its structure.
const OPAQUE: unique symbol = Symbol("opaque")

// An object's shadow: its own enumerable keys in order, and their values' shadows.
class ObjectShape {
  constructor(readonly keys: string[], readonly values: unknown[]) {}
}

// Builds the shadow and counts its nodes (`count.n`), which is what comparing against it will cost.
function shapeOf(value: unknown, count: { n: number }): unknown {
  count.n++
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const items = new Array<unknown>(value.length)
    for (let i = 0; i < value.length; i++) {
      const item = shapeOf(value[i], count)
      if (item === OPAQUE) return OPAQUE
      items[i] = item
    }
    return items
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return OPAQUE
  const record = value as Record<string, unknown>
  if (typeof record.toJSON === "function") return OPAQUE
  const keys: string[] = []
  const values: unknown[] = []
  for (const key in record) {
    const shape = shapeOf(record[key], count)
    if (shape === OPAQUE) return OPAQUE
    keys.push(key)
    values.push(shape)
  }
  return new ObjectShape(keys, values)
}

function sameShape(value: unknown, shape: unknown): boolean {
  if (value === shape) return true // a primitive, the same value
  if (value === null || typeof value !== "object") return typeof value === "number" && value !== value && shape !== shape // NaN: both write null
  if (Array.isArray(value)) {
    if (!Array.isArray(shape) || shape.length !== value.length) return false
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (item !== shape[i] && !sameShape(item, shape[i])) return false
    }
    return true
  }
  if (!(shape instanceof ObjectShape)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const record = value as Record<string, unknown>
  const { keys, values } = shape
  let i = 0
  for (const key in record) {
    if (i >= keys.length || keys[i] !== key) return false
    const item = record[key]
    if (item !== values[i] && !sameShape(item, values[i])) return false
    i++
  }
  return i === keys.length
}

/** Plain JSON, measured, with no memo. */
export function messageJson(value: unknown): MessageJson {
  const json = JSON.stringify(value)
  return { json, bytes: Buffer.byteLength(json) }
}

// Two variants per message: the canonical message the window is measured on and the projected copy the
// socket sends (agent lifecycles, peer names) usually agree, and when they do not, neither may evict the
// other on every read.
const VARIANTS = 2

// WHICH MESSAGES ARE KEPT ACROSS READS. Comparing a message to its shadow costs a step per node of its tree;
// serializing it costs a step per node plus one per byte, in native code. So the shadow only pays where a
// message carries a lot of text per node — a long reply, a tool's captured output, a diff — and those are
// exactly the messages that made a read expensive (2.2 ms to serialize a real 133-message, 981 KB window,
// 0.07 ms to compare it). A message of a few short fields (the scripted workers' tool calls: ~600 B over
// ~26 nodes) is serialized afresh each read instead: measured on such a transcript, comparing it cost as
// much as serializing it, and its shadow would be memory for nothing. Within ONE read every message is
// serialized at most once either way (`#read`), which is the saving that needs no shadow at all: the window
// bound and the encoder used to serialize the same window twice.
//
// Two gates, both on what the message serialized to: it must be at least MEMO_MIN_JSON_BYTES (below that,
// even building the shadow once is not repaid — measured on the live server, a 600-byte message's shadow
// cost a third of its serialization, every read it was rejected), and it must carry MEMO_MIN_BYTES_PER_NODE
// bytes per node of its tree.
export const MEMO_MIN_JSON_BYTES = 2048
export const MEMO_MIN_BYTES_PER_NODE = 32

export class MessageJsonMemo {
  #previous = new Map<string, Variant[]>()
  #current = new Map<string, Variant[]>()
  // This read's answers by object. Nothing changes a message during one read (the fold ingests before it,
  // and the read is synchronous), so the same object is the same JSON until the next rotate.
  #read = new Map<object, MessageJson>()
  /** Messages answered without serializing them. */
  hits = 0
  /** Messages serialized afresh. */
  misses = 0

  /** Start a read: whatever the last read did not keep is dropped at the next rotate. */
  rotate(): void {
    this.#previous = this.#current
    this.#current = new Map()
    this.#read = new Map()
  }

  /** How many messages the memo keeps a shadow and JSON for (both generations). */
  get size(): number {
    let n = this.#current.size
    for (const key of this.#previous.keys()) if (!this.#current.has(key)) n++
    return n
  }

  get<M extends { sourceId?: string }>(message: M): MessageJson {
    const seen = this.#read.get(message)
    if (seen) {
      this.hits++
      return seen
    }
    const answer = this.#lookup(message)
    this.#read.set(message, answer)
    return answer
  }

  json<M extends { sourceId?: string }>(message: M): string {
    return this.get(message).json
  }

  bytes<M extends { sourceId?: string }>(message: M): number {
    return this.get(message).bytes
  }

  #lookup(message: { sourceId?: string }): MessageJson {
    const key = message.sourceId
    if (typeof key !== "string") {
      this.misses++
      return messageJson(message)
    }
    const current = this.#current.get(key)
    const hit = (current && find(current, message)) ?? this.#fromPrevious(key, message)
    if (hit) {
      this.hits++
      return hit
    }
    this.misses++
    const fresh = messageJson(message)
    if (fresh.json === undefined || fresh.json.length < MEMO_MIN_JSON_BYTES) return fresh
    const count = { n: 0 }
    const shape = shapeOf(message, count)
    if (shape === OPAQUE || fresh.json.length < MEMO_MIN_BYTES_PER_NODE * count.n) return fresh
    const variant: Variant = { ...fresh, shape }
    const list = this.#current.get(key)
    if (!list) this.#current.set(key, [variant])
    else {
      list.unshift(variant)
      if (list.length > VARIANTS) list.length = VARIANTS
    }
    return variant
  }

  #fromPrevious(key: string, message: unknown): Variant | undefined {
    const previous = this.#previous.get(key)
    if (!previous) return undefined
    const hit = find(previous, message)
    if (!hit) return undefined
    const list = this.#current.get(key)
    if (!list) this.#current.set(key, [hit])
    else if (!list.includes(hit)) {
      list.push(hit)
      if (list.length > VARIANTS) list.length = VARIANTS
    }
    return hit
  }
}

function find(list: Variant[], message: unknown): Variant | undefined {
  for (const variant of list) if (sameShape(message, variant.shape)) return variant
  return undefined
}
