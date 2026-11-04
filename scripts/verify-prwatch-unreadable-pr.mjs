// Real-subsystem proof for the second way a PR watcher stalls a parked worker: a PR the SERVER's own
// `gh` cannot read. Before 2026-08-25 the status poll swallowed every `gh` failure — no log line, no
// wake, ever — and registration accepted any parseable ref, so a worker on such a PR rested believing it
// was covered. Real `gh`, real GitHub, the real scheduler and the real router handler; only the thread
// row is a fixture.
//
//   1. the CONTROL: a public PR the world can read probes OK and registers;
//   2. a repo that does not exist is REFUSED at registration, with gh's own reason in the message;
//   3. a watcher on it that somehow exists anyway (armed before this change) is now SAID: one status
//      failure line on the first poll, the repeat suppressed on the next, and nothing armed or woken.
//
// Needs Frizz signed in to GitHub — a stored credential or FRIZZ_GITHUB_TOKEN (the control reads a public PR). Usage: nub scripts/verify-prwatch-unreadable-pr.mjs
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "../packages/server/src/storage.ts"
import { createScheduler, probePrReadable, parsePrRef } from "../packages/server/src/scheduler.ts"
import { createRouter } from "../packages/server/src/router.ts"

const READABLE = process.env.PR_REF ?? "nubjs/nub#555"
const UNREADABLE = "acme/definitely-not-a-repo-xyz#1"
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`) }

const root = mkdtempSync(join(tmpdir(), "verify-prwatch-unreadable-"))
const storage = createStorage(join(root, "ui.db"), "p")
const logs = []
const telemetry = new Map()
const tailer = { get: (slug) => telemetry.get(slug), subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} }
let offset = 0
const now = () => Date.now() + offset
const scheduler = createScheduler({
  storage, tailer, now,
  resume: () => {},
  fetchGithubReview: async () => [],
  log: (m) => { logs.push(m); if (process.env.VERBOSE) console.log(`  waker> ${m}`) },
})
const router = createRouter({
  project: { id: "p", dir: root, cwdSlug: "p", stateDir: root }, storage, tailer,
  board: { refresh: () => ({}) },
  getSettings: () => ({ permissionMode: "auto" }),
  probePr: probePrReadable, // the production probe, verbatim
})

try {
  storage.upsertSession({
    slug: "t", session_id: "sid-t", thread_name: "frizz-t", spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: "t", state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  telemetry.set("t", { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastActivityAt: new Date().toISOString() })

  // ---- 1. CONTROL ---------------------------------------------------------------------------------
  const okProbe = await probePrReadable(parsePrRef(READABLE))
  check(`CONTROL: the probe reads ${READABLE}`, okProbe.ok === true, JSON.stringify(okProbe))
  const added = await router.addOwnPrWatch.handler({ input: { slug: "t", target: READABLE, for: "1h" } })
  check("CONTROL: …and registration arms it", added?.alreadyArmed === false && storage.listPrWatches("t", { armedOnly: true }).length === 1)

  // ---- 2. REFUSED AT REGISTRATION ---------------------------------------------------------------------
  const badProbe = await probePrReadable(parsePrRef(UNREADABLE))
  check(`the probe cannot read ${UNREADABLE}`, badProbe.ok === false, JSON.stringify(badProbe))
  check("…and gh's own reason is carried, not a generic one", badProbe.ok === false && /definitely-not-a-repo-xyz|Could not resolve|not found|404/i.test(badProbe.reason), badProbe.reason)
  let refusal
  try { await router.addOwnPrWatch.handler({ input: { slug: "t", target: UNREADABLE, for: "1h" } }) } catch (err) { refusal = err }
  check("registration is REFUSED", !!refusal, refusal?.message?.slice(0, 160))
  check("…naming the PR, the reason, and what to check", !!refusal && refusal.message.includes(UNREADABLE) && /Settings → GitHub/.test(refusal.message) && /definitely-not-a-repo-xyz|Could not resolve/i.test(refusal.message))
  check("…and nothing was armed for it", storage.listPrWatches("t", { armedOnly: true }).every((w) => `${w.owner}/${w.repo}` !== "acme/definitely-not-a-repo-xyz"))

  // ---- 3. A PRE-EXISTING WATCHER ON IT IS SAID -------------------------------------------------------
  const ref = parsePrRef(UNREADABLE)
  storage.armPrWatch({ id: "prw_legacy", slug: "t", owner: ref.owner, repo: ref.repo, number: ref.number, createdAtMs: now(), expiresAtMs: now() + 3_600_000 })
  await scheduler.tick()
  const failureLines = () => logs.filter((m) => m.includes(`PR status check failed for ${UNREADABLE}`))
  check("the first poll SAYS the status check failed, with gh's reason", failureLines().length === 1 && /definitely-not-a-repo-xyz|Could not resolve/i.test(failureLines()[0]), failureLines()[0]?.slice(0, 200))
  offset += 61_000
  await scheduler.tick()
  check("the identical failure on the next poll is suppressed, not repeated", failureLines().length === 1, `lines=${failureLines().length}`)
  check("no wake was queued for a PR that cannot be read", storage.db.prepare("SELECT count(*) AS n FROM wake_delivery WHERE thread_slug='t' AND fence_id LIKE 'prwatch%prw_legacy%'").get().n === 0)
} finally {
  try { await scheduler.stop() } catch {}
  try { storage.close() } catch {}
  rmSync(root, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${results.length} checks`)
process.exit(failed === 0 ? 0 : 1)
