import { test } from "node:test"
import assert from "node:assert/strict"
import { MessageJsonMemo } from "./message-json-memo.ts"

// The memo must answer EXACTLY JSON.stringify of the message as it is now, however it was changed since
// the last read — in place, by a copy, by a key added, removed or moved. These drive it the way the fold
// does (mutation in place, between reads) and check every answer against a fresh stringify.

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Json = null | boolean | number | string | undefined | Json[] | { [k: string]: Json }

function randomValue(r: () => number, depth: number): Json {
  const k = Math.floor(r() * (depth > 2 ? 5 : 8))
  switch (k) {
    case 0: return null
    case 1: return r() < 0.5
    case 2: return r() < 0.05 ? Number.NaN : r() < 0.05 ? -0 : Math.floor(r() * 1000) / 10
    case 3: return ["", "a", "pending", "completed", "é→", `s${Math.floor(r() * 50)}`][Math.floor(r() * 6)]
    case 4: return r() < 0.3 ? undefined : "x".repeat(Math.floor(r() * (r() < 0.2 ? 2000 : 40)))
    case 5: return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1))
    default: {
      const o: Record<string, Json> = {}
      for (let i = Math.floor(r() * 5); i > 0; i--) o[["text", "tools", "status", "a", "b", "0", "10", "id"][Math.floor(r() * 8)]] = randomValue(r, depth + 1)
      return o
    }
  }
}

// Every container in a value, so a mutation can land anywhere in the tree, as the fold's do.
function containers(v: Json, out: Array<Json[] | Record<string, Json>> = []): Array<Json[] | Record<string, Json>> {
  if (v && typeof v === "object") {
    out.push(v)
    for (const child of Array.isArray(v) ? v : Object.values(v)) containers(child, out)
  }
  return out
}

function mutate(r: () => number, m: Record<string, Json>): void {
  const all = containers(m)
  const c = all[Math.floor(r() * all.length)]!
  if (Array.isArray(c)) {
    const op = Math.floor(r() * 3)
    if (op === 0) c.push(randomValue(r, 2))
    else if (op === 1 && c.length) c.pop()
    else if (c.length) c[Math.floor(r() * c.length)] = randomValue(r, 2)
    return
  }
  // The memo's key (the fold never rewrites a sourceId) and the long body that makes each message worth a
  // shadow stay put; everything else is fair game.
  const keys = Object.keys(c).filter((k) => k !== "sourceId" && k !== "body")
  const op = Math.floor(r() * 5)
  if (op === 0 || !keys.length) c[`k${Math.floor(r() * 6)}`] = randomValue(r, 2)
  else if (op === 1) delete c[keys[Math.floor(r() * keys.length)]!]
  else if (op === 2) {
    // The same keys, the same values, a different ORDER: JSON.stringify writes it differently.
    const key = keys[0]!
    const value = c[key]
    delete c[key]
    c[key] = value
  } else if (op === 3) {
    // An equal string that is a different object: the answer must not change.
    const key = keys[Math.floor(r() * keys.length)]!
    if (typeof c[key] === "string") c[key] = [...(c[key] as string)].join("")
  } else c[keys[Math.floor(r() * keys.length)]!] = randomValue(r, 2)
}

test("every answer equals JSON.stringify of the message as it is now, across in-place mutations between reads", () => {
  const r = rng(20261110)
  const memo = new MessageJsonMemo()
  const messages: Record<string, Json>[] = Array.from({ length: 40 }, (_, i) => ({ sourceId: `claude:x:${i}`, body: "b".repeat(20000 + i), ...(randomValue(r, 0) as object) }) as Record<string, Json>)
  for (let read = 0; read < 3000; read++) {
    memo.rotate()
    for (let n = Math.floor(r() * 4); n > 0; n--) mutate(r, messages[Math.floor(r() * messages.length)]!)
    // A read uses some window of them, sometimes a copy (what a projection hands the encoder).
    const from = Math.floor(r() * 10)
    for (const m of messages.slice(from)) {
      const subject = r() < 0.2 ? { ...m } : m
      const want = JSON.stringify(subject)
      const got = memo.get(subject)
      assert.equal(got.json, want, `read ${read}, ${String(m.sourceId)}`)
      assert.equal(got.bytes, Buffer.byteLength(want))
    }
  }
  assert.ok(memo.hits > memo.misses, `the memo served most reads (${memo.hits} hits, ${memo.misses} misses)`)
})

test("an unchanged message is served without serializing it again, as the same string", () => {
  const memo = new MessageJsonMemo()
  const m = { sourceId: "claude:x:0", role: "assistant", text: `a long reply ${"w".repeat(4000)}`, tools: [{ name: "Bash", status: "pending" }], parts: [] as unknown[] }
  memo.rotate()
  const first = memo.json(m)
  memo.rotate()
  const realStringify = JSON.stringify
  let calls = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    calls++
    return realStringify(...args)
  }) as typeof JSON.stringify
  try {
    assert.equal(memo.json(m), first)
    assert.equal(memo.json(m) === first, true)
    assert.equal(calls, 0)
    m.tools[0]!.status = "completed" // a tool result back-filled in place, as the fold does
    memo.rotate() // the next read
    assert.equal(memo.json(m), realStringify(m))
    assert.equal(calls, 1)
  } finally {
    JSON.stringify = realStringify
  }
})

test("a message the last read did not use is dropped at the next rotate", () => {
  const memo = new MessageJsonMemo()
  memo.rotate()
  const big = "v".repeat(4000) // past MEMO_MIN_JSON_BYTES, so each is kept
  for (let i = 0; i < 10; i++) memo.get({ sourceId: `s${i}`, text: `t${i}${big}` })
  assert.equal(memo.size, 10)
  memo.rotate()
  for (let i = 5; i < 10; i++) memo.get({ sourceId: `s${i}`, text: `t${i}${big}` })
  memo.rotate()
  assert.equal(memo.size, 5, "only what the previous read used survives")
  memo.rotate()
  assert.equal(memo.size, 0)
})

test("what JSON cannot be read off the structure is serialized every time: a Date, a toJSON, a class", () => {
  const memo = new MessageJsonMemo()
  const at = new Date(0)
  const m: Record<string, unknown> = { sourceId: "s", at }
  memo.rotate()
  assert.equal(memo.json(m), JSON.stringify(m))
  at.setTime(1000) // the same object, a different JSON
  memo.rotate()
  assert.equal(memo.json(m), JSON.stringify(m))
  let n = 0
  const custom = { sourceId: "c", v: { toJSON: () => n } }
  memo.rotate()
  assert.equal(memo.json(custom), "{\"sourceId\":\"c\",\"v\":0}")
  n = 1
  memo.rotate()
  assert.equal(memo.json(custom), "{\"sourceId\":\"c\",\"v\":1}")
})

test("two variants of one source id (the canonical message and its projected copy) do not evict each other", () => {
  const memo = new MessageJsonMemo()
  const prompt = "p".repeat(3000)
  const canonical = { sourceId: "s", tools: [{ agentId: "a", prompt }] }
  const projected = { sourceId: "s", tools: [{ agentId: "a", prompt, agentStatus: "completed" }] }
  for (let read = 0; read < 5; read++) {
    memo.rotate()
    assert.equal(memo.json(canonical), JSON.stringify(canonical))
    assert.equal(memo.json(projected), JSON.stringify(projected))
  }
  assert.equal(memo.misses, 2, "each variant serialized once")
})
