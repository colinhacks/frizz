import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AdoptThreadInput, DispatchInput, THREAD_SLUG_MAX_CHARS, ThreadSlug, threadIdentityName } from "@frizz/shared"
import { createDispatcher, resolveLegacyThreadFile, resolveSlug, slugify } from "./dispatch.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { type PaneIdentity } from "./adoption-recovery.ts"
import { readBoard, type FrizzBoard, type FrizzThread } from "./frizz.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
} from "./adoption-recovery.ts"

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `${slug}-owner`,
    thread_name: `frizz-${slug}`,
    spawned_at: "2026-07-13T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    transcript_id: null,
    state: "open",
    meta: null,
    seen_at: null,
    backend: "claude",
    agent_session_id: null,
    ...over,
  }
}

interface SpawnRecord {
  slug: string
  cmd: string[]
  cwd: string
  env?: Record<string, string>
  identity: PaneIdentity
  /** The broker takes the adoption orientation as a string, not a `--append-system-prompt-file` argv. */
  appendSystemPrompt?: string
  sessionId?: string
}

function harness(options: {
  hasSession?: (slug: string) => boolean
  onSpawn?: (storage: Storage, spawn: SpawnRecord) => void
  readBoard?: (threads: readonly FrizzThread[], dir: string) => FrizzBoard | Promise<FrizzBoard>
  adoptionRuntime?: AdoptionRecoveryRuntime
  preflightAuth?: (kind: string) => Promise<"authed" | "signed-out" | "unknown">
  preflightCodexBinary?: () => Promise<"present" | "missing" | "unknown">
  settings?: Partial<ReturnType<typeof defaultSettings>>
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-adopt-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = {
    dir,
    id: "adopt-test",
    name: "adopt-test",
    label: "o/adopt-test",
    stateDir: dir,
    cwdSlug: cwdSlug(dir),
  }
  const spawned: SpawnRecord[] = []
  const killedPanes: PaneIdentity[] = []
  const killedNames: string[] = []
  let ensureCalls = 0
  let hasSessionCalls = 0
  let rebuilds = 0
  let boardReads = 0
  const legacyThreads = new Map<string, FrizzThread>()
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => void rebuilds++,
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    readBoard: async () => {
      boardReads++
      const threads = [...legacyThreads.values()]
      return options.readBoard?.(threads, dir) ?? {
        config: {},
        threads,
        errors: [],
        warnings: [],
        errorItems: [],
      }
    },
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high", ...options.settings }),
    // Adoption spawns through the broker daemon. The fake records the same facts the
    // assertions below rely on (which slug/session/cwd, and the composed prompt).
    claudeBroker: {
      spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; appendSystemPrompt?: string }) => {
        const record = {
          slug: input.threadSlug,
          cmd: [input.prompt],
          cwd: input.cwd,
          env: {} as Record<string, string>,
          identity: { paneId: "%1", panePid: 1000, sessionCreated: 2000 },
          appendSystemPrompt: input.appendSystemPrompt ?? "",
          sessionId: input.sessionId,
        }
        spawned.push(record)
        options.onSpawn?.(storage, record)
        return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
      },
      releaseSession: () => {},
    } as unknown as ClaudeAgentBrokerBridge,
    adoptionRuntime: options.adoptionRuntime,
    preflightAuth: options.preflightAuth,
    preflightCodexBinary: options.preflightCodexBinary,
  })

  const discoverLegacy = (slug: string, over: Partial<FrizzThread> = {}) => {
    legacyThreads.set(slug, {
      id: slug,
      title: slug,
      status: "active",
      owner: null,
      agents: [],
      errors: [],
      warnings: [],
      ...over,
    })
  }
  const addLegacyFile = (slug: string, over: Partial<FrizzThread> = {}) => {
    mkdirSync(join(dir, ".frizz"), { recursive: true })
    writeFileSync(
      join(dir, ".frizz", `${slug}.md`),
      `---\ntitle: ${slug}\nstatus: active\n---\n\n## Goal\n\nContinue ${slug}.\n`,
    )
    discoverLegacy(slug, over)
  }

  return {
    dir,
    storage,
    dispatcher,
    spawned,
    killedPanes,
    killedNames,
    addLegacyFile,
    discoverLegacy,
    ensureCalls: () => ensureCalls,
    hasSessionCalls: () => hasSessionCalls,
    rebuilds: () => rebuilds,
    boardReads: () => boardReads,
  }
}

const HOSTILE_SLUGS = [
  "",
  ".",
  "..",
  "../outside",
  "/tmp/outside",
  "a/b",
  "a\\b",
  "C:\\outside",
  "%2e%2e",
  "Uppercase",
  "with_underscore",
  "with.dot",
  "é",
  "a\nb",
  "a\rb",
  "a\0b",
  "`touch-pwned`",
  "-leading-option",
  "a".repeat(THREAD_SLUG_MAX_CHARS + 1),
]

test("one canonical thread slug contract rejects path, control, option, Unicode, and oversized identities", () => {
  for (const valid of ["a", "0", "thread-2", "a".repeat(THREAD_SLUG_MAX_CHARS)]) {
    assert.equal(ThreadSlug.safeParse(valid).success, true, valid)
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: valid }).success, true, valid)
    assert.equal(AdoptThreadInput.safeParse({ slug: valid }).success, true, valid)
    assert.equal(threadIdentityName(valid), `frizz-${valid}`)
  }
  for (const invalid of HOSTILE_SLUGS) {
    assert.equal(ThreadSlug.safeParse(invalid).success, false, JSON.stringify(invalid))
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: invalid }).success, false, JSON.stringify(invalid))
    assert.equal(AdoptThreadInput.safeParse({ slug: invalid }).success, false, JSON.stringify(invalid))
    assert.throws(() => threadIdentityName(invalid))
  }
  assert.equal(AdoptThreadInput.safeParse({ slug: "safe", extra: true }).success, false, "adoption input is strict")
  assert.equal(AdoptThreadInput.safeParse({ slug: "safe", message: "x".repeat(64 * 1024 + 1) }).success, false)
})

test("derived and collision slugs remain canonical at the maximum length", () => {
  const max = slugify("a".repeat(THREAD_SLUG_MAX_CHARS + 50))
  assert.equal(max.length, THREAD_SLUG_MAX_CHARS)
  assert.equal(ThreadSlug.safeParse(max).success, true)
  const dir = mkdtempSync(join(tmpdir(), "frizz-slug-bound-"))
  writeFileSync(join(dir, `${max}.md`), "taken")
  const collision = resolveSlug(dir, max)
  assert.equal(collision.length, THREAD_SLUG_MAX_CHARS)
  assert.match(collision, /-2$/)
  assert.equal(ThreadSlug.safeParse(collision).success, true)
})

test("direct dispatcher entry points reject hostile slugs before board, spawn, scratch, or storage", async () => {
  const h = harness()
  for (const invalid of HOSTILE_SLUGS) {
    await assert.rejects(h.dispatcher.adopt(invalid), /thread is not available for adoption/)
    await assert.rejects(h.dispatcher.dispatch({ prompt: "safe", slug: invalid }))
  }
  assert.equal(h.boardReads(), 0)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.allSessions().length, 0)
  assert.equal(existsSync(join(h.dir, ".frizz")), false)
})

test("storage rejects a noncanonical thread identity at its direct mutation boundary", () => {
  const h = harness()
  assert.throws(() => h.storage.insertSessionIfAbsent(sessionRow("../escape")))
  assert.throws(() => h.storage.upsertSession(sessionRow("-option")))
  assert.throws(() => h.storage.upsertSession(sessionRow("safe", { thread_name: "frizz-someone-else" })))
  assert.equal(h.storage.allSessions().length, 0)
})

test("the real board reader omits unsafe ids and never follows markdown symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-board-safe-"))
  mkdirSync(join(dir, ".frizz"))
  writeFileSync(join(dir, ".frizz", "safe.md"), "---\ntitle: safe\nstatus: active\n---\n\n## Goal\n\nsafe\n")
  writeFileSync(join(dir, ".frizz", "Upper.md"), "---\ntitle: Upper\nstatus: active\n---\n")
  const outside = join(mkdtempSync(join(tmpdir(), "frizz-board-outside-")), "outside.md")
  writeFileSync(outside, "---\ntitle: linked\nstatus: active\n---\n")
  symlinkSync(outside, join(dir, ".frizz", "linked.md"))

  const board = await readBoard(dir)
  assert.deepEqual(board.threads.map((thread) => thread.id), ["safe"])
  assert.ok(board.errors.some((error) => error.includes("unsafe filename stem") && error.includes("Upper")))

  const linkedRoot = mkdtempSync(join(tmpdir(), "frizz-board-linked-root-"))
  symlinkSync(join(dir, ".frizz"), join(linkedRoot, ".frizz"))
  await assert.rejects(readBoard(linkedRoot), /unsafe or missing \.frizz directory/)
})

test("a file that is absent from the fresh board is stale and cannot be adopted", async () => {
  const h = harness({
    readBoard: () => ({ config: {}, threads: [], errors: [], warnings: [], errorItems: [] }),
  })
  h.addLegacyFile("stale")

  await assert.rejects(h.dispatcher.adopt("stale"), /thread is not available for adoption/)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("stale"), undefined)
  assert.equal(existsSync(join(h.dir, ".frizz", "threads")), false)
})

test("fresh-board ownership, agents, errors, and terminal or unknown statuses all fail closed", async () => {
  const cases: [string, Partial<FrizzThread>][] = [
    ["owned", { owner: "another-session" }],
    ["agent-bound", { agents: [{ id: "agent-1", state: "working" }] }],
    ["invalid", { errors: ["invalid frontmatter"] }],
    ["done", { status: "done" }],
    ["dismissed", { status: "dismissed" }],
    ["unknown", { status: "future-status" }],
    ["missing-agents", { agents: undefined }],
    ["missing-errors", { errors: undefined }],
  ]

  for (const [slug, override] of cases) {
    const h = harness()
    h.addLegacyFile(slug, override)
    await assert.rejects(h.dispatcher.adopt(slug), /thread is not available for adoption/, slug)
    assert.equal(h.boardReads(), 1, slug)
    assert.equal(h.ensureCalls(), 0, slug)
    assert.equal(h.hasSessionCalls(), 0, slug)
    assert.equal(h.spawned.length, 0, slug)
    assert.equal(h.storage.getSession(slug), undefined, slug)
  }
})

test("legacy source resolution rejects a symlinked file and a symlinked .frizz root", async () => {
  const externalDir = mkdtempSync(join(tmpdir(), "frizz-adopt-outside-"))
  const externalFile = join(externalDir, "outside.md")
  writeFileSync(externalFile, "---\ntitle: outside\nstatus: active\n---\n")

  const fileLink = harness()
  mkdirSync(join(fileLink.dir, ".frizz"))
  symlinkSync(externalFile, join(fileLink.dir, ".frizz", "linked.md"))
  fileLink.discoverLegacy("linked")
  assert.equal(resolveLegacyThreadFile(fileLink.dir, "linked"), null)
  await assert.rejects(fileLink.dispatcher.adopt("linked"), /thread is not available for adoption/)
  assert.equal(fileLink.boardReads(), 0)
  assert.equal(fileLink.ensureCalls(), 0)
  assert.equal(fileLink.spawned.length, 0)

  const frizzLink = harness()
  const externalFrizz = join(externalDir, "frizz-root")
  mkdirSync(externalFrizz)
  writeFileSync(join(externalFrizz, "linked-root.md"), "---\ntitle: linked-root\nstatus: active\n---\n")
  symlinkSync(externalFrizz, join(frizzLink.dir, ".frizz"))
  frizzLink.discoverLegacy("linked-root")
  assert.equal(resolveLegacyThreadFile(frizzLink.dir, "linked-root"), null)
  await assert.rejects(frizzLink.dispatcher.adopt("linked-root"), /thread is not available for adoption/)
  assert.equal(frizzLink.boardReads(), 0)
  assert.equal(frizzLink.ensureCalls(), 0)
  assert.equal(frizzLink.spawned.length, 0)
})

test("a threads directory symlink cannot redirect adoption writes outside the project", async () => {
  const h = harness()
  h.addLegacyFile("scratch-link")
  const external = mkdtempSync(join(tmpdir(), "frizz-scratch-outside-"))
  symlinkSync(external, join(h.dir, ".frizz", "threads"))

  await assert.rejects(h.dispatcher.adopt("scratch-link"), /thread is not available for adoption/)
  assert.deepEqual(readdirSync(external), [])
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("scratch-link"), undefined)
})

test("a source replaced while its fresh board is read fails the identity recheck", async () => {
  const h = harness({
    readBoard: (threads, dir) => {
      writeFileSync(join(dir, ".frizz", "changed.md"), "---\ntitle: changed\nstatus: active\n---\n\nchanged during scan\n")
      return { config: {}, threads: [...threads], errors: [], warnings: [], errorItems: [] }
    },
  })
  h.addLegacyFile("changed")

  await assert.rejects(h.dispatcher.adopt("changed"), /thread is not available for adoption/)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("changed"), undefined)
  assert.equal(existsSync(join(h.dir, ".frizz", "threads")), false)
})

test("adopt claims a fresh slug once and stores an exact Claude identity", async () => {
  let observedReservation = false
  const h = harness({
    onSpawn: (storage) => {
      const claim = storage.getAdoptionClaim("fresh")
      observedReservation = claim?.state === "reserved" && storage.getSession("fresh") === undefined
    },
  })
  h.addLegacyFile("fresh")
  assert.ok(resolveLegacyThreadFile(h.dir, "fresh"))

  const result = await h.dispatcher.adopt("fresh", "continue")
  const saved = h.storage.getSession("fresh")
  assert.equal(saved?.session_id, result.sessionId)
  assert.equal(saved?.backend, "claude")
  assert.equal(saved?.agent_session_id, null)
  assert.equal(saved?.model, "sonnet")
  assert.equal(saved?.effort, "high")
  assert.equal(observedReservation, true, "the unique durable reservation exists before external spawn")
  const claim = h.storage.getAdoptionClaim("fresh")
  assert.equal(claim?.state, "finalized")
  assert.equal(claim?.session_id, result.sessionId)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].slug, "fresh")
  assert.equal(h.spawned[0].cwd, h.dir)
  // The adoption orientation rides the broker's appendSystemPrompt now, not a --append-system-prompt-file
  // argv: there is no argv, because there is no pane to spawn one into.
  const systemPrompt = h.spawned[0].appendSystemPrompt ?? ""
  assert.match(systemPrompt, /ADOPTION: this thread predates you/)
  assert.match(systemPrompt, /\.frizz\/fresh\.md/)
  assert.doesNotMatch(systemPrompt, /\.\.\//)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.rebuilds(), 1)
})

test("two adoption requests for the same slug produce one worker and one owner", async () => {
  const h = harness()
  h.addLegacyFile("double")

  const results = await Promise.allSettled([
    h.dispatcher.adopt("double", "first"),
    h.dispatcher.adopt("double", "second"),
  ])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  const failure = results.find((result) => result.status === "rejected")
  assert.ok(failure && failure.status === "rejected")
  assert.match(String(failure.reason), /thread is not available for adoption/)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.storage.allSessions().length, 1)
  assert.equal(h.storage.getSession("double")?.session_id, results.find((result) => result.status === "fulfilled")?.value.sessionId)
})

test("an unexpired durable adoption reservation blocks retry before spawn or file provisioning", async () => {
  const h = harness()
  h.addLegacyFile("reserved")
  const now = Date.now()
  assert.equal(h.storage.reserveAdoptionClaim({
    slug: "reserved",
    attemptToken: randomUUID(),
    sessionId: randomUUID(),
    reservedAtMs: now,
    leaseExpiresAtMs: now + 60_000,
  }), true)

  await assert.rejects(h.dispatcher.adopt("reserved"), /thread is not available for adoption/)
  assert.equal(h.spawned.length, 0)
  assert.equal(existsSync(join(h.dir, ".frizz", "threads")), false)
})


test("a registered active worker owns its slug and adoption never spawns a worker", async () => {
  const h = harness({ hasSession: () => true })
  h.addLegacyFile("registered")
  assert.equal(h.storage.insertSessionIfAbsent(sessionRow("registered", {
    session_id: "registered-codex",
    backend: "codex",
    agent_session_id: "registered-native",
  })), true)

  await assert.rejects(h.dispatcher.adopt("registered"), /thread is not available for adoption/)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("registered")?.session_id, "registered-codex")
  assert.equal(h.storage.getSession("registered")?.backend, "codex")
  assert.equal(h.storage.getSession("registered")?.agent_session_id, "registered-native")
})

test("exited and archived rows still own their slugs and cannot be adopted over", async () => {
  const h = harness()
  const cases = [
    sessionRow("exited", { session_id: "exited-codex", backend: "codex", agent_session_id: "exited-native", exited: 1 }),
    sessionRow("archived", {
      session_id: "archived-codex",
      backend: "codex",
      agent_session_id: "archived-native",
      exited: 1,
      archived: 1,
      state: "archived",
    }),
  ]
  for (const existing of cases) {
    h.addLegacyFile(existing.slug)
    assert.equal(h.storage.insertSessionIfAbsent(existing), true)
    await assert.rejects(h.dispatcher.adopt(existing.slug), /thread is not available for adoption/)
    const saved = h.storage.getSession(existing.slug)
    assert.equal(saved?.session_id, existing.session_id)
    assert.equal(saved?.backend, "codex")
    assert.equal(saved?.agent_session_id, existing.agent_session_id)
    assert.equal(saved?.exited, existing.exited)
    assert.equal(saved?.archived, existing.archived)
    assert.equal(saved?.state, existing.state)
  }
  assert.equal(h.spawned.length, 0)
})

// The sibling of the test above, for the OTHER way an adoption rollback can end. Above, the liveness
// probe proves the losing worker is gone, so the rollback is complete: claim retired, scratchpad removed.
//
// Here the probe cannot answer (`unknown`), so the spawned worker may still be ALIVE and still writing
// the scratchpad it was given. abandonAdoptionAttempt deliberately refuses to release anything it cannot
// prove dead — the claim and the session's files are RETAINED for boot recovery rather than deleted
// out from under a possible orphan. That asymmetry is the whole point of the tri-state lookup, so it
// is pinned here: a future "just always clean up in rollback" simplification must fail this test.
//
// Retained is not leaked. Recovery is retire-only — it never resumes an attempt — and it reads the
// session id from the CLAIM, not from the scratchpad, so once the probe answers again the level-triggered
// sweep in context.ts finishes exactly the cleanup the rollback declined to do.
// ---- Dispatch auth preflight (claude-auth plan, Slice A) ----

test("signed-out preflight rejects dispatch before scratch, spawn, and storage", async () => {
  const seen: string[] = []
  const h = harness({
    preflightAuth: async (kind) => {
      seen.push(kind)
      return "signed-out"
    },
  })
  await assert.rejects(h.dispatcher.dispatch({ prompt: "do the thing" }), /AUTH_REQUIRED:claude$/)
  assert.deepEqual(seen, ["claude"])
  assert.equal(h.spawned.length, 0)
  // Zero trace: no scratchpad tree, no registry row.
  assert.equal(existsSync(join(h.dir, ".frizz")), false)
})

test("a missing codex binary rejects a codex dispatch early, before any thread state", async () => {
  const probed: number[] = []
  const h = harness({
    preflightAuth: async () => "authed", // credential is fine; the BINARY is what's missing
    preflightCodexBinary: async () => { probed.push(1); return "missing" },
  })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "start a codex thread" }, { backend: "codex" }),
    /Codex is not installed.*not on PATH/,
  )
  assert.equal(probed.length, 1, "the binary was probed")
  assert.equal(h.spawned.length, 0)
  // Zero trace, exactly like the signed-out gate: no scratchpad, no registry row.
  assert.equal(existsSync(join(h.dir, ".frizz")), false)
})

test("codex dispatch proceeds when the binary probe is uncertain — fail OPEN, never trap a working user", async () => {
  // "unknown" (a timeout, a permission error, anything short of ENOENT) must NOT block. It reaches the
  // bridge, which is absent in this harness, so it fails THERE — proving the binary gate let it past.
  const h = harness({
    preflightAuth: async () => "authed",
    preflightCodexBinary: async () => "unknown",
  })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "start a codex thread" }, { backend: "codex" }),
    /Codex app-server is unavailable|could not start/,
  )
})

test("the codex binary probe is codex-only — a claude dispatch never runs it", async () => {
  let probed = false
  const h = harness({
    preflightAuth: async () => "authed",
    preflightCodexBinary: async () => { probed = true; return "missing" },
  })
  // A claude dispatch with an available binary path should not consult the codex probe at all.
  await h.dispatcher.dispatch({ prompt: "claude thread" }).catch(() => {})
  assert.equal(probed, false, "the codex binary probe must not run for a claude dispatch")
})

test("signed-out preflight names the codex backend when the dispatch targets codex", async () => {
  const h = harness({ preflightAuth: async () => "signed-out" })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "do the thing", backend: "codex" }, { backend: "codex" }),
    /AUTH_REQUIRED:codex$/,
  )
  assert.equal(h.spawned.length, 0)
})

test("unknown preflight fails OPEN — dispatch proceeds", async () => {
  const h = harness({ preflightAuth: async () => "unknown" })
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})

test("a preflight that itself throws fails OPEN — dispatch proceeds", async () => {
  const h = harness({
    preflightAuth: async () => {
      throw new Error("keychain exploded")
    },
  })
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})

test("no injected preflight (unit-test composition) leaves dispatch untouched", async () => {
  const h = harness()
  const res = await h.dispatcher.dispatch({ prompt: "do the thing" })
  assert.equal(h.spawned.length, 1)
  assert.ok(h.storage.getSession(res.slug))
})

// ---- adoptSession: PROMOTING one of the human's OWN terminals on its first steer ----
//
// Distinct from adopt() above in both directions: it binds to a conversation that already exists
// rather than cold-starting a worker on a thread file, and it deliberately spawns NOTHING. The
// External band only ever lists sessions at rest, and the follow-up that triggered the promotion is
// what resumes it — so promoting AND spawning would be a second resume path to keep correct forever.
test("adoptSession: a claude terminal keeps its id and its transcript, and no worker is started", async () => {
  const h = harness()
  const EXTERNAL = "6543d3fb-e38e-461a-b10a-9c78261b67b2"
  const res = await h.dispatcher.adoptSession({ sessionId: EXTERNAL, backend: "claude", title: "Debug Frizz thread startup issue" })

  // THE ID DOES NOT CHANGE — slug and session_id are both the id the session was discovered under.
  // That is what lets promotion happen under a mounted composer: every piece of optimistic client
  // state (the queued bubble, the steer overlay, the per-slug send queue, the draft key) is keyed by
  // slug, and a fresh slug would strand all of it mid-send.
  assert.equal(res.slug, EXTERNAL)
  assert.equal(res.sessionId, EXTERNAL)
  const row = h.storage.getSession(EXTERNAL)
  assert.equal(row?.session_id, EXTERNAL)
  assert.equal(row?.backend, "claude")
  assert.equal(row?.agent_session_id ?? null, null, "claude's transcript IS <session_id>.jsonl; nothing extra to pin")
  assert.equal(row?.thread_name, `frizz-${EXTERNAL}`)
  // The name the human just read in the rail, kept — and NOT marked provisional, because it is a real
  // name (Claude's own ai-title) rather than the dispatch chop that placeholder exists for.
  assert.equal(row?.title, "Debug Frizz thread startup issue")
  assert.equal(row?.title_auto, 0)
  assert.equal(h.spawned.length, 0, "promotion starts no worker; the follow-up that triggered it resumes")
})

test("adoptSession: a codex terminal pins the SAME id on agent_session_id, where its rollout is found", async () => {
  const h = harness()
  const ROLLOUT = "01a01b81-bbf3-7841-b704-a7c4b95b7bd7"
  const res = await h.dispatcher.adoptSession({ sessionId: ROLLOUT, backend: "codex" })

  // Codex locates a rollout by `agent_session_id`, so that column has to carry the id too. Unlike a
  // codex DISPATCH — which mints a session_id before codex has told it the rollout id — promotion
  // already knows the id, so both columns hold it and the thread's identity stays stable either way.
  assert.equal(res.slug, ROLLOUT)
  assert.equal(res.sessionId, ROLLOUT)
  const row = h.storage.getSession(ROLLOUT)
  assert.equal(row?.agent_session_id, ROLLOUT)
  assert.equal(row?.session_id, ROLLOUT)
  assert.equal(row?.backend, "codex")
  // Codex writes no title record, so there is no name to inherit — the short id stands.
  assert.equal(row?.title, `Session ${ROLLOUT.slice(0, 8)}`)
})

// The follow-up that triggers a promotion resumes the session with `row.permission_mode`. A row
// stamped with NOTHING fell through to the bridge's `"default"` — Claude's prompt-on-everything mode,
// which the worker's perm-policy hook defers on every call — so a terminal session driven from the
// board turned every Edit into a card (observed 2026-09-03). The promoted row therefore carries the
// same Settings-driven launch mode a dispatched worker gets.
test("adoptSession: the promoted row carries the dispatch launch mode, never an empty one", async () => {
  const CLAUDE_ID = "6543d3fb-e38e-461a-b10a-9c78261b67b2"
  const ROLLOUT = "01a01b81-bbf3-7841-b704-a7c4b95b7bd7"

  // Shipped default: bypass for claude, danger-full-access for codex.
  const shipped = harness()
  await shipped.dispatcher.adoptSession({ sessionId: CLAUDE_ID, backend: "claude", title: "Terminal" })
  await shipped.dispatcher.adoptSession({ sessionId: ROLLOUT, backend: "codex" })
  assert.equal(shipped.storage.getSession(CLAUDE_ID)?.permission_mode, "bypassPermissions")
  assert.equal(shipped.storage.getSession(ROLLOUT)?.permission_mode, "bypassPermissions")

  // The one Settings deviation frizz honours for claude — and a restrictive value left by an older
  // build still coerces to the floor rather than to Claude's `default`.
  const auto = harness({ settings: { permissionMode: "auto" } })
  await auto.dispatcher.adoptSession({ sessionId: CLAUDE_ID, backend: "claude", title: "Terminal" })
  assert.equal(auto.storage.getSession(CLAUDE_ID)?.permission_mode, "auto")
  const restrictive = harness({ settings: { permissionMode: "default" } })
  await restrictive.dispatcher.adoptSession({ sessionId: CLAUDE_ID, backend: "claude", title: "Terminal" })
  assert.equal(restrictive.storage.getSession(CLAUDE_ID)?.permission_mode, "auto")
})

test("adoptSession: a session frizz already owns cannot be promoted again, through EITHER id column", async () => {
  const h = harness()
  const CLAUDE_ID = "6543d3fb-e38e-461a-b10a-9c78261b67b2"
  const ROLLOUT = "01a01b81-bbf3-7841-b704-a7c4b95b7bd7"
  await h.dispatcher.adoptSession({ sessionId: CLAUDE_ID, backend: "claude", title: "First" })
  await h.dispatcher.adoptSession({ sessionId: ROLLOUT, backend: "codex", title: "Second" })

  // The registry is re-read rather than the caller's claim trusted: the request arrives from a browser
  // saying "this came from the foreign band", and a crafted one must not be able to mint a second row
  // over a thread frizz is already driving.
  await assert.rejects(() => h.dispatcher.adoptSession({ sessionId: CLAUDE_ID, backend: "claude" }), /already a frizz thread/)
  await assert.rejects(() => h.dispatcher.adoptSession({ sessionId: ROLLOUT, backend: "codex" }), /already a frizz thread/)
  // And a malformed id is refused before anything is written.
  await assert.rejects(() => h.dispatcher.adoptSession({ sessionId: "../escape", backend: "claude" }), /cannot be adopted/)
})
