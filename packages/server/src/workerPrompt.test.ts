import assert from "node:assert/strict"
import test from "node:test"
import { questionFenceBlocks, questionFencesIn } from "@frizz/shared"
import { buildWorkerPrompt } from "./workerPrompt.ts"

test("both worker backends receive the gerund activity-caption contract", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /starts with an `-ing` verb\*\*, in sentence case/)
    assert.match(prompt, /Reading src\/config\.ts/)
    // The imperative is the form that keeps slipping through, so the contract must name it and show
    // the conversion — and must forbid papering over it with a `Running` prefix.
    assert.match(prompt, /`Find relative links in the README` → `Finding relative links in the README`/)
    assert.match(prompt, /Never prefix a description with `Running`/)
  }
})

// "SEND NOW" ENDS A CLAUDE TURN TO DELIVER A MESSAGE, and the runtime answers the tool call it cut off
// with its stock rejection: "The user doesn't want to proceed with this tool use … STOP what you are
// doing and wait". Frizz cannot change that text, so the contract says what it is. Measured on real
// broker sessions (see CLAUDE_INTERRUPTED_CALL): without the section 4 of 24 workers stopped to ask the
// human how to re-run the call a remark had interrupted, and with it none of 19 did.
test("only Claude's contract explains the tool result an interrupting message leaves behind", () => {
  const claude = buildWorkerPrompt("claude")
  assert.match(claude, /^## When a message cuts a tool call short$/m)
  // The rule is recalled by the text it is about, so it has to quote the runtime's own opening words.
  assert.match(claude, /"The user doesn't want to proceed with this tool use … STOP what you are doing"/)
  assert.match(claude, /Nothing rejected the call — it was cut off part-way — and it is no\s+correction/)
  assert.match(claude, /The message that follows is the whole signal/)
  assert.match(claude, /re-run the call if it is still needed/)
  // No other transport ends a turn for a message: a Codex steer is read at the next step, an ACP one queues.
  for (const backend of ["codex", "acp"] as const) assert.doesNotMatch(buildWorkerPrompt(backend), /cuts a tool call short/)
})

// ONE PLACE FOR WORKTREES. The contract named none until 2026-10-11, and four projects on one machine
// had four conventions, two of them outside the project. The path is also known to the server: the
// board's `.frizz` watcher prunes `worktrees` (board.test.ts pins that list) and repo-files.ts reads a
// worktree's own ignore rules, so a contract that moves the location has to move those with it.
test("every backend sends worktrees to one directory inside the project", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /^## Git worktrees$/m)
    assert.match(prompt, /`git worktree add \.frizz\/worktrees\/<slug> -b <slug>`/)
    assert.match(prompt, /A project that names its own worktree location or command keeps it/)
    assert.match(prompt, /never move or remove one you did not create/)
  }
  // Only Claude Code has tools that create a worktree somewhere else.
  assert.match(buildWorkerPrompt("claude"), /`EnterWorktree` and the Agent tool's\s+`isolation: "worktree"`/)
  assert.doesNotMatch(buildWorkerPrompt("codex"), /EnterWorktree/)
})

// THE CEILING, which is the counterweight to a stop criterion that otherwise only ever says "do not
// stop". Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an issue and recommend
// what to do, it produced the analysis, asked one design question, got no answer for 36 hours, and then
// — under a Goal telling it that a written-up plan is not an ending and that unanswered calls are its own
// to make — decided the question itself and shipped seven commits, a moved global bin dir, shell-profile
// writing and a docs change. Nothing woke it but its own background completions.
//
// "Keep going" is unbounded by construction: there is always more to do in any repo, so a worker
// forbidden to stop can only stop by widening its remit. Both halves have to be in the contract.
test("the contract bounds the work to the task, not only the stopping", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /THE INSTRUCTION IS ALSO THE CEILING/)
    assert.match(prompt, /Work you notice on the way is a FINDING, not a task/)
    // An ANALYSIS job ends with its analysis. Denying that is what turned a triage into a feature branch.
    assert.match(prompt, /the document is the ending/i)
    assert.match(prompt, /Implementing what it proposes is the NEXT job/)
    // …and silence from the human is not a mandate.
    assert.match(prompt, /unanswered question is not permission to build the answer/i)
  }
})

// THE WHOLE ROAD (2026-11-10; the reasons are beside STOP_CRITERION). A worker that stops to ask asks for
// every later stop on the way to the finish as well, as `when:` follow-ups, so one reply can carry the
// thread to merge. The guard clause is half the rule: without it, this reads as licence to ask more often.
test("a worker that stops to ask also asks what every later step will need", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const c = buildWorkerPrompt(backend).replace(/\s+/g, " ")
    assert.match(c, /\*\*WHEN YOU STOP TO ASK, ASK FOR THE WHOLE ROAD, NOT THE NEXT STEP\.\*\*/, backend)
    assert.match(c, /how far they want it taken/, backend)
    assert.match(c, /each a `when:` follow-up on the option that leads to it, where one does — so one reply can carry the thread to the finish/, backend)
    // Measured 2026-11-10: without "a call you would make yourself stays yours", a worker turned a fix it
    // had already chosen into a question, to have something to hang the merge follow-up on.
    assert.match(c, /a call you would make yourself stays yours \(say which way you went, and hang nothing on it\), and so does every gate the project's norms or the human's prompt already settle/, backend)
  }
})

// THE QUESTION FENCE (2026-10-13). The contract has taught five things here, and a stale assertion would
// resurrect the wrong one. (1) Until 2026-08-27 a free-form ```question fence was the only way to ask.
// (2) `ask` registered a ROW beside it, and both were taught. (3) 2026-09-11 the free-form fence was
// retired — nothing tracked its answer — and an empty ```question qst_… PLACEMENT marker moved a
// registered card into the prose. (4) 2026-10-05 a later rest had to name every open question under
// `questions:` or withdraw it. (5) 2026-10-13 the maintainer moved registration INTO the message: a
// structured fence with a worker-chosen `id:` registers a row, an `id:`-only fence references one, and
// no rest owes an old question anything. So: every question fence the contract writes must be one the
// shared parser registers, and none of the retired spellings may come back.
test("the contract teaches the structured question fence, and none of the grammars it replaced", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    // Every fence in the contract is one a worker could copy, so every one must READ: six asks of every
    // kind the examples need, one follow-up, and the reference form.
    const reads = questionFenceBlocks(prompt).map((b) => b.read)
    assert.deepEqual(reads.filter((r) => r.form === "invalid"), [], backend)
    assert.deepEqual(reads.map((r) => r.form), ["ask", "ask", "ask", "ask", "ask", "ask", "ref"], backend)
    const asked = questionFencesIn(prompt)
    // …and they assemble as one message would: the `when:` follow-up hangs on its parent's option.
    assert.deepEqual(asked.faults, [], backend)
    assert.ok(reads.some((r) => r.form === "ask" && r.spec.secret), `${backend}: the examples show a secret`)
    // A free-text ask is shown too: with a table row and no example, a model asked for a name in prose.
    assert.ok(reads.some((r) => r.form === "ask" && !r.spec.secret && !r.spec.options), `${backend}: the examples show a text question`)
    // The grammar's moving parts, each taught where a worker reads it.
    assert.match(c, /every value is read VERBATIM to the end of its line/)
    assert.match(c, /Below the `---` is the question's CONTEXT/)
    assert.match(c, /a table, a code block or a diff, a callout, a list, a `<details>` section, a `mermaid` diagram/)
    assert.match(c, /\*\*A CODE BLOCK INSIDE THE QUESTION NEEDS A LONGER OUTER FENCE\*\*, in an option's `detail` and in the context alike/)
    assert.match(prompt, /^````question\n/m)
    assert.match(c, /`when:` naming the option it hangs on/)
    // What real models got wrong against the first wording (2026-10-13; the reasons are beside QUESTIONS):
    // a go-ahead asked in prose, the deciding diff left above the card, a four-backtick opener closed
    // with three (or the reverse), an `awaiting` fence after a question, and a follow-up's label retyped.
    assert.match(c, /ANYTHING YOU NEED BACK BEFORE YOU CAN GO ON IS A QUESTION/)
    assert.match(c, /\*\*WHAT THE HUMAN MUST READ TO CHOOSE GOES INSIDE THE FENCE\*\*/)
    assert.match(c, /open AND close the question with FOUR backticks, the same four on both lines/)
    // The four-backtick example carries a code block in its CONTEXT too — the place three backticks break.
    assert.match(prompt, /^````question\n[\s\S]*?\n---\n[\s\S]*?\n```\n[\s\S]*?\n```\n````$/m)
    assert.match(c, /A QUESTION IS THE HANDBACK, AND THE ONLY FENCE ITS SIGN-OFF NEEDS/)
    assert.match(c, /the text after `=` is that option's `label:` EXACTLY as written/)
    assert.match(c, /in the same message as its parent `choice` or in a later one while the parent is still unanswered/)
    assert.match(c, /\*\*A VALUE ONLY THE HUMAN HOLDS IS `kind: secret`\*\*/)
    assert.match(c, /\*\*ASKING DOES NOT END YOUR TURN\.\*\* A fence in a message you send mid-turn registers the moment that message lands/)
    assert.match(c, /ON A THREAD CARRYING A GOAL, FRIZZ REFUSES THE QUESTION/)
    assert.match(c, /a correction opening `⚠️ Your ```question fence` names the fault/)
    assert.match(c, /`frizzctl unask <id>`/)
    // One gate for both sign-offs: the command is refused, the fence is corrected (scheduler SOURCE 15).
    assert.match(c, /\*\*NO SIGN-OFF AS DONE WHILE ANY QUESTION OF YOURS IS OPEN\*\* — at every rest, whether the question still stands or the human has typed past it/)
    assert.match(c, /`frizzctl done` refuses, naming each open question by its id\. A ` ```done ` fence cannot be refused, so Frizz corrects it instead: one message for that rest, opening `⚠️ Your ```done fence`/)
    assert.doesNotMatch(c, /write no `done` fence beside it/, "the done rule is its own paragraph now, and reaches past the rest that asked")
    // Question QUALITY survives the move intact.
    assert.match(c, /NO "I" AND NO "you" ANYWHERE IN A QUESTION/)
    assert.match(c, /Write the question in the human's OWN vocabulary/)
    assert.match(c, /A GO\/NO-GO gate is not a special kind — it is an ordinary `choice` with two options/)
    assert.match(c, /put the one you would take FIRST and mark it `recommended: true`/)
    // The card is drawn where the fence is written, so prose that restates it draws nothing.
    assert.match(c, /EVERY QUESTION DRAWS ITS OWN CARD WHERE YOU WROTE IT/)
    assert.match(c, /prose that repeats it draws NOTHING, one question is one card/)
    // A question fades when the HUMAN types past it, never because Frizz woke the worker (2026-10-13:
    // a shell finishing took a question out of the queue before the human had seen it).
    assert.match(c, /A QUESTION YOU ASKED STAYS YOUR ASK UNTIL THE HUMAN TYPES TO THIS THREAD/)
    assert.match(c, /A QUESTION STAYS ASKED ACROSS WAKES\. IT FADES ONLY WHEN THE HUMAN TYPES PAST IT/)
    assert.match(c, /Your next sign-off — after a wake that brought something new, or after the human typed — names it again with its REFERENCE, a ` ```question ` fence carrying its `id:` alone/)
    // A sign-off is the whole handoff (2026-11-11): it names every open question, and a wake with nothing
    // new gets the fence alone, which leaves the sign-off before it standing.
    assert.match(c, /\*\*A SIGN-OFF IS THE WHOLE HANDOFF, AND IT REPLACES THE ONE BEFORE IT\.\*\*/)
    assert.match(c, /\*\*WOKEN WITH NOTHING NEW, REST ON THE FENCE ALONE\.\*\*/)
    assert.match(c, /\*\*EVERY NEW SIGN-OFF NAMES EVERY OPEN QUESTION\*\*/)
    assert.match(c, /A message that only re-lists question ids, with nothing written around them, is refused/)
    assert.match(c, /A QUESTION YOU ASK IS THAT REST'S SIGN-OFF — REST NORMALLY/)
    // And every retired spelling stays gone: the command, the key, the marker and the per-rest rule.
    assert.doesNotMatch(prompt, /frizzctl (ask|secret)\b/, backend)
    assert.doesNotMatch(prompt, /questions: \[|`questions:`|qst_/, backend)
    assert.doesNotMatch(prompt, /^\s*```question[ \t]+\S/m, backend)
    assert.doesNotMatch(c, /placement marker|PLACE A QUESTION INSIDE YOUR PROSE/i, backend)
    assert.doesNotMatch(c, /SAY WHERE EACH OLD QUESTION STANDS/, backend)
    assert.doesNotMatch(c, /THERE IS NO `question` FENCE ANY MORE|A QUESTION HAS NO FENCE ANY MORE/, backend)
  }
})

// QUESTIONS SIT BESIDE WHAT THEY DECIDE (2026-10-30). Workers piled their fences at the bottom of the
// message (measured beside QUESTIONS in workerPrompt.ts), so the contract shows a whole message that
// interleaves, and that example has to stay one: prose before the first card, prose between every pair,
// and only what holds either way after the last.
test("the contract shows a whole message whose questions sit under the paragraphs they decide", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    assert.match(c, /\*\*EACH FENCE GOES IN YOUR PROSE, DIRECTLY UNDER THE PARAGRAPH IT DECIDES — NEVER STACKED AT THE BOTTOM\.\*\*/, backend)
    assert.match(c, /not three paragraphs and then three fences, and never a "the questions below"/, backend)
    // The signal section, which a worker reads first, says the same in its own place.
    assert.match(c, /A question is not a signal block, and it does not go at the end/, backend)
    assert.match(c, /so a sign-off is not a last line: each fence sits in the prose, under the paragraph it decides/, backend)
    const example = prompt.match(/^````markdown\n([\s\S]*?)\n````$/m)?.[1]
    assert.ok(example, `${backend}: the contract carries the whole-message example`)
    const asks = questionFenceBlocks(example).filter((b) => b.read.form === "ask")
    assert.equal(asks.length, 2, backend)
    assert.notEqual(example.slice(0, asks[0].start).trim(), "", `${backend}: a finding comes before the first card`)
    assert.notEqual(example.slice(asks[0].end, asks[1].start).trim(), "", `${backend}: the second card has its own paragraph`)
    assert.notEqual(example.slice(asks[1].end).trim(), "", `${backend}: what holds either way closes the message`)
    // Its questions are ones a worker could copy, so they read and assemble without a fault.
    assert.deepEqual(questionFencesIn(example).faults, [], backend)
  }
})

// STEPS FOR THE HUMAN (2026-10-03) ride the awaiting fence, and the contract has to route to them at the
// places a worker decides how to hand over — or "what the human must do" stays a sentence in a handoff
// that nothing tracks and nothing wakes on.
test("the contract teaches steps: as the wait on a human's act, and routes to it where a worker hands over", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    // Taught by example, in the grammar the parser reads: one `- ` item per step under the key.
    assert.match(prompt, /```awaiting\n {2}title: Approve the npm sign-in so the release can publish\n {2}steps:\n {4}- Open \[the npm sign-in this thread started\]/)
    // Its properties: verbatim, names the human (so no other name and no `for:`), always queues, and its
    // one verb comes back as the human's own reply — anything else is a message of their own.
    assert.match(c, /The `title:` and `steps:` values are the exceptions: frizz reads them verbatim/)
    assert.match(c, /Steps NAME THE HUMAN as the wait, so the fence needs no other name and no `for:`/)
    assert.match(c, /it always puts the thread in their queue/)
    assert.match(c, /anything else they need to tell you — a step that failed, the account they used — comes as that note or a message of their own/)
    assert.doesNotMatch(c, /Couldn't do it/)
    assert.match(c, /\(`steps:` counts: it names the human\.\)/)
    // Every step is clickable and complete (maintainer 2026-10-08): links to the pages it names, taught
    // by a bad/good pair, and the example fence itself carries a link.
    assert.match(c, /EVERY STEP IS CLICKABLE AND COMPLETE — A STEP THAT MAKES THE HUMAN GO LOOKING IS A BROKEN STEP/)
    assert.match(c, /every page it names is a real Markdown link to that exact page/)
    assert.match(c, /Good: `Open the \[Frizz account audit log\]\(https:\/\/dash\.cloudflare\.com\/<account-id>\/audit-log\)/)
    assert.match(prompt, /steps:\n {4}- Open \[the npm sign-in this thread started\]\(https:\/\/www\.npmjs\.com\/login\?next=\/login\/cli\/9f3c2a71\)[^\n]*\n {4}- /)
    // THE FIRST TEST (maintainer 2026-10-10): a step is only what the worker cannot do itself. It sits
    // AHEAD of clickable-and-complete, and the example fence obeys it — the command is the worker's, run
    // already, and no step tells the human to run one.
    assert.match(c, /THE FIRST TEST OF EVERY STEP: COULD YOU DO IT YOURSELF\? THEN IT IS NOT A STEP — DO IT\./)
    assert.ok(c.indexOf("THE FIRST TEST OF EVERY STEP") < c.indexOf("EVERY STEP IS CLICKABLE AND COMPLETE"), "the residue test comes first")
    assert.match(c, /A step is only what needs the human's BODY or the human's IDENTITY/)
    assert.match(c, /do everything up to the first one, hand over only that, and do what follows yourself when their reply wakes you/)
    assert.match(c, /`npm login --auth-type=web` is running in this thread and waiting on that approval/)
    assert.doesNotMatch(prompt, /steps:\n(?: {4}- [^\n]*\n)*? {4}- Run `npm login/)
    assert.match(c, /FRIZZ KEEPS ONE TO-DO LIST FOR THE HUMAN PER THREAD, AND EVERY `steps:` LANDS ON IT/)
    assert.match(c, /an unticked step your newest `steps:` leaves out drops off the list, so each `steps:` names everything still owed/)
    assert.match(c, /Everything ticked and sent comes back to you as their reply, `Done`, the same as anything they type; only some of it comes back as `Done 1 of 3:`/)
    // A decision is still a question; an act is steps — at every place the two used to blur.
    assert.match(c, /A DECISION you need from them is a question, never an `awaiting` fence/)
    assert.match(c, /WAITING ON ONE TO ACT IS `steps:`/)
    assert.match(c, /Once nothing is left to DECIDE and only the human's act remains, the steps go to them under `steps:`/)
    assert.match(c, /Something the human must DO \("re-pull before you restart"\) is not a dangling idea either: hand it to them under `steps:`/)
    assert.doesNotMatch(c, /that is the handoff, and it belongs in the prose/)
    // And the registered first cut is gone from the contract entirely.
    assert.doesNotMatch(c, /mcp__frizz__instruct|\buninstruct\b/)
  }
})

// COMMAND WATCHES ARE CLAUDE-ONLY (2026-10-11). The server refuses every Codex and ACP thread one
// (command-watch.ts `commandWatchRefusal`), so only Claude's contract may teach the key, the week-long
// ceiling and the route to it; anywhere else each mention is a refused call per wait. Claude's must
// also say why a polling shell is the wrong wait, and where the loop goes when Frizz refuses.
test("a Claude thread that starts in auto is told to use a background shell, in words a later switch cannot make false", () => {
  const claude = buildWorkerPrompt("claude")
  assert.doesNotMatch(claude, /monitor add|--persistent|monitors:|cmw_/)
  assert.match(claude, /a polling loop in a background shell that exits once it holds/)
  assert.match(claude, /refused unless this thread is in\s+`bypassPermissions` mode, and it did not start in that mode/)
  assert.doesNotMatch(claude, /\{\{FRIZZ_/)
})

test("only a bypass Claude contract teaches monitors, and it routes outside-condition waits to them", () => {
  const claude = buildWorkerPrompt("claude", { commandWatches: true })
  assert.match(claude, /`monitors:` — monitors you REGISTERED with `frizzctl monitor add`/)
  assert.match(claude, /`monitors:` with nothing but those, where it runs to a week/)
  assert.match(claude, /`frizzctl monitor add "<check that exits 0 once it holds>" --every 5m --for 6h`/)
  assert.match(claude, /Not a polling loop in a background shell/)
  assert.match(claude, /can never be hibernated/)
  assert.match(claude, /Only when Frizz REFUSES it[\s\S]{0,140}does the loop go in a background shell/)
  for (const backend of ["codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.doesNotMatch(prompt, /frizzctl monitor|monitors:|cmw_/, backend)
    assert.doesNotMatch(prompt, /\{\{FRIZZ_/, backend)
    assert.match(prompt, /where it runs to a year\.\n/, backend)
    assert.match(prompt, /`frizzctl watch-issue`\.\n    For anything else stay ACTIVE/, backend)
  }
})
