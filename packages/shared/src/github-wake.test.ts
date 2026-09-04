import { test } from "node:test"
import assert from "node:assert/strict"
import {
  formatGithubWakeSteer,
  isGithubWakeBacklog,
  parseGithubWakeSteer,
  parseLimitResumeWake,
  parseLimitModelSwitchWake,
  parseParkWake,
  parsePrWatchExpiredWake,
  parsePrWatchStateWake,
  parsePrWatchWake,
  parseShellDoneWake,
  parseTimerWake,
  limitResumeSteer,
  limitModelSwitchSteer,
  parkExpiredWakeMessage,
  parkFinishedWakeMessage,
  prWatchExpiredWakeMessage,
  prWatchWakeMessage,
  shellDoneMessage,
  timerPromptMessage,
  splitWakeDeliveries,
  stripWakeDeliveryToken,
  stripWakeTrailer,
  wakeDeliveryToken,
  PR_WATCH_ARMED_TRAILER,
  PR_WATCH_SPENT_TRAILER,
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
    ["ci gated", { target: "nodejs/node#65795", checks: { verdict: "gated", passed: 3, failed: 0, failing: [], gated: 8, gating: ["Test Linux", "Test macOS"] } },
      { ref: "nodejs/node#65795", kind: "ci", verdict: "gated", gated: 8, gating: ["Test Linux", "Test macOS"] }],
    ["ci gated, one workflow and no names", { target: "acme/app#12", checks: { verdict: "gated", passed: 0, failed: 0, failing: [], gated: 1, gating: [] } },
      { ref: "acme/app#12", kind: "ci", verdict: "gated", gated: 1, gating: [] }],
  ] as [string, Parameters<typeof prWatchWakeMessage>[0], unknown][]) {
    assert.deepEqual(parsePrWatchWake(prWatchWakeMessage(input)), want, name)
  }
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
  parseParkWake, parsePrWatchExpiredWake, parsePrWatchStateWake,
] as const

test("every wake frizz composes is recognized by a parser — none may reach the verbatim fallback", () => {
  const composed: [string, string][] = [
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
  ]
  for (const [name, text] of composed) {
    assert.ok(RECOGNIZERS.some((parse) => parse(text)), `${name} falls through to the verbatim card`)
  }
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
    assert.ok(!shown.includes("mcp__frizz__"), `${name}: a raw tool name reached the operator`)
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
