// BoardSocket's request state machine under random sequences of requests, reconnects (sometimes by a
// board of another key), drops, sockets that die mid-send, late answers on replaced sockets, streams and
// clock jumps, held to the invariants a visitor depends on after every run. Fixed seeds, so a failure
// reproduces; FUZZ_RUNS and FUZZ_SEED widen a hunt (2026-11-16: 15,000 runs found the two bugs fixed with
// it, a stream orphaned by a duplicate head and a held page resent to another key's board).
//
//   FUZZ_RUNS=20000 FUZZ_SEED=1 nub run test packages/relay/src/board-socket.fuzz.test.ts
import assert from "node:assert/strict"
import test from "node:test"
import { encodeBody, parseFrame, serializeFrame } from "@frizz/shared"
import { BoardSocket, type SocketLike } from "./board-socket.ts"

const RUNS = Number(process.env.FUZZ_RUNS ?? 300)
const STEPS = Number(process.env.FUZZ_STEPS ?? 80)
const TIMEOUT = 30_000
const GRACE = 10_000
const STREAM_IDLE = 2 * 60_000

function prng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x1_0000_0000
  }
}

function clock() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    timers,
    now: () => now,
    options: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn }); return seq },
      clearTimer: (h: unknown) => void timers.delete(h as number),
    },
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        now = Math.max(now, next[1].at)
        timers.delete(next[0])
        next[1].fn()
        await new Promise<void>((r) => setImmediate(r))
      }
      now = target
    },
  }
}

interface Sock { key: string | null; n: number; socket: SocketLike; frames: Array<{ id: string; url: string; method: string }>; dead: boolean; closed?: number }
interface Req {
  key: string | null; marker: string; method: string; stream: boolean; startedAt: number
  settled: number; outcome?: "ok" | "err"; body?: string; err?: string; settledAt?: number
  headAt?: number; ended: boolean; chunks: string[]; streamedHead?: boolean
}

const flush = () => new Promise<void>((r) => setImmediate(r))

async function run(seed: number) {
  const rnd = prng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const c = clock()
  const relay = new BoardSocket({ ...c.options, requestTimeoutMs: TIMEOUT, boardReturnGraceMs: GRACE })
  const sockets: Sock[] = []
  let current: Sock | null = null
  const reqs: Req[] = []
  const log: string[] = []
  let sockSeq = 0
  let lastKey: string | null = null
  const makeSocket = (key: string | null = null): Sock => {
    const s: Sock = { key, n: ++sockSeq, frames: [], dead: false, socket: null as unknown as SocketLike }
    s.socket = {
      send: (d) => {
        if (s.dead) throw new Error("dead")
        const f = parseFrame(d) as { t: string; id: string; url?: string; method?: string }
        if (f?.t === "req") s.frames.push({ id: f.id, url: f.url!, method: f.method! })
      },
      close: (code) => { s.closed = code ?? 1000 },
    }
    sockets.push(s)
    return s
  }
  const markerOf = (url: string) => new URL(url).searchParams.get("m")!
  const reqOf = (marker: string) => reqs.find((r) => r.marker === marker)!

  for (let step = 0; step < STEPS; step++) {
    const roll = rnd()
    if (roll < 0.22) {
      const method = pick(["GET", "GET", "GET", "HEAD", "POST", "OPTIONS"])
      const stream = method === "GET" && rnd() < 0.3
      const marker = `m${reqs.length}`
      const r: Req = { key: lastKey, marker, method, stream, startedAt: c.now(), settled: 0, ended: false, chunks: [] }
      reqs.push(r)
      log.push(`req ${marker} ${method}${stream ? " stream" : ""}`)
      let p: Promise<{ status: number; body: Uint8Array | null; end: boolean }>
      try {
        p = relay.request(
          { method, url: `https://ada.frizz.sh/x?m=${marker}`, headers: [], ...(method === "POST" ? { body: new TextEncoder().encode("{}") } : {}) },
          stream ? { push: (b) => void r.chunks.push(new TextDecoder().decode(b)), end: () => { r.ended = true } } : undefined,
        )
      } catch (e) {
        p = Promise.reject(e)
      }
      p.then(
        (res) => { r.settled++; r.outcome = "ok"; r.settledAt = c.now(); r.streamedHead = !res.end; r.body = res.body ? new TextDecoder().decode(res.body) : "" },
        (e: Error) => { r.settled++; r.outcome = "err"; r.err = e.message; r.settledAt = c.now() },
      )
    } else if (roll < 0.32) {
      const key = pick(["A", "A", "A", "B"])
      const s = makeSocket(key)
      log.push(`attach s${s.n} key ${key}`)
      relay.attach(s.socket, key)
      lastKey = key
      current = s
    } else if (roll < 0.38) {
      if (current) { log.push(`detach s${current.n}`); relay.detach(current.socket); current = null }
    } else if (roll < 0.41) {
      // A stale socket's close arriving late.
      const s = pick(sockets.length ? sockets : [makeSocket()])
      log.push(`detach-any s${s.n}`)
      relay.detach(s.socket)
      if (current === s) current = null
    } else if (roll < 0.45) {
      if (current) { log.push(`dead s${current.n}`); current.dead = true }
    } else if (roll < 0.70) {
      // The board answers some frame it received, on any socket, possibly late.
      const all = sockets.flatMap((s) => s.frames.map((f) => ({ s, f })))
      if (all.length) {
        const { s, f } = pick(all)
        const marker = markerOf(f.url)
        const streaming = reqOf(marker).stream && rnd() < 0.8
        log.push(`answer ${f.id} (${marker}) on s${s.n}${streaming ? " head" : ""}`)
        relay.handleFrame(serializeFrame(streaming
          ? { t: "res", id: f.id, status: 200, headers: [], end: false }
          : { t: "res", id: f.id, status: 200, headers: [], body: encodeBody(new TextEncoder().encode(marker)), end: true }))
      }
    } else if (roll < 0.78) {
      const all = sockets.flatMap((s) => s.frames.map((f) => ({ s, f })))
      if (all.length) {
        const { f } = pick(all)
        const marker = markerOf(f.url)
        if (rnd() < 0.7) {
          log.push(`chunk ${f.id}`)
          relay.handleFrame(serializeFrame({ t: "res-chunk", id: f.id, data: encodeBody(new TextEncoder().encode(marker)) }))
        } else {
          log.push(`end ${f.id}`)
          relay.handleFrame(serializeFrame({ t: "res-end", id: f.id }))
        }
      }
    } else if (roll < 0.85) {
      void relay.whenConnected()
      log.push("whenConnected")
    } else {
      const ms = pick([0, 50, 500, 1500, 5000, 9000, 11_000, 20_000, 31_000])
      log.push(`advance ${ms}`)
      await c.advance(ms)
    }
    await flush()
  }
  // Quiesce: let every deadline, grace and stream idle timer run out.
  await c.advance(STREAM_IDLE + TIMEOUT + GRACE + 1)
  await flush()
  await flush()

  const fail = (msg: string) => assert.fail(`seed ${seed}: ${msg}\n  ${log.join("\n  ")}`)
  for (const r of reqs) {
    if (r.settled !== 1) fail(`${r.marker} settled ${r.settled} times`)
    if (r.outcome === "ok" && !r.stream && r.body !== r.marker) fail(`${r.marker} got ${JSON.stringify(r.body)}, someone else's answer`)
    if (r.settledAt! - r.startedAt > TIMEOUT) fail(`${r.marker} settled ${r.settledAt! - r.startedAt}ms after it asked, past the deadline`)
    for (const ch of r.chunks) if (ch !== r.marker) fail(`${r.marker} was streamed ${ch}'s chunk`)
    if (r.streamedHead && !r.ended) fail(`${r.marker}'s stream never ended`)
    const sends = sockets.flatMap((s) => s.frames).filter((f) => markerOf(f.url) === r.marker).length
    if (r.method === "POST" && sends > 1) fail(`POST ${r.marker} was sent ${sends} times`)
    if (sends > 3) fail(`${r.marker} was sent ${sends} times`)
    for (const s of sockets) for (const f of s.frames) {
      if (markerOf(f.url) === r.marker && s.key !== r.key) fail(`${r.marker}, made for key ${r.key}, was sent to s${s.n} of key ${s.key}`)
    }
  }
  const internals = relay as unknown as { pending: Map<string, unknown>; waiting: Set<unknown>; returning: Set<unknown>; timers: Map<string, unknown> }
  if (internals.pending.size) fail(`${internals.pending.size} entries left pending`)
  if (internals.waiting.size) fail(`${internals.waiting.size} entries left waiting`)
  if (internals.returning.size) fail(`${internals.returning.size} whenConnected callers left`)
  if (internals.timers.size) fail(`${internals.timers.size} stream timers left`)
  if (c.timers.size) fail(`${c.timers.size} timers still armed`)
}

test(`BoardSocket holds its invariants over ${RUNS} random runs of ${STEPS} steps`, async () => {
  const base = Number(process.env.FUZZ_SEED ?? 1)
  for (let i = 0; i < RUNS; i++) await run(base + i)
})
