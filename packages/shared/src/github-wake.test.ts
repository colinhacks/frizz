import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COMMAND_WATCH_FALLBACK,
  commandWatchCancelledWakeMessage,
  commandWatchExpiredWakeMessage,
  commandWatchPassedWakeMessage,
  formatGithubWakeSteer,
  interruptEndedSubAgentsMessage,
  parseCommandWatchWake,
  parseInterruptEndedWake,
  isGithubWakeBacklog,
  parseGithubWakeSteer,
  parseLimitResumeWake,
  parseLimitModelSwitchWake,
  parseParkWake,
  parseMergedWake,
  parseOwnWatchExpiredWake,
  parsePrWatchExpiredWake,
  parsePrWatchGoneWake,
  parseQuestionsCancelledWake,
  parseRecurringPrompt,
  restPromptMessage,
  stripWakeTimeHeader,
  parsePrWatchStateWake,
  parsePrWatchWake,
  parseShellDoneWake,
  parseTimerWake,
  limitResumeSteer,
  limitModelSwitchSteer,
  parkExpiredWakeMessage,
  parkFinishedWakeMessage,
  mergedWakeMessage,
  ownWatchExpiredWakeMessage,
  prWatchExpiredWakeMessage,
  prWatchGoneWakeMessage,
  questionsCancelledWakeMessage,
  wakeTimeHeader,
  prWatchWakeMessage,
  shellDoneMessage,
  timerPromptMessage,
  splitWakeDeliveries,
  stripWakeDeliveryToken,
  stripWakeTrailer,
  wakeDeliveryToken,
  PR_WATCH_ARMED_TRAILER,
  PR_WATCH_SPENT_TRAILER,
  ISSUE_WATCH_ARMED_TRAILER,
  ISSUE_WATCH_SPENT_TRAILER,
  issueWatchWakeMessage,
  splitAwaitingFrontmatter,
  SHELL_DONE_TRAILER,
  type GithubWakeSteer,
} from "./index.ts"

const single: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [{ label: "comment", actor: "colinhacks", bot: false, at: "2026-07-29T15:39:28Z", url: "https://github.com/nubjs/nub/pull/587#issuecomment-5120099362" }],
}

const burst: GithubWakeSteer = {
  ref: "nubjs/nub#587",
  omitted: 0,
  items: [
    { label: "comment", actor: "colinhacks", bot: false, at: "2026-07-29T15:39:28Z", url: "https://github.com/nubjs/nub/pull/587#issuecomment-5120099362" },
    { label: "review comment", actor: "pullfrog", bot: true, at: "2026-07-29T15:46:04Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810252801" },
    { label: "approval", actor: "dana", bot: false, at: "2026-07-29T15:47:52Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810267375" },
  ],
}

// THE contract this pair exists for: whatever the scheduler composes, the chat can rebuild. A wording
// tweak on the formatter that the parser doesn't know about silently downgrades every card in the chat
// to a plain text blob, and nothing else in either package would fail.
test("github wake steer round-trips through its own parser", () => {
  for (const [name, steer] of [
    ["single", single],
    ["burst", burst],
    ["capped burst", { ...burst, omitted: 7 }],
    ["single, no timestamp or url", { ref: "acme/app#1", omitted: 0, items: [{ label: "approval", actor: "dana", bot: false }] }],
    ["bot-only burst", { ref: "acme/app#1", omitted: 0, items: [
      { label: "comment", actor: "coderabbitai[bot]", bot: true, at: "2026-07-29T10:00:00Z" },
      { label: "review", actor: "pullfrog", bot: true, at: "2026-07-29T10:01:00Z" },
    ] }],
    ["a login with punctuation", { ref: "acme/app.js#12", omitted: 0, items: [
      { label: "comment", actor: "a-b_c[bot]", bot: true, at: "2026-07-29T10:00:00Z", url: "https://github.com/acme/app.js/pull/12#issuecomment-1" },
      { label: "change request", actor: "erin", bot: false },
    ] }],
  ] as [string, GithubWakeSteer][]) {
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(steer)), steer, name)
  }
})

// The card is a projection of the delivered text, which always arrives with the machine-facing token
// appended — so the two must compose in that order without the token defeating the parse.
//
// The token used to make the parse FAIL, and that was asserted as the contract. It is not one worth
// keeping: the only thing a refusal buys is that a missed strip degrades to the raw-text card WITH
// `<!-- frizz-wake:… -->` showing, which is the very bug the strip exists to prevent. A parser that
// reads the steer either way is strictly better, and it falls out of dropping unrecognized lines.
test("a delivered wake parses with or without its delivery token", () => {
  const delivered = `${formatGithubWakeSteer(burst)}\n\n${wakeDeliveryToken("a".repeat(64))}`
  assert.deepEqual(parseGithubWakeSteer(delivered), burst, "a machine-facing tail must not cost the card")
  assert.deepEqual(parseGithubWakeSteer(stripWakeDeliveryToken(delivered)), burst)
})

// THE regression this file exists to prevent, stated directly: on 2026-07-31 the steer gained a
// review-read tail, the shipped parsers had never seen those two lines, and every already-open tab
// rendered the raw-text fallback card instead of the divider. Nothing reloads those tabs — `boot.ts`
// adopts a new server boot id in place on purpose — so the parser has to tolerate a line the build it
// runs in has never heard of. This asserts that for lines NO build has heard of.
test("a steer that grew lines this parser has never seen still renders its card", () => {
  for (const tail of [
    "\n\nSome future paragraph a later build appends to speak to the worker.",
    "\n\ngh gist create --public # a command shape this build does not know",
    "\n\nA lead-in:\nline one\nline two\n\nand a trailing note",
  ]) {
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(single) + tail), single, tail)
    assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(burst) + tail), burst, tail)
  }
})

test("the single-item steer names the item and ends on its bare URL", () => {
  const text = formatGithubWakeSteer(single)
  assert.equal(
    text,
    "👤 New GitHub comment on nubjs/nub#587 from @colinhacks at 2026-07-29T15:39:28Z. Read that exact comment — ignore older activity you have already handled — and continue: https://github.com/nubjs/nub/pull/587#issuecomment-5120099362",
  )
  assert.ok(!/[.,;]$/.test(text), "a trailing period would be swallowed into the href by a terminal autolinker")
})

// Each line carries its own icon because a login is not a reliable tell — @pullfrog is a GitHub App
// with no `[bot]` suffix, and deriving `bot` from the login alone would render it as a person.
test("every burst line carries its own actor icon, and a suffix-less app still reads as a bot", () => {
  const lines = formatGithubWakeSteer(burst).split("\n").filter((l) => l.startsWith("- "))
  assert.deepEqual(lines.map((l) => l.slice(2, 4)), ["👤", "🤖", "👤"])
  assert.equal(parseGithubWakeSteer(formatGithubWakeSteer(burst))?.items[1].bot, true)
})

test("the header count is authoritative — a truncated or padded burst is refused, not guessed", () => {
  const text = formatGithubWakeSteer(burst)
  assert.ok(parseGithubWakeSteer(text))
  // Drop the last ITEM line, not the last line: the steer now ends on a review-read tail the parser
  // discards, so slicing the raw end would only remove a line that never carried an item.
  const lines = text.split("\n")
  const lastItem = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("- ")).at(-1)![1]
  assert.equal(
    parseGithubWakeSteer(lines.filter((_, i) => i !== lastItem).join("\n")),
    null,
    "a dropped line must not parse as a smaller burst",
  )
  assert.equal(parseGithubWakeSteer(text.replace("3 new GitHub items", "4 new GitHub items")), null)
})

// The defect this tail exists for: a review app files an empty-bodied review whose substance is inline
// comments, and the permalink's obvious read returns that empty body. A woken worker spent four calls
// finding the endpoint that answers it in one (2026-07-31, nubjs/nub#587).
test("a review wake names the one call that reads its inline comments", () => {
  const review: GithubWakeSteer = {
    ref: "nubjs/nub#587",
    omitted: 0,
    items: [{ label: "review comment", actor: "pullfrog", bot: true, at: "2026-07-31T20:33:58Z", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4831999377" }],
  }
  const text = formatGithubWakeSteer(review)
  assert.match(text, /^gh api --paginate repos\/nubjs\/nub\/pulls\/587\/reviews\/4831999377\/comments$/m)
  // The permalink still ends its own line — the tail is a separate paragraph, so no autolinker can
  // swallow the command into the href.
  assert.ok(text.split("\n")[0].endsWith("#pullrequestreview-4831999377"))
  assert.deepEqual(parseGithubWakeSteer(text), review, "the tail is derived, so it must not survive the parse")
})

test("the read tail is per-review, deduped, and absent when nothing woke a review", () => {
  const cmds = (s: GithubWakeSteer) => formatGithubWakeSteer(s).split("\n").filter((l) => l.startsWith("gh api "))
  // `burst` holds one issue comment and TWO distinct reviews.
  assert.deepEqual(cmds(burst), [
    "gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810252801/comments",
    "gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810267375/comments",
  ])
  assert.deepEqual(cmds(single), [], "a plain issue comment carries its substance in its own body")
  const twice = { ...burst, items: [burst.items[1], { ...burst.items[1], label: "approval", actor: "dana", bot: false }] }
  assert.deepEqual(cmds({ ...twice, omitted: 1 }), ["gh api --paginate repos/nubjs/nub/pulls/587/reviews/4810252801/comments"], "one review, one command")
})

// The tail lines must never be mistaken for the card's own content, in either direction.
test("the read tail neither adds items nor lets prose masquerade as one", () => {
  const text = formatGithubWakeSteer(burst)
  assert.equal(parseGithubWakeSteer(text)?.items.length, 3, "three items, not five")
  assert.equal(
    parseGithubWakeSteer("A review's body is often empty because its substance is inline comments. Read them, one call each:\ngh api --paginate repos/a/b/pulls/1/reviews/2/comments"),
    null,
    "the tail alone is not a wake",
  )
})

test("ordinary prose never masquerades as a wake card", () => {
  for (const text of [
    "plain follow-up",
    "",
    "👤 New GitHub comment on nubjs/nub#587 from @colinhacks. Read it and continue.", // the PRE-FIX steer
    "3 new GitHub items on nubjs/nub#587",
    "- comment from @someone",
    "👤 2 new GitHub items on nubjs/nub#587. Read exactly these — ignore older activity you have already handled — and continue:\n\n- 👤 comment from @a\nnot an item line",
  ]) {
    assert.equal(parseGithubWakeSteer(text), null, JSON.stringify(text))
  }
})

// The runtime merges deliveries that land while the worker is mid-turn into ONE user record. Every
// anchored projection in this file then reads the LAST delivery only, and the ones above it — token,
// trailer and all — are stranded mid-text where nothing can see them. Splitting first is what restores
// each one's own presentation; the boundary is the token alone on its line, which is exactly how the
// runtime joins them and is never how prose quotes one.
test("a coalesced record splits into its deliveries, and a quoted token is not a boundary", () => {
  const a = "KEEP GOING.\n\n(Recurring prompt — sent each time you come to rest. …)"
  const b = `<frizz-relay:b7xm5f1db> Background command "trace" completed (exit code 0).`
  const ta = wakeDeliveryToken("a".repeat(64))
  const tb = wakeDeliveryToken("b".repeat(64))
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}\n${b}\n\n${tb}`), [`${a}\n\n${ta}`, `${b}\n\n${tb}`])
  // A trailing segment the runtime appended with no token of its own (a human follow-up merged onto a
  // wake) is still its own message — it must not ride along inside the wake's card.
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}\nand one more thing`), [`${a}\n\n${ta}`, "and one more thing"])
  // One delivery, or none, is the overwhelming case and must come back untouched.
  assert.deepEqual(splitWakeDeliveries(`${a}\n\n${ta}`), [`${a}\n\n${ta}`])
  assert.deepEqual(splitWakeDeliveries("just a follow-up"), ["just a follow-up"])
  // …and the human asking about a token mid-sentence keeps one bubble, as stripWakeDeliveryToken does.
  const quoting = `Why is ${ta} showing up in the bubble?`
  assert.deepEqual(splitWakeDeliveries(quoting), [quoting])
})

// The display strip is the BACKSTOP the split leans on. The split has to model how the RUNTIME joins
// coalesced deliveries, which is not frizz's format to pin — so if a joiner change ever defeats it, a
// token must still never reach the human's eyes. On its own line it is plumbing wherever it sits; only
// a token quoted mid-sentence is the human's own words.
test("a token on its own line is stripped from anywhere, quoted prose is not", () => {
  const t = wakeDeliveryToken("a".repeat(64))
  assert.equal(stripWakeDeliveryToken(`steer\n\n${t}`), "steer")
  assert.equal(stripWakeDeliveryToken(`steer\n\n${t}\nand a stranded tail`), "steer\n\nand a stranded tail")
  assert.equal(stripWakeDeliveryToken(`${t}\nplumbing led this one`), "plumbing led this one")
  const quoting = `Why is ${t} showing up in the bubble?`
  assert.equal(stripWakeDeliveryToken(quoting), quoting)
  assert.equal(stripWakeDeliveryToken("ordinary text\n"), "ordinary text\n", "no token, no rewrite")
})

// ---- isGithubWakeBacklog ----
//
// The chat has to tell a FIRST-PARK REPLAY apart from news, because they read as opposite things and
// only one of them is an event (maintainer 2026-08-13: "That already is preexisting on the PR, which I
// find quite weird"). The flag rides the delivered TEXT rather than the steer, which is what keeps the
// formatter's round-trip above intact — so this is the test that the two stay in step.
test("a backlog replay is recognizable from its delivered text, and ordinary news is not", () => {
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(burst, { backlog: true })), true)
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(single, { backlog: true })), true)
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(burst)), false, "an ordinary burst is news")
  assert.equal(isGithubWakeBacklog(formatGithubWakeSteer(single)), false)
  assert.equal(isGithubWakeBacklog(undefined), false)
  // A legacy transcript written before the tail existed reads as not-a-backlog, which is what it was.
  assert.equal(isGithubWakeBacklog("🤖 New GitHub comment on acme/app#1 from @dana."), false)
})

// Marking it must not cost the round trip — the whole reason `backlog` is an argument and not a field.
test("the backlog tail leaves the steer parseable, unchanged", () => {
  assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(burst, { backlog: true })), burst)
  assert.deepEqual(parseGithubWakeSteer(formatGithubWakeSteer(single, { backlog: true })), single)
})

// ---- parsePrWatchWake ----
//
// Same contract as the steer's round trip, for the OTHER half of what a watcher says. These lines fell
// through to the raw-text card for want of a parser, so the same watcher spoke in two voices down one
// transcript; the pair below is what keeps them in one voice from now on.
test("a pr-watch status line round-trips through its own parser", () => {
  for (const [name, input, want] of [
    ["merged", { target: "nubjs/nub#760", merged: true }, { ref: "nubjs/nub#760", kind: "merged" }],
    ["closed", { target: "nubjs/nub#760", closed: true }, { ref: "nubjs/nub#760", kind: "closed" }],
    ["ci green", { target: "acme/app#12", checks: { verdict: "passing", passed: 3, failed: 0, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 3, failing: [] }],
    ["ci green, one check", { target: "acme/app#12", checks: { verdict: "passing", passed: 1, failed: 0, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 1, failing: [] }],
    ["ci red", { target: "acme/app.js#12", checks: { verdict: "failing", passed: 1, failed: 2, failing: ["build", "test (macos)"] } },
      { ref: "acme/app.js#12", kind: "ci", verdict: "failing", failing: ["build", "test (macos)"] }],
    ["ci red, no named jobs", { target: "acme/app#12", checks: { verdict: "failing", passed: 0, failed: 1, failing: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "failing", failing: [] }],
    // The skip clause is written only when there ARE skips, so a green line with none is byte-identical
    // to every one already sitting in a transcript and must still parse without a `skipped` field.
    ["ci green, skips counted apart", { target: "acme/app#12", checks: { verdict: "passing", passed: 3, failed: 0, failing: [], skipped: 12 } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 3, skipped: 12, failing: [] }],
    ["ci green, no skips — the pre-2026-09-04 wording, unchanged", { target: "acme/app#12", checks: { verdict: "passing", passed: 3, failed: 0, failing: [], skipped: 0 } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", passed: 3, failing: [] }],
    // The commit since 2026-11-06, at the seven characters GitHub prints.
    ["ci green, on a commit", { target: "acme/app#12", checks: { verdict: "passing", passed: 3, failed: 0, failing: [], skipped: 2, head: "abc1234def5678" } },
      { ref: "acme/app#12", kind: "ci", verdict: "passing", commit: "abc1234", passed: 3, skipped: 2, failing: [] }],
    ["ci red, on a commit", { target: "acme/app#12", checks: { verdict: "failing", passed: 1, failed: 2, failing: ["build"], head: "abc1234def5678" } },
      { ref: "acme/app#12", kind: "ci", verdict: "failing", commit: "abc1234", failing: ["build"] }],
    ["ci red, on a commit, no named jobs", { target: "acme/app#12", checks: { verdict: "failing", passed: 0, failed: 1, failing: [], head: "abc1234def5678" } },
      { ref: "acme/app#12", kind: "ci", verdict: "failing", commit: "abc1234", failing: [] }],
    ["ci gated, a head beside it stays unprinted", { target: "acme/app#12", checks: { verdict: "gated", passed: 0, failed: 0, failing: [], gated: 1, gating: [], head: "abc1234def5678" } },
      { ref: "acme/app#12", kind: "ci", verdict: "gated", gated: 1, gating: [] }],
    ["ci gated", { target: "nodejs/node#65795", checks: { verdict: "gated", passed: 3, failed: 0, failing: [], gated: 8, gating: ["Test Linux", "Test macOS"] } },
      { ref: "nodejs/node#65795", kind: "ci", verdict: "gated", gated: 8, gating: ["Test Linux", "Test macOS"] }],
    ["ci gated, one workflow and no names", { target: "acme/app#12", checks: { verdict: "gated", passed: 0, failed: 0, failing: [], gated: 1, gating: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "gated", gated: 1, gating: [] }],
  ] as [string, Parameters<typeof prWatchWakeMessage>[0], unknown][]) {
    assert.deepEqual(parsePrWatchWake(prWatchWakeMessage(input)), want, name)
  }
})

test("a verdict line names its commit in the words the agent compares against what it pushed", () => {
  const red = prWatchWakeMessage({ target: "acme/app#393", checks: { verdict: "failing", passed: 0, failed: 1, failing: ["lint"], head: "abc1234def5678" } })
  assert.match(red, /^❌ CI FAILED on acme\/app#393 at abc1234: lint\.$/m)
  const green = prWatchWakeMessage({ target: "acme/app#393", checks: { verdict: "passing", passed: 29, failed: 0, failing: [], head: "abc1234def5678" } })
  assert.match(green, /^✅ CI PASSED on acme\/app#393 at abc1234 — 29 checks green\.$/m)
  // A line already in a transcript, and one from a report held across the upgrade, read as they always did.
  assert.deepEqual(parsePrWatchWake("❌ CI FAILED on acme/app#393: lint."), { ref: "acme/app#393", kind: "ci", verdict: "failing", failing: ["lint"] })
  assert.deepEqual(parsePrWatchWake("✅ CI PASSED on acme/app#393 — 29 checks green."), { ref: "acme/app#393", kind: "ci", verdict: "passing", passed: 29, failing: [] })
})

// A delivery routinely carries BOTH parts — one poll saw CI flip and a comment land — and the chat draws
// a divider per part. Each parser must therefore find its own line and ignore the other's, whichever
// order they arrive in, and neither may be defeated by the machine-facing tail below them.
test("a wake carrying CI and review activity yields both parts", () => {
  const text = prWatchWakeMessage({
    target: "nubjs/nub#587",
    checks: { verdict: "failing", passed: 1, failed: 1, failing: ["build"] },
    review: formatGithubWakeSteer(single),
  })
  assert.deepEqual(parsePrWatchWake(text), { ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["build"] })
  assert.deepEqual(parseGithubWakeSteer(text.slice(text.indexOf(formatGithubWakeSteer(single)))), single)
  // The STEER PARSER READS LINE 0 AND NOTHING ELSE, so a status line above one means the server serves
  // no `wakeSteer` for this delivery. That is not an accident to be tidied up later — FrizzWake
  // relies on it: it is what keeps an already-open tab on an older bundle rendering the whole text
  // rather than drawing the review hairline alone and silently dropping the CI verdict beside it.
  assert.equal(parseGithubWakeSteer(text), null, "a status line above the steer must defeat the served parse")
  assert.deepEqual(parsePrWatchWake(`${text}\n\n${wakeDeliveryToken("a".repeat(64))}`), {
    ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["build"],
  }, "a machine-facing tail must not cost the divider")
})

test("red beside workflows held for approval never says every check has finished", () => {
  const text = prWatchWakeMessage({
    target: "nubjs/nub#587",
    checks: { verdict: "failing", passed: 0, failed: 1, failing: ["cla"], running: 0, gated: 2, gating: ["ci", "e2e"] },
  })
  assert.doesNotMatch(text, /Every check has finished/)
  assert.match(text, /Nothing else is running, but 2 workflows are held for a maintainer's approval and have not run: ci, e2e\./)
  assert.deepEqual(parsePrWatchWake(text), { ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["cla"] })
  const one = prWatchWakeMessage({ target: "nubjs/nub#587", checks: { verdict: "failing", passed: 0, failed: 1, failing: ["cla"], running: 0, gated: 1 } })
  assert.match(one, /1 workflow is held for a maintainer's approval and has not run\./)
})

test("a red wake's running count costs neither the CI part nor the steer beside it", () => {
  for (const running of [2, 0]) {
    const text = prWatchWakeMessage({
      target: "nubjs/nub#587",
      checks: { verdict: "failing", passed: 1, failed: 1, failing: ["build"], running },
      review: formatGithubWakeSteer(single),
    })
    assert.match(text, running ? /2 checks still running/ : /Every check has finished\./)
    assert.deepEqual(parsePrWatchWake(text), { ref: "nubjs/nub#587", kind: "ci", verdict: "failing", failing: ["build"] })
    const rest = text.split("\n").filter((line) => !parsePrWatchWake(line)).join("\n")
    assert.deepEqual(parseGithubWakeSteer(rest), single, "the steer still leads what is left once the CI line comes off")
  }
})

// The trailer, the review steer and ordinary agent prose are all NOT status lines. A false positive here
// puts a divider on a message that never said a PR finished, which is worse than the card it replaces.
test("text with no pr-watch status line parses as none", () => {
  assert.equal(parsePrWatchWake(formatGithubWakeSteer(burst)), null)
  assert.equal(parsePrWatchWake("(This watcher is spent — there is nothing further to report on a finished PR.)"), null)
  assert.equal(parsePrWatchWake("⏰ Your background shell finished: `bzvtnt3ig` — the churn suite."), null)
  assert.equal(parsePrWatchWake("⏰ nub#760 was CLOSED."), null, "a bare number is not an owner/repo#N")
  assert.equal(parsePrWatchWake("⏰ nubjs/nub#760 was ABANDONED."), null)
})

// ---- parseShellDoneWake ----
//
// The third producer/parser pair, for the same reason as the other two. This one guards a distinction
// the transcript should never have been drawing: the same shell finishing drew a hairline when the
// worker was awake (the runtime reported it) and a card when it was resting (frizz reported it).
test("a shell-done wake round-trips through its own parser", () => {
  for (const [name, shell, want] of [
    ["completed, with a task id", { taskId: "bzvtnt3ig", label: "the churn suite", status: "completed" },
      { taskId: "bzvtnt3ig", label: "the churn suite", outcome: "finished" }],
    ["failed", { taskId: "bzvtnt3ig", label: "the churn suite", status: "failed" },
      { taskId: "bzvtnt3ig", label: "the churn suite", outcome: "failed" }],
    ["killed", { taskId: "b52kqwc13", label: "vite --port 5199", status: "killed" },
      { taskId: "b52kqwc13", label: "vite --port 5199", outcome: "stopped" }],
    // No id is the shape a legacy delivery wears, and the label is then the whole subject.
    ["no task id", { label: "Running the focused tests", status: "completed" },
      { label: "Running the focused tests", outcome: "finished" }],
    // A label ending in its own period must not eat the sentence's — the greedy tail is what buys this.
    ["a label that ends in a period", { taskId: "a1", label: "nub --test packages/shared/src/index.ts", status: "completed" },
      { taskId: "a1", label: "nub --test packages/shared/src/index.ts", outcome: "finished" }],
  ] as [string, Parameters<typeof shellDoneMessage>[0], unknown][]) {
    assert.deepEqual(parseShellDoneWake(shellDoneMessage(shell)), want, name)
  }
})

// The other wakes are NOT shell completions, and neither is the agent quoting one back at itself. A
// false positive here draws a terminal hairline over a message that never reported a shell.
test("text that is not a shell-done wake parses as none", () => {
  assert.equal(parseShellDoneWake(prWatchWakeMessage({ target: "nubjs/nub#760", merged: true })), null)
  assert.equal(parseShellDoneWake(formatGithubWakeSteer(single)), null)
  assert.equal(parseShellDoneWake("⏰ Your background shell EXPLODED: `a1` — the churn suite."), null)
  assert.equal(
    parseShellDoneWake("Which shell was it?\n\n⏰ Your background shell finished: `a1` — the churn suite."),
    null,
    "only the first line may claim the divider",
  )
})

// ---- parseCommandWatchWake / parseInterruptEndedWake ----
//
// Both arrived in the chat as the raw-prose card until 2026-10-14, printing their closing instructions
// to the worker — "Carry on with whatever you were waiting on it for", "register it again with
// `frizzctl watch-command add`", "re-dispatch it or take its work over" — at the operator. The parse is
// what the divider draws from, so what it returns must keep the news and drop exactly those.
test("a command watch's three wakes round-trip, keeping the command and the news and none of the worker's instructions", () => {
  const command = "test -f /tmp/released && echo ```done```"
  const passed = parseCommandWatchWake(commandWatchPassedWakeMessage({ id: "cmw_3d480448ae89", command, output: "0.13.12\n", runs: 44, armedMs: 7_680_000 }))
  assert.deepEqual(passed, { kind: "passed", id: "cmw_3d480448ae89", command, summary: "Exited 0 on check 44, 2h 8m after it was armed. Its output ended:", output: "0.13.12" })
  assert.deepEqual(parseCommandWatchWake(commandWatchPassedWakeMessage({ id: "cmw_a1", command, output: "", runs: 1, armedMs: 60_000 })),
    { kind: "passed", id: "cmw_a1", command, summary: "Exited 0 on check 1, 1m after it was armed. It printed nothing." })

  const expired = parseCommandWatchWake(commandWatchExpiredWakeMessage({ id: "cmw_a1", command, lastRun: { outcome: "exit", exitCode: 1, output: "npm error 404\n```" } }))
  assert.deepEqual(expired, { kind: "expired", id: "cmw_a1", command, summary: "Its last check exited 1, ending:", output: "npm error 404\n```" })
  assert.deepEqual(parseCommandWatchWake(commandWatchExpiredWakeMessage({ id: "cmw_a1", command })), { kind: "expired", id: "cmw_a1", command, summary: "It never completed a check." })

  // The reason is the server gate's refusal, which carries the same fallback instruction as the trailer.
  const cancelled = parseCommandWatchWake(commandWatchCancelledWakeMessage({ id: "cmw_a1", command, reason: `this thread runs in \`default\` permission mode. ${COMMAND_WATCH_FALLBACK}` }))
  assert.deepEqual(cancelled, { kind: "cancelled", id: "cmw_a1", command, summary: "Frizz stopped it: this thread runs in default permission mode." })

  for (const wake of [passed, expired, cancelled]) assert.doesNotMatch(`${wake!.summary} ${wake!.output ?? ""}`, /frizzctl|Carry on|background shell|wake you/, wake!.kind)
  assert.equal(parseCommandWatchWake(shellDoneMessage({ taskId: "b1", label: "build", status: "completed" })), null)
})

test("the interrupt note round-trips to the sub-agents it names, without the instructions around them", () => {
  const agents = [{ taskId: "abc9b9b5f0da4c677", label: "Audit the auth flow — both halves" }, { label: "Survey the readouts" }]
  assert.deepEqual(parseInterruptEndedWake(interruptEndedSubAgentsMessage(agents)), { agents })
  assert.equal(parseInterruptEndedWake("- `a1` — not a note"), null)
})

// ---- parseTimerWake ----
//
// The one wake in the family that keeps a BODY, so this pair guards something the others do not: the
// worker's prose must come back out whole. A fired one-off's registration is gone the moment it
// delivers, which makes this rendering the only one that text ever gets.
test("a fired timer round-trips through its own parser, body and instant intact", () => {
  const at = "2026-08-19T02:00:00Z"
  for (const [name, prompt] of [
    ["one line", "Re-check the promoted artifact."],
    ["several paragraphs", "Re-check the promoted artifact.\n\nIf the release job is still red, bisect rather than re-run."],
    // The trailer is matched at the END, so prose that merely LOOKS like one must not truncate the body.
    ["prose containing a lookalike trailer", "It said (One-off timer, set for X. It has fired and will not repeat.) — check that."],
  ] as [string, string][]) {
    assert.deepEqual(parseTimerWake(timerPromptMessage(prompt, at)), { prompt, at }, name)
  }
})

test("text that is not a fired timer parses as none", () => {
  assert.equal(parseTimerWake(formatGithubWakeSteer(single)), null)
  assert.equal(parseTimerWake(prWatchWakeMessage({ target: "nubjs/nub#760", merged: true })), null)
  // A trailer with NOTHING above it is not a delivery — the worker's own text is the whole message here.
  assert.equal(parseTimerWake("(One-off timer, set for 2026-08-19T02:00:00Z. It has fired and will not repeat.)"), null)
  // A REPEATING bump wears its own trailer and collapses through parseRecurringPrompt, never this.
  assert.equal(parseTimerWake("Keep going.\n\n(Goal — sent every 15 minutes. Reply ALLDONE to stop.)"), null)
})

// ---- parseLimitResumeWake ----
//
// This formatter moved out of the scheduler to sit beside its parser: the chat rebuilds the hairline from
// the delivered text alone, so the pair has to live in the one package both sides can reach. The round
// trip is what makes that move safe to have made.
test("a usage-limit resume round-trips through its own parser", () => {
  for (const window of ["weekly", "session", "model", "unknown"] as const) {
    assert.deepEqual(parseLimitResumeWake(limitResumeSteer(window)), { window }, window)
  }
})

test("text that is not a usage-limit resume parses as none", () => {
  assert.equal(parseLimitResumeWake(formatGithubWakeSteer(single)), null)
  assert.equal(parseLimitResumeWake("⏳ The weekly usage limit that interrupted you has reset."), null)
  assert.equal(parseLimitResumeWake("⏳ The context window that interrupted you has reset. Continue exactly where you left off."), null)
})

// ---- parseLimitModelSwitchWake ----
//
// The MODEL-SCOPED cap's other answer, and the reason it needs a wake of its own: nothing has reset.
// The cap is still standing and the thread is running on a different model, so the resume steer above
// would tell the worker — and the hairline the human reads — something that is simply not true.
test("a model switch round-trips, naming both models", () => {
  assert.deepEqual(parseLimitModelSwitchWake(limitModelSwitchSteer("Fable 5", "Opus")), { capped: "Fable 5", to: "Opus" })
})

test("the two limit wakes never read as each other", () => {
  assert.equal(parseLimitResumeWake(limitModelSwitchSteer("Fable 5", "Opus")), null)
  assert.equal(parseLimitModelSwitchWake(limitResumeSteer("model")), null)
})

// ---- parseParkWake / parsePrWatchExpiredWake ----
//
// The three formatters that stayed in the SERVER package until 2026-08-24 and so had no parser the chat
// could reach. Every one fell through FrizzWake's legacy fallback and printed its whole agent-facing
// body as a bordered "Frizz" card in the human's transcript — which tool to call, which fence to write
// (maintainer: "frizz cards that seem to be exposing internals"). Measured across every transcript on
// the machine: 73 of 12 891 delivered wakes drew that card, and every live one was one of these.
//
// Round-tripped against the REAL formatter, never a hand-written string, for the same reason every test
// above is: a parser pinned to a copy of the wording cannot notice the wording moving.

const parkStatus = ["- `shell: bkjf8exat` — still running", "- `pr: nubjs/nub#777` — CI running"]

test("parseParkWake: an expired park round-trips, and its item list is the disclosure", () => {
  const wake = parseParkWake(parkExpiredWakeMessage(parkStatus))
  assert.deepEqual(wake, { kind: "expired", items: parkStatus })
})

test("parseParkWake: a finished park round-trips in both its singular and plural wordings", () => {
  assert.equal(parseParkWake(parkFinishedWakeMessage(["- `agent: azf10ktb2` — finished"], false))?.kind, "finished")
  assert.equal(parseParkWake(parkFinishedWakeMessage(parkStatus, true))?.kind, "finished")
})

test("parseParkWake: a park with nothing to list still parses — the divider just draws no disclosure", () => {
  assert.deepEqual(parseParkWake(parkExpiredWakeMessage([])), { kind: "expired", items: [] })
})

// THE CLOCK RIDES EVERY ONE OF THESE. scheduler SOURCE 12 appends `wakeTimeHeader` to its own messages,
// so the parser has to survive a trailer it never wrote — the same shape that would have broken it in
// production while every unit test passed.
test("parseParkWake: the appended wake-time header does not break the match", () => {
  const delivered = `${parkExpiredWakeMessage(parkStatus)}\n\n⏱ 2026-08-24 09:50 — you last spoke 1h30m ago.`
  assert.equal(parseParkWake(delivered)?.kind, "expired")
})

test("parseParkWake: prose that merely QUOTES a park head is not a park wake", () => {
  assert.equal(parseParkWake("Why does ⏰ Your wait expired, nothing resolved. keep showing up?"), null)
  assert.equal(parseParkWake("all clear"), null)
})

test("parsePrWatchExpiredWake: the lapsed watcher's ref is the whole of what a reader can act on", () => {
  assert.deepEqual(parsePrWatchExpiredWake(prWatchExpiredWakeMessage("nubjs/nub#777")), { ref: "nubjs/nub#777" })
  assert.equal(parsePrWatchExpiredWake(prWatchWakeMessage({ target: "nubjs/nub#777", merged: true })), null)
  assert.equal(parsePrWatchExpiredWake("I watched nubjs/nub#777 expire"), null)
})

// ---- THE FALLBACK IS FOR LEGACY TEXT, NOT FOR ANYTHING FRIZZ WRITES TODAY -------------------------
//
// `FrizzWake` ends in a branch that prints an unrecognized wake VERBATIM in a bordered card, and that
// branch is correct: a transcript written by an older frizz, or by a newer one, must never lose its
// text. What is NOT correct is a formatter shipping into it — every one of them is frizz instructing
// the WORKER about its own registrations, and the human reading the transcript has none of them.
//
// It happened three times, silently, because a formatter and its parser could live in different
// packages: the park bumps and the lapsed-watcher notice sat in `scheduler.ts` where the chat could not
// reach them, and printed "THE ONLY LINE KINDS NOW SUPPORTED" into a human's transcript for five days.
//
// THIS TABLE IS THE CONTRACT. A new frizz-composed wake adds a row here and a parser beside its
// formatter, or this fails — which is the point. It is the machine-checked half of the `frizz-wake`
// fixture's claim to hold "every wake frizz delivers".
const RECOGNIZERS = [
  parseShellDoneWake, parseTimerWake, parseLimitResumeWake, parseLimitModelSwitchWake, parsePrWatchWake, parseGithubWakeSteer,
  parseParkWake, parsePrWatchExpiredWake, parsePrWatchGoneWake, parseOwnWatchExpiredWake, parsePrWatchStateWake, parseQuestionsCancelledWake,
] as const

const COMPOSED: [string, string][] = [
  ["shell finished", shellDoneMessage({ taskId: "b1", label: "the churn suite", status: "completed" })],
  ["shell failed", shellDoneMessage({ label: "vite --port 5199", status: "failed" })],
  ["timer fired", timerPromptMessage("Re-check the promoted artifact.", "2026-08-24T09:50:00.000Z")],
  ["limit reset", limitResumeSteer("weekly")],
  ["limit model switch", limitModelSwitchSteer("Fable 5", "Opus")],
  ["pr merged", prWatchWakeMessage({ target: "nubjs/nub#777", merged: true })],
  ["pr checks", prWatchWakeMessage({ target: "nubjs/nub#777", checks: { verdict: "failing", passed: 1, failed: 1, failing: ["typecheck"] } })],
  ["pr checks green with skips", prWatchWakeMessage({ target: "nubjs/nub#777", checks: { verdict: "passing", passed: 3, failed: 0, failing: [], skipped: 12 } })],
  ["pr checks gated", prWatchWakeMessage({ target: "nubjs/nub#777", checks: { verdict: "gated", passed: 0, failed: 0, failing: [], gated: 8, gating: ["Test Linux"] } })],
  ["review activity", formatGithubWakeSteer(single)],
  ["pr state moved", prWatchWakeMessage({ target: "nubjs/nub#777", changes: ["now CONFLICTS with the base branch"] })],
  ["park expired", parkExpiredWakeMessage(parkStatus)],
  ["park expired, nothing listed", parkExpiredWakeMessage([])],
  ["park finished", parkFinishedWakeMessage(parkStatus, true)],
  ["watcher lapsed", prWatchExpiredWakeMessage("nubjs/nub#777")],
  ["pr watcher gone", prWatchGoneWakeMessage("nubjs/nub#777", "pull", 30)],
  ["issue watcher gone", prWatchGoneWakeMessage("nubjs/nub#12", "issue", 30)],
  ["own shell watch lapsed", ownWatchExpiredWakeMessage("shell", "bzvtnt3ig")],
  ["own sub-agent watch lapsed", ownWatchExpiredWakeMessage("agent", "a01b2d20b32feab11")],
  ["questions cancelled", questionsCancelledWakeMessage(2)],
]

test("every wake frizz composes is recognized by a parser — none may reach the verbatim fallback", () => {
  for (const [name, text] of COMPOSED) {
    assert.ok(RECOGNIZERS.some((parse) => parse(text)), `${name} falls through to the verbatim card`)
  }
})

// ---- …AND THAT HOLDS WHEN THEY ARE SENT TOGETHER (2026-10-11) -------------------------------------
//
// The table above was satisfied for five weeks while the commonest pair in it drew the verbatim card.
// The scheduler merges everything waiting for a thread into ONE message, and its composer lived in the
// server package, so the envelope was a shape with no row here and no parser anywhere: a park ending
// beside the shell whose exit ended it printed both agent-facing bodies in a bordered "Frizz" card.
// The envelope's contract is that it cuts back into exactly the wakes that went in.
const NOW = Date.parse("2026-10-11T16:52:00Z")
const stamped = (text: string) => `${text}\n\n${wakeTimeHeader(NOW - 60_000, "2026-10-11T16:40:00Z")}`

test("a merged delivery cuts back into the wakes it carries, and each is still recognized", () => {
  for (const [nameA, a] of COMPOSED) {
    for (const [nameB, b] of COMPOSED) {
      if (a === b) continue
      const merged = mergedWakeMessage([{ reason: nameA, message: stamped(a) }, { reason: nameB, message: stamped(b) }], NOW, "2026-10-11T16:49:00Z")
      const parts = parseMergedWake(merged)
      assert.deepEqual(parts, [{ body: a, count: 1 }, { body: b, count: 1 }], `${nameA} + ${nameB}`)
      for (const part of parts!) {
        assert.ok(RECOGNIZERS.some((parse) => parse(stripWakeTrailer(part.body))), `${nameA} + ${nameB}: a part falls through to the verbatim card`)
      }
      // The token the outbox appends and the clock at the foot are the two riders the server's display
      // projection takes off. The split reads the same with them on, which is what the fold hands it.
      assert.deepEqual(parseMergedWake(`${merged}\n\n${wakeDeliveryToken("a".repeat(64))}`), parts)
    }
  }
})

test("identical events fold into one part that says how many it stands for", () => {
  const ci = prWatchWakeMessage({ target: "nubjs/nub#777", checks: { verdict: "failing", passed: 1, failed: 1, failing: ["typecheck"] } })
  const shell = shellDoneMessage({ taskId: "b1", label: "the churn suite", status: "completed" })
  const merged = mergedWakeMessage([
    { reason: "pr-watch nubjs/nub#777 CI failing", message: stamped(ci) },
    { reason: "background shell finished (b1)", message: stamped(shell) },
    { reason: "pr-watch nubjs/nub#777 CI failing", message: stamped(ci) },
  ], NOW)
  assert.match(merged, /^Frizz held 3 wakes /)
  assert.deepEqual(parseMergedWake(merged), [{ body: ci, count: 2 }, { body: shell, count: 1 }])
})

// Byte for byte the delivery in the maintainer's screenshot, token and all — the releaser thread,
// 2026-10-11 09:52. The park wake carries the "NOTHING running" paragraph the scheduler appends to it.
test("the delivery that was reported cuts into its park and its shell", () => {
  const record = "Frizz held 2 wakes for this thread and is delivering them together, oldest first. Each is under its own heading; read all of them before acting on any.\n\n### 1. awaiting park named 1 dead item(s)\n\n✅ The work you parked on has FINISHED, so the park is over and your thread is back in the queue.\n\n- `shells: [br6vpp762]` — FINISHED — its result is waiting for you\n\nREAD ITS OUTPUT AND CARRY ON. This is not a broken fence and there is nothing to fix: the wait\nyou declared simply ended. Do NOT relaunch the same work — its result is already on disk.\n\nThen park on whatever comes next, or end in ```done or a registered question (`mcp__frizz__ask`) if nothing is left.\n\nYou have NOTHING running right now — no shell, no sub-agent, no timer, no registered\npull request. There is nothing that could wake you, so this thread is not awaiting: finish in\n```done, or register a question with `mcp__frizz__ask`.\n\n### 2. background shell finished (br6vpp762)\n\n⏰ Your background shell finished: `br6vpp762` — Running the update harness against the built shell and server.\n\n(Frizz sends this because it finished after you came to rest, where your runtime's own completion notification does not reach you. Read its output if you still need it.)\n\n⏱ 2026-10-11 09:52 — you last spoke 3m ago.\n\n<!-- frizz-wake:5d7e952abebe8b7153215553d6bc077258f6d28e3ca6e825cf93cbe8d97c3234 -->"
  const parts = parseMergedWake(record)
  assert.equal(parts?.length, 2)
  assert.deepEqual(parseParkWake(parts![0].body), { kind: "finished", items: ["- `shells: [br6vpp762]` — FINISHED — its result is waiting for you"] })
  assert.deepEqual(parseShellDoneWake(parts![1].body), { taskId: "br6vpp762", label: "Running the update harness against the built shell and server", outcome: "finished" })
})

// THE SPLIT IS ASKED FIRST, and this is why. A Goal prompt is recognized by a trailer at the END of the
// text, and a merged delivery whose last wake is that prompt ends in the same trailer — so the Goal's
// parser reads the WHOLE delivery as one recurring prompt. Routed ahead of the split, the chat drew one
// "Goal · at rest" line and every wake held beside it was never shown.
test("a merged delivery that ends in the Goal's prompt still reads as one to the Goal's own parser", () => {
  const shell = shellDoneMessage({ taskId: "b1", label: "the churn suite", status: "completed" })
  const goal = restPromptMessage("KEEP GOING.")
  const merged = mergedWakeMessage([{ reason: "background shell finished (b1)", message: shell }, { reason: "recurring prompt at rest", message: goal }], NOW)
  const display = stripWakeTimeHeader(merged)
  assert.ok(parseRecurringPrompt(display), "the trap: asked first, this answer swallows the shell")
  assert.deepEqual(parseMergedWake(display)?.map((part) => part.body), [shell, goal])
  assert.ok(parseRecurringPrompt(parseMergedWake(display)![1].body), "and the Goal is still a Goal once it is cut out")
})

test("only the envelope frizz composes is a merged delivery", () => {
  const shell = shellDoneMessage({ taskId: "b1", label: "the churn suite", status: "completed" })
  assert.equal(parseMergedWake(shell), null, "a lone wake")
  assert.equal(parseMergedWake("all clear"), null)
  const merged = mergedWakeMessage([{ reason: "a", message: shell }, { reason: "b", message: limitResumeSteer("weekly") }], NOW)
  assert.equal(parseMergedWake(`Why did this show up?\n\n${merged}`), null, "prose that quotes one is the human's own words")
  assert.equal(parseMergedWake(merged.replace("### 1. a", "Something else first.\n\n### 1. a")), null, "the first heading follows the lead")
})

// A Goal prompt or a timer's text is arbitrary prose and may carry numbered headings of its own, and
// nothing in the envelope says which `### 2.` is the scheduler's. A cut inside that prose would hand the
// chat a wake that ends mid-thought and a second one that starts there, with the heading line between
// them gone — so an envelope holding ANY numbered heading that is not a boundary in sequence is refused
// whole, and the fallback card is what guarantees the text.
test("a body with numbered headings of its own is refused, never cut", () => {
  const prose = timerPromptMessage("Work through these.\n\n### 1. Rebuild\n\nthe artifact\n\n### 2. Re-run\n\nthe suite\n\n### 3. Report\n\nback", "2026-08-24T09:50:00.000Z")
  const shell = shellDoneMessage({ taskId: "b1", label: "the churn suite", status: "completed" })
  const timer = { reason: "one-off timer elapsed", message: prose }
  const done = { reason: "background shell finished (b1)", message: shell }
  // LAST in the frame: its "### 3." would be a third section of a delivery that holds two.
  assert.equal(parseMergedWake(mergedWakeMessage([done, timer], NOW)), null)
  // FIRST in the frame: its "### 2." sits ahead of the real one, and would add up — two sections, two
  // wakes — which is why the count alone is not the check.
  assert.equal(parseMergedWake(mergedWakeMessage([timer, done], NOW)), null)
  // Headings that are not numbered section headings are just prose, and cut nothing.
  const plain = timerPromptMessage("### Notes\n\n1. rebuild\n2. re-run", "2026-08-24T09:50:00.000Z")
  assert.deepEqual(parseMergedWake(mergedWakeMessage([{ reason: "one-off timer elapsed", message: plain }, done], NOW))?.map((p) => p.body), [plain, shell])
})

// …and the fallback still has to WORK, or the guard above would be satisfied by deleting it.
test("a shape no parser knows still reaches the fallback, so its text survives", () => {
  const future = "⏰ Frizz has invented a wake shape this build predates.\n\nAnd whatever it says, the text must survive."
  assert.ok(RECOGNIZERS.every((parse) => !parse(future)))
})

// ---- THE PR'S OWN STATE (2026-09-04) --------------------------------------------------------------
//
// The watcher saw reviews, comments and the check rollup, and nothing else — so a PR that developed a
// merge conflict, gained a `blocked` label or had a reviewer requested said nothing at all until
// something else happened to it. `mergeable` was even computed on every poll and then never read as a
// trigger. These pin the line that carries all three.
test("a pr-state line round-trips, and one poll's clauses stay one line", () => {
  for (const [name, changes, detail] of [
    ["a conflict appearing", ["now CONFLICTS with the base branch"], "now CONFLICTS with the base branch"],
    ["labels both ways", ["labels +blocked, −needs-ci"], "labels +blocked, −needs-ci"],
    ["a reviewer requested", ["review requested from richardlau"], "review requested from richardlau"],
    ["all of it at once", ["now CONFLICTS with the base branch", "labels +blocked", "review requested from richardlau, nodejs/crypto-reviewers"],
      "now CONFLICTS with the base branch; labels +blocked; review requested from richardlau, nodejs/crypto-reviewers"],
  ] as [string, string[], string][]) {
    const text = prWatchWakeMessage({ target: "nodejs/node#65796", changes })
    assert.deepEqual(parsePrWatchStateWake(text), { ref: "nodejs/node#65796", detail }, name)
    // Every clause is on ONE line: a label edit must not be given the weight of a headline.
    assert.equal(text.split("\n").filter((l) => l.startsWith("🔔")).length, 1, name)
  }
})

// The three parts coexist down one delivery, and the chat draws a hairline per part — so each parser
// must find its own line and ignore the other two, in whatever combination a poll produced.
test("a wake carrying CI, PR state and review activity yields all three parts", () => {
  const text = prWatchWakeMessage({
    target: "nodejs/node#65796",
    checks: { verdict: "failing", passed: 30, failed: 1, failing: ["x86_64-darwin: with shared libraries / build"] },
    changes: ["labels +commit-queue-failed"],
    review: formatGithubWakeSteer(single),
  })
  assert.deepEqual(parsePrWatchWake(text), {
    ref: "nodejs/node#65796", kind: "ci", verdict: "failing",
    failing: ["x86_64-darwin: with shared libraries / build"],
  })
  assert.deepEqual(parsePrWatchStateWake(text), { ref: "nodejs/node#65796", detail: "labels +commit-queue-failed" })
  assert.deepEqual(parseGithubWakeSteer(text.slice(text.indexOf(formatGithubWakeSteer(single)))), single)
})

// A PR LEAVING THE MERGE QUEUE rides the state line, so every tab — including one built before this —
// draws it as the same hairline; the instructions under it are for the worker, and no parser reads them.
test("a merge-queue exit is a state line, with what to do under it only when the PR is stuck", () => {
  const clause = "REMOVED from the merge queue (failed checks: integration (shard 1))"
  const stuck = prWatchWakeMessage({ target: "acme/app#512", changes: [clause], offMergePath: "queue-failed" })
  assert.deepEqual(parsePrWatchStateWake(stuck), { ref: "acme/app#512", detail: clause })
  assert.equal(parsePrWatchWake(stuck), null, "not a CI verdict, whatever its clause says about checks")
  assert.match(stuck, /`gh pr merge 512 --repo acme\/app --auto`/)
  assert.match(stuck, /gh-readonly-queue/, "a queue exit says where its failures ran")
  // A queue exit with no failed checks — a conflict, a removal by hand — has no failures to explain.
  const conflict = prWatchWakeMessage({ target: "acme/app#512", changes: ["REMOVED from the merge queue (merge conflict)"], offMergePath: "dequeued" })
  assert.match(conflict, /It did NOT merge, and nothing will merge it now\. Find out why it left/)
  assert.match(conflict, /`gh pr merge 512 --repo acme\/app --auto` re-queues it/)
  assert.doesNotMatch(conflict, /gh-readonly-queue|those failures/)
  // Auto-merge going off has no merge group, so the sentence about one would be false there.
  const autoOff = prWatchWakeMessage({ target: "acme/app#512", changes: ["auto-merge turned OFF by @bob (manually disabled)"], offMergePath: "auto-merge-off" })
  assert.match(autoOff, /It did NOT merge, and nothing will merge it now\. Find out why auto-merge went off/)
  assert.match(autoOff, /`gh pr merge 512 --repo acme\/app --auto`/)
  assert.doesNotMatch(autoOff, /merge queue|gh-readonly-queue|those failures/)
  const requeued = prWatchWakeMessage({ target: "acme/app#512", changes: [`${clause}, and is back in the queue`] })
  assert.doesNotMatch(requeued, /gh pr merge/)
})

test("prose that merely mentions a PR is not a state wake", () => {
  for (const not of [
    "🔔 something happened.",
    "Reading nodejs/node#65796: the labels moved.",
    formatGithubWakeSteer(single),
  ]) {
    assert.equal(parsePrWatchStateWake(not), null, not.slice(0, 40))
  }
})

// ---- THE AGENT-FACING TRAILER NEVER REACHES THE OPERATOR (2026-09-04) -----------------------------
//
// The dividers drop the trailer by never rendering it — but that only holds for a delivery some parser
// RECOGNIZED, and the browser is the half that routinely cannot. A tab is a build behind whenever frizz
// restarts under it, so the first delivery in a shape its bundle predates falls through to the verbatim
// card and prints "(Registered PR watcher — STILL ARMED … drop it with `mcp__frizz__watch_pr`)" at the
// operator. That is exactly what happened to a conflict wake an hour after the state line shipped
// (maintainer 2026-09-04: "why am I still seeing shit like this? This should just never show up").
//
// So the trailer comes off in the DISPLAY PROJECTION, on the side that composed it and can never be a
// build behind itself — which makes the leak impossible for a tab of any age, and for wake shapes not
// written yet. These pin that, and pin that stripping it costs no parser its anchor.
test("every trailer frizz appends comes off the display projection", () => {
  for (const [name, text, trailer] of [
    ["still armed", prWatchWakeMessage({ target: "nubjs/nub#879", changes: ["now CONFLICTS with the base branch"] }), PR_WATCH_ARMED_TRAILER],
    ["watcher spent", prWatchWakeMessage({ target: "nubjs/nub#879", merged: true }), PR_WATCH_SPENT_TRAILER],
    ["shell done", shellDoneMessage({ taskId: "bzvtnt3ig", label: "the churn suite", status: "completed" }), SHELL_DONE_TRAILER],
  ] as [string, string, string][]) {
    assert.ok(text.includes(trailer), `${name}: the producer no longer writes the constant it is pinned by`)
    const shown = stripWakeTrailer(text)
    assert.ok(!shown.includes(trailer), `${name}: the trailer survived the projection`)
    assert.doesNotMatch(shown, /frizzctl|mcp__frizz__/, `${name}: a raw command name reached the operator`)
    assert.ok(shown.trim().length > 0, `${name}: the projection ate the news with the boilerplate`)
  }
})

// The strip runs BEFORE the chat parses, so a parser that lost its anchor would trade the boilerplate
// for a lost divider — the same defect wearing the other face.
test("stripping the trailer leaves every parser's anchor intact", () => {
  const state = prWatchWakeMessage({ target: "nodejs/node#65796", changes: ["labels +blocked"] })
  assert.deepEqual(parsePrWatchStateWake(stripWakeTrailer(state)), { ref: "nodejs/node#65796", detail: "labels +blocked" })
  const ci = prWatchWakeMessage({ target: "nodejs/node#65796", checks: { verdict: "passing", passed: 3, failed: 0, failing: [] } })
  assert.deepEqual(parsePrWatchWake(stripWakeTrailer(ci)), { ref: "nodejs/node#65796", kind: "ci", verdict: "passing", passed: 3, failing: [] })
  const merged = prWatchWakeMessage({ target: "nodejs/node#65796", merged: true })
  assert.deepEqual(parsePrWatchWake(stripWakeTrailer(merged)), { ref: "nodejs/node#65796", kind: "merged" })
  const shell = shellDoneMessage({ label: "vite --port 5199", status: "failed" })
  assert.deepEqual(parseShellDoneWake(stripWakeTrailer(shell)), { label: "vite --port 5199", outcome: "failed" })
  const review = prWatchWakeMessage({ target: "nubjs/nub#587", review: formatGithubWakeSteer(single) })
  assert.deepEqual(parseGithubWakeSteer(stripWakeTrailer(review)), single)
})

// THE TIMER'S TRAILER IS THE ONE THAT STAYS. `parseTimerWake` matches ON it — a fired one-off is the
// worker's own arbitrary prose, and that parenthetical is the only anchor saying which timer this was —
// so a strip here would cost the divider the trailer exists to draw.
test("the timer's trailer is left alone, because its parser is what drops it", () => {
  const fired = timerPromptMessage("Re-check the promoted artifact.", "2026-08-24T09:50:00.000Z")
  assert.equal(stripWakeTrailer(fired), fired)
  assert.equal(parseTimerWake(fired)?.prompt, "Re-check the promoted artifact.")
})

test("prose that merely quotes a trailer keeps it, and a trailer mid-message is not a trailer", () => {
  const quoted = `A worker asking about its own wake: ${PR_WATCH_ARMED_TRAILER} — what does that mean?`
  assert.equal(stripWakeTrailer(quoted), quoted)
  assert.equal(stripWakeTrailer("nothing frizz composed"), "nothing frizz composed")
  // Nothing composes a body-less trailer, but an empty bubble is a worse failure than the boilerplate.
  assert.equal(stripWakeTrailer(PR_WATCH_ARMED_TRAILER), PR_WATCH_ARMED_TRAILER)
})

// THE TRAILERS NAMED AN MCP TOOL UNTIL 2026-10-11, and every watcher wake delivered before that date
// ends with those bytes. The strip matches exact strings, so rewording the constants would have put the
// old boilerplate back on the operator's screen for every wake already in a transcript.
test("a watcher wake written before the command line still loses its trailer", () => {
  const armedPr = "(Registered PR watcher — STILL ARMED. It reports again on the next CI change, review, comment, label, conflict or review request. Drop it with `mcp__frizz__watch_pr` when it stops mattering.)"
  const armedIssue = "(Registered issue watcher — STILL ARMED. It reports again on the next comment, label or assignee change, and once more when the issue closes. Drop it with `mcp__frizz__watch_issue` when it stops mattering.)"
  assert.notEqual(armedPr, PR_WATCH_ARMED_TRAILER, "the trailer a worker gets today names the command")
  assert.match(PR_WATCH_ARMED_TRAILER, /Drop it with `frizzctl watch-pr drop <id>`/)
  assert.match(ISSUE_WATCH_ARMED_TRAILER, /Drop it with `frizzctl watch-issue drop <id>`/)
  for (const [now, then] of [[PR_WATCH_ARMED_TRAILER, armedPr], [ISSUE_WATCH_ARMED_TRAILER, armedIssue]]) {
    const wake = prWatchWakeMessage({ target: "nubjs/nub#879", changes: ["labels +blocked"] }).replace(PR_WATCH_ARMED_TRAILER, now)
    const old = wake.replace(now, then)
    assert.ok(old.endsWith(then))
    assert.equal(stripWakeTrailer(old), stripWakeTrailer(wake), "the old trailer comes off exactly as the new one does")
    assert.doesNotMatch(stripWakeTrailer(old), /STILL ARMED|mcp__frizz__/)
  }
})

// ---- ISSUE WATCHER WAKES (2026-09-14) -----------------------------------------------------------------
// The lines keep the PR shapes on purpose, so a tab built before issues existed still draws the divider.
test("issueWatchWakeMessage: the close line parses as a closed PR-watch wake, with the reason on its own line", () => {
  const text = issueWatchWakeMessage({ target: "acme/app#7", closed: { reason: "not planned" } })
  assert.deepEqual(parsePrWatchWake(text), { ref: "acme/app#7", kind: "closed" })
  assert.match(text, /^GitHub's reason: not planned\.$/m)
  assert.ok(text.endsWith(ISSUE_WATCH_SPENT_TRAILER))
  assert.equal(stripWakeTrailer(text).includes("watcher is spent"), false, "the issue trailers strip like the PR ones")
})

test("issueWatchWakeMessage: state changes and a comment steer share one delivery under the issue trailer", () => {
  const steer = formatGithubWakeSteer({ ref: "acme/app#7", items: [{ label: "comment", actor: "bob", bot: false }], omitted: 0 })
  const text = issueWatchWakeMessage({ target: "acme/app#7", changes: ["labels +confirmed", "assigned to @alice"], review: steer })
  assert.deepEqual(parsePrWatchStateWake(text), { ref: "acme/app#7", detail: "labels +confirmed; assigned to @alice" })
  assert.equal(parsePrWatchWake(text), null, "no CI line, ever")
  assert.ok(parseGithubWakeSteer(text.split("\n\n")[1]), "the steer is the second paragraph")
  assert.ok(text.endsWith(ISSUE_WATCH_ARMED_TRAILER))
  assert.doesNotMatch(stripWakeTrailer(text), /watch[-_]issue/)
})

test("parsePrWatchGoneWake: a watcher GitHub stopped resolving names its ref, for a PR and an issue alike", () => {
  assert.deepEqual(parsePrWatchGoneWake(prWatchGoneWakeMessage("nubjs/nub#777", "pull", 30)), { ref: "nubjs/nub#777" })
  assert.deepEqual(parsePrWatchGoneWake(prWatchGoneWakeMessage("acme/app#7", "issue", 30)), { ref: "acme/app#7" })
  assert.equal(parsePrWatchGoneWake(prWatchExpiredWakeMessage("nubjs/nub#777")), null, "an expiry is its own wake")
  assert.equal(parsePrWatchExpiredWake(prWatchGoneWakeMessage("nubjs/nub#777", "pull", 30)), null)
  assert.equal(parsePrWatchGoneWake("nubjs/nub#777 can no longer be read, it seems"), null)
})

test("prWatchExpiredWakeMessage: an issue's expiry parses through the same head and points at watch-issue", () => {
  const text = prWatchExpiredWakeMessage("acme/app#7", "issue")
  assert.deepEqual(parsePrWatchExpiredWake(text), { ref: "acme/app#7" })
  assert.match(text, /nothing on that issue will wake/)
  assert.match(text, /register it again with `frizzctl watch-issue add` and a fresh `--for`/)
  assert.match(prWatchExpiredWakeMessage("acme/app#7"), /register it again with `frizzctl watch-pr add` and a fresh `--for`/, "the default is still a PR")
})

test("splitAwaitingFrontmatter: `issues:` is a structural key producing `issue` hints", () => {
  const { hints, body } = splitAwaitingFrontmatter("issues: [acme/app#7, https://github.com/acme/app/issues/9]\nprs: [acme/app#391]\nfor: 90d\n---\nWaiting on the reporter.")
  assert.deepEqual(hints, [
    { kind: "issue", value: "acme/app#7" },
    { kind: "issue", value: "https://github.com/acme/app/issues/9" },
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "90d" },
  ])
  assert.equal(body, "Waiting on the reporter.")
})
