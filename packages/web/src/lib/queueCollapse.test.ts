import { test } from "node:test"
import assert from "node:assert/strict"
import { carriesDoneRegistration, collapseMiddleRuns, opensQueueSegment, queueCollapseSegments, segmentFolds, supersededAskIndices, survivesQueueCollapse } from "./queueCollapse.ts"

// The REAL Goal delivery frizz wrote into the maintainer's zod thread on 2026-08-12, verbatim — trailer,
// the `<!-- frizz-wake:… -->` token and all.
const GOAL_TEXT =
  "If further work towards the original task/goal remains, keep going. If there are open questions that require human input, ask them with question fences.\n\n" +
  "(Goal — sent each time you come to rest. To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished: it files this thread away, and nothing but new work from the human reopens it. Sign off either way — ```question if you need the human, ```done if it is truly finished: 1-3 sentences, then **bolded verb phrase** bullets.)\n\n" +
  "<!-- frizz-wake:c6f2d0f6ac80b70c94d4310334e92a8852245d9076df1cb2529a37251f7310b3 -->"
const GOAL_DISPLAY = GOAL_TEXT.replace(/\n*<!-- frizz-wake:[a-f0-9]+ -->$/, "")

const ask = (body: string) => "Here is where things stand.\n\n```question\n" + body + "\n```\n"

// ---- supersededAskIndices ----

test("a verbatim re-ask supersedes the older copy, and only the older copy", () => {
  const blocks = "Ship it?\n\n- A. Yes (recommended)\n- B. No"
  const messages = [
    { text: "Working on it." },
    { text: "The engineering is finished and green.\n\n" + ask(blocks) },
    { text: "Confirmed independently: every check now passes.\n\n" + ask(blocks) },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [1], "only the earlier of the two identical asks")
})

test("two DIFFERENT asks never supersede each other", () => {
  const messages = [
    { text: ask("Ship it?\n\n- A. Yes\n- B. No") },
    { text: ask("Delete the branch?\n\n- A. Yes\n- B. No") },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [])
})

test("supersession keys on the question BLOCKS, never the prose around them", () => {
  // The measured case: the two fences were byte-identical and ONLY the lead paragraph differed.
  const blocks = "Which handler shape?\n\n- A. Return a fragment (recommended)\n- B. Policy only"
  const messages = [
    { text: "Two things are genuinely yours to decide.\n\n" + ask(blocks) },
    { text: "Confirmed independently: the PR is fully green.\n\n" + ask(blocks) },
  ]
  assert.deepEqual([...supersededAskIndices(messages)], [0])
})

test("a message with no question fence is never superseded", () => {
  assert.deepEqual([...supersededAskIndices([{ text: "plain prose" }, { text: "plain prose" }])], [])
})

// ---- survivesQueueCollapse ----

test("an open ask survives the collapse; a superseded one does not", () => {
  const blocks = "Ship it?\n\n- A. Yes\n- B. No"
  const messages = [{ text: ask(blocks) }, { text: ask(blocks) }]
  const superseded = supersededAskIndices(messages)
  assert.equal(survivesQueueCollapse(messages[0], 0, superseded), false, "the older copy collapses")
  assert.equal(survivesQueueCollapse(messages[1], 1, superseded), true, "the newest copy carries the decision")
})

test("a SCHEDULER wake survives — nothing else on the card represents it", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "👤 Review from @colinhacks on acme/app#391", wake: true }, 3, none), true)
})

test("a provider failure survives — it is why the run stopped, and the card's tail stands down for it", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "", providerError: { message: "stream disconnected", at: "2026-10-09T10:00:00.000Z" } }, 3, none), true)
  assert.equal(survivesQueueCollapse({ text: "" }, 3, none), false)
})

// Its POSITION decides it instead — see the waker tests below. This predicate answers only "is it a wake
// DELIVERY", and a completion marker is not one.
test("a background-task/sub-agent COMPLETION is not a wake delivery", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "Sub-agent « Watching CI » finished", boundary: "wake" }, 4, none), false)
  assert.equal(survivesQueueCollapse({ text: "Background task «Running the full suite» finished", boundary: "wake" }, 5, none), false)
})

// It used to be the ONE wake the card refused to narrate, and that suppression is what left the
// maintainer's own thread showing resumed work with nothing above it to explain the resumption
// (2026-08-16). It is a wake like any other now: it opens a run and draws its own hairline.
test("the GOAL's own bump survives and cuts, exactly like every other wake", () => {
  const none = new Set<number>()
  const bump = { text: GOAL_TEXT, displayText: GOAL_DISPLAY, wake: true }
  assert.equal(survivesQueueCollapse(bump, 5, none), true)
  assert.equal(opensQueueSegment(bump), true)
})

test("a message with no wake flag opens nothing, whatever its text says", () => {
  assert.equal(opensQueueSegment({ text: GOAL_TEXT, displayText: GOAL_DISPLAY }), false)
  assert.equal(opensQueueSegment({ text: "", boundary: "wake" }), false, "a background-task completion is not a wake DELIVERY")
})

// THE BURIED HANDOFF. The pullfrog `if-you-were-going-to-migrate` thread (2026-09-02): the worker wrote
// its 2,329-char conclusion and called `mcp__frizz__done` in one breath — one projected message — then
// appended a 340-char pointer note. The note, being the run's last prose, anchored the fold's close, and
// the conclusion collapsed by default. The registration IS the sign-off, so the message carrying it is a
// resting message and survives.
test("the message carrying a successful done registration survives the collapse", () => {
  const none = new Set<number>()
  const m = { text: "It looks that way from the app-developer seat, but the field is bigger…", tools: [{ name: "mcp__frizz__done", status: "completed" }] }
  assert.equal(carriesDoneRegistration(m), true)
  assert.equal(survivesQueueCollapse(m, 2, none), true)
})

// The same registration as a worker writes it since 2026-10-11: a shell call. Every backend's shell
// call is projected as `Bash`; a long or multi-line one carries its raw text in `command`.
test("a successful `frizzctl done` is the same registration, however the command was composed", () => {
  const none = new Set<number>()
  const signedOff = (tool: { name: string; status: string; detail?: string; command?: string }) => carriesDoneRegistration({ text: "The write-up.", tools: [tool] })
  const heredoc = "frizzctl done --body-file - <<'EOF'\n- **Fixed the lookup** in `src/resolver.ts`.\nEOF"
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "frizzctl done --body-file - <<'EOF' …", command: heredoc }), true)
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "frizzctl done --body-file handoff.md" }), true)
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "nub run test && frizzctl done --body-file handoff.md" }), true)
  assert.equal(survivesQueueCollapse({ text: "The write-up.", tools: [{ name: "Bash", status: "completed", command: heredoc }] }, 2, none), true)
  // Exit 2 — the gate held — is a failed shell call, and a failed registration did not stand.
  assert.equal(signedOff({ name: "Bash", status: "failed", command: heredoc }), false)
  // Another command of the same program, the words inside something else's argument, and the same
  // text under a tool that is not a shell are none of them a sign-off.
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "frizzctl done-something" }), false)
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "frizzctl activity" }), false)
  assert.equal(signedOff({ name: "Bash", status: "completed", detail: "grep -rn 'frizzctl done' packages/" }), false)
  assert.equal(signedOff({ name: "Grep", status: "completed", detail: "frizzctl done" }), false)
})

test("a REFUSED done registration does not — the sign-off did not stand", () => {
  const none = new Set<number>()
  const m = { text: "The report is written. I sign off with the finding summary.", tools: [{ name: "mcp__frizz__done", status: "failed" }] }
  assert.equal(carriesDoneRegistration(m), false)
  assert.equal(survivesQueueCollapse(m, 2, none), false)
})

test("ask and watch registrations are not sign-offs here — neither ends the turn", () => {
  const none = new Set<number>()
  for (const name of ["mcp__frizz__ask", "mcp__frizz__watch", "mcp__frizz__watch_pr"]) {
    const m = { text: "Registering and continuing.", tools: [{ name, status: "completed" }] }
    assert.equal(survivesQueueCollapse(m, 2, none), false, name)
  }
})

test("a pending done registration does not survive — only the completed fact counts", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "Signing off.", tools: [{ name: "mcp__frizz__done" }] }, 2, none), false)
})

test("ordinary chatter collapses", () => {
  const none = new Set<number>()
  assert.equal(survivesQueueCollapse({ text: "Let me read the implementation." }, 2, none), false)
  assert.equal(survivesQueueCollapse({ text: "", boundary: "rest" }, 2, none), false)
})

// ---- queueCollapseSegments ----
//
// ONE FOLD PER REST. These are the shapes the maintainer described on 2026-08-12 (a thread driven across
// several watcher wakes, and the run whose calls landed after its closing prose) and on 2026-08-16 ("you
// should show all of the resting messages, but then all of the stuff between them can be collapsed").

// Shorthand: `p` prose, `t` a tools-only step, `w` a wake, `r` the rest divider, `x` a message the card
// drops outright.
const p = (tools = 0) => ({ text: true, tools, countable: true })
const t = (tools = 1) => ({ tools, countable: true })
const w = () => ({ opens: true, survives: true, countable: true })
const r = () => ({ skip: true, closes: true })
const x = () => ({ skip: true })

test("with no rest or wake the whole run is one segment, anchored on the first and last prose", () => {
  const segs = queueCollapseSegments([x(), p(), t(3), t(2), p()], 1)
  assert.equal(segs.length, 1)
  assert.deepEqual(
    { start: segs[0].start, end: segs[0].end, open: segs[0].open, close: segs[0].close, resumed: segs[0].resumed },
    { start: 1, end: 4, open: 1, close: 4, resumed: false },
  )
  assert.equal(segs[0].tools, 5)
  assert.equal(segs[0].steps, 2, "the two tools-only middles are hidden whole")
})

test("a wake CUTS: each run gets its own fold, and the wake itself belongs to neither", () => {
  //  0 ask · 1 prose · 2 tools · 3 prose · 4 WAKE · 5 tools · 6 tools · 7 prose
  const segs = queueCollapseSegments([x(), p(), t(4), p(), w(), t(3), t(2), p()], 1)
  assert.equal(segs.length, 2)
  assert.deepEqual([segs[0].start, segs[0].end, segs[0].resumed], [1, 3, false])
  assert.deepEqual([segs[1].start, segs[1].end, segs[1].resumed], [5, 7, true])
  assert.equal(segs[0].tools, 4)
  assert.equal(segs[1].tools, 5, "the second run's calls are ITS run's, not the first's")
})

// THE REGRESSION. The maintainer's zod thread: he asked a question, the agent answered it and RESTED,
// and the Goal woke it twice more. The wake CUT but the card never drew it, so before `closes` existed
// only `w()` cut anything — and with the Goal suppressed entirely (an `x()` here) the three turns merged
// into one run whose fold hid everything but its first and last prose. That fold swallowed the answer.
test("a REST cuts even when nothing narrates the wake that follows it", () => {
  //  0 ask · 1 prose · 2 tools · 3 THE ANSWER · 4 rest · 5 ⟨unnarrated bump⟩ · 6 tools · 7 prose · 8 rest
  const segs = queueCollapseSegments([x(), p(), t(6), p(), r(), x(), t(4), p(), r()], 1)
  assert.equal(segs.length, 2)
  assert.deepEqual([segs[0].open, segs[0].close], [1, 3], "the answer the agent rested on closes its own run")
  assert.deepEqual([segs[1].open, segs[1].close], [7, 7])
  assert.equal(segs[1].resumed, true, "a run past a rest has the rested message above it as its anchor")
})

test("rest then wake is ONE cut, not two empty runs", () => {
  //  0 ask · 1 prose · 2 rest · 3 WAKE · 4 tools · 5 prose · 6 rest
  const segs = queueCollapseSegments([x(), p(), r(), w(), t(3), p(), r()], 1)
  assert.equal(segs.length, 2)
  assert.deepEqual([segs[0].start, segs[0].end], [1, 1])
  assert.deepEqual([segs[1].start, segs[1].end], [4, 5], "the run starts after the wake, not after the rest")
})

test("the TRAILING rest closes the last run and leaves no empty one behind it", () => {
  const segs = queueCollapseSegments([x(), p(), t(2), p(), r()], 1)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].end, 3)
})

// ---- the run's WAKER --------------------------------------------------------------------------------
//
// A completion marker's POSITION decides whether it is news. At the head of a resumed run it is what
// re-invoked the agent and nothing else on the card says so; anywhere else the agent was already working
// and it is chatter the fold carries.
const c = () => ({ completion: true, countable: true })

test("a completion at the head of a resumed run is that run's WAKER, and is not counted as hidden", () => {
  //  0 ask · 1 prose · 2 rest · 3 COMPLETION · 4 prose · 5 tools · 6 prose
  const segs = queueCollapseSegments([x(), p(), r(), c(), p(), t(3), p()], 1)
  assert.equal(segs.length, 2)
  assert.equal(segs[1].waker, 3)
  assert.equal(segs[1].open, 4, "the waker renders above the run's opening prose, it does not become it")
  assert.equal(segs[1].steps, 1, "only the tools-only middle is hidden — the waker is on screen, not in the fold")
})

test("a completion MID-run is chatter — it folds and it counts", () => {
  const segs = queueCollapseSegments([x(), p(), r(), p(), c(), p()], 1)
  assert.equal(segs[1].waker, -1)
  assert.equal(segs[1].steps, 1, "it is a hidden step like any other row the fold swallows")
})

test("a completion in the human's OWN first run is never a waker — nothing was resting", () => {
  // The agent launched a task and it finished while the agent kept working. Calling that a wake would
  // claim the human's turn had ended.
  const segs = queueCollapseSegments([x(), c(), p(), t(2), p()], 1)
  assert.equal(segs[0].waker, -1)
})

test("a run opened by a scheduler WAKE does not also claim a completion as its waker", () => {
  // The wake already draws its own hairline; a completion right behind it is the run's first step.
  const segs = queueCollapseSegments([x(), p(), r(), w(), c(), p(), t(2), p()], 1)
  assert.equal(segs[1].waker, -1, "the wake hairline is what named the resumption")
})

// The screenshot that started this: "a bunch of bash calls show up right at the end". They are the same
// run's work — the agent simply stopped narrating before it stopped working — so they fold with it.
test("calls made AFTER the closing prose stay inside that run's fold", () => {
  const segs = queueCollapseSegments([x(), p(), p(), t(6), t(1)], 1)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].end, 4, "the run reaches past its closing prose")
  assert.equal(segs[0].close, 2)
  assert.equal(segs[0].tools, 7)
})

test("a message the card drops outright anchors nothing and counts as nothing", () => {
  // A Goal bump / rest divider sits at 2. Expanding reveals nothing where it stood, so counting it as a
  // hidden step would promise a row the expansion never shows.
  const segs = queueCollapseSegments([x(), p(), x(), t(2), p()], 1)
  assert.equal(segs[0].steps, 1)
  assert.equal(segs[0].tools, 2)
})

test("a mid-run ask keeps its own row, so it is not counted as hidden", () => {
  const segs = queueCollapseSegments([x(), p(), { text: true, countable: true, survives: true }, t(3), p()], 1)
  assert.equal(segs[0].steps, 1, "only the tools-only middle is hidden")
})

// ---- segmentFolds ----

test("a WOKEN run folds even when one message both opens and closes it", () => {
  const [seg] = queueCollapseSegments([w(), t(9), p()], 0)
  assert.equal(seg.open, seg.close, "one prose message doing both jobs")
  assert.equal(segmentFolds(seg), true, "its wake hairline is the anchor above the fold")
})

test("a run RESUMED by a bare rest folds on the same strength — the rested message is its anchor", () => {
  const segs = queueCollapseSegments([x(), p(), r(), t(9), p()], 1)
  const seg = segs[1]
  assert.equal(seg.open, seg.close)
  assert.equal(segmentFolds(seg), true)
})

// The render loop hangs a lone-prose run's divider on that one message, and this is what says which side.
test("hiddenBeforeOpen says which side of a lone prose message the hidden work sat on", () => {
  const before = queueCollapseSegments([w(), t(2), t(1), p()], 0)[0]
  assert.equal(before.open, before.close)
  assert.equal(before.hiddenBeforeOpen, true, "worked, then wrote")
  const after = queueCollapseSegments([w(), p(1), t(2)], 0)[0]
  assert.equal(after.open, after.close)
  assert.equal(after.hiddenBeforeOpen, false, "wrote, then worked — its own batched calls run after its text")
  // The waker draws its hairline above the run; it is on screen, not hidden work before the prose.
  const woken = queueCollapseSegments([x(), p(), r(), c(), p(), t(3)], 1)[1]
  assert.equal(woken.waker, 3)
  assert.equal(woken.hiddenBeforeOpen, false)
})

// Today's rule, kept deliberately: a lone agent turn has nothing intermediate, and a divider standing
// between the human's ask and the only answer reads as the card withholding the answer.
test("the FIRST run does NOT fold when one message both opens and closes it", () => {
  const [seg] = queueCollapseSegments([x(), t(9), p()], 1)
  assert.equal(segmentFolds(seg), false)
})

test("a run with nothing hidden never folds", () => {
  const [seg] = queueCollapseSegments([x(), p(), p()], 1)
  assert.equal(seg.tools, 0)
  assert.equal(seg.steps, 0)
  assert.equal(segmentFolds(seg), false)
})

test("a run with no prose at all never folds — it has no anchor to render", () => {
  const [seg] = queueCollapseSegments([w(), t(4)], 0)
  assert.equal(seg.open, -1)
  assert.equal(segmentFolds(seg), false)
})

// ---- THE MIDDLE ROUNDS ---------------------------------------------------------------------------
//
// One fold per rest is right for two or three rests and unreadable at thirty. `investigate-nubjs-nub-642`
// rested 30+ times against ONE ask, and because a rested message always survives its own run's fold, the
// card painted thirty near-identical restatements in full (maintainer 2026-08-17: "it's just so much
// unnecessary rendering"). The first rested message is the answer to whatever was last asked, and the
// last one is where the thread stands now; everything between them is the part nobody reads.
test("three or more runs keep the first and last, and collapse the middle whole", () => {
  // Four runs: ask → rest → wake → rest → wake → rest → wake → prose.
  const segs = queueCollapseSegments(
    [x(), p(), t(3), r(), w(), p(), t(2), r(), w(), p(), t(4), r(), w(), p(), t(5)],
    1,
  )
  assert.equal(segs.length, 4, "four runs to start with")
  const { kept, middles } = collapseMiddleRuns(segs)
  const [middle] = middles
  const first = segs[0]
  assert.equal(kept.length, 2, "the first run and the last one survive")
  assert.equal(kept[0], segs[0])
  assert.equal(kept[1], segs[3])
  assert.equal(middles.length, 1, "and the two between them collapse into one line")
  assert.equal(middle.runs, 2, "counted in ROUNDS — what the reader wants is how many times it went round")
  assert.equal(middle.tools, segs[1].tools + segs[2].tools, "with every call inside them")
  // IT REACHES BACK OVER THE OPENING WAKE. A resumed run's `start` is the message AFTER the wake that
  // opened it, so keying on `start` left that wake rendering above the collapse line — the card drew a
  // "Goal · at rest" hairline for a round it was hiding. Found by looking at the rendered card, not here:
  // the walk's own output was right, which is exactly why a unit test could not see it.
  assert.equal(middle.start, segs[1].start - 1, "the awakening that opened the middle goes WITH the middle")
  assert.equal(middle.end, segs[2].end)
  // …and it stops short of the LAST run's waker, which must stay visible: it is what says why the final
  // message exists.
  assert.ok(middle.end < segs[3].start - 1, "the last run keeps its own waker")
  assert.ok(middle.start > first.end, "and it never reaches back into the first run")
})

test("two runs are left alone — there is no middle to hide", () => {
  const segs = queueCollapseSegments([x(), p(), t(3), r(), w(), p(), t(2)], 1)
  assert.equal(segs.length, 2)
  const { kept, middles } = collapseMiddleRuns(segs)
  assert.deepEqual(middles, [], "nothing between the first and the last")
  assert.deepEqual(kept, segs, "so the card behaves exactly as it did before")
})

test("one run, and no run at all, are both left alone", () => {
  for (const steps of [[x(), p(), t(3)], [x()]]) {
    const { kept, middles } = collapseMiddleRuns(queueCollapseSegments(steps, 1))
    assert.deepEqual(middles, [])
    assert.ok(kept.length <= 1)
  }
})

// The 642 shape at scale: the count has to be the number of ROUNDS, not of records, or the divider says
// "412 steps" where the honest summary is "the agent went round 28 more times".
test("thirty runs collapse to two visible runs and one line", () => {
  const steps = [x(), p(), t(2)]
  for (let i = 0; i < 29; i++) steps.push(r(), w(), p(), t(2))
  const segs = queueCollapseSegments(steps, 1)
  assert.equal(segs.length, 30)
  const { kept, middles } = collapseMiddleRuns(segs)
  assert.equal(kept.length, 2)
  assert.equal(middles.length, 1)
  assert.equal(middles[0].runs, 28)
})

// THE RUN AN OPEN QUESTION SITS IN STAYS ON SCREEN. The 2026-10-15 shape: the worker asked in its 6th run,
// a background task woke it, and it rested again without naming the question — so the card stayed at the
// 6th run's rest, inside the middle, behind "N more rounds". The rail said [?] and nothing showed the ask.
test("a middle run holding an open question is kept, with the rounds on each side collapsed", () => {
  const steps = [x(), p(), t(2)] // 0..2: the human's ask and the first run
  for (let i = 0; i < 7; i++) steps.push(r(), w(), p(), t(2)) // seven more runs, four messages each
  const segs = queueCollapseSegments(steps, 1)
  assert.equal(segs.length, 8)
  const ask = segs[5].open // the 6th run's prose carries the question fence
  const { kept, middles } = collapseMiddleRuns(segs, [ask])
  assert.deepEqual(kept, [segs[0], segs[5], segs[7]], "the first run, the asking run and the last")
  assert.equal(middles.length, 2, "one line above the asking run and one below it")
  assert.deepEqual([middles[0].runs, middles[1].runs], [4, 1])
  assert.equal(middles[0].tools, segs[1].tools + segs[2].tools + segs[3].tools + segs[4].tools)
  assert.ok(middles[0].end < segs[5].start - 1, "the asking run keeps the wake that opened it")
  assert.equal(middles[1].start, segs[6].start - 1, "the second line takes its own run's wake with it")
  assert.ok(middles[1].start > segs[5].end, "and never reaches back into the asking run")
  assert.ok(middles[1].end < segs[7].start - 1, "the last run keeps its waker")
})

test("a question anchored to a rest pins the run that rest closed", () => {
  const steps = [x(), p(), t(2)]
  for (let i = 0; i < 4; i++) steps.push(r(), w(), p(), t(2))
  const segs = queueCollapseSegments(steps, 1)
  assert.equal(segs.length, 5)
  // A question registered without a fence draws after its rest: the rest record that closed run 2.
  const rest = segs[2].end + 1
  assert.equal(steps[rest].closes, true)
  const { kept, middles } = collapseMiddleRuns(segs, [rest])
  assert.deepEqual(kept, [segs[0], segs[2], segs[4]])
  assert.deepEqual(middles.map((m) => m.runs), [1, 1])
})

test("adjacent pinned runs share no divider, and pins in the first or last run change nothing", () => {
  const steps = [x(), p(), t(2)]
  for (let i = 0; i < 4; i++) steps.push(r(), w(), p(), t(2))
  const segs = queueCollapseSegments(steps, 1)
  const both = collapseMiddleRuns(segs, [segs[2].open, segs[3].open])
  assert.deepEqual(both.kept, [segs[0], segs[2], segs[3], segs[4]])
  assert.deepEqual(both.middles.map((m) => m.runs), [1], "only run 1 is left to hide")
  const outer = collapseMiddleRuns(segs, [segs[0].open, segs[4].open, 0])
  assert.deepEqual(outer.kept, [segs[0], segs[4]])
  assert.deepEqual(outer.middles.map((m) => m.runs), [3])
})
