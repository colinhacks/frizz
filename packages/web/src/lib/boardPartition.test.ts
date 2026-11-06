import { test } from "node:test"
import assert from "node:assert/strict"
import { activeBandThread, sectionOf, type ThreadView } from "@frizz/shared"
import { externalThreads, isConsolePinned, isPinned, orderActive, orderByInteraction, orderDone, orderQueue, orderRunning, queued, sectionThreads, type SectionedThreads } from "../groups.ts"
import { consolePinned, consoleQueue, consoleRunning } from "./consoleBoard.ts"
import { optimisticallySteered, overlayEach, overlayLive } from "./steering.ts"
import { partitionBoard, settledThread } from "./boardPartition.ts"

// THE PARTITION MAY SKIP A SETTLED THREAD ONLY WHERE THE ANSWER IS ALREADY KNOWN (lib/boardPartition).
// These pin that promise the only way it can be pinned: every derivation that reads the partition is run
// against its old whole-board form, on boards that evolve the way a live one does — a delta replacing a
// few slots, a thread archived or reopened, pinned, steered, removed, added — and the partition carried
// from one array to the next is checked against one built from scratch.

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    title: id,
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    kind: "session",
    state: "open",
    spawnedAt: "2026-07-08T00:00:00.000Z",
    ...over,
  } as ThreadView
}

// A small deterministic generator, so a failure names a seed that reproduces it.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomThread(id: string, r: () => number): ThreadView {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const archived = r() < 0.7
  return thread(id, {
    kind: r() < 0.03 ? undefined : "session",
    foreign: r() < 0.05,
    pinnedAt: r() < 0.05 ? `2026-10-0${1 + Math.floor(r() * 9)}T00:00:00.000Z` : undefined,
    consolePinnedAt: r() < 0.05 ? `2026-10-0${1 + Math.floor(r() * 9)}T00:00:00.000Z` : undefined,
    state: archived ? "archived" : "open",
    archived,
    runtime: pick(["turn-idle", "turn-idle", "turn-idle", "exited", "running", "spawning"] as const),
    needsYou: r() < 0.2,
    deliveryInFlight: r() < 0.05,
    bgShells: r() < 0.05 ? [{ label: "dev", startedAt: "2026-10-01T00:00:00.000Z", state: "running", id: "s" }] : [],
    lastUserAt: `2026-09-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T00:00:00.000Z`,
    lastActivityAt: `2026-09-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T00:00:00.000Z`,
    runningSince: r() < 0.5 ? `2026-09-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T00:00:00.000Z` : undefined,
    archivedAt: r() < 0.5 ? `2026-09-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T00:00:00.000Z` : undefined,
    title: `${id} v${Math.floor(r() * 1000)}`,
    // A child thread is never settled and never sectioned (shared drawnUnderParent): the partition must
    // carry it live, and every derivation below must drop it the way the whole-board form does.
    parentSlug: r() < 0.1 ? "parent" : undefined,
  } as Partial<ThreadView>)
}

// sectionThreads as it was before the partition: every thread classified.
function sectionThreadsReference(threads: readonly ThreadView[]): SectionedThreads {
  const out: SectionedThreads = { pinned: [], active: [], snoozed: [], inactive: [] }
  for (const t of threads) {
    if (t.kind === "session" && t.foreign === true) continue
    if (isPinned(t)) {
      out.pinned.push(t)
      continue
    }
    const k = sectionOf(t)
    if (k) out[k].push(t)
  }
  out.pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  out.active = orderActive(out.active, "fifo")
  out.snoozed = orderByInteraction(out.snoozed)
  out.inactive = orderDone(out.inactive)
  return out
}

const ids = (xs: readonly ThreadView[]) => xs.map((t) => t.id)

function checkAgainstReference(threads: readonly ThreadView[], label: string): void {
  const p = partitionBoard(threads)
  const fresh = { live: threads.filter((t) => !settledThread(t)), settled: threads.filter(settledThread) }
  assert.deepEqual(ids(p.live), ids(fresh.live), `${label}: live`)
  assert.deepEqual(ids(p.settled), ids(fresh.settled), `${label}: settled`)
  assert.deepEqual(p.liveAt.map((i) => threads[i]), p.live, `${label}: liveAt names the live slots`)
  for (const t of p.settled) assert.ok(threads.includes(t), `${label}: a settled thread is the board's own object`)

  const sections = sectionThreads(threads)
  const reference = sectionThreadsReference(threads)
  for (const key of ["pinned", "active", "snoozed", "inactive"] as const) {
    assert.deepEqual(ids(sections[key]), ids(reference[key]), `${label}: section ${key}`)
  }
  assert.deepEqual(ids(externalThreads(threads)), ids(threads.filter((t) => t.kind === "session" && t.foreign === true)), `${label}: external`)
  assert.deepEqual(ids(p.live.filter(queued)), ids(threads.filter(queued)), `${label}: queued`)
  // The Console's two bands (lib/consoleBoard.ts) ask the live threads only.
  for (const direction of ["fifo", "lifo"] as const) {
    assert.deepEqual(ids(consoleQueue(threads, direction, "project")), ids(orderQueue(threads.filter(queued), direction)), `${label}: Console queue, ${direction}`)
  }
  assert.deepEqual(ids(consoleRunning(threads)), ids(orderRunning(threads.filter(activeBandThread))), `${label}: Console running`)
  // Its pinned band reads the settled threads too: a Console pin outranks Done.
  const consoleShelf = threads.filter(isConsolePinned).sort((a, b) => (a.consolePinnedAt ?? "").localeCompare(b.consolePinnedAt ?? "") || a.id.localeCompare(b.id))
  assert.deepEqual(ids(consolePinned(threads)), ids(consoleShelf), `${label}: Console pinned`)
  const now = Date.parse("2026-10-14T00:00:00.000Z")
  const steer = (t: ThreadView) => optimisticallySteered(t, undefined, now)
  const live = overlayLive(threads, steer)
  const every = overlayEach(threads, steer)
  assert.equal(live.length, every.length, `${label}: overlay length`)
  live.forEach((t, i) => {
    if (t === threads[i]) assert.equal(every[i], threads[i], `${label}: overlay slot ${i} kept by both`)
    else assert.deepEqual(t, every[i], `${label}: overlay slot ${i}`)
  })
  if (every === threads) assert.equal(live, threads, `${label}: an overlay that changes nothing returns the board's own array`)
}

test("board partition: every derivation that skips settled threads agrees with its whole-board form, across a board's life", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed)
    let threads: ThreadView[] = Array.from({ length: 60 }, (_, i) => randomThread(`t${i}`, r))
    checkAgainstReference(threads, `seed ${seed} start`)
    for (let step = 0; step < 40; step++) {
      // The store's copy-on-write: a new array, a few slots replaced, now and then one added or removed.
      const next = threads.slice()
      const edits = 1 + Math.floor(r() * 3)
      for (let e = 0; e < edits; e++) {
        const i = Math.floor(r() * next.length)
        next[i] = randomThread(next[i]!.id, r)
      }
      if (r() < 0.1) next.push(randomThread(`n${seed}-${step}`, r))
      if (r() < 0.1) next.splice(Math.floor(r() * next.length), 1)
      threads = next
      checkAgainstReference(threads, `seed ${seed} step ${step}`)
    }
  }
})

test("board partition: a delta that touches only live threads keeps the settled list itself, and reads no settled thread", () => {
  const settledOne = thread("done-1", { state: "archived", archived: true })
  const settledTwo = thread("done-2", { state: "archived", archived: true })
  const first = [settledOne, thread("live", { runtime: "running" }), settledTwo]
  const p1 = partitionBoard(first)
  assert.deepEqual(ids(p1.settled), ["done-1", "done-2"])
  const next = first.slice()
  next[1] = thread("live", { runtime: "turn-idle", needsYou: true })
  // A settled thread that is asked anything throws: the carried partition must not ask.
  for (const t of [settledOne, settledTwo]) {
    Object.defineProperty(t, "runtime", { get() { throw new Error(`${t.id} was read`) }, configurable: true })
  }
  const p2 = partitionBoard(next)
  assert.equal(p2.settled, p1.settled, "the same array, so the Done band's order is reused by identity")
  assert.deepEqual(ids(p2.live), ["live"])
  assert.equal(p2.live[0], next[1])
})

test("board partition: a thread archived or reopened moves across, and the next board is built afresh", () => {
  const a = thread("a", { state: "archived", archived: true })
  const b = thread("b")
  const first = [a, b]
  assert.deepEqual(ids(partitionBoard(first).settled), ["a"])
  const reopened = [thread("a"), b]
  assert.deepEqual(ids(partitionBoard(reopened).settled), [])
  assert.deepEqual(ids(partitionBoard(reopened).live), ["a", "b"])
  const archived = [reopened[0]!, thread("b", { state: "archived", archived: true })]
  assert.deepEqual(ids(partitionBoard(archived).settled), ["b"])
  // Pinned, running, foreign, a delivery in flight: archived, and still not settled.
  for (const over of [{ pinnedAt: "2026-10-01T00:00:00.000Z" }, { runtime: "running" }, { foreign: true }, { deliveryInFlight: true }] as Partial<ThreadView>[]) {
    assert.equal(settledThread(thread("x", { state: "archived", archived: true, ...over })), false, JSON.stringify(over))
  }
})
