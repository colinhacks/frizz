import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const renderText = () => {
  const render = source.match(/const renderText = \([\s\S]*?\n {2}\}/)?.[0]
  assert.ok(render, "renderText must exist")
  return render
}

// An ```awaiting fence that is not a LIVE wait draws NOTHING — not the card, and not its prose. Two ways
// it stops being live: frizz REFUSED the park (the flag the server sets when it folds the correction out
// of the transcript, transcript.ts markFenceRefused), or the worker has SPOKEN since, which settles by
// construction whatever the fence named.
test("a fence that is not a live wait is skipped before it ever reaches a card", () => {
  assert.match(
    renderText(),
    /if \(fseg\.fenceKind === "awaiting" && \(m\.fenceRefused \|\| staleAwaiting \|\| restingCardShown\)\) continue/,
    "both non-live cases must be skipped, not rendered as an empty card",
  )
  // SKIPPED, not returned as null from the card: the block list is interleaved with explicit spacers, so
  // a slot that renders nothing still spends one.
  assert.ok(
    renderText().indexOf("staleAwaiting") < renderText().indexOf("<FenceCard"),
    "the skip must come before the push, so no block slot is spent on a fence that draws nothing",
  )
  // …and `done` is untouched: a finished thread stays finished, whatever frizz thought of its last park
  // and however long ago it was written.
  assert.doesNotMatch(renderText(), /(fenceRefused|staleAwaiting)[^\n]*"done"/)
})

// A LIVE FENCE THE RESTING CARD STATES IS SKIPPED THE SAME WAY. FenceCard returns null when the thread is
// at rest on the fence (the resting card opens on its body), but a null child is not a skipped block: the
// block list is interleaved with spacers, so the slot still spent its 14px — a gap dangling under the
// prose, above the resting card, on every rested awaiting thread (maintainer 2026-08-28, with a
// screenshot). So the owning surfaces pass `restingCardShown` and the block never reaches the card.
test("a fence the resting card states never reaches the card either", () => {
  // The flag is set for the LAST agent message only — the one whose fence the resting card is about — so
  // the memo boundary holds for every other row. ONE place answers it for every surface: the thread
  // surface's `hidesAwaiting` (ThreadSurface.tsx), which ThreadMessage hands to Message. Each surface used
  // to pass it at each of its own Message sites, four in two files.
  const chat = source
  const todos = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")
  const shell = readFileSync(new URL("./ThreadSurface.tsx", import.meta.url), "utf8")
  // One message before the cut keeps its fence: the handoff the board holds the thread in the queue for.
  assert.match(shell, /hidesAwaiting: \(index\) => \[awaitingCut >= 0 && index < awaitingCut && index !== heldIdx, index === lastAgentIdx && restingShown\] as const/)
  assert.match(chat, /const \[staleAwaiting, restingCardShown\] = t\.hidesAwaiting\(index\)/, "ThreadMessage takes both reasons from the surface")
  assert.equal(chat.match(/restingCardShown=\{/g)?.length, 1, "ThreadMessage is the only site that passes it")
  assert.doesNotMatch(todos, /restingCardShown=|staleAwaiting=/, "the queue card draws its messages through ThreadMessage")
  // …and the emptiness walk agrees, or a fence-only last message keeps its spacer and its rest divider.
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /restingCardShown = false/, "it takes the resting-card reason")
  assert.match(helper, /entry\.messageIndex === awaitingCut\) stated\.add\(entry\.message\)/, "…and marks the last message as stated")
  assert.match(helper, /messageRendersNothing\(message, stale\.has\(message\), stated\.has\(message\)\)/, "…as its own reason, not one more stale member")
  assert.equal(chat.match(/rendersNothingIn\([a-zA-Z]+, awaitingCut, restingShown, heldIdx\)/g)?.length, 2, "every rendersNothingIn call passes it, and the held handoff")
  assert.match(todos, /const \{ lastAgentIdx, hidesAwaiting, [^}]*\} = surface\.transcript/, "the queue card's walk asks the surface")
  assert.equal(todos.match(/message(?:RendersNothing|HasRenderableText)\(m, \.\.\.hidesAwaiting\(globalIdx\)\)/g)?.length, 2, "the queue card's predicates take both reasons")
  assert.doesNotMatch(todos, /isStaleAwaiting|showsRestingCard\(/, "…and derive neither for themselves")
})

// THE TAIL MOUNTS WITH THE TRANSCRIPT, NOT BEFORE IT. The board lands first, so the queue card used to
// paint its resting/done/rested card under the "Loading…" line and then shove it down ~1s later when the
// messages mounted above it — the layout shift the maintainer refreshed into (2026-08-28).
test("the queue card holds its tail cards until the transcript window has loaded", () => {
  const todos = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")
  // Its tail is the drawer's slot since 2026-10-09, and the slot sits inside the same hold as the gates
  // above it.
  assert.match(todos, /\{!q\.isLoading && \(\n\s*<>\n\s*<InteractionStack[^\n]*\n[\s\S]*?<RuntimeStatusSlot/)
  // The thread view holds it by construction: the slot is a row of the virtualized transcript, which is
  // mounted only once the window has messages, and the empty state drawn before then has no slot at all.
  assert.match(source, /\{count > 0 \? \(\n\s*<VirtualizedThreadTranscript/)
  const empty = source.slice(source.indexOf("AN EMPTY TRANSCRIPT, the one thing this branch draws"), source.indexOf("data-transcript-overlay"))
  assert.ok(empty.length > 0, "the empty-state branch must be found")
  assert.doesNotMatch(empty, /RuntimeStatus/, "the empty state draws no slot under its Loading… line")
})

// THE CARD NEVER LEARNS ABOUT STALENESS. It used to: a `stale` branch stripped the frame and printed the
// body as free-standing prose. That prose is what the whole block now drops with it, so a prop that can
// only mean "draw a settled card" would be a card shape that no longer exists.
//
// The one thing that does follow the rest is the DONE card's verb (`pastRest`, the last test in this
// file), and it changes no shape: the card is the same record without its button. The awaiting branch
// never reads it.
test("FenceCard has no settled branch to fall into", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  assert.doesNotMatch(card, /\bstale\b/, "a settled fence never reaches the card, so it takes no `stale` prop")
  const awaiting = card.slice(card.indexOf("AND THE ```awaiting FENCE IS THE RESTING CARD"))
  assert.ok(awaiting.length > 200 && awaiting.length < card.length, "the awaiting branch must be found")
  assert.doesNotMatch(awaiting, /pastRest/, "the awaiting card draws one shape whatever the thread has done since")
})

// The fence's prose has been BLOCK markdown since frontmatter landed (2026-08-17), but every body kept
// the `md-inline` class, which styles only code/strong/em/links — so a `<ul>` arrived with Tailwind's
// preflight reset still on it and a handoff's bullet list rendered as flat unmarked lines.
test("every awaiting-fence body renders through the block markdown sheet", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  // Comments off first — the note explaining WHY the class moved names the old one, and an unstripped
  // match would be satisfied by that sentence rather than by the code.
  const code = card.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /md-inline/, "a fence body is block markdown — md-inline gives its lists no markers")
})

// WHETHER A MESSAGE RENDERS AT ALL IS NOW POSITIONAL, and that is the part with teeth. The contract
// invites a worker to rest on the fence ALONE, so a whole message can be one awaiting fence and no prose
// — 99 of the 6,999 awaiting fences in this machine's transcripts are that shape. Once settled, such a
// message draws nothing, and every surface that walks the transcript has to agree: a predicate that still
// reports it visible spends an adjacency spacer on an empty slot and saves a rest divider with nothing
// under it, which is the exact bug the refused-fence strip was added for.
test("the empty-message predicates take the settled case", () => {
  for (const fn of ["messageRendersNothing", "messageHasRenderableText"]) {
    const re = new RegExp(`export function ${fn}\\(m: ChatMessage, staleAwaiting\\?: boolean, restingCardShown\\?: boolean\\)`)
    assert.match(source, re, `${fn} must accept the message's staleness, and the resting card's claim on it`)
  }
  const blank = source.match(/function blankText\([\s\S]*?\n}/)?.[0]
  assert.ok(blank, "blankText must exist")
  const code = blank.replace(/^\s*\/\/.*$/gm, "")
  assert.match(code, /if \(!m\.fenceRefused && !staleAwaiting && !restingCardShown\) \{\n\s*if \(!text\.includes\("```awaiting"\)\) return !text\.trim\(\)/, "a settled fence must be stripped exactly as a refused one is")
  // …and a LIVE fence that names questions with no prose is as empty: renderText draws nothing for it.
  assert.match(code, /awaitingDefersToQuestions\(s\.hints\) && !awaitingProseBlock\(s\.body\)/)
  // …except a settled fence that handed the human steps, which keeps its card (renderText) — and is
  // stripped again only when it is refused or the resting card states it.
  assert.match(code, /\(m\.fenceRefused \|\| restingCardShown \|\| !settledFenceDraws\(s\.hints\)\)/)
})

// A FENCE THAT NAMES QUESTIONS DRAWS NO CARD (maintainer 2026-10-08: "if there are questions that are
// getting rendered, we don't even need to bother rendering the awaiting card"). Its prose stays as the
// message's own text, and the branch sits before the card push so no slot is spent on a card.
test("a fence that names questions renders its prose and no card", () => {
  const render = renderText()
  const branch = render.indexOf('if (fseg.fenceKind === "awaiting" && awaitingDefersToQuestions(fseg.hints))')
  assert.ok(branch >= 0, "the branch must exist")
  assert.ok(branch < render.indexOf("<FenceCard"), "it must come before the card push")
  assert.match(render.slice(branch), /^[^]*?const prose = awaitingProseBlock\(fseg\.body\)\n\s*if \(prose\) push\(<ProseHtml [^\n]*\/>\)\n\s*continue/)
})

// A SETTLED STEPS FENCE KEEPS ITS CARD (2026-10-08, maintainer: "We need to continue showing the to do
// instructions even after they are complete & the thread has moved on"). Drawn with NO thread, so it
// carries no live rows and no Done; settledSteps.e2e.test.ts drives it in the real drawer.
test("a settled fence that handed the human steps keeps its card, with no thread behind it", () => {
  const render = renderText()
  const keep = render.indexOf("settledFenceDraws(fseg.hints)")
  assert.ok(keep >= 0, "the exception must exist")
  assert.ok(keep < render.indexOf("(m.fenceRefused || staleAwaiting || restingCardShown)) continue"), "…ahead of the skip it excepts")
  assert.match(render, /staleAwaiting && !m\.fenceRefused && !restingCardShown && settledFenceDraws\(fseg\.hints\)/, "never for a refused fence, nor one the resting card states")
  assert.match(render, /push\(<AwaitingBackgroundCard key=\{`[^`]+`\} fence=\{\{ body: fseg\.body, hints: fseg\.hints \}\} stepsDone=\{stepsDone\} \/>\)/, "no `thread`, so no rows and no verb — only the record of a reply that was the box's")
  assert.match(source, /function settledFenceDraws\(hints: readonly AwaitingHint\[\]\): boolean \{\n\s*return awaitingSteps\(hints\)\.length > 0\n\}/)
})

// ONE CUT, SHARED. The renderer marks a fence settled by comparing its index against the last assistant
// message; so must the spacer walk, or a message renders on one path and not the other. `rendersNothingIn`
// is how the position reaches a row builder that only takes `(message) => boolean`, and it keys on the
// message OBJECT because coalescing replaces that object when it absorbs a tool tail.
test("every transcript surface cuts staleness at the same index", () => {
  const lastAssistant = readFileSync(new URL("../lib/lastAssistant.ts", import.meta.url), "utf8")
  const shell = readFileSync(new URL("./ThreadSurface.tsx", import.meta.url), "utf8")
  const todos = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")
  const scan = lastAssistant.match(/export function lastAssistantIndex[\s\S]*?\n}/)?.[0]
  assert.ok(scan, "lastAssistantIndex must exist")
  // SAID, not "is the last assistant ROW". A `kind:"event"` line — rest, wake, compaction, sub-agent
  // completion — carries role:"assistant" and no utterance. Counting one puts the cut AFTER the fence it
  // protects, and since every rested thread ends with an "Agent rested" event that made EVERY live fence
  // read as settled: card and hourglass stripped off the one wait still open. That is the defect behind
  // the "light gray lines" reports, and restyling the body twice could never have fixed it.
  assert.match(scan, /messages\[i\]\.kind !== "event"/, "a synthetic event row is not the agent speaking")
  // Nobody re-derives it by hand — a second copy of the scan is how two surfaces' cuts drift apart.
  const scans = (text: string) => text.match(/for \(let i = messages\.length - 1; i >= 0; i--\) if \(messages\[i\]\.role === "assistant"/g)?.length ?? 0
  assert.equal(scans(lastAssistant), 1, "the last-assistant scan must exist exactly once, inside lastAssistantIndex")
  assert.equal(scans(source) + scans(todos) + scans(shell), 0, "no surface, and not the shell, carries a second copy")
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /new WeakSet<ChatMessage>\(\)/, "it keys on the message object the entry holds")
  assert.match(helper, /entry\.messageIndex < awaitingCut && entry\.messageIndex !== heldIdx/, "…cut at the same index the renderer uses, sparing the same held handoff")
  // NO AWAITING CARD WHILE THE THREAD RUNS (maintainer 2026-09-24, on a screenshot of a park card above a
  // spinning worker: "When the agent is running, an awaiting card should never be shown at all"). The cut
  // sits past every message while running, so each fence in the window is stale; at rest it is the last
  // assistant message, which the resting card at the tail keys on too. This replaced the 2026-08-28 rule
  // that kept the card at the last REST while the worker ran past it (lib/restAnchor, deleted with it).
  // The cut is the thread surface's, computed once for the queue card and the thread view (it was written
  // out in each surface, and in each of the thread view's two columns, until 2026-10-13, and this
  // reversal had to be applied to each).
  assert.equal(shell.match(/const awaitingCut = running \? messages\.length : lastAgentIdx/g)?.length, 1, "the cut sits past every message while running")
  assert.doesNotMatch(source + todos, /const awaitingCut = /, "no surface computes a cut of its own")
  assert.equal(source.match(/\{ [^}]*awaitingCut, restingShown, [^}]*\} = transcript\n/g)?.length, 1, "the thread view reads it from the surface")
  assert.doesNotMatch(source, /lastRest\(|restAnchor\.ts|restedAt/, "the rest anchor is gone; nothing keeps a card at a rest the worker ran past")
  assert.equal(source.match(/staleAwaiting=\{/g)?.length, 1, "the renderer is handed the surface's answer, at ThreadMessage alone")
  assert.doesNotMatch(source, /staleAwaiting=\{lastAgentIdx/, "no surface may still cut at the last message")
  // Both transcript columns go through it; a bare `messageRendersNothing` handed to a row builder is the
  // regression — it cannot see position, so it reports a settled fence-only message as visible.
  assert.doesNotMatch(source, /\n\s+messageRendersNothing,\n/, "no row builder may take the position-blind predicate")
})

// ONE AWAITING CARD, EVERY RUNTIME (2026-09-04). A live fence whose thread is NOT at rest on it — mid-turn
// on a follow-up the human sent, woken by the very shell it named, or bg-snoozed — reaches FenceCard
// rather than the tail's resting card. It used to draw a SECOND card there, agreeing with the resting one
// by hand: its own heading rule ("Awaiting", never "Background shells running"), its own glyph (a radar
// for a PR wait), its own empty-body placeholder, its own wrap rule, and its own PR chips. So steering a
// worker re-shaped the card under the human (maintainer 2026-09-04: "I'll steer an agent with a new
// message, and it'll re-render the awaiting card in a totally different fucking way. This doesn't make
// any sense at all"). Now there is one component, and the ONLY thing that may vary with the runtime is
// the Snooze, which that component withholds itself where there is no rest to park.
test("the awaiting fence renders the resting card itself, not a second card beside it", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  const code = card.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  // THE FENCE IS PASSED IN, not read off the thread: the board holds `lastFence` only while the fence is
  // the worker's last word, and the tailer clears it on the very user record that bumps the thread — so a
  // card reading the thread alone lost the shell row at the bump while the PR and timer rows (rows in
  // their own registries) survived (maintainer 2026-08-28: "it hides the background shell for some
  // reason").
  assert.match(code, /return <AwaitingBackgroundCard thread=\{fenceThread\} fence=\{\{ body, hints \}\} \/>/, "the resting card itself, stating this fence")
  // Nothing about the awaiting card may be built HERE — a heading, a glyph, a prose call, a chip. Every
  // one of those was a place the two cards could disagree, and one of them is how each difference got in.
  // The DONE card is FenceCard's own and reads its own fence's `title:` (2026-10-13), so the heading rule
  // is checked past the done branch, on the code that reaches the awaiting card.
  const awaitingBranch = code.slice(code.indexOf('if (fenceKind === "done")'))
  const pastDone = awaitingBranch.slice(awaitingBranch.indexOf("\n  }\n") + 1)
  assert.ok(pastDone.includes("return <AwaitingBackgroundCard"), "the slice reaches the awaiting card")
  assert.doesNotMatch(code, /Hourglass|Radar|TerminalSquare/, "the glyph is the card's, and it follows the card's title")
  assert.doesNotMatch(pastDone, /awaitingFenceTitle|AWAITING_FALLBACK_TITLE|parkTitle/, "the heading is the card's")
  assert.doesNotMatch(code, /awaitingPresentationLine|awaitingProseBlock|prWatchRefs|WatchedRef/, "the prose and the PR chips are the card's")
  assert.doesNotMatch(code, /AwaitingWaitTable|AwaitingParkButton/, "…and so is the wait table and any verb under it")
  assert.doesNotMatch(code, /awaitingItemLabels|awaitingForLabel|itemLabels|forLabel/, "no label line of ids and a duration")
})

// …and the pieces the fence card used to own are now the resting card's, once each.
test("the resting card owns the heading, the glyph, the prose and the chips", () => {
  const cardSource = readFileSync(new URL("./AwaitingBackgroundCard.tsx", import.meta.url), "utf8")
  // To the END of the file, not to the first column-0 `}`: the props type closes on one of those, so a
  // lazy match would stop at the signature and every assertion below would pass on the type alone.
  const at = cardSource.indexOf("export function AwaitingBackgroundCard(")
  const card = at >= 0 ? cardSource.slice(at) : undefined
  assert.ok(card, "AwaitingBackgroundCard must exist")
  const code = card.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  // The fence it STATES is a parameter, defaulting to the thread's own — that default is the at-rest
  // case, and the parameter is what lets one card also state a fence the board has already dropped.
  assert.match(code, /const stated = fence \?\? \(thread\?\.lastFence\?\.kind === "awaiting" \? thread\.lastFence : undefined\)/)
  assert.match(code, /kind=\{awaitingBackgroundKind\(work, hints\)\}/, "the kind reads the stated fence's hints")
  assert.match(code, /const title = awaitingFenceTitle\(hints\)/, "…and so does the title under it")
  assert.match(code, /icon=\{steps\.length > 0 \? ListTodo : shellsAlone\(work\) \? TerminalSquare : Hourglass\}/, "three kinds, three glyphs, and no fourth — steps are the one wait on the reader")
  assert.match(code, /const prose = awaitingProseBlock\(stated\?\.body\)/)
  assert.match(code, /const unrowed = listsWork \? unrowedWatchRefs\(work, hints\) : \[\]/, "a PR the table already rows gets no chip — one PR, one place")
  // A steps card lists none of the work: its box sits right under the steps (maintainer 2026-10-15).
  assert.match(code, /const listsWork = steps\.length === 0/)
  assert.match(code, /const groups = listsWork \? awaitingWaitGroups\(work, now, \{ hints \}\) : \[\]/)
  // THE VERBS ARE THE ONLY THINGS THE RUNTIME MAY CHANGE, and each is withheld rather than re-styled: a
  // thread already bg-snoozed has no rest for the Snooze to park, and a thread that has left the rest its
  // steps were posted at has nobody waiting on the steps' Done (2026-10-03). A steps card takes no Snooze
  // at all — the reader is what it waits on — and neither does a `watching` rest (2026-10-05): its worker
  // already parked it in Snoozed, which is the park the button would make. Nor does a fence handed in from
  // the transcript (2026-10-28): that is an earlier fence, a held handoff above the resting card, and the
  // rest has one Snooze, on the card that states it.
  assert.match(code, /const snoozable = thread !== undefined && fence === undefined && steps\.length === 0 && thread\.waitStatus !== "watching" && showsRestingCard\(thread\) && threadLifecycleAvailability\(thread\)\.snooze/)
  assert.match(code, /const stepsLive = thread !== undefined && restingOnSteps\(thread, steps\)/)
  // Nothing else may key on the runtime. A second `showsRestingCard` call inside this card is how a
  // heading, a glyph or a truncation rule would start varying with it again.
  assert.equal(code.match(/showsRestingCard\(/g)?.length, 1, "the runtime reaches the Snooze once")
  assert.equal(code.match(/restingOnSteps\(/g)?.length, 1, "…and the steps' box once")
  assert.doesNotMatch(code, /\.runtime\b/, "and nothing in the card reads the runtime directly")
})


// A DONE CARD KEEPS ITS CARD AND GIVES UP ITS VERB. The card is a record and stays (the first test above);
// "Mark as done" belongs to the rest, so it is drawn only while the thread rests on that card. It used to
// stay live on every earlier done card, and a reply to an ARCHIVED thread grew one on the card being
// replied to, a frame after the reply's bubble: 3 geometry states for one send (2026-10-13,
// scripts/layout-timeline.mjs), 2 with the verb gated here.
test("a done card draws Mark as done only while the thread rests on it", () => {
  assert.match(renderText(), /<FenceCard[\s\S]*?pastRest=\{staleAwaiting\}/, "the message tells the card the thread has moved past it")
  const card = source.match(/export function FenceCard[\s\S]*?\n}\n/)?.[0]
  assert.ok(card, "FenceCard must exist")
  assert.match(card, /const markDone = doneThread && !isMobile && !pastRest \? \(/, "a card the thread has moved past draws no verb")
  // The tail's own done card (a sign-off that came in as a tool call) is never stale: it is only drawn at rest.
  assert.match(source, /case "registered-done":\n\s+return <FenceCard fenceKind="done" body=\{thread!\.lastFence!\.body\} hints=\{thread!\.lastFence!\.hints\} wrap=\{wrap\} \/>/)
})
