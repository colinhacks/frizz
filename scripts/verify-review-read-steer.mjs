#!/usr/bin/env node
// REAL-SUBSYSTEM VERIFICATION that a pr-watch wake for a REVIEW hands the worker a command that
// actually returns the review's substance.
//
// No stubbed GitHub anywhere. This drives the REAL scheduler with the REAL GraphQL fetcher (the
// maintainer's own `gh` token, real HTTPS) against a REAL public PR, takes the steer the scheduler
// composes, EXTRACTS the `gh` command out of it, RUNS that exact command, and checks the bytes that
// come back are the review's inline comments. Steer → command → content, end to end.
//
//   node scripts/verify-review-read-steer.mjs
//
// The defect it exists for (2026-07-31, nubjs/nub#587): a review app files a review whose `body` is
// EMPTY and whose substance is N inline comments. The wake's permalink lands on the review anchor, so
// the obvious read — `gh api …/pulls/N/reviews/ID` — hands back `body: ""`. A woken worker spent FOUR
// calls getting to the content: the body, the body again in full, a `…/pulls/N/comments` sweep filtered
// by `pull_request_review_id` that silently hit the 100-item default page, and finally the same sweep
// with `--paginate`. It never reached `…/pulls/N/reviews/ID/comments`, which answers it in ONE call.
//
// Requires `gh auth status` to be green. Exits nonzero on any failed assertion.

import { execGh } from "./lib/gh-command.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "../packages/server/src/storage.ts"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createGithubReviewFetcher } from "../packages/server/src/github-review.ts"

const PR = process.env.PR_REF ?? "nubjs/nub#587"

let failures = 0
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const live = createGithubReviewFetcher()

// Replay the PR's own history by hiding what had not happened yet — every tick is still a live
// round-trip returning real ids, real authors and real permalinks.
const asOf = (instant) => async (ref) => {
  const result = await live(ref)
  if (result.status !== "ok") return result
  const cutoff = Date.parse(instant)
  return { status: "ok", activity: result.activity.filter((a) => Date.parse(a.at ?? "") <= cutoff) }
}

async function run(label, { fenceAt, ticks }) {
  const home = mkdtempSync(join(tmpdir(), "frizz-review-read-"))
  try {
    const storage = createStorage(join(home, "ui.db"))
    const resumes = []
    const logs = []
    storage.upsertSession({
      slug: label, session_id: `sid-${label}`, thread_name: `frizz-${label}`, spawned_at: fenceAt,
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
      title: label, state: "open", meta: null, seen_at: null, transcript_id: null,
    })
    const fence = { kind: "awaiting", body: `pr-watch: ${PR}\nWatching for review.`, hints: [{ kind: "pr-watch", value: PR }] }
    let fetcher = ticks[0]
    const scheduler = createScheduler({
      storage,
      tailer: {
        get: () => ({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence, lastActivityAt: fenceAt }),
        foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
      },
      resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
      fetchGithubReview: (ref) => fetcher(ref),
      log: (m) => logs.push(m),
      pollMs: 0,
    })
    for (const phase of ticks) {
      fetcher = phase
      await scheduler.tick()
      await scheduler.tick()
    }
    await scheduler.stop()
    const failed = logs.find((l) => l.includes("review check failed"))
    check("the real GitHub poll succeeded", !failed, failed ?? "no failure logged")
    return resumes
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// The window the production fetcher reads (`reviews(last: 50)`) slides as the PR grows, so the fixture
// is chosen FROM LIVE DATA rather than pinned to an instant that will age out of it. Pick the newest
// review the fetcher can currently see, and baseline just before it.
const [refRepo, refNumber] = PR.split("#")
const snapshot = await live({ owner: refRepo.split("/")[0], repo: refRepo.split("/")[1], number: Number(refNumber) })
if (snapshot.status !== "ok") {
  console.log(`FAIL  could not read ${PR} live: ${JSON.stringify(snapshot.failure ?? snapshot)}`)
  process.exit(1)
}
const reviews = snapshot.activity.filter((a) => a.kind === "review" && a.at && /#pullrequestreview-\d+$/.test(a.url ?? ""))
if (!reviews.length) {
  console.log(`FAIL  ${PR} exposes no review with a permalink in the fetcher's window — pick another PR via PR_REF`)
  process.exit(1)
}
const target = reviews.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)
const before = new Date(Date.parse(target.at) - 1000).toISOString()

console.log(`\nA REVIEW wake on ${PR} — @${target.actor} at ${target.at}`)
const resumes = await run("review-read", {
  fenceAt: new Date(Date.parse(target.at) - 3_600_000).toISOString(),
  ticks: [asOf(before), asOf(target.at)],
})
check("woke exactly once", resumes.length === 1, `${resumes.length} resume(s)`)
const msg = resumes[0]?.message ?? ""
console.log(`\n--- the steer a real worker now receives ---\n${msg}\n---\n`)

// ---- the steer names the one call ------------------------------------------------------------------
// Read the review id OUT OF the delivered steer rather than predicting which review the scheduler will
// choose. Predicting it made this harness fail against a perfectly correct steer: `target` is the
// newest review, the scheduler woke on a slightly older one, and the mismatch read exactly like a
// product bug. The invariant that actually matters is internal to the steer — the command must address
// the SAME review the permalink does — and that holds whichever item wakes the thread.
const head = msg.split("\n")[0]
const reviewId = /#pullrequestreview-(\d+)$/.exec(head)?.[1]
const [repo, number] = PR.split("#")
check("the wake's permalink is a review anchor and ends its own line", Boolean(reviewId), head.slice(-60))
const want = `gh api --paginate repos/${repo}/pulls/${number}/reviews/${reviewId}/comments`
check("the steer names the one-call read for the review it woke on", msg.includes(want), want)
check("the read is a separate paragraph, not glued to the sentence", /\n\nA review's body is often empty/.test(msg))

// ---- the command in the steer actually WORKS -------------------------------------------------------
// The whole point: a worker that pastes this line gets the content. Anything less is a steer that reads
// well and leaves the worker exactly where it started.
const cmd = msg.split("\n").find((l) => l.startsWith("gh api "))
check("a worker can lift the command straight off the steer", Boolean(cmd), cmd ?? "no gh line")
let comments = []
let ran = false
try {
  const out = execGh("Verify the review-read steer against a public PR", [...cmd.split(" ").slice(1)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  comments = JSON.parse(out)
  ran = true
} catch (error) {
  check("running the steer's command succeeds", false, String(error).slice(0, 300))
}
if (ran) {
  check("running the steer's command succeeds", true, `${comments.length} inline comment(s)`)
  check("it returns the review's inline comments, not an empty list", comments.length > 0)
  check("every comment belongs to THAT review", comments.every((c) => String(c.pull_request_review_id) === reviewId))
  const substance = comments.reduce((n, c) => n + (c.body?.length ?? 0), 0)
  check("the comments carry real substance", substance > 0, `${substance} chars across ${comments.length} comment(s)`)

  // ---- the CONTROL: the read the worker would otherwise have made ---------------------------------
  // Without this steer the obvious move is the review's own body. A green result above means nothing
  // without showing that read FAILING to reach the same content — the differential is the evidence.
  //
  // Note the claim is NOT "the body is empty": a review may carry both a body and inline comments (and
  // on this PR some do). The defect is narrower and always true — the body does not CONTAIN the inline
  // comments, so a worker that reads only the body never sees them and goes hunting.
  const body = execGh("Verify the review-read steer against a public PR", ["api", `repos/${repo}/pulls/${number}/reviews/${reviewId}`, "--jq", ".body"], { encoding: "utf8" }).trim()
  console.log(`\n  control — the obvious read (\`…/reviews/${reviewId}\` → .body) returned ${body.length} chars`)
  const missed = comments.filter((c) => {
    const first = (c.body ?? "").split("<!--")[0].trim().slice(0, 80)
    return first && !body.includes(first)
  })
  check(
    "CONTROL: the body-only read misses the inline substance the steer's command returns",
    missed.length === comments.length,
    `${missed.length}/${comments.length} inline comment(s) absent from the body (${body.length} body chars)`,
  )
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
