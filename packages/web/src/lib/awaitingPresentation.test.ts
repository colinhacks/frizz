import assert from "node:assert/strict"
import test from "node:test"
import { SetThreadSnoozeInput } from "@frizz/shared"
import {
  AWAITING_FALLBACK_TITLE,
  AWAITING_NO_PROSE,
  awaitingProseBlock,
  prWatchRefs,
  awaitingWaitClause,
  reasonSentence,
  awaitingProse,
  hintGloss,
} from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

// THE CARD'S COPY, for a fence that is now PURE STRUCTURE.
//
// What these replaced was a matrix: every hint kind had a park action ("Scheduled snooze", "Awaiting
// human"), a synthesized sentence ("Wait for Alice", "Scheduled for tomorrow at 9"), and a snooze target
// derived from whatever instant the worker had typed. All of it is gone with the kinds — a worker no
// longer describes its wait in prose frizz has to parse back, it NAMES things frizz can look up, and it
// writes exactly one line for a human. So there is nothing left to synthesize and nothing to get wrong.
//
// `awaitingParkAction` — the reader that turned a hint kind into a button — went with the last caller on
// 2026-09-04: it had returned null for every fence since 2026-08-15, and the awaiting card it fed was
// folded into the resting card (AwaitingBackgroundCard), whose park is the ordinary Snooze and has never
// depended on a fence. `awaitingPresentationLine` went the same day, for the same reason: ONE card reads
// the body now, through awaitingProseBlock, and it decides for itself what an empty one says.

test("prWatchRefs surfaces every watched PR as a link target, in fence order", () => {
  const refs = prWatchRefs([
    { kind: "pr", value: "acme/app#391" },
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "pr", value: "acme/app#12" },
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "2h" },
  ])
  assert.deepEqual(refs.map((r) => r.ref), ["acme/app#391", "acme/app#12"], "fence order, deduped")
  assert.ok(refs[0].url?.includes("acme/app"), "a parseable ref is a link")
  // A malformed ref still names what the worker meant, so the card shows it as plain text rather than
  // hiding it or offering a broken link — and the server refuses to park on it either way.
  const bogus = prWatchRefs([{ kind: "pr", value: "the auth PR" }])
  assert.deepEqual(bogus.map((r) => r.ref), ["the auth PR"])
  assert.equal(bogus[0].url, null)
})
// THE BODY NO LONGER JOINS THE SENTENCE, so the punctuation rule this pinned has nothing left to join.
// It existed because a fence carried BOTH free prose and a synthesized action line, and gluing them
// needed a separator that did not read as a typo. The structural grammar has one prose field: the body
// is only ever a line the parser did not recognise, and printing that at a human is the bug the tests
// above now cover.

// RAW FENCE SYNTAX MUST NEVER REACH THE READER (maintainer 2026-08-16, with a screenshot of a card
// reading "watch: bvg44v4ij / for: 40m / reason: CI on #1227 is running…" — "why the fuck is the
// awaiting block looking like this? We had a bunch of special rendering here, did we not?").
//
// A fence's frontmatter is structure and nothing else (the live keys are `shells:`/`agents:`/`timers:`/
// `prs:` plus `for:`, plural YAML since 2026-08-24), so anything left in `body` above the `---` is a line
// the parser did NOT recognise — a worker still writing the deleted `watch:`, or a typo. It is a
// malformed declaration, not prose: the worker is bumped for it (scheduler SOURCE 12), and the card
// shows what it can instead of showing the machinery.
test("an unrecognized fence line never becomes prose", () => {
  const REASON = "CI on acme/app#1227 is running the upgraded fixture."
  // The exact shape from the screenshot: a stale `watch:` fell into the body beside real prose. Until
  // 2026-08-24 the card dodged it by preferring the `reason:` hint; `reason:` is retired, so the body is
  // now the only source and the filter has to be explicit.
  assert.equal(awaitingProseBlock(`watch: bvg44v4ij\n${REASON}`), REASON)
  assert.doesNotMatch(awaitingProseBlock(`watch: bvg44v4ij\n${REASON}`) ?? "", /watch:/)
  // The retired SINGULAR keys and the live plural ones are both machinery, and neither may card.
  assert.equal(awaitingProseBlock("pr: acme/app#1\nreason: waiting on your merge"), null)
  assert.equal(awaitingProseBlock("prs: [acme/app#1]\nfor: 2h"), null)
  // …but a handoff that merely CONTAINS a colon is prose, and eating it would be the opposite bug.
  assert.equal(awaitingProseBlock("Note: the macOS leg is the flaky one."), "Note: the macOS leg is the flaky one.")
})

// …and a fence puts its handoff in the BODY — the fences written before the grammar had a `reason:` did,
// and so does every fence written since the `---` delimiter landed on 2026-08-17 and `reason:` was retired
// on 2026-08-24. A body that survives the filter is the card's whole opening stratum; one that does not
// leaves the card to say AWAITING_NO_PROSE, and only where it has no rows to say it with either.
test("a fence with no reason still shows its body rather than carding blank", () => {
  assert.equal(awaitingProseBlock("PR is open and CI is green."), "PR is open and CI is green.")
  assert.equal(awaitingProseBlock(""), null)
  assert.equal(awaitingProseBlock("   "), null)
  assert.equal(AWAITING_NO_PROSE, "Waiting for an external update.")
})

// THE RAIL'S WAIT CLAUSE. The sidebar row is a TITLE and nothing else (maintainer 2026-08-19), so what
// the fence names is only legible on hover — and it has to READ there. One verb over one conjoined
// list, generated from the hint KINDS, so the same fence always reads the same way and no runtime id
// ever reaches the human.
test("the fence becomes one clause: the PR it watches, then what it counts", () => {
  const hints = [
    { kind: "for" as const, value: "2h" },
    { kind: "agent" as const, value: "agent_7" },
    { kind: "pr" as const, value: "acme/app#391" },
    { kind: "shell" as const, value: "bvg44v4ij" },
    { kind: "shell" as const, value: "k92hs01x2" },
  ]
  assert.equal(awaitingWaitClause(hints), "waiting on acme/app#391, 2 background shells and a sub-agent")
  // The order the worker wrote them in must not change a word of it — the clause keys on KIND.
  assert.equal(awaitingWaitClause([...hints].reverse()), awaitingWaitClause(hints))
  // The clause is DERIVED from the items and nothing else — the worker's own prose never joins it, and
  // the popover puts the fence body on its own line where a human sentence cannot be mistaken for a
  // generated one. A third assertion used to guard that against a `reason` hint riding in the same
  // array; the kind was retired on 2026-08-24 and cannot be constructed, so the exact-string assertion
  // above is now the whole of it.
})

test("a runtime id never reaches the popover — it is counted, not listed", () => {
  assert.equal(awaitingWaitClause([{ kind: "shell", value: "bvg44v4ij" }]), "waiting on a background shell")
  assert.equal(awaitingWaitClause([{ kind: "timer", value: "tmr_a1b2c3" }]), "waiting on a timer")
  assert.equal(
    awaitingWaitClause([
      { kind: "timer", value: "tmr_a1" },
      { kind: "timer", value: "tmr_b2" },
      { kind: "agent", value: "agent_7" },
    ]),
    "waiting on a sub-agent and 2 timers",
  )
  // Two PRs read as two refs, because each one is a THING the human may want to go look at.
  assert.equal(
    awaitingWaitClause([{ kind: "pr", value: "acme/app#391" }, { kind: "pr", value: "acme/app#392" }]),
    "waiting on acme/app#391 and acme/app#392",
  )
})

test("a fence naming nothing yields nothing, so the popover cannot invent a wait", () => {
  assert.equal(awaitingWaitClause([{ kind: "for", value: "2h" }]), null, "a duration describes a wait; it is not one")
  assert.equal(awaitingWaitClause([{ kind: "shell", value: "  " }]), null, "a blank value names nothing")
})

// The MOBILE row keeps one inline caption, because a phone has no hover to move it to.
test("hintGloss is the phone's one line, and it is the PR ref", () => {
  assert.equal(hintGloss([{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "2h" }]), "PR acme/app#391")
  assert.equal(hintGloss([{ kind: "shell", value: "bvg44v4ij" }]), null)
})

// THE WORKER'S REASON, SET AS A SENTENCE. It stands alone everywhere frizz draws it — its own paragraph
// under the rail popover's sentence, its own line on the card — and it arrives lowercase because the
// shipped contract's example was a fragment (maintainer 2026-08-19: "why is that second sentence
// fucking lowercase?"). The contract now models a sentence; this carries every worker dispatched before
// it, whose prompt is frozen.
test("a lowercase reason is presented as a sentence, and only its first letter is touched", () => {
  assert.equal(
    reasonSentence("the tap submission is queued behind their CI backlog"),
    "The tap submission is queued behind their CI backlog",
  )
  assert.equal(reasonSentence("Already a sentence"), "Already a sentence", "nothing to do")
  // Only the first letter — the rest of the line is the worker's, verbatim, capitals and all.
  assert.equal(reasonSentence("waiting on CI for the v2 drivers"), "Waiting on CI for the v2 drivers")
})

test("a reason that opens on CODE is left exactly as written", () => {
  const cases = [
    "awaitingFragments still returns the old shape", // an identifier: a capital would be a WRONG NAME
    "packages/web has not rebuilt yet", // a path
    "v2.1 is still tagging", // a ref
    "#391 is waiting on a second approval", // an issue number
    "npm test is still running", // lowercase by name, not by accident
    "gh pr checks reports one job queued",
  ]
  for (const reason of cases) assert.equal(reasonSentence(reason), reason, reason)
})

// WHAT THE POPOVER READS, and why it is not `reason:` — a key since retired outright (2026-08-24), when
// the frontmatter became YAML and could no longer hold prose. An awaiting fence is FRONTMATTER, THEN
// MARKDOWN (2026-08-17): structural keys, a `---`, and below it as much prose as the worker wants —
// optional prose, since what frizz requires is a live item and a `for:`. Reading only `reason:` dropped the
// handoff of every fence written that way, which is exactly what the rail popover did (maintainer
// 2026-08-19: "the actual block content … was all below the triple hyphen, sort of like a front matter
// with Markdown beneath it").
const HINTS = [{ kind: "shell" as const, value: "bzvtnt3ig" }, { kind: "for" as const, value: "2h" }]

test("the popover reads the fence's BODY — the prose below the delimiter", () => {
  const body = "The tap submission is queued behind their CI backlog."
  assert.equal(awaitingProse({ body }), body)
})

test("the prose is OPTIONAL — a fence with neither says nothing rather than inventing a wait", () => {
  assert.equal(awaitingProse({ body: "" }), null)
  assert.equal(awaitingProse({}), null, "and an absent body is not a crash")
  assert.equal(awaitingProse({ body: "   \n\n  " }), null, "whitespace is not prose")
})

test("only the FIRST paragraph reaches a hover label, flattened onto one line", () => {
  const body = [
    "Waiting on the three-platform run",
    "before porting the v2 drivers.",
    "",
    "- the macOS leg is the one that has been flaky",
    "- if it goes red I will bisect rather than re-run",
  ].join("\n")
  assert.equal(awaitingProse({ body }), "Waiting on the three-platform run before porting the v2 drivers.")
})

test("a long lede is cut on a word boundary, not mid-word", () => {
  const body = `The release job ${"keeps timing out on the arm64 leg and ".repeat(6)}so I am waiting`
  const out = awaitingProse({ body }) ?? ""
  assert.ok(out.length <= 241, `capped, got ${out.length}`)
  assert.match(out, /…$/, "and says so")
  assert.doesNotMatch(out, /\s…$/, "no dangling space before the ellipsis")
  assert.ok(body.startsWith(out.slice(0, -1)), "the kept text is the worker's own, unaltered")
})

// The unified resting card's prose slot (2026-08-24): the fence body, machinery-stripped, or NULL —
// because that card's heading and rows already state the wait, so an empty handoff wants no
// placeholder sentence and no divider drawn above one.
test("awaitingProseBlock: prose survives, machinery strips, emptiness is null", () => {
  assert.equal(awaitingProseBlock("Waiting on the release run.\n\n- the macOS leg is flaky"), "Waiting on the release run.\n\n- the macOS leg is flaky")
  assert.equal(awaitingProseBlock("watch: bzvtnt3ig\nfor: 40m"), null, "raw fence syntax never reaches the reader")
  assert.equal(awaitingProseBlock("shells: [b1]\nNote: the suite is slow"), "Note: the suite is slow", "a prose line with a colon is not a key")
  assert.equal(awaitingProseBlock(""), null)
  assert.equal(awaitingProseBlock(undefined), null)
})
