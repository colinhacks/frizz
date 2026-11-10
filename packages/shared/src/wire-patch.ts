// WHAT CHANGED, NOT THE WHOLE THING — the two encodings the /ws socket uses to send a change as the
// difference from what that connection already holds (app-socket.ts, and api/wirePatch.ts in the web app).
//
// Both are only ever applied to the exact value the same connection received last, in order, over one
// ordered socket: the server keeps what it sent each connection, so a patch can never be applied to a
// base the client does not hold. A client that finds it cannot apply one (a bug, never a path) asks for
// the whole value again. Measured on the maintainer's real boards with three busy scripted workers
// (2026-11-09, Console with one thread drawer open): the transcript push sent the whole 300-message
// window, 130 KB, about 4.5 times a second for a change of one or two messages at its tail (69 MB of
// JSON in two minutes), and every board delta sent each changed thread whole, ~2 KB, when a tool call
// had moved four of its fields.
//
// Type-only imports: like delta.ts this module has no runtime dependency on index.ts.

// ── a sliding window: the transcript's latest page ────────────────────────────────────────────────────

/**
 * The new window as `prev.slice(drop, drop + keep)` followed by `next.slice(keep)`: what fell off the
 * head, what is unchanged, and the tail that is new or changed. Compared by each message's own JSON, so
 * it is exact whatever alignment it picks — the kept run is equal string for string by construction.
 * `keep` 0 means nothing could be reused.
 */
export interface WindowSplice {
  drop: number
  keep: number
}

export function windowSplice(prev: readonly string[], next: readonly string[]): WindowSplice {
  if (!next.length || !prev.length) return { drop: prev.length, keep: 0 }
  // The window slides forward, so the new head is almost always near the old head: a linear search
  // from the start finds it in a step or two. A head that is nowhere in `prev` reuses nothing.
  const head = next[0]
  let drop = -1
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] === head) {
      drop = i
      break
    }
  }
  if (drop < 0) return { drop: prev.length, keep: 0 }
  let keep = 0
  const most = Math.min(prev.length - drop, next.length)
  while (keep < most && prev[drop + keep] === next[keep]) keep++
  return { drop, keep }
}

export function applyWindowSplice<T>(prev: readonly T[], splice: WindowSplice, tail: readonly T[]): T[] {
  return prev.slice(splice.drop, splice.drop + splice.keep).concat(tail)
}

// ── a JSON value: one thread's view on the board ──────────────────────────────────────────────────────

/** One edit: `[path, value]` sets the value at `path`, `[path]` deletes the key there. */
export type JsonPatchOp = [path: (string | number)[], value?: unknown] | [path: (string | number)[]]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// What JSON.stringify writes for a value — or that it writes nothing (undefined, a function, a symbol).
function absentInJson(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol"
}

/**
 * The edits that turn `prev` into `next`, AS JSON: applying them to `JSON.parse(JSON.stringify(prev))`
 * gives a value equal to `JSON.parse(JSON.stringify(next))`. Objects are compared key by key; arrays of
 * the same length index by index; anything else that differs is replaced whole. A key JSON would leave
 * out (an `undefined`) counts as absent.
 */
export function diffJson(prev: unknown, next: unknown): JsonPatchOp[] {
  const ops: JsonPatchOp[] = []
  diffInto(prev, next, [], ops)
  return ops
}

function diffInto(prev: unknown, next: unknown, path: (string | number)[], ops: JsonPatchOp[]): void {
  if (prev === next) return
  if (isPlainObject(prev) && isPlainObject(next)) {
    for (const key of Object.keys(next)) {
      const n = next[key]
      if (absentInJson(n)) continue
      const p = prev[key]
      if (absentInJson(p) || !Object.prototype.hasOwnProperty.call(prev, key)) ops.push([[...path, key], n])
      else diffInto(p, n, [...path, key], ops)
    }
    for (const key of Object.keys(prev)) {
      if (absentInJson(prev[key])) continue
      if (!Object.prototype.hasOwnProperty.call(next, key) || absentInJson(next[key])) ops.push([[...path, key]])
    }
    return
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    for (let i = 0; i < next.length; i++) {
      // In an array JSON writes null for what it would leave out of an object, so both sides are read
      // that way: an element is never deleted, only set.
      const p = absentInJson(prev[i]) ? null : prev[i]
      const n = absentInJson(next[i]) ? null : next[i]
      if (p === n) continue
      if ((isPlainObject(p) && isPlainObject(n)) || (Array.isArray(p) && Array.isArray(n))) diffInto(p, n, [...path, i], ops)
      else if (!sameJson(p, n)) ops.push([[...path, i], n])
    }
    return
  }
  if (!sameJson(prev, next)) ops.push([path, next])
}

// Two leaves (or mismatched shapes) as JSON: what decides whether a replace is needed at all. A number
// that JSON writes as null (NaN, Infinity) equals null; a Date equals its ISO string.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" && typeof b !== "object" && typeof a === typeof b && typeof a !== "number") return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * `base` with `ops` applied, as a NEW value: every object and array on an edited path is copied, and
 * everything else is shared with `base`, which is never written. Throws when a path does not lead
 * through `base` — the patch was made against something else, and the caller must read the value whole.
 */
export function applyJsonPatch<T>(base: T, ops: readonly JsonPatchOp[]): T {
  if (!ops.length) return base
  const copied = new Set<object>()
  const copy = (v: unknown): Record<string | number, unknown> => {
    const c = (Array.isArray(v) ? v.slice() : { ...(v as object) }) as Record<string | number, unknown>
    copied.add(c)
    return c
  }
  let root: unknown = base
  for (const op of ops) {
    const [path] = op
    if (!path.length) {
      if (op.length < 2) throw new Error("cannot delete the root")
      root = op[1]
      continue
    }
    if (typeof root !== "object" || root === null) throw new Error("patch path does not lead through its base")
    if (!copied.has(root as object)) root = copy(root)
    let node = root as Record<string | number, unknown>
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!
      const child = node[key]
      if (typeof child !== "object" || child === null) throw new Error("patch path does not lead through its base")
      if (!copied.has(child)) node[key] = copy(child)
      node = node[key] as Record<string | number, unknown>
    }
    const last = path[path.length - 1]!
    if (op.length < 2) {
      if (Array.isArray(node)) throw new Error("patch deletes an array element")
      delete node[last]
    } else {
      if (Array.isArray(node) && (typeof last !== "number" || last >= node.length)) throw new Error("patch path does not lead through its base")
      node[last] = op[1]
    }
  }
  return root as T
}
