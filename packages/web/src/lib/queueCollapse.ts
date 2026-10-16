// What the QUEUE CARD's intermediate collapse is allowed to swallow.
//
// The card hides each RUN — the agent's opening narration through the prose it rested on — behind one
// summary divider, so a triage card reads "what I asked" → "where it landed" without the wall of tool
// calls in between. Two things must survive that elision, for the same reason the background-task and
// sub-agent dispatch CALLS are lifted out of it (maintainer 2026-08-01: "It's important that those show
// up in the chat") — they are LIFECYCLE, not disposable chatter.
//
// Pure string/shape logic, no DOM and no schema import: the predicates take the structural minimum so
// they stay unit-testable, mirroring answering.ts's AskMsgLike.

import { hasQuestionBlock, splitQuestionBlocks } from "./questionBlocks.ts"

// The minimal message shape these walks need.
//
// `displayText` no longer changes any answer here and is kept because callers pass whole transcript
// messages: this module used to classify the GOAL's own bump apart from every other wake (to suppress
// it), which meant parsing frizz's `$`-anchored trailer off the presentation text rather than the raw
// `text` the server's delivery token still trails. Every wake is treated alike now — see
// survivesQueueCollapse — so that distinction, and the parse it needed, are gone.
export interface CollapseMsgLike {
  text: string
  /** The ids of its question fences the server refused (lib/questionFaults): code blocks, not asks. */
  refusedFences?: ReadonlySet<string>
  displayText?: string
  wake?: boolean
  boundary?: "wake" | "compaction" | "rest"
  sourceId?: string
  /** The message's tool calls, reduced to the facts the sign-off check reads. Callers pass whole
   *  transcript messages, whose TranscriptToolCall entries satisfy this structurally. `command` is a
   *  shell call's raw text when it ran long or over several lines, `detail` its one-line summary. */
  tools?: readonly { name?: string; status?: string; detail?: string; command?: string }[]
  /** Set on the transcript's provider-failure row (a Codex request that failed). */
  providerError?: unknown
}

// A shell command that runs `frizzctl done`, at its start or after anything that begins a new command
// (a newline, `;`, `&&`, `||`, `|`, a subshell). The transcript projects every backend's shell call as
// `Bash`, so one pattern reads Claude, Codex and ACP alike. Not a parse and not meant to be: it answers
// "did this message sign off", where a false positive keeps one extra message unfolded.
const RUNS_FRIZZCTL_DONE = /(?:^|[\n;&|(])\s*frizzctl\s+done(?=\s|$)/

// The message that REGISTERED the thread's completion — a successful `frizzctl done`, or, on a thread
// started before the command line (2026-10-11), a successful `mcp__frizz__done` tool call. Its prose
// IS the handoff: a worker writes the conclusive write-up and calls the verb in the same breath, so the
// projection coalesces both into one message. That message used to fold whenever ANY prose followed it,
// because the run's closing anchor is simply the last prose in the run — and workers routinely append a
// short pointer note after registering ("the report is in the message above…"), which stole the anchor
// and buried the write-up it points at (maintainer 2026-09-02, pullfrog `if-you-were-going-to-migrate`:
// a 340-char afterword anchored the run while the 2,329-char conclusion collapsed by default).
//
// Completed only. A REFUSED registration (`status: "failed"` — the command exits 2 when the gate holds,
// which a shell call reports as a failure) did not stand — the worker re-signs-off,
// and that later message is the one carrying the handoff. `ask`/`watch` deliberately do NOT
// count: neither ends the turn (a worker keeps working past both), and the ask already renders its own
// answerable card at the rest it was asked at (questionAnchors), so the prose around them is mid-run
// narration the fold is right to carry.
export function carriesDoneRegistration(m: CollapseMsgLike): boolean {
  return (m.tools ?? []).some((t) =>
    t.status === "completed" &&
    (t.name === "mcp__frizz__done" || (t.name === "Bash" && RUNS_FRIZZCTL_DONE.test(t.command ?? t.detail ?? ""))),
  )
}

// A message's ```question fences, normalized — its identity as an ASK. The surrounding prose is
// deliberately excluded: an agent restating its open questions rewords the lead paragraph every time,
// and the lead is not what the human is being asked to answer.
function askSignature(text: string): string | undefined {
  const blocks = splitQuestionBlocks(text).filter((s) => s.kind === "question")
  if (blocks.length === 0) return undefined
  return JSON.stringify(blocks.map((b) => (b.kind === "question" ? [b.questionKind, b.danger === true, b.text.trim()] : null)))
}

// Indices of asks a LATER message repeats verbatim. An agent woken mid-park — a sub-agent returning, a
// watcher firing — commonly restates its open questions under a fresh lead, and both copies then render
// as live answer cards, so one queue card offered the same pair of decisions twice (maintainer
// 2026-08-12: "The pair of questions it asked at the end was also asked twice"; measured on that thread,
// the two fences were byte-identical and only the lead paragraph differed). The NEWEST copy renders; the
// superseded one collapses with the rest of the run.
//
// PRESENTATION ONLY. selectOpenAsks still makes every ask answerable wherever it sits (maintainer
// 2026-08-03), and answering the surviving copy sends exactly what answering the older one would.
export function supersededAskIndices(messages: readonly CollapseMsgLike[]): Set<number> {
  const lastAt = new Map<string, number>()
  const signatures: (string | undefined)[] = []
  for (let i = 0; i < messages.length; i++) {
    const sig = askSignature(messages[i].text)
    signatures.push(sig)
    if (sig !== undefined) lastAt.set(sig, i)
  }
  const superseded = new Set<number>()
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i]
    if (sig !== undefined && lastAt.get(sig) !== i) superseded.add(i)
  }
  return superseded
}

// Whether a message sitting mid-span keeps its own row instead of collapsing into the summary divider.
//
//   - A ```question. An ask the agent kept working past is a decision the human still owes; collapsing it
//     left the card offering "Send answers" with no question in sight, and the same ask answerable one
//     click away in the drawer. A SUPERSEDED copy is the exception — the newer one carries the decision.
//   - The message carrying a successful DONE REGISTRATION (`carriesDoneRegistration`). It is a resting
//     message in everything but the divider that marks one — the registration is the sign-off — so it
//     falls under the maintainer's standing rule that every rested message is shown. It renders textOnly
//     through the collapse branch like an open ask (NOT the lifted-wake ordinary path — that would paint
//     the fold divider below prose it summarizes, the 2026-08-13 inversion), so its own tool band stays
//     folded and counted while its prose survives.
//   - A SCHEDULER WAKE (`wake: true` — a PR-watcher delivery, a timer, a watcher, AND the Goal's own bump).
//     It names WHAT RE-INVOKED THE AGENT, and NOTHING ELSE on the card represents it. Hiding it left a
//     card that showed a park on a PR watcher and then, with nothing in between, more work — reading as
//     a watcher wake that had never happened (maintainer 2026-08-12: "there's no indication of the PR
//     Watcher triggering and actually causing the additional follow-ups").
//
//     THE GOAL'S OWN BUMP IS NO LONGER THE EXCEPTION, which reverses a call made on 2026-08-12 ("do not
//     include 'Agent rested' above it or the stop hook firing"). That exemption was written when a rest
//     did not CUT: the bump's hairline had no rested message above it to belong to, so it landed jammed
//     against the final handoff and read as part of it. Now that each rest closes a run, the bump sits
//     exactly where the maintainer asked for it — under the message the agent rested on, naming why
//     there is more below (2026-08-16: "Anytime the agent does additional work after an awaiting block
//     or a done block or what have you, there should be a hairline beneath it telling it what woke up
//     the chat"). Measured on the thread that produced that ask (zod
//     `dedupe-zod-6236-exactoptional-with-coercion-2-prs`): all three wakes were Goal bumps, the card
//     drew none of them, and the maintainer read the resumed work as an unexplained PR-watcher firing.
//     The `rest` divider itself stays dropped — the rested message above the hairline says it better.
//
// A `boundary:"wake"` COMPLETION divider — a background task or sub-agent finishing — does not survive
// HERE, and its position decides it instead: see `CollapseSegment.waker` below. Mid-run it is chatter,
// because the agent was already working and the completion changed nothing about why; the run's own fold
// carries it. At the HEAD of a run it is the waker, and it draws its hairline like any other.
//
// That split replaces a flat "never survives" rule whose stated reason had quietly expired. It was
// dropped because "its LAUNCH card is already lifted out of this same span" (2026-08-12), so keeping the
// completion rendered one event twice and inverted — the completions flow in transcript order while the
// launches were one synthesized row at the foot of the span. Later the same day the launches were folded
// IN (a queue card gives no background task a card of its own), so nothing on the card stood for the
// event any more, and a run could begin with no statement of what began it — the exact gap the 2026-08-16
// ask names.
//
// The counting walk and the render loop BOTH go through this, so the divider can never promise the
// expansion a message it is already showing.
export function survivesQueueCollapse(m: CollapseMsgLike, index: number, superseded: ReadonlySet<number>): boolean {
  if (hasQuestionBlock(m.text, m.refusedFences)) return !superseded.has(index)
  if (carriesDoneRegistration(m)) return true
  // A PROVIDER FAILURE is lifecycle, not chatter: it is why the run stopped, and often why the card is in
  // the queue at all. Folded, it vanished with the calls before it, and the card read as an ordinary rest
  // (2026-10-09). The runtime-status ladder stands its own error card down whenever this row is drawn.
  if (m.providerError) return true
  return m.wake === true
}

/** Does this message OPEN a new collapse segment — i.e. is it the scheduler wake that re-invoked a
 *  rested agent? An open ask survives the fold too (above) but does not start a segment: the agent asked
 *  and kept working, which is one continuous run of work, not a new one. */
export function opensQueueSegment(m: CollapseMsgLike): boolean {
  return m.wake === true
}

// ---- SEGMENTS -------------------------------------------------------------------------------------
//
// ONE FOLD PER REST, not one fold per card.
//
// THE REST IS THE CUT, and the wake is only the label on it. Cutting on the WAKE alone was the bug: a
// wake the card chose not to narrate — the Goal's bump, which is how nearly every frizz-driven thread is
// resumed — cut nothing, so every turn it drove merged into ONE run whose fold hid all but the first and
// last prose in it. On the maintainer's zod thread that swallowed the whole answer to the question he had
// just asked: he asked about a field, the agent answered it and rested, the Goal woke it twice more, and
// the card showed the stale message above his ask, one fold, and the last turn's summary — the answer
// itself inside the fold (2026-08-16: "the entire answer to that question was collapsed by default").
//
// So the rule is now the one he stated: "you should show all of the resting messages, but then all of the
// stuff between them can be collapsed." Every message the agent RESTED on is a run's closing prose and is
// therefore shown; the run behind it folds; the wake that started the next run draws its own hairline
// between the two. A wake still cuts as well, because a wake can arrive mid-turn (a watcher firing while
// the agent works) with no rest to cut on.
//
// The card used to compute a single span — the agent's first prose after the human's ask through its
// last prose anywhere — and hang one divider off it. Wakes were lifted OUT of that span but did not
// SPLIT it, so a thread frizz had driven across five wakes rendered as: opening prose, five hairlines in
// a row, one fold, closing prose. Every hairline was detached from the work it explained, and the fold
// claimed a single run for five separate ones.
//
// A rest — and a wake — now CUTS. Each segment is [what re-invoked the agent → the prose it rested on],
// folds its own calls, and shows its own closing message, so the card reads down the page as it ran
// (maintainer 2026-08-12: "collapse everything starting at the point where the watcher was triggered up
// until it comes to rest… multiple messages in their complete form, with various collapsed tool call
// blocks between them, plus some hairline indicators showing why they were reawoken").
//
// THE SEGMENT SPANS THE WHOLE RUN, not just [open..close]. Calls made after the closing prose used to
// sit outside the fold and render as raw rows at the foot of the card — the tail of exactly the ordering
// the maintainer reported ("a bunch of bash calls show up right at the end"). They are the same run's
// work and they fold with it.

/** One message's shape, reduced to the seven facts the segment walk needs. The caller evaluates them
 *  (they need the transcript schema and the card's own render predicates); this stays pure so the walk
 *  itself is unit-testable. */
export interface CollapseStep {
  /** Belongs to no run — a queued send, a message that renders nothing, or a PINNED background op the
   *  server appended after the real tail (it renders, but outside every fold). */
  skip?: boolean
  /** Contributes visible PROSE, so it can anchor a segment's opening or closing row. */
  text?: boolean
  /** Tool calls this message would hand to a fold. Zero for a sub-agent completion marker, which renders
   *  as a divider rather than a card — counting it would promise a tool the expansion never shows. */
  tools?: number
  /** Would read as a hidden STEP if folded (it renders something a reader could have seen). */
  countable?: boolean
  /** Lifted out of the fold onto its own row — an open ask, or a wake. */
  survives?: boolean
  /** Starts a new segment (`opensQueueSegment`). The wake itself belongs to no segment. */
  opens?: boolean
  /** ENDS the run: the `rest` divider the agent's own stop emits. It renders nothing itself — the card
   *  drops it — but the prose before it is what the agent RESTED on, and that message is the reason the
   *  cut exists. Carried alongside `skip`, since the walk must see it before it skips it. */
  closes?: boolean
  /** A background-task / sub-agent COMPLETION marker, which renders as a hairline rather than a card.
   *  Only its POSITION decides whether it survives — see `CollapseSegment.waker`. */
  completion?: boolean
}

export interface CollapseSegment {
  /** First index in the run — the message after the wake or rest, or the first after the human's ask. */
  start: number
  /** Last index in the run — the message before the next wake or rest, or the last message. */
  end: number
  /** First index contributing prose, rendered text-only above the fold; -1 when the run has none. */
  open: number
  /** Last index contributing prose, rendered text-only below the fold; -1 when the run has none. */
  close: number
  /** Messages hidden whole. */
  steps: number
  /** Tool calls the fold carries. */
  tools: number
  /** This run did NOT open on the human's ask — a WAKE or a previous REST stands above it. That is the
   *  only thing `segmentFolds` needs to know: a resumed run has a visible anchor above its divider, so it
   *  may fold on the strength of anything hidden at all, while the first run may not. */
  resumed: boolean
  /** Index of the COMPLETION marker that opened this run — a background task or sub-agent finishing while
   *  the agent was at rest, which is what re-invoked it. It renders as its own hairline ABOVE the run's
   *  opening prose (and so above the fold), and is not counted as a hidden step. -1 when the run began
   *  some other way: on the human's ask, on a scheduler wake that draws its own hairline already, or on
   *  the agent simply carrying on. A completion sitting anywhere ELSE in the run is chatter and folds. */
  waker: number
  /** A hidden step sits BEFORE the opening prose. Only the render loop's lone-prose case reads it: when
   *  one message both opens and closes a folding run there is no second prose row to hang the divider
   *  on, and this says which side of that message the hidden work happened on — above it when the agent
   *  worked and then wrote, below it when it wrote and then worked (a message's own batched calls run
   *  after its text, so they alone put the divider below). */
  hiddenBeforeOpen: boolean
}

/** Split `[from .. end]` into one segment per run. The wake and rest messages themselves are excluded —
 *  the wake renders as its own hairline at the boundary, and the card drops the rest divider outright. */
export function queueCollapseSegments(steps: readonly CollapseStep[], from: number): CollapseSegment[] {
  const segments: CollapseSegment[] = []
  let current: CollapseSegment | undefined
  // Latched, never cleared: once a rest or a wake has gone by, NOTHING after it is the run the human's
  // ask opened, so every later run is anchored by something visible above it.
  let resumed = false
  const close = () => {
    if (current && current.start <= current.end) segments.push(current)
    current = undefined
  }
  for (let i = Math.max(0, from); i < steps.length; i++) {
    const s = steps[i]
    // BEFORE the skip: a rest renders nothing, so the card skips it — but it is the cut, so the walk
    // has to see it first.
    if (s.closes === true) {
      close()
      resumed = true
      continue
    }
    if (s.skip === true) continue
    if (s.opens === true) {
      close()
      resumed = true
      current = { start: i + 1, end: i, open: -1, close: -1, steps: 0, tools: 0, resumed: true, waker: -1, hiddenBeforeOpen: false }
      continue
    }
    const opening = current === undefined
    if (!current) current = { start: i, end: i, open: -1, close: -1, steps: 0, tools: 0, resumed, waker: -1, hiddenBeforeOpen: false }
    // A COMPLETION that opens a RESUMED run is what re-invoked the agent, and is the run's waker. The
    // `resumed` guard is what keeps a completion arriving during the human's own first turn — the agent
    // launched a task and it finished while the agent kept working — from being read as a wake.
    if (opening && s.completion === true && current.resumed) current.waker = i
    current.end = i
    current.tools += s.tools ?? 0
    if (s.text === true) {
      if (current.open < 0) current.open = i
      current.close = i
    }
  }
  close()
  // The hidden-step count is a SECOND pass because it needs the run's own open/close, which is only
  // known once the run has ended.
  for (const seg of segments) {
    for (let i = seg.start; i <= seg.end; i++) {
      const s = steps[i]
      if (s.skip === true || s.survives === true) continue
      if (i === seg.open || i === seg.close || i === seg.waker) continue
      if (s.countable !== true) continue
      seg.steps++
      if (i < seg.open) seg.hiddenBeforeOpen = true
    }
  }
  return segments
}

/** Is this run worth folding?
 *
 *  A RESUMED run folds on the strength of anything hidden at all: the message the agent rested on, or the
 *  wake hairline under it, is the anchor above it — and "the watcher fired and then twelve calls happened"
 *  is precisely the run the maintainer asked to see collapsed, even when the agent narrated it in a
 *  single message.
 *
 *  THE FIRST run, which opens on the human's ask, additionally needs DISTINCT opening and closing prose.
 *  That is today's rule kept deliberately: a lone agent turn has nothing intermediate, and hiding its own
 *  batched calls behind a divider that stands between the ask and the only answer reads as the card
 *  withholding the answer rather than summarizing the work. */
export function segmentFolds(seg: CollapseSegment): boolean {
  if (seg.open < 0) return false
  if (seg.tools < 1 && seg.steps < 1) return false
  return seg.resumed || seg.open !== seg.close
}

/** The MIDDLE runs, collapsed whole — prose, wakes and all.
 *
 *  One fold per rest is right for a thread with two or three of them and unreadable for a thread with
 *  thirty. `investigate-nubjs-nub-642` rested 30+ times against a single ask, and because a rested
 *  message always survives its own run's fold, the card painted thirty near-identical restatements in
 *  full (maintainer 2026-08-17: "it's just so much unnecessary rendering… we need to just hide all of
 *  the intermediate work").
 *
 *  A straight revert would bring back the bug that made a rest cut in the first place — the answer to the
 *  question the human had just asked was swallowed into a fold. That answer is the FIRST rested message,
 *  so keeping the first run and the last one whole preserves it exactly, and everything between them —
 *  every intermediate rest, every wake hairline, every tool call — becomes one divider (maintainer:
 *  "show the first one and then collapse everything in the middle and then show the last one… it can
 *  collapse all of the awakenings that happened in the middle").
 *
 *  Computed over ALL runs, not just the folding ones: a middle run with nothing worth folding on its own
 *  is still intermediate work, and leaving it visible would put a stray restatement inside the very span
 *  this is hiding.
 *
 *  EXCEPT A RUN HOLDING AN OPEN QUESTION, which is not intermediate work: it is what the thread is queued
 *  on. A worker that asks mid-run and is then woken by a shell or a sub-agent rests again without naming
 *  the question, so its card stays at the rest it was asked at (lib/questionAnchor) — and that rest was
 *  one of these middle runs. The card's rail said [?] and the composer said "Or skip the questions", and
 *  the question itself sat behind "9 more rounds · click to expand" (2026-10-15, an open-knowledge thread
 *  whose ask landed in its 6th of 8 runs: "I have to click a bunch of buttons to expand previous tool
 *  calls … The question should come to me in the queue"). Such a run is KEPT like the first and the last,
 *  folding only its own calls, and the runs on either side of it collapse into a divider each. */
export interface MiddleCollapse {
  /** Inclusive index range this swallows — every message in it renders nothing but the one divider. */
  start: number
  end: number
  /** How many RUNS are hidden. This is the number the reader cares about: "the agent went round 28 more
   *  times", not how many records that took. */
  runs: number
  /** Tool calls across those runs, summed, for the divider's own count. */
  tools: number
}

/** Split the runs into [first, …middle…, last]. `middles` is empty when there is nothing in between —
 *  fewer than three runs — and the card then behaves exactly as it did before.
 *
 *  `pinned` is the message indices that must stay on screen: where each open question is drawn (the
 *  message whose fence places it, or the rest it is anchored to). A middle run holding one is kept, and
 *  splits the middle into one divider on each side of it. A rest record belongs to the run it closed. */
export function collapseMiddleRuns(
  segments: readonly CollapseSegment[],
  pinned: Iterable<number> = [],
): { kept: CollapseSegment[]; middles: MiddleCollapse[] } {
  if (segments.length < 3) return { kept: [...segments], middles: [] }
  const held = new Set<number>()
  for (const at of pinned) {
    let owner = -1
    for (let s = 0; s < segments.length && segments[s].start <= at; s++) owner = s
    if (owner > 0 && owner < segments.length - 1) held.add(owner)
  }
  const kept: CollapseSegment[] = [segments[0]]
  const middles: MiddleCollapse[] = []
  let hidden: CollapseSegment[] = []
  const collapse = () => {
    if (hidden.length === 0) return
    middles.push({
      // ONE BEFORE the first hidden run, because a resumed run's `start` is the message AFTER the wake
      // that opened it — so keying on `start` alone left that wake rendering above the collapse line, and
      // the card drew a "Goal · at rest" hairline for a round it was busy hiding. The maintainer asked for
      // the awakenings in the middle to go WITH the middle. Caught by looking at the rendered card; no
      // unit test on the segment walk could see it, because the walk's output was correct.
      //
      // Clamped to the end of the run kept above it so this can never reach back into content that must
      // stay visible. For a run cut by a REST rather than a wake, `start - 1` is the rest record, which
      // renders nothing anyway — harmless to swallow.
      start: Math.max(kept[kept.length - 1].end + 1, hidden[0].start - 1),
      // Up to the last hidden run's END, so the wake or rest that opens the next KEPT run still renders:
      // it is what says why that run's message exists, and the maintainer has already reported once that
      // resumed work with nothing above it reads as unexplained.
      end: hidden[hidden.length - 1].end,
      runs: hidden.length,
      tools: hidden.reduce((n, s) => n + s.tools, 0),
    })
    hidden = []
  }
  for (let s = 1; s < segments.length - 1; s++) {
    if (!held.has(s)) {
      hidden.push(segments[s])
      continue
    }
    collapse()
    kept.push(segments[s])
  }
  collapse()
  kept.push(segments[segments.length - 1])
  return { kept, middles }
}
