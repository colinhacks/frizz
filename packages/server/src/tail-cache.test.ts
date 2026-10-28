import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeSync, writeFileSync, utimesSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import { createTailer } from "./tailer.ts"
import type { Project } from "./project.ts"
import { createTailStateCache, encodeTailState, decodeTailState, measureFence, fenceMatches } from "./tail-cache.ts"

// The durable prime cache exists to remove the FULL re-fold of every transcript on every boot. Its one
// non-negotiable property is that it can only ever make boot FASTER, never make the derived state
// DIFFERENT — so almost every test here is the same shape: derive a thread's telemetry twice, once
// through a cold fold from byte 0 and once through the cache, and assert the two are identical.

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

const stamp = (n: number) => `2026-07-01T00:00:${String(n).padStart(2, "0")}.000Z`
const user = (n: number, text: string) => JSON.stringify({
  type: "user", timestamp: stamp(n), promptSource: "typed", message: { content: [{ type: "text", text }] },
})
const assistant = (n: number, text: string, stop = "end_turn") => JSON.stringify({
  type: "assistant", timestamp: stamp(n), message: { model: "claude-opus-4-8", stop_reason: stop, content: [{ type: "text", text }] },
})
const title = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t })

interface Harness {
  dir: string
  storage: Storage
  bus: Bus
  path: (sessionId: string) => string
}

function harness(): Harness {
  const dir = tmp("frizz-tailcache-")
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { dir, storage, bus: new Bus(), path: (id) => join(dir, `${id}.jsonl`) }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: null, meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

/** One boot: build a tailer over the harness, prime it, and return the thread's telemetry. */
function boot(h: Harness, over: Partial<Parameters<typeof createTailer>[0]> & { slug?: string } = {}) {
  const { slug = "t", ...opts } = over
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => {},
    now: () => Date.parse("2026-07-01T01:00:00.000Z"),
    paneDead: () => true,
    sessionLogDir: h.dir,
    ...opts,
  })
  t.start()
  const telemetry = t.get(slug)
  t.stop()
  return telemetry
}

// Tolerant of the table not existing yet: a boot with the cache disabled never creates it.
const cachedSlugs = (h: Harness): string[] => {
  try {
    return h.storage.db.prepare<[], { slug: string }>("SELECT slug FROM tail_state").all().map((r) => r.slug)
  } catch {
    return []
  }
}

// ---- the codec ----

test("tail-cache codec: round-trips Maps and Sets, and every field it was not told about", () => {
  const state = {
    slug: "t", offset: 42, partial: "xy", turn: "idle",
    subAgents: new Map([["toolu_1", { kind: "agent", label: "child", startedAt: stamp(1) }]]),
    deliveredReports: new Set(["task-1"]),
    // A field the codec has never heard of must survive: the whole point of a generic codec is that
    // the next TailState field cannot be silently dropped by someone forgetting to add it here.
    somethingAddedLater: { nested: [1, 2, 3] },
  }
  const back = decodeTailState(encodeTailState(state))
  assert.ok(back)
  assert.equal(back.offset, 42)
  assert.ok(back.subAgents instanceof Map, "a Map must come back as a Map, not a plain object")
  assert.equal((back.subAgents as Map<string, { label: string }>).get("toolu_1")?.label, "child")
  assert.ok(back.deliveredReports instanceof Set, "a Set must come back as a Set, not a plain object")
  assert.deepEqual([...back.deliveredReports as Set<string>], ["task-1"])
  assert.deepEqual(back.somethingAddedLater, { nested: [1, 2, 3] })
})

test("tail-cache codec: garbage decodes to null rather than throwing", () => {
  assert.equal(decodeTailState("{not json"), null)
  assert.equal(decodeTailState("[1,2,3]"), null)
  assert.equal(decodeTailState("null"), null)
})

// ---- the file fence ----

test("tail-cache fence: an append still matches; a truncation and a same-size rewrite do not", () => {
  const dir = tmp("frizz-fence-")
  const path = join(dir, "a.jsonl")
  writeFileSync(path, "aaaa\nbbbb\ncccc\n")
  const at = statSync(path).size
  const fence = measureFence(path, at)
  assert.ok(fence)

  // Appended: the prefix we folded is untouched, so the fence holds and the tailer consumes the delta.
  appendFileSync(path, "dddd\n")
  assert.equal(fenceMatches(fence, measureFence(path, at)!), true)

  // Truncated below the folded prefix: no fence at all (the file cannot supply those bytes).
  writeFileSync(path, "aa\n")
  assert.equal(measureFence(path, at), null)

  // Rewritten IN PLACE to the same length, and the mtime restored, so size+mtime alone would accept
  // it. The content digest is what refuses.
  writeFileSync(path, "aaaa\nbbbb\ncccc\n")
  const before = statSync(path)
  const fd = openSync(path, "r+")
  writeSync(fd, Buffer.from("zzzz"), 0, 4, 0)
  closeSync(fd)
  utimesSync(path, before.atime, before.mtime)
  const rewritten = measureFence(path, at)
  assert.ok(rewritten)
  assert.equal(rewritten.size, fence.size)
  assert.equal(fenceMatches(fence, rewritten), false, "an in-place rewrite must never pass the fence")
  rmSync(dir, { recursive: true, force: true })
})

test("tail-cache fence: an offset of 0 or a missing file has no fence", () => {
  const dir = tmp("frizz-fence-")
  const path = join(dir, "a.jsonl")
  writeFileSync(path, "aaaa\n")
  assert.equal(measureFence(path, 0), null)
  assert.equal(measureFence(join(dir, "missing.jsonl"), 10), null)
  rmSync(dir, { recursive: true, force: true })
})

// ---- the whole-boot equivalence property ----

test("tail-cache: a warm boot derives EXACTLY what a cold boot derives", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "working", "tool_use"), assistant(3, "done"), title("a title")].map((l) => l + "\n").join(""))

  const cold = boot(h, { tailCache: null })
  assert.deepEqual(cachedSlugs(h), [], "an explicitly-disabled cache writes nothing")

  const seeding = boot(h)
  assert.deepEqual(seeding, cold, "seeding the cache must not change the derivation")
  assert.deepEqual(cachedSlugs(h), ["t"])

  const warm = boot(h)
  assert.deepEqual(warm, cold, "the cached derivation must equal the cold one")
})

test("tail-cache: a thread whose transcript GREW resumes at the cached offset and lands where a cold fold does", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "first answer")].map((l) => l + "\n").join(""))
  boot(h) // seed the cache at the current size

  appendFileSync(h.path("sid"), [user(3, "again"), assistant(4, "second answer")].map((l) => l + "\n").join(""))
  const warm = boot(h)

  // A fresh project with the SAME final bytes, folded from 0, is the reference.
  const reference = harness()
  reference.storage.upsertSession(row())
  writeFileSync(reference.path("sid"), [user(1, "go"), assistant(2, "first answer"), user(3, "again"), assistant(4, "second answer")].map((l) => l + "\n").join(""))
  assert.deepEqual(warm, boot(reference, { tailCache: null }))
  assert.equal(warm?.lastAssistant, "second answer")
})

test("tail-cache: a REPLACED transcript (same path, new file) is a miss, not a stale hit", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "old answer")].map((l) => l + "\n").join(""))
  boot(h)

  // Rewrite the file wholesale — a different transcript at the same path.
  rmSync(h.path("sid"))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "brand new answer")].map((l) => l + "\n").join(""))

  const warm = boot(h)
  assert.equal(warm?.lastAssistant, "brand new answer", "the cache must never serve the replaced file's derivation")
})

test("tail-cache: a thread the registry calls DONE still invalidates when its JSONL grows", () => {
  const h = harness()
  // exited + archived: by every registry signal this thread is finished and will never move again.
  h.storage.upsertSession(row({ exited: 1, archived: 1, state: "archived" }))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "done")].map((l) => l + "\n").join(""))
  boot(h)

  appendFileSync(h.path("sid"), assistant(9, "actually there is more") + "\n")
  assert.equal(boot(h)?.lastAssistant, "actually there is more")
})

test("tail-cache: a different fold schema is ignored, and pruned", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  boot(h)
  assert.deepEqual(cachedSlugs(h), ["t"])

  // A boot whose fold implementation hashes differently must not read the old entries at all: their
  // derivation came from code that no longer exists.
  const cache = createTailStateCache(h.storage.scope, "a-different-fold-schema")
  assert.equal(cache.load().size, 0)
  const warm = boot(h, { tailCache: cache })
  assert.equal(warm?.lastAssistant, "answer")
  // Re-seeded under the new schema; the entry from the retired one is gone.
  const remaining = h.storage.db.prepare<[], { fold_schema: string }>("SELECT fold_schema FROM tail_state").all()
  assert.deepEqual([...new Set(remaining.map((r) => r.fold_schema))], ["a-different-fold-schema"])
})

test("tail-cache: a CORRUPT stored state degrades to the full re-read", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  const cold = boot(h, { tailCache: null })
  boot(h)

  h.storage.db.prepare("UPDATE tail_state SET state = ?").run("{ this is not json")
  assert.deepEqual(boot(h), cold, "a corrupt blob must be ignored, not trusted")

  h.storage.db.prepare("UPDATE tail_state SET state = ?").run(JSON.stringify({ offset: 999, partial: "" }))
  assert.deepEqual(boot(h), cold, "a blob whose offset disagrees with its own fence must be ignored")
})

test("tail-cache: a row with an OPEN delivery ledger keeps its full replay", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  h.storage.setDeliveryLedger("t", JSON.stringify([
    { id: "d1", text: "please continue", state: "pending", at: stamp(3), updatedAt: stamp(3) },
  ]))
  boot(h)
  assert.deepEqual(cachedSlugs(h), [], "a thread with follow-ups in flight is never cached")
})

test("tail-cache: an entry for a slug the registry no longer has is pruned", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.upsertSession(row({ slug: "u", session_id: "sid2", thread_name: "frizz-u" }))
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "a")].map((l) => l + "\n").join(""))
  writeFileSync(h.path("sid2"), [user(1, "go"), assistant(2, "b")].map((l) => l + "\n").join(""))
  boot(h)
  assert.deepEqual(cachedSlugs(h).sort(), ["t", "u"])

  h.storage.forgetSession("u")
  boot(h)
  assert.deepEqual(cachedSlugs(h), ["t"])
})

test("tail-cache: a MISSING table degrades to correct-but-slow rather than throwing", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  const cold = boot(h, { tailCache: null })
  boot(h)
  h.storage.db.exec("DROP TABLE tail_state")
  // The next boot re-creates it; the derivation is unaffected either way.
  assert.deepEqual(boot(h), cold)
})

// A field the fold does NOT derive from the transcript has no business surviving in this cache. The
// marker-derived permission state is exactly that — permPrompt is already in UNRESTORED_TAIL_FIELDS
// for the same reason — and permPolicy was left out.
//
// It matters more than the usual staleness because the fold-schema digest CANNOT save us here. In a
// promoted artifact the .ts sources are not shipped (verified: `find ~/.frizz/builds -name tailer.ts`
// is empty), so foldSchemaDigest falls back to the fixed "frizz-tail-state-v2-unreadable" constant and
// every build's rows match every other build's. A state cached by the build that still retained
// auto-APPROVALS would therefore be handed straight back to the build that removed them — resurrecting
// the note ab774ee deleted, permanently, because nothing clears it.
test("tail-cache: marker-derived permission state is never restored from the cache", () => {
  const h = harness()
  h.storage.upsertSession(row())
  writeFileSync(h.path("sid"), [user(1, "go"), assistant(2, "answer")].map((l) => l + "\n").join(""))
  boot(h) // seed

  // Forge the blob the PREVIOUS build would have written: same fold cursor, plus the retained policy.
  const stored = h.storage.db.prepare<[], { state: string }>("SELECT state FROM tail_state").get()!
  const decoded = decodeTailState(stored.state)!
  decoded.permPolicy = { decision: "allow", rule: "worker-autonomy", reason: "unattended", tool: "Bash", command: "git status --short", at: stamp(2) }
  decoded.permDenies = 4
  h.storage.db.prepare("UPDATE tail_state SET state = ?").run(encodeTailState(decoded))

  const warm = boot(h)
  assert.equal(warm?.lastAssistant, "answer", "the cache still hit — this is a restore, not a re-fold")
  assert.equal(warm?.permPolicy, undefined, "a cached policy decision must not be handed back")
  assert.equal(warm?.permDenies, undefined, "nor its denial count")
})

// ---- the renamed project directory ----
//
// Claude Code pins a session's transcript to the bucket for the cwd it was BORN in, so renaming the
// checkout leaves `<sessionId>.jsonl` one directory over (discover.ts). The tailer recovers by rebinding
// to it — but `hydrateFromCache` runs BEFORE that recovery, with `state.path` still derived from the
// project's CURRENT path. Fenced on the directory alone, every stranded thread's cached entry missed
// forever: it re-folded from byte 0 on EVERY boot rather than once. On the real board that was 386 of
// 427 sessions, 1.5 GB (measured 2026-08-11). The filename is the pinned session id and the
// session/generation fences have already matched, so a same-name entry in another bucket is the same
// transcript — and accepting it also rebinds the state to where the file actually is.

test("tail-cache: an entry written before the project was renamed still hydrates (and rebinds the path)", () => {
  const h = harness()
  const oldBucket = join(h.dir, "-Users-me-projects-fray")
  const newBucket = join(h.dir, "-Users-me-projects-frizz")
  mkdirSync(oldBucket, { recursive: true })
  mkdirSync(newBucket, { recursive: true })
  h.storage.upsertSession(row())
  // The transcript never moved: it is still in the bucket the session was born in.
  writeFileSync(join(oldBucket, "sid.jsonl"), [user(1, "go"), assistant(2, "the real answer")].map((l) => l + "\n").join(""))

  // Boot 1: the sweep finds it one directory over, folds it, and caches it under the OLD bucket path.
  const first = boot(h, { sessionLogDir: newBucket })
  assert.equal(first?.lastAssistant, "the real answer")
  const stored = h.storage.db.prepare<[], { path: string }>("SELECT path FROM tail_state").all()
  assert.deepEqual(stored.map((r) => r.path), [join(oldBucket, "sid.jsonl")], "cached under the bucket the file is really in")

  // Boot 2 must HYDRATE, not re-fold. Proven by poisoning the cached derivation with a value no fold of
  // this file could ever produce: if the entry is used, the sentinel surfaces; if it is rejected, the
  // re-fold overwrites it with the real answer.
  const blob = h.storage.db.prepare<[], { state: string }>("SELECT state FROM tail_state").get()!
  const poisoned = JSON.parse(blob.state)
  assert.equal(poisoned.lastAssistant, "the real answer", "sanity: the codec stores the fold flat")
  poisoned.lastAssistant = "HYDRATED-FROM-CACHE"
  h.storage.db.prepare("UPDATE tail_state SET state = ?").run(JSON.stringify(poisoned))

  assert.equal(boot(h, { sessionLogDir: newBucket })?.lastAssistant, "HYDRATED-FROM-CACHE", "the pre-rename entry must be used, not re-folded")
})

// …AND THE REBIND THE WIDENING PROMISES HAS TO ACTUALLY HAPPEN. The test above proves the entry is
// USED; it never proved the state could go on READING, and it could not. `path` is in
// UNRESTORED_TAIL_FIELDS — identity comes from the live row, never the cache — so hydrate kept the
// derived (new-bucket, nonexistent) path while restoring the offset from the old-bucket entry. Then
// `resolveTranscript` short-circuits on `offset > 0` ("already bound to a real transcript"), the
// recovery that would have rebound it never runs, and `consume` reads a file that is not there. The
// thread goes PERMANENTLY DEAF at the byte it was cached on.
//
// On the live board that was `i-want-a-way-to-run`: frozen at 2026-08-19 for five days while its
// worker kept answering into a transcript 1.36 MB further on, including a follow-up the operator sent
// and watched go nowhere (maintainer 2026-08-24: "it fucking frozen again"). Two mechanisms each
// correct alone — a widening that accepts the entry ON THE PROMISE that path round-trips, and a
// restore list that guarantees it does not.
test("tail-cache: a hydrated pre-rename entry keeps READING the bucket the file is really in", () => {
  const h = harness()
  const oldBucket = join(h.dir, "-Users-me-projects-fray")
  const newBucket = join(h.dir, "-Users-me-projects-frizz")
  mkdirSync(oldBucket, { recursive: true })
  mkdirSync(newBucket, { recursive: true })
  // Its OWN slug/session id. The pair above uses `t`/`sid`, and `assistant()`'s text is the only thing
  // distinguishing two otherwise identical fixtures — sharing the identity made this case read the
  // neighbour's cached prefix and pass or fail on test order.
  h.storage.upsertSession(row({ slug: "reread", session_id: "reread-sid", thread_name: "frizz-reread" }))
  const transcript = join(oldBucket, "reread-sid.jsonl")
  writeFileSync(transcript, [user(1, "go"), assistant(2, "the real answer")].map((l) => l + "\n").join(""))

  assert.equal(boot(h, { sessionLogDir: newBucket, slug: "reread" })?.lastAssistant, "the real answer", "boot 1 finds it one bucket over")

  // The worker answers again while frizz is down — the ordinary case for a thread that outlives a restart.
  appendFileSync(transcript, assistant(3, "and the answer AFTER the restart") + "\n")

  assert.equal(
    boot(h, { sessionLogDir: newBucket, slug: "reread" })?.lastAssistant,
    "and the answer AFTER the restart",
    "boot 2 hydrates the cached prefix AND reads on from the file it was cached against",
  )
})

test("tail-cache: a DIFFERENT session's file in another bucket is never mistaken for this one", () => {
  const h = harness()
  const other = join(h.dir, "-some-other-project")
  const mine = join(h.dir, "-my-project")
  mkdirSync(other, { recursive: true })
  mkdirSync(mine, { recursive: true })
  h.storage.upsertSession(row())
  writeFileSync(join(mine, "sid.jsonl"), [user(1, "go"), assistant(2, "mine")].map((l) => l + "\n").join(""))
  // A neighbour bucket holding a DIFFERENT session id must not be reachable through the widened fence.
  writeFileSync(join(other, "someone-elses.jsonl"), [user(1, "go"), assistant(2, "theirs")].map((l) => l + "\n").join(""))
  boot(h, { sessionLogDir: mine })
  const stored = h.storage.db.prepare<[], { path: string }>("SELECT path FROM tail_state").all()
  assert.deepEqual(stored.map((r) => r.path), [join(mine, "sid.jsonl")], "bound to its own file, in its own bucket")
  assert.equal(boot(h, { sessionLogDir: mine })?.lastAssistant, "mine")
})
