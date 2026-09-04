// THE resting card — one card, three surfaces. A thread whose top-level turn has come to rest while
// its OWN dispatched work (sub-agents / launched background shells) is still live is not stalled and is
// not waiting on the human: it is waiting on results it kicked off. Server-derived
// (board.deriveAwaitingBackground); this module only renders it.
//
// It renders on the DRAWER and the FULL-SCREEN page, because the rest is a fact about the thread. On the
// QUEUE it renders too — but only for the shape that queues, and the event-Snooze is passed in as
// `actions` there (parking a card is a queue verb, and the queue is where a card you don't want to look
// at costs you something). The drawer and standalone page pass none, since you opened the thread
// deliberately and have nothing to dismiss (maintainer 2026-07-25: "in the drawer or in the full screen
// view, it should not").
//
// WHICH SHAPE QUEUES has flipped twice, and the current split is the point of this card's two voices:
//   • rest on a live SUB-AGENT — excused from the queue (board.deriveNeedsYou, 2026-07-30). The child
//     returns and re-invokes the parent within seconds, so the thread is mid-flight in substance and
//     there is nothing for the human to do. The drawer and the full-screen page are then the ONLY places
//     this state is stated in words, which raises the stakes on the card rather than lowering them.
//   • rest on a background SHELL alone — QUEUED (maintainer 2026-08-04: "if a thread has rested and the
//     only thing remaining is background shells, we should put it into the queue"). A shell is detached;
//     the thread has finished its turn in every sense that matters to the operator, so it is a handoff.
//     Shells were briefly excused too (2026-08-01) and that is what this reverses.
//
// Without it those surfaces showed NOTHING at rest: the shimmer stops and the transcript just ends,
// which reads as "the agent died" for exactly the threads that are healthiest. (The shimmer coming back
// on afterwards is CORRECT, not a bug — a child's <task-notification> lands as a re-invoking user record
// and the parent genuinely resumes; measured 15/15 times on a live worker thread, with idle windows as
// short as 0.13s. This card is what makes that alternation legible.)
import { Fragment, useEffect, useState, type ReactNode } from "react"
import { Bot, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, GitMerge, GitPullRequestClosed, Hourglass, TerminalSquare } from "lucide-react"
import type { AwaitingHint, GithubWatchStatus, ThreadView, ThreadWatchView } from "@frizz/shared"
import { awaitingFenceTitle, isDirectSubAgent } from "@frizz/shared"
import { githubRefUrl } from "../lib/githubRef.ts"
import { noteGithubRefs } from "../lib/githubHovercards.ts"
import { AWAITING_FALLBACK_TITLE, AWAITING_NO_PROSE, awaitingProseBlock, prWatchRefs } from "../lib/awaitingPresentation.ts"
import { compactElapsedSince, formatCompactElapsed } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { pushBackgroundShellDrawer, pushSubAgentDrawer, showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { PRIMER, PRIMER_DANGER_LINK } from "../lib/primer.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { BLOCK_RADIUS_INNER_BOTTOM, CARD_ACTION_EXPLAINER, CARD_BODY, CARD_LINK, CARD_PRIMARY_ACTION, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

// Name what the thread is ACTUALLY waiting on. Three real cases, and the sentence has to be true in all
// of them: "sub-agents" is wrong for a shell-only thread (a launched dev server is not a child whose
// result you await), so shells get their own noun; and a thread with BOTH kinds live must name both
// rather than silently dropping the shells behind the agent count.
//
// The noun is "background shell", which is what the maintainer calls them and what the card's own title
// now says (it was the vaguer "background task" while the two shapes shared one title).
//
// The count is DIRECT children only. The sentence below says "it dispatched", and a descendant — a
// sub-agent's own sub-agent, which `subAgents` also carries now so the rows can nest — was dispatched by
// the child, not by this thread's worker. Counting them would make the sentence false.
// PR WATCHERS ARE THE THIRD KIND (2026-08-13), and they are listed exactly like the other two rather
// than getting a card of their own: the awaiting fence no longer offers a park action for a PR wait
// (lib/awaitingPresentation), so this card and its event-snooze are the one place a parked watcher is
// stated in words and the one control for hiding it.
export function prWatcherCount(thread: Pick<ThreadView, "watches">): number {
  return (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").length
}

// `watchers: false` is for the sentence that ends "…it dispatched": a PR watcher is not dispatched, it
// is PARKED ON, and naming it there makes the sentence false. That branch names it in its own clause.
export function awaitingBackgroundSubject(
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">,
  opts: { watchers?: boolean } = {},
): string {
  const agents = (thread.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").length
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  const watchers = opts.watchers === false ? 0 : prWatcherCount(thread)
  // Each kind names itself and the list is comma-joined with a trailing "and" — a thread can genuinely
  // have all three out, and silently dropping one behind another's count is what this replaced.
  const parts = [
    agents > 0 ? `${agents} sub-agent${agents === 1 ? "" : "s"}` : null,
    shells > 0 ? `${shells} background shell${shells === 1 ? "" : "s"}` : null,
    watchers > 0 ? `${watchers} PR watcher${watchers === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return "0 background shells" // unreachable via the card's own gate; never an empty sentence
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

// Whether the thread is genuinely WAITING or merely still has something running — the distinction the
// rail now draws with two different marks (groups.sessionIndicatorKind: a live sub-agent spins, a
// shell-only rest pulses), and the card has to agree with it. A dispatched sub-agent returns and
// re-invokes its parent, so "awaiting the results" is exactly right. A launched dev server never returns
// anything; saying the thread awaits its results describes a wait that is not happening.
function awaitsResults(thread: Pick<ThreadView, "subAgents">): boolean {
  return (thread.subAgents ?? []).some((a) => isDirectSubAgent(a) && a.state === "running")
}

// "when one of them finishes" is false of a single thing, and a thread with exactly one is the common
// case — so the pronoun agrees with the count rather than assuming the plural. SHELLS ONLY: a watcher is
// never the subject of this sentence any more, because it has a row of its own further down.
function liveShellCount(thread: Pick<ThreadView, "bgShells">): number {
  return (thread.bgShells ?? []).filter((s) => s.state === "running").length
}

/** Is there any work the SENTENCE has to name — i.e. work with no row of its own? A watched PR gets a
 *  row, so a rest on watchers alone needs no prose at all: the heading says the thread is waiting and the
 *  rows say on what. Counting the same watchers in a sentence directly above the rows is the restatement
 *  the maintainer called busy (2026-08-14). */
function hasUnrowedWork(thread: Pick<ThreadView, "subAgents" | "bgShells">): boolean {
  return awaitsResults(thread) || liveShellCount(thread) > 0
}

// The title, and it is CONDITIONAL for the same reason the body sentence is. "Background shells running"
// is the maintainer's own name for the shell-only rest (2026-08-04) and it is the shape that now carries
// a queue card, so that is the title the human meets in the queue. A rest on a live SUB-AGENT is a
// different state on a different surface — it is genuinely awaiting a result, and calling it "background
// shells" would name work it never launched — so it keeps the older title.
//
// THE AWAITING TITLE IS ONE WORD (maintainer 2026-08-24, off the round-5 mockups: "The title should
// just say 'Awaiting'"). "Awaiting background work" was carrying the specifics the card now states
// better below it — the worker's own prose and a row per thing — so the heading only has to name the
// STATE. The shell-only title survives because that shape is not awaiting anything and its name was
// ruled explicitly.
//
// The GLYPH follows the title. An hourglass is a WAIT, which is true of the sub-agent rest and false of
// the shell one: a queued handoff behind a detached shell is not waiting on anything, and stamping the
// wait mark on it would contradict the whole reason it is in the queue.
// NO KIND-SPECIFIC TITLE FOR A WATCHER. This briefly read "PR watcher armed" here, which quietly
// rebuilt the very card the consolidation removed — a bespoke PR-watcher card, just on a different
// surface (maintainer 2026-08-13: "the card that you're showing me still says 'PR watcher armed'. It is
// not a generic card, snooze card. I thought we decided to go generic").
//
// So the kind-naming title survives for EXACTLY the case the maintainer named it for — a rest on
// background shells and nothing else (2026-08-04) — and every other shape takes the generic one. That
// keeps it honest in both directions: "Background shells running" never names work the thread did not
// launch, and no new kind gets a heading of its own. The sentence beneath is where the specifics live.
//
// THE WORKER MAY NAME IT ITSELF (maintainer 2026-08-26: "let's let the agent specify its own title for
// these awaiting cards"). A `title:` in the fence frontmatter wins over both derived headings, because
// only the worker knows what this particular wait IS — "Awaiting" is true of every park and specific to
// none. It is capped at parse time (AWAITING_TITLE_MAX) so a worker cannot write a paragraph into a
// heading: the card already carries its full prose one line below.
//
// THE HINTS ARE A PARAMETER, not `thread.lastFence`, and that is what lets ONE card state a fence the
// BOARD no longer holds: the tailer clears `lastFence` on the user record that bumps the thread, and
// this card is still the one drawn at that rest (see the `fence` prop below).
export function awaitingBackgroundLabel(
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">,
  hints: readonly AwaitingHint[],
): string {
  return awaitingFenceTitle(hints) ?? (shellsAlone(thread) ? "Background shells running" : AWAITING_FALLBACK_TITLE)
}

/** Background shells and nothing else — the one shape with a title of its own. An armed timer
 *  disqualifies it the same way a PR watcher does: the card then holds a Timers group too, and a
 *  kind-naming title over a mixed table names only half the wait. */
function shellsAlone(thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">): boolean {
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  return shells > 0 && !awaitsResults(thread) && prWatcherCount(thread) === 0 && armedTimerWatches(thread).length === 0
}

/** The thread's armed timers, as the board's watch rows state them (kind "timer" since 2026-08-24 —
 *  before that a timer park reached this card nowhere at all). */
function armedTimerWatches(thread: Pick<ThreadView, "watches">): ThreadWatchView[] {
  return (thread.watches ?? []).filter((w) => w.kind === "timer" && w.state === "armed")
}

/** A card drawn with no owning thread — a fence in a SUB-AGENT's own transcript, which is a real
 *  surface with no board row behind it. It has no live work, so it has no rows and no shell-only
 *  heading; stating that once here beats an optional chain at every reader below. */
const NO_LIVE_WORK: Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches"> = { id: "", subAgents: [], bgShells: [], watches: [] }
const NO_HINTS: readonly AwaitingHint[] = []

/** The watched PRs that get a CHIP: the `prs:` the fence names which the wait table does not already
 *  row. A registered PR is a github row below — verdict glyph, check counts, the same link — so a chip
 *  for it too would be one PR twice on a card that was trimmed for exactly that. What is left is a
 *  `prs:` entry nothing registered, whose ref then exists NOWHERE else on the card, and the card is
 *  about it (maintainer 2026-07-31: "obviously this should have a link to the PR being watched"). */
function unrowedWatchRefs(thread: Pick<ThreadView, "watches">, hints: readonly AwaitingHint[]) {
  const rowed = new Set((thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").map((w) => w.target))
  return prWatchRefs(hints).filter((w) => !rowed.has(w.ref))
}

/** One watched PR reference. A worker writes each `prs:` entry by hand, so a ref that isn't
 *  `owner/repo#N` still says WHAT is being watched — it degrades to muted text in the same position
 *  rather than to a dead link or to nothing at all.
 *
 *  A valid ref carries `data-gh-ref`, so the app-wide hovercard layer (GithubHovercards) opens the PR's
 *  card on it exactly as on a `#123` in prose — the fence line is the only place the ref exists, and
 *  the card is what tells the reader which PR that is without leaving. Pre-noted at render, as prose
 *  is, so the first hover is never blank. */
function WatchedRef({ watch }: { watch: { ref: string; url: string | null } }) {
  useEffect(() => {
    if (watch.url) noteGithubRefs([watch.ref])
  }, [watch.url, watch.ref])
  if (!watch.url) return <span className="text-[12px] text-muted">{watch.ref}</span>
  return (
    <a href={watch.url} target="_blank" rel="noreferrer noopener" data-gh-ref={watch.ref} className={`${CARD_LINK} text-[12px]`}>
      {watch.ref}
    </a>
  )
}

// ---- ONE ROW PER WATCHED PR ----------------------------------------------------------------------
// Maintainer 2026-08-14: "in the card that renders all of the 'awaiting background tasks' stuff, we
// should have a row for each GitHub watcher. If the PRs are mergeable, then we should indicate as much
// in the UI. We should basically have it evoke the GitHub UI that shows up for running versus completed
// checks."
//
// So the row is GitHub's merge box on ONE line: its own state glyph, the ref, the check counts and the
// merge verdict. The count VOCABULARY is GitHub's, because the human has just come from there and a
// second set of words for one fact is a second thing to learn.
//
// IT WAS THREE LINES UNTIL 2026-08-14 — a prose verdict ("All checks have passed"), the same verdict as
// counts ("— 7 successful"), and a merge sentence under it ("This branch has no conflicts with the base
// branch") — and four PRs then filled eleven lines with three ways of saying green (maintainer: "this
// looks busy and shitty"). Each fact now appears exactly once, in its shortest true form:
//   • the GLYPH carries the verdict, so the words carry only what the glyph cannot: the numbers.
//   • the counts drop the prose headline that restated them.
//   • the merge verdict joins the same line, and only when it is not already implied (below).
//
// AN UNPOLLED PR SAYS "Checking…", not "no checks". They are different facts — frizz has not looked yet
// versus this PR has no CI — and only the second of them means the wait is nearly over. The same
// distinction decides the queue rule server-side, where not-knowing never parks a thread.

// The merge verdict, appended to the counts. Two of GitHub's four states are SILENT here, for two
// different reasons:
//   • UNKNOWN — GitHub computes mergeability asynchronously and reports it while still thinking, so a
//     phrase for it would say "frizz has not heard back" in words that sound like a verdict.
//   • BLOCKED WHILE CI IS RED OR RUNNING — "blocked" is then just the checks restated, which is the
//     doubling this row exists to remove. It survives on a GREEN PR, where it is the one thing the
//     counts do not say: CI is done and something else (a review, a required branch) still holds it.
const MERGE_CLAUSE: Record<GithubWatchStatus["merge"], string | null> = {
  mergeable: "no conflicts",
  blocked: "merge blocked",
  conflicting: "has conflicts",
  unknown: null,
}

function mergeClause(status: GithubWatchStatus): string | null {
  if (status.state !== "open") return null
  if (status.merge === "blocked" && status.checks !== "passing" && status.checks !== "none") return null
  return MERGE_CLAUSE[status.merge]
}

// `1cap` is the RESOLVED font's cap height, so this puts a symmetric 1em glyph's ink on the cap band in
// either font at any size — nothing to re-measure when the font setting flips or the type scale moves.
// It needs a shared baseline to align against, hence `items-baseline` on every row.
//
// NO INK TRIM ON THE MARK, and that is a MEASURED result rather than an omission. The usual
// glyph-beside-text problem is a bare glyph wearing dead box on both sides; a lucide CIRCLE at size 12
// paints ~11.5 of its 12 box px, so it behaves like a text run. Measured on this row
// (scripts/ink-gaps.mjs, dsf 4, sans): glyph→ref 6.50px against ref→headline 6.27px, both on one
// `gap-1.5`. A -1px trim "to be safe" made it WORSE (5.50 vs 6.27). 0.23px is inside the instrument's
// own noise floor — leave it.
export const ON_CAP = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"

/** RUNNING CHECKS SPIN (maintainer 2026-08-14: "the yellow should be a spinner if the checks are still
 *  running. A yellow spinner"). A static amber dot claimed "in progress" without showing it.
 *
 *  A RING, not lucide's Loader2: the row's other three marks are 12px circles, so a ring keeps ONE
 *  circular footprint down the mark column and the gutter does not jitter as a PR goes running → green.
 *  Same idiom as the inline ring ChatView already uses. `motion-safe:` because a continuous animation is
 *  exempt from the micro-interaction default only when the reader has not asked for stillness.
 *
 *  Since 2026-08-29 this is the SUB-AGENT row's spinner only; a running PR draws GitHub's own icon
 *  (ChecksInProgress below). */
function Spinner({ tone }: { tone: string }) {
  return <span aria-hidden className={`inline-block size-3 rounded-full border ${tone} border-t-transparent motion-safe:animate-spin ${ON_CAP}`} />
}

/** A RUNNING PR WEARS GITHUB'S OWN IN-PROGRESS CHECK ICON, traced from GitHub's DOM rather than evoked
 *  (maintainer 2026-08-29, with a screenshot of the merge box: "mirror this more closely […] the exact
 *  shape and style of the yellow spinner"). The plain ring above read as a generic loader; the human has
 *  just come from GitHub, and the same mark for the same fact is one less thing to translate.
 *
 *  GitHub's icon is three parts on a 16-box (read off github.com/…/pull/N/checks on 2026-08-29): a filled
 *  dot `r=4`; a full ring track `r=7`, `stroke-width=2`, at reduced opacity; and a bright QUARTER arc
 *  (`M15 8A7 7 0 0 1 8 15`, butt caps) on the same ring, rotating once a second, linear. The track's
 *  opacity is the one number the two GitHub surfaces disagree on: the Checks tab's SVG says `.5`, while
 *  the merge box in the maintainer's screenshot measures rgb(53,42,19) over rgb(2,4,8) — the attention
 *  colour at 0.25 — and the merge box is the surface this row mirrors, so 0.25 wins. The colour is
 *  Primer's `fgColor-attention` (the screenshot's dot samples rgb(211,154,33)); Tailwind's `amber-400`
 *  that this mark wore before rendered `#ffb900`, brighter and pinker than the thing it evoked. It now
 *  comes from `lib/primer.ts` with the row's other three verdicts, which is where that reading lives.
 *  Drawn at 12 through the 16 viewBox so it scales with the column's other 12px circles:
 *  dot ⌀6, ring ⌀12 with a 1.5px pen.
 *
 *  Only the ring GROUP spins — the dot is concentric so spinning it would be invisible, but rotating the
 *  whole svg would also rotate the cap-band translate it sits on. `origin-center` on an SVG `<g>` resolves
 *  against the view-box (transform-box's SVG default), i.e. 8 8 — the ring's own centre. */
function ChecksInProgress() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" overflow="visible" className={ON_CAP} style={{ color: PRIMER.fgAttention }}>
      <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
      <g strokeWidth="2" className="origin-center motion-safe:animate-spin">
        <circle cx="8" cy="8" r="7" opacity="0.25" />
        <path d="M15 8A7 7 0 0 1 8 15" />
      </g>
    </svg>
  )
}

/** GITHUB'S STATE COLOURS, NOT TAILWIND'S NEAREST HUE (`lib/primer.ts` carries the readings). This row
 *  sits inches under the hovercard's `#238636` "Open" pill and its `#3fb950` "+316", and `emerald-500`
 *  renders `#00bc7d` — 32° of hue away, a teal beside a green (maintainer 2026-08-31: "These greens
 *  just don't match"). A bare 12px glyph takes the `fg*` family, never the `bg*Emphasis` fill.
 *
 *  The CircleDashed arms stay on the app's `muted`, deliberately: "frizz has not polled this PR yet" is
 *  not a GitHub state, so no Primer colour means it. */
function ChecksGlyph({ status }: { status: GithubWatchStatus | undefined }) {
  if (!status) return <CircleDashed size={12} className={`${ON_CAP} text-muted/60`} />
  if (status.state === "merged") return <GitMerge size={12} className={ON_CAP} style={{ color: PRIMER.fgDone }} />
  if (status.state === "closed") return <GitPullRequestClosed size={12} className={ON_CAP} style={{ color: PRIMER.fgDanger }} />
  if (status.checks === "failing") return <CircleX size={12} className={ON_CAP} style={{ color: PRIMER.fgDanger }} />
  if (status.checks === "passing") return <CircleCheck size={12} className={ON_CAP} style={{ color: PRIMER.fgSuccess }} />
  if (status.checks === "running") return <ChecksInProgress />
  return <CircleDashed size={12} className={`${ON_CAP} text-muted/60`} />
}

/** "2 failing, 1 in progress, 9 successful" — GitHub's own count words, and only the counts that are
 *  nonzero: a row of zeroes reads as noise, and every count that is there is a count worth reading.
 *
 *  SEVERITY FIRST, and the order is fixed rather than per-state: the number that decides what the human
 *  does is the failing one, and a reader scanning four rows should find it in the same place on each.
 *  It is also what survives the row's `truncate` on a narrow queue card — measured at a 368px card, a
 *  red PR renders "2 failing, 1 in progress, 9 succ…", losing the count that matters least. */
export function checkCountLine(status: GithubWatchStatus): string {
  const parts = [
    status.failed > 0 ? `${status.failed} failing` : null,
    status.running > 0 ? `${status.running} in progress` : null,
    status.passed > 0 ? `${status.passed} successful` : null,
  ].filter((p): p is string => p !== null)
  return parts.join(", ")
}

/** The whole right-hand side of a row: what the checks say, then the merge verdict, on one line.
 *
 *  Merged/closed outrank everything — a merged PR's CI is history. Otherwise the counts speak and the
 *  glyph beside them carries the verdict they used to spell out in prose. */
export function watchStatusLine(status: GithubWatchStatus | undefined): string {
  if (!status) return "Checking…" // frizz has not polled yet — NOT "no checks"
  if (status.state === "merged") return "Merged"
  if (status.state === "closed") return "Closed"
  const counts = checkCountLine(status)
  const merge = mergeClause(status)
  // "No checks" rather than an empty left half: a PR with no CI at all is a real state, and the wait
  // then hangs entirely on the merge verdict beside it.
  return [counts || "No checks", merge].filter((p): p is string => p !== null).join(" · ")
}

// ---- ONE ROW SHAPE, EVERY KIND -------------------------------------------------------------------
// Maintainer 2026-08-15, choosing the shape off the mockup sheet: "Definitely group them by kind. They
// should all consistently use the chevron […] and right justify the status label, the light gray status
// label."
//
// So: mark · name · light-gray status right-justified · chevron. Four tracks shared by every row through
// `grid-cols-subgrid`, so the statuses line up down ONE edge across the group headings instead of
// starting wherever each name happened to end. The same right-justified light-gray reading the child-op
// rows already use under the prompt box (ChildOpRow, maintainer 2026-07-27) — one language, two surfaces.
//
// THE CHEVRON IS THE SAME GLYPH ON EVERY ROW even though the destinations differ (GitHub in a new tab,
// the shell's output drawer, the sub-agent's transcript). An earlier draft split it — an external arrow
// for a PR, a chevron for the rest — which is more literal and reads as two kinds of affordance on one
// list. The maintainer chose consistency, and it is the better call: the chevron means "this row opens",
// which is true of all three.
//
// A ROW WITH NOTHING TO OPEN RENDERS NON-INTERACTIVE — no chevron, no hover, no focus stop. Never a
// disabled control (which announces an affordance that is not there) and never a dropped row (which
// hides live work). That is ChildOpRow's settled policy for an id-less child, applied here.

// NO `gap-x` ON THE ROW, and that is the whole reason the margins below exist. One grid gap sets ONE
// distance, and this row's three boundaries want three: the mark belongs to the name (tight), the name
// and the status are opposite ends of the row (the 1fr owns that space), and the chevron is the status's
// handle (medium). A gap is also a BOX distance, and two of the four cells are mostly empty box — so the
// numbers here are INK, measured with the row's own probe at dsf 6, sans and mono.
const ROW = "group relative col-span-4 grid grid-cols-subgrid items-baseline rounded-sm text-[12px] leading-5"
// The same row laid out by FLEX, for a row that INDENTS (the rail's edited-files tree). Subgrid could
// not do it: a subgrid item's padding is folded into the shared edge track, so one deep row would
// have widened the mark column for every row and none of the names would have moved. In flex the
// name is the `1fr` (flex-1), the status keeps its own width, and the chevron sits at the end —
// the same four marks in the same order, at the same right edge.
const ROW_FLEX = "group relative col-span-4 flex items-baseline rounded-sm text-[12px] leading-5"
// ml-1.5 → 6.5px of ink between the mark and the name, which is the figure the old single-row layout was
// measured and left at (a -1px "safety" trim made it worse). A lucide circle at 12 inks ~10 of its box,
// so it behaves like a text run and needs no trim of its own.
const NAME = "ml-1.5 min-w-0 truncate font-medium text-fg/90"
/** The light-gray status column. `text-right` right-justifies it inside its own track; the name's `1fr`
 *  eats the slack, so the status lands against the chevron at the card's right edge. `ml-3` is only a
 *  floor — the distance the reader actually sees is whatever the truncating name leaves. */
const STATUS = "ml-3 min-w-0 truncate text-right text-muted/70"

/** The whole row is the target, so the name's link stretches over it (`after:inset-0` against the row's
 *  `relative`). A real <a>/<button> rather than a click handler on the div: right-click, middle-click and
 *  the keyboard all keep working, and any OTHER link in the row — the failures link — sits above the
 *  overlay as a sibling rather than nesting inside it, which is invalid and would swallow its own click. */
const STRETCH = "outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-1 focus-visible:after:ring-fg/60"

function Chevron() {
  // A CHEVRON IS MOSTLY EMPTY BOX — lucide's paints ~4.3 of its 13 box px, ~4.9 of dead space on each
  // side — so both of its distances have to be set in INK, not in box. Measured on this row at dsf 6
  // (the probe reads an SVG child's getBoundingClientRect, which IS its ink box):
  //
  //   BEFORE, at `-mr-0.5` and the row's shared `gap-x-2.5`:
  //     ink to the card's content edge  3.88px   — while the mark on the left sits flush at 0
  //     status ink → chevron ink       14.88px   — wider than the 13.00px that got "fix the fucking
  //                                                optical spacing on that chevron" (FRIZZ.md)
  //   AFTER, with these two:            1.88px and  7.88px — identical in BOTH fonts, which is the point
  //                                     of setting them in px against an ink measurement rather than in
  //                                     em against a cap height that moves.
  //
  // `ml-[3px]` sets the pair distance (3 + ~4.9px of dead box ≈ 8px of ink, so the chevron reads as the
  // status's handle rather than floating between it and the card edge); `-mr-[4px]` pulls the ink back
  // toward the content edge the mark column already sits on. A further -1px to close the last 1.88px was
  // drafted and rejected: 1.88px of optical inset at a card's edge reads as intentional, and dead flush
  // against a 12px rounded corner does not.
  return <ChevronRight size={13} aria-hidden className={`${ON_CAP} ml-[3px] -mr-[4px] text-muted/35 transition-colors group-hover:text-muted/70`} />
}

export function WaitRow({ mark, name, status, onOpen, onPrewarm, href, ghRef, title, testKind, testId, indent }: {
  mark: ReactNode
  name: string
  status: ReactNode
  onOpen?: () => void
  /** Left inset in px for a row in a TREE (the rail's edited files). Switches the row from the shared
   *  subgrid to its own flex line — see ROW_FLEX for why subgrid cannot indent. */
  indent?: number
  /** Fired when a pointer rests on the row, or the row's control takes focus — the row's chance to
   *  fetch what the click is about to need. Must be idempotent and silent: it runs on a HOVER. */
  onPrewarm?: () => void
  href?: string
  /** The `owner/repo#N` key of a GitHub row, stamped as `data-gh-ref` so the app-wide hovercard layer
   *  (GithubHovercards, delegated off the document) opens the PR's card on it exactly as it does on a
   *  `#123` in prose. The anchor STRETCHES over the whole row, so the whole row summons the card — which
   *  is right, because the whole row is the link. */
  ghRef?: string
  title?: string
  testKind: "github" | "shell" | "agent" | "timer" | "file"
  testId: string
}) {
  const tree = indent !== undefined
  const nameClass = tree ? `${NAME} flex-1` : NAME
  const open = href
    ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={title}
        data-gh-ref={ghRef}
        // The QUEUE card and the drawer both act on their own pointer-down; a row press must not reach
        // them, exactly as the ops strip's rows already stop it.
        onMouseDown={(e) => e.stopPropagation()}
        className={`${nameClass} ${STRETCH} group-hover:underline group-hover:decoration-fg/40 group-hover:underline-offset-2`}
      >
        {name}
      </a>
    )
    : onOpen
    ? (
      <button
        type="button"
        onClick={onOpen}
        onMouseDown={(e) => e.stopPropagation()}
        title={title}
        className={`${nameClass} ${STRETCH} text-left group-hover:underline group-hover:decoration-fg/40 group-hover:underline-offset-2`}
      >
        {name}
      </button>
    )
    : <span className={nameClass} title={title}>{name}</span>
  const interactive = !!(href || onOpen)
  return (
    <div
      data-wait-row={testId}
      data-wait-kind={testKind}
      onMouseEnter={onPrewarm}
      onFocus={onPrewarm}
      style={tree ? { paddingLeft: indent } : undefined}
      className={`${tree ? ROW_FLEX : ROW} ${interactive ? "cursor-pointer transition-colors hover:bg-fg/[0.045]" : ""}`}
    >
      <span className="flex shrink-0">{mark}</span>
      {open}
      <span data-wait-status className={STATUS}>{status}</span>
      {interactive ? <Chevron /> : <span />}
    </div>
  )
}

export function GithubWatchRow({ watch }: { watch: ThreadWatchView }) {
  const status = watch.github
  const url = githubRefUrl(watch.target)
  // Queue the hovercard fetch at render time, the same contract prose keeps (useGithubHovercardRefs):
  // the delegated pointerover asks again just in time, but pre-noting means the first hover is never
  // blank. Only a ref that resolved to a URL — the card is keyed by the same `owner/repo#N`.
  useEffect(() => {
    if (url) noteGithubRefs([watch.target])
  }, [url, watch.target])
  return (
    <WaitRow
      testKind="github"
      testId={watch.target}
      mark={<ChecksGlyph status={status} />}
      name={watch.target}
      href={url ?? undefined}
      ghRef={url ? watch.target : undefined}
      title={url ? `Open ${watch.target} on GitHub` : watch.target}
      status={
        <>
          {watchStatusLine(status)}
          {/* THE FAILING JOBS ARE NOT LISTED ANY MORE (maintainer 2026-08-15: "I don't think we should
              list out the failed checks. I think there should just be a button to view the failures, and
              it can just link out to the PR"). The names cost a whole second line on every red row for
              something the reader has to go to GitHub to act on anyway. The count still speaks — "2
              failing" says HOW red — and this goes to the PR's own CHECKS tab, which is where they are.
              `relative` lifts it over the stretched overlay so it keeps its own click. */}
          {status && status.failing.length > 0 && url && (
            <>
              {" · "}
              <a
                href={`${url}/checks`}
                target="_blank"
                rel="noreferrer noopener"
                onMouseDown={(e) => e.stopPropagation()}
                className={`relative underline underline-offset-2 ${PRIMER_DANGER_LINK}`}
              >
                view failures
              </a>
            </>
          )}
        </>
      }
    />
  )
}

// ---- THE DECLARED BACKGROUND SHELLS --------------------------------------------------------------
// A shell reaches this card only when the WORKER NAMED IT in the fence's `shells:` (a `watch:` line when
// this was written; that spelling was retired 2026-08-15 and the singular `shell:` on 2026-08-24), which
// is the same rule the
// server already applies to decide the card exists at all: "a background SHELL is the case that must be
// declared […] a dev server, a log tail and a test run are the same row here, and only the worker knows
// which of them it is actually resting behind" (board.hasDeclaredWait). So the list here is
// `watches[kind: "shell"]`, NOT `bgShells` — an undeclared dev server says nothing and gets no row.
//
// That watch was rendered NOWHERE until now (maintainer 2026-08-15: "My understanding was that the agent
// could mark at least background shells as things that it is explicitly waiting on"). It was: the fence
// parsed, the server built the row, and this card filtered for `kind === "github"` and dropped it.
//
// The watch's `target` is whichever handle the worker wrote, and there are three legal ones — the launch
// tool_use id, the runtime's task id, and the label (board.liveWaitHandles). Resolving back to the shell
// is what gets a readable NAME and the id the output drawer needs; an unresolvable target still renders,
// naming itself, rather than vanishing.
function resolveShell(thread: Pick<ThreadView, "bgShells">, target: string) {
  return (thread.bgShells ?? []).find((s) => s.id === target || s.taskId === target || s.label === target)
}

function declaredShellWatches(thread: Pick<ThreadView, "watches">): ThreadWatchView[] {
  return (thread.watches ?? []).filter((w) => w.kind === "shell" && w.state === "armed")
}

function ShellWatchRow({ watch, thread, slug, now }: {
  watch: ThreadWatchView
  thread: Pick<ThreadView, "bgShells">
  slug: string
  now: number
}) {
  const shell = resolveShell(thread, watch.target)
  if (shell) return <BgShellRow shell={shell} slug={slug} now={now} testId={watch.target} />
  const elapsed = compactElapsedSince(watch.createdAt, now)
  return (
    <WaitRow
      testKind="shell"
      testId={watch.target}
      mark={<TerminalSquare size={12} className={`${ON_CAP} text-shell`} />}
      name={watch.target}
      title={watch.target}
      status={elapsed ? `running · ${elapsed}` : "running"}
    />
  )
}

/** A running background shell as a row — the declared-watch row above once its target resolved, and
 *  the fullscreen rail's row for EVERY running shell, declared or not (a dev server the worker walked
 *  away from is still what is going on in the thread). */
export function BgShellRow({ shell, slug, now, testId }: {
  shell: ThreadView["bgShells"][number]
  slug: string
  now: number
  testId?: string
}) {
  const elapsed = compactElapsedSince(shell.startedAt, now)
  // A CODEX shell has an id (its processId) but no readable output — codex keeps that inside its own
  // session — so the row states its wait and declines the drill-in rather than opening a drawer that
  // could only report "unavailable". Same parting of the two affordances as the ops strip.
  const openable = shell.id && !shell.outputUnavailable
  return (
    <WaitRow
      testKind="shell"
      testId={testId ?? shell.id ?? shell.label}
      mark={<TerminalSquare size={12} className={`${ON_CAP} text-shell`} />}
      name={shell.label}
      onOpen={openable ? () => pushBackgroundShellDrawer(slug, shell.id!, { label: shell.label, startedAt: shell.startedAt }) : undefined}
      title={openable ? `Read this shell's output — running for ${elapsed}` : shell.label}
      status={elapsed ? `running · ${elapsed}` : "running"}
    />
  )
}

// ---- THE ARMED TIMERS ----------------------------------------------------------------------------
// The fourth kind (maintainer 2026-08-24: this card "enumerates all of the pull requests and the
// background shells … I don't understand why timer isn't represented in the same way"). Until then a
// timer park's one rendering was the fence card's machinery footer — "a timer   for 2h".
//
// The row's NAME is the timer's own prompt — the text the worker armed it with — because that is the
// honest answer to "what happens when this fires"; the `tmr_…` id names nothing to a human and stays in
// data attributes. NON-INTERACTIVE by ChildOpRow's settled policy: there is nothing to open — no output
// drawer, no transcript, no external page — so it renders without a chevron, hover, or focus stop
// rather than as a disabled control.
export function TimerRow({ watch, now }: { watch: ThreadWatchView; now: number }) {
  const fireMs = Date.parse(watch.timer?.fireAt ?? "")
  // "fires in 34m", counting down live off the card's shared clock. A due-but-undelivered timer (the
  // scheduler's tick is seconds behind the instant) says "firing…" rather than a 0s countdown or a
  // negative one — the same present-progressive the PR row uses for its own gap ("Checking…").
  const status = !Number.isFinite(fireMs) ? "armed" : fireMs > now ? `fires in ${formatCompactElapsed(fireMs - now)}` : "firing…"
  return (
    <WaitRow
      testKind="timer"
      testId={watch.target}
      mark={<Clock size={12} className={`${ON_CAP} text-muted/60`} />}
      name={watch.timer?.prompt || watch.target}
      title={watch.timer?.fireAt ? `One-off timer, set for ${watch.timer.fireAt}` : watch.target}
      status={status}
    />
  )
}

// ---- THE LIVE SUB-AGENTS -------------------------------------------------------------------------
// DIRECT children only. A descendant rides `subAgents` so other surfaces can nest the tree, but it was
// dispatched by the child rather than by this thread's worker — and it has no retirement signal in this
// thread's transcript, so a stale grandchild would sit on this card indefinitely.
export function liveAgents(thread: Pick<ThreadView, "subAgents">) {
  return (thread.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running")
}

export function AgentRow({ agent, slug, now }: { agent: ThreadView["subAgents"][number]; slug: string; now: number }) {
  const elapsed = compactElapsedSince(agent.startedAt, now)
  // The profile without its namespace: `frizz:opus-high` is how it is dispatched, `opus-high` is how the
  // maintainer says it, and the row has no width to spend on a prefix every row would repeat.
  const profile = agent.subagentType?.replace(/^frizz:/, "")
  return (
    <WaitRow
      testKind="agent"
      testId={agent.id ?? agent.label}
      // A sub-agent is ALWAYS in motion while it is on this card — it returns and re-invokes its parent —
      // so it is always the spinner, never a static mark. Accent-yellow rather than the checks' amber,
      // matching the rail's one-hue-per-runtime-concern (a sub-agent pulses accent, a shell pulses blue).
      mark={<Spinner tone="border-accent" />}
      name={agent.label}
      onOpen={agent.id ? () => pushSubAgentDrawer(slug, agent.id!, { label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
      title={agent.id ? `Open this sub-agent — working for ${elapsed}` : agent.label}
      status={[profile, elapsed].filter(Boolean).join(" · ")}
    />
  )
}

// ---- THE TABLE, AS A PIECE -----------------------------------------------------------------------
// Every live wait the thread has out, grouped by kind — the resting card's real content, and since
// 2026-08-28 the AWAITING FENCE CARD's too (ChatView.FenceCard). The two draw the SAME fence: the
// resting card while the thread is at rest on it, the fence card whenever it is not — mid-turn on a
// follow-up the human typed while the worker was still working, or after a wake, until the worker rests
// again. The fence card used to print the fence's machinery there instead, one muted line of
// runtime ids ("shell b7w140a81   for 45m"), and the maintainer kept meeting it on SHELL waits precisely
// because a shell wait is the one that resumes mid-turn — a PR fence at least carried its ref as a link
// (2026-08-27: "for shells, I keep on seeing this fucking disgusting thing … I feel like we've had many
// other times where I see it render a shell waiter much nicer than this").
//
// THE FENCE'S OWN `shells:` ARE ROWED HERE, off `hints`, and not only off `thread.watches`. The board
// synthesizes a shell row from the fence only while that fence is the worker's last word
// (board.fenceWatchViews reads `tele.lastFence`, and the tailer clears it on the very user record that
// bumps the thread) — so the day this table moved onto the fence card it was written believing the rows
// survived the bump, and they did not. A registered PR and an armed timer are rows in their own
// registries and outlived it; a shell the worker had only DECLARED vanished from the card the moment the
// human replied, while the shell kept running (maintainer 2026-08-28, with the screenshots: "it hides
// one of the rows, one of the three specifically. It hides the background shell for some reason"). A
// hint is resolved against the thread's live shells exactly as the board resolves it — a name matching
// nothing running is not a wait and gets no row — so the fence card cannot claim a shell that finished.
//
// `notAfter` is the instant the thread RESTED, when the card is drawn at a rest the thread has since
// been bumped past: a wait that started AFTER it — a sub-agent the reply dispatched, a watcher it
// registered — is mid-turn work, listed under the prompt box, and not something the worker rested on.
// The fence's own hints are exempt: the worker named them, so they were there.
export interface AwaitingWaitOptions {
  hints?: readonly AwaitingHint[]
  notAfter?: string
}

/** A fence's `shells:` hints as watch rows, for the shells the thread still has running. Skips any the
 *  board already rowed (the at-rest case, where `watches` carries the fence's shells too). */
function hintedShellWatches(thread: Pick<ThreadView, "id" | "bgShells">, hints: readonly AwaitingHint[], rowed: readonly ThreadWatchView[]): ThreadWatchView[] {
  const seen = new Set(rowed.map((w) => w.target))
  const out: ThreadWatchView[] = []
  for (const hint of hints) {
    if (hint.kind !== "shell") continue
    const target = hint.value.trim()
    if (!target || seen.has(target)) continue
    const shell = resolveShell(thread, target)
    if (!shell || shell.state !== "running") continue
    seen.add(target)
    out.push({ id: `shell:${thread.id}:${target}`, kind: "shell", target, state: "armed", createdAt: shell.startedAt })
  }
  return out
}

/** The rows themselves, before they are drawn — one list per kind, already filtered to what is live
 *  (and, given `notAfter`, to what was live at the rest). Exported through hasAwaitingWaitRows so a
 *  caller can decide whether to spend a card on them without rendering one. */
function awaitingWaitItems(thread: Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches">, opts: AwaitingWaitOptions = {}) {
  const cutoff = Date.parse(opts.notAfter ?? "")
  // Unknown start → kept: a row with no instant is never dropped on the strength of a guess.
  const startedByRest = (iso: string | undefined) => !Number.isFinite(cutoff) || !iso || !(Date.parse(iso) > cutoff)
  const prs = (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed" && startedByRest(w.createdAt))
  const declared = declaredShellWatches(thread).filter((w) => startedByRest(resolveShell(thread, w.target)?.startedAt ?? w.createdAt))
  const shells = [...declared, ...hintedShellWatches(thread, opts.hints ?? [], declared)]
  const agents = liveAgents(thread).filter((a) => startedByRest(a.startedAt))
  const timers = armedTimerWatches(thread).filter((w) => startedByRest(w.createdAt))
  return { prs, shells, agents, timers }
}

/** Would the wait table draw at least one row for this thread? The gate for drawing a card at a rest
 *  the thread has been bumped past: a card with a heading and no rows says less than nothing. */
export function hasAwaitingWaitRows(thread: Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches">, opts: AwaitingWaitOptions = {}): boolean {
  const items = awaitingWaitItems(thread, opts)
  return items.prs.length + items.shells.length + items.agents.length + items.timers.length > 0
}

function awaitingWaitGroups(thread: Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches">, now: number, opts: AwaitingWaitOptions = {}): Array<{ head: string; rows: ReactNode[] }> {
  const { prs, shells, agents, timers } = awaitingWaitItems(thread, opts)
  // GROUPED BY KIND (maintainer 2026-08-15: "Definitely group them by kind"), and the order is the one
  // the ops strip already settled, for the same reason: a sub-agent and a shell are running RIGHT NOW,
  // a watched PR is waiting on somebody else, and a timer is waiting on nothing but the clock. Read
  // most-alive first. An empty group renders nothing — never a heading over no rows.
  return [
    { head: "Sub-agents", rows: agents.map((a) => <AgentRow key={a.id ?? a.label} agent={a} slug={thread.id} now={now} />) },
    { head: "Background shells", rows: shells.map((w) => <ShellWatchRow key={w.id} watch={w} thread={thread} slug={thread.id} now={now} />) },
    { head: "Pull requests", rows: prs.map((w) => <GithubWatchRow key={w.id} watch={w} />) },
    { head: "Timers", rows: timers.map((w) => <TimerRow key={w.id} watch={w} now={now} />) },
  ].filter((g) => g.rows.length > 0)
}

/** One group of the table. A group with `onToggle` is COLLAPSIBLE: its heading becomes the toggle,
 *  wears the row count and a trailing caret, and hides its rows while `collapsed`. The fullscreen
 *  rail's edited-files list is the one group that takes it (maintainer 2026-09-03) — a wait row is
 *  never hidden, because a hidden live wait is the thing this table exists to stop. */
export interface WaitGroup {
  head: string
  rows: ReactNode[]
  count?: number
  collapsed?: boolean
  onToggle?: () => void
}

// The heading's caret TRAILS the label rather than leading it, so a collapsible heading's label sits
// on the same left edge as every heading without one — the rail mixes both kinds in one grid, and the
// awaiting card never has a caret at all. A chevron is mostly empty box, so its distance is set in INK:
// the label→count gap reads wider than its `ml-1.5` because `tracking-wide` trails letter-space after
// the last cap, and `ml-[5px]` is what puts the caret the same distance from the count. Measured with
// scripts/ink-gaps.mjs at dsf 6 on the fullscreen rail — label→count / count→caret: sans 7.84 / 8.10px,
// mono 8.10 / 7.42px. `ml-[3px]` read 6.10px in sans, visibly tighter than the gap before it.
function GroupHeading({ group, first }: { group: WaitGroup; first: boolean }) {
  const cls = `col-span-4 text-[10.5px] uppercase tracking-wide text-muted/45 ${first ? "" : "mt-2.5"}`
  if (!group.onToggle) return <div className={cls}>{group.head}</div>
  return (
    <button
      type="button"
      onClick={group.onToggle}
      aria-expanded={!group.collapsed}
      onMouseDown={(e) => e.stopPropagation()}
      className={`${cls} flex items-baseline rounded-sm text-left transition-colors hover:text-muted/80`}
    >
      <span>{group.head}</span>
      {group.count !== undefined && <span className="ml-1.5 tabular-nums">{group.count}</span>}
      <ChevronRight size={10} aria-hidden className={`${ON_CAP} ml-[5px] transition-transform ${group.collapsed ? "" : "rotate-90"}`} />
    </button>
  )
}

export function WaitGrid({ groups, divider }: { groups: ReadonlyArray<WaitGroup>; divider: boolean }) {
  if (groups.length === 0) return null
  return (
    <>
      {/* THE DIVIDER — the horizontal rule between the worker's message and the machinery, full bleed
          (maintainer 2026-08-24). It comes and goes with the prose: a card with rows alone (a bare
          sub-agent rest) needs no seam, and a seam over nothing reads as a scratch. */}
      {divider && <div aria-hidden className="-mx-4 mt-3 border-t border-border" />}
      {/* THE TABLE — the card's real content, not an appendix to a sentence.
          ONE grid for every group, so `grid-cols-subgrid` on each row shares FOUR tracks across the whole
          card and the light-gray statuses line up down one edge even across a heading. Per-group grids
          would each size their own name column and the statuses would step.

          THE STATUS TRACK IS CAPPED AT HALF THE GRID — `fit-content(50%)`, not `auto` — because the
          tracks are sized before the `1fr` name gets anything: a bare `auto` grows to the WIDEST status
          in the whole shared grid, so one red PR's "2 failing, 1 in progress, 9 successful · view
          failures" measured the track at 271px on the 308px fullscreen rail and truncated every file
          name in the grid to its ellipsis (maintainer 2026-09-02, screenshot of a 22-file rail reading
          "b…" down the column). Under the cap the wide status is the one that truncates — the reading
          checkCountLine already orders severity-first for — and the names keep the other half.

          mt-3 UNCONDITIONALLY — 12px, and it is the WHOLE gap rather than an addition: CardContent's own
          mt-1 collapses into it, which is why an earlier mt-2 measured 8px and put the first row closer
          to the card title than to the row beneath it (measured, sans and mono, dsf 3). */}
      <div className="mt-3 grid grid-cols-[auto_1fr_fit-content(50%)_auto] gap-y-px">
        {groups.map((g, i) => (
          <Fragment key={g.head}>
            {/* The heading spans all four tracks. `mt-*` on every group but the first: the gap between
                a group and the one above it has to beat the gap between two rows, or the heading reads
                as belonging to the rows above rather than the ones below. */}
            <GroupHeading group={g} first={i === 0} />
            {!g.collapsed && g.rows}
          </Fragment>
        ))}
      </div>
    </>
  )
}

/** The table on its own, for the awaiting fence card. Live-ticking exactly as the resting card is, and
 *  NOTHING when the thread has no rows: a fence whose shell has since finished (the worker woke on it
 *  and is working) draws its prose alone rather than a heading over an empty grid — and never the raw
 *  ids the fence was written in. `divider` says whether there is prose above for the rule to separate.
 *  `hints` are the fence's own, so its `shells:` row whether or not the board still lists them; `notAfter`
 *  is the rest's instant when the fence is drawn at a rest the thread has moved past (see
 *  AwaitingWaitOptions). */
export function AwaitingWaitTable({ thread, divider, hints, notAfter }: {
  thread: Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches">
  divider: boolean
  hints?: readonly AwaitingHint[]
  notAfter?: string
}) {
  const now = useNowMs()
  return <WaitGrid groups={awaitingWaitGroups(thread, now, { hints, notAfter })} divider={divider} />
}

/** Does the CHAT show the resting card at the bottom of this thread?

 *
 *  Three conditions, and the last two were added on 2026-08-14 after the maintainer found it on threads
 *  it had no business being on: "this snooze card only shows up at the bottom of a rendered chat thread
 *  inside of an agent that has actually come to rest. Doesn't make sense for it to be showing up in a
 *  currently running thread. Or a thread that is currently snoozed."
 *
 *  - `awaitingBackground` — the server says the thread is waiting on something it NAMED.
 *  - AT REST, checked here rather than inferred. The card's slot already loses to the working indicator,
 *    but that indicator keys on `running`/`spawning` alone, so every other non-resting runtime — a
 *    permission prompt, an exited pane — fell through to a card claiming a rest that is not happening.
 *  - NOT EVENT-SNOOZED. This one reverses a dated decision rather than extending it: the snooze was
 *    deliberately confined to the queue, because the drawer showing NOTHING at rest reads as "the agent
 *    died". That argument is about a thread nobody has parked. Once the human has parked THIS rest, the
 *    same card with the same button one surface over is not information. */
export function showsRestingCard(
  thread: Pick<ThreadView, "awaitingBackground" | "runtime" | "bgSnoozed"> | undefined,
): boolean {
  return thread?.awaitingBackground === true && thread.runtime === "turn-idle" && thread.bgSnoozed !== true
}

/** IT HAS TO FIT ON ONE LINE beside the button, and that is a hard constraint rather than a preference:
 *  the pair reads as one control with its caption, and a caption that wraps stops being one (maintainer
 *  2026-08-13: "I hate that the 'removes this from the queue…' label is breaking onto two lines here").
 *  The wording is theirs, verbatim. */
export const BG_SNOOZE_EXPLAINER = "Hides card until new activity is detected"

/** THE CARD'S OWN SNOOZE, ON EVERY SURFACE IT DRAWS — the drawer and the full-screen page included as
 *  of 2026-08-31.
 *
 *  It was injected by the QUEUE alone until then, as an `actions` node: parking was reasoned about as a
 *  queue verb, so "you opened the thread deliberately and have nothing to dismiss" kept it off the other
 *  two surfaces (maintainer 2026-07-25). What that reasoning missed is WHICH THREADS REACH THE QUEUE. A
 *  worker that writes a good ```awaiting fence — every name still resolving to something live — is
 *  EXCUSED from the queue outright (server/board.deriveNeedsYou → hasDeclaredBackgroundPark), so the one
 *  surface carrying the control was the one surface that thread never appeared on. The better the fence,
 *  the more certainly the human lost the button, which is exactly backwards (maintainer 2026-08-31:
 *  "Why is there no fucking snooze button?!?!?! There are very few cases where an awaiting block should
 *  lock a snooze button").
 *
 *  So the card carries its own verb instead of waiting to be handed one, and the fence can no longer
 *  take it away. The drawer does not blank on the click, which is what the original ruling was protecting
 *  (found 2026-07-29, "reads as if the agent died"): `showsRestingCard` goes false, and the awaiting
 *  FENCE card — suppressed only while this card shows — takes the slot and states the same wait compactly.
 *
 *  `onSnooze`/`onSnoozeFailed` are the QUEUE's optimistic card exit and stay queue-only; off the queue
 *  there is no card to fade and the click just re-renders the slot. */
function AwaitingSnooze({ thread, onSnooze, onSnoozeFailed }: {
  thread: Pick<ThreadView, "id" | "sessionId">
  onSnooze?: () => void
  onSnoozeFailed?: () => void
}) {
  const [pending, setPending] = useState(false)
  const snooze = () => {
    setPending(true)
    onSnooze?.() // fade the queue card immediately, like every other queue dismissal
    rpc
      .snoozeAwaitingBackground({ slug: thread.id, sessionId: thread.sessionId ?? "" })
      .then(() => showToast("Snoozed until the background work returns"))
      .catch((error) => {
        onSnoozeFailed?.() // roll the card back into the queue
        showToast(`Couldn’t snooze: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }
  return (
    // Button FIRST, explainer immediately to its right and centered against it (maintainer 2026-07-29):
    // the pair reads as one control with its caption. The explainer is not decoration — a snooze whose
    // wake condition is an EVENT rather than a clock is unguessable from the verb alone, and the
    // maintainer asked for it in as many words (2026-08-04: "the snooze button should indicate that this
    // will remove the item from the queue until one of the background shells completes").
    <>
      <button
        type="button"
        onClick={snooze}
        disabled={pending}
        onMouseDown={(e) => e.preventDefault()}
        title={BG_SNOOZE_EXPLAINER}
        // The shared card-action chrome. Taking CARD_PRIMARY_ACTION rather than restating it is what
        // keeps this from drifting off the other card actions on a corner or a fill.
        className={`disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
      >
        {/* Measured, not guessed: the icon read 1.58px LOW here. See lib/iconAlign.ts for why box
            centering leaves a descender-free label's ink high, and why leading-none is not the fix. */}
        <Hourglass size={12} className={ICON_LABEL_NUDGE} />
        Snooze
      </button>
      <span className={CARD_ACTION_EXPLAINER}>{BG_SNOOZE_EXPLAINER}</span>
    </>
  )
}

export function AwaitingBackgroundCard({ thread, fence, onSnooze, onSnoozeFailed, notAfter }: {
  // `id` joins the Pick because the rows OPEN things now: a shell's output drawer and a sub-agent's
  // transcript are both addressed by the parent thread's slug. `lastFence` joined on 2026-08-24: the
  // fence's prose is this card's opening stratum, so the card reads it directly off the thread.
  // `kind`/`foreign`/`state`/`archived`/`sessionId` joined the Pick on 2026-08-31, when the card took
  // ownership of its own Snooze: the control renders for an actionable owned thread and for nothing
  // else, on the SAME test the lifecycle footer uses (threadLifecycleAvailability).
  // `awaitingBackground`/`runtime`/`bgSnoozed` joined on 2026-09-04, when the card took ownership of
  // WHETHER to draw the Snooze at all rather than being drawn only where one applied (showsRestingCard).
  //
  // OPTIONAL since 2026-09-04: a fence card in a SUB-AGENT's own transcript has no owning thread, so it
  // has no rows and no verb — but it is still this card, at this heading, with this prose.
  thread?: Pick<ThreadView, "id" | "sessionId" | "kind" | "foreign" | "state" | "archived" | "awaitingBackground" | "runtime" | "bgSnoozed" | "subAgents" | "bgShells" | "watches" | "lastFence">
  /** The fence this card STATES, when it is not the one the board is holding. Defaults to the thread's
   *  own `lastFence` — which is the at-rest case, and the only one until 2026-09-04.
   *
   *  ONE CARD, EVERY RUNTIME. An awaiting card used to render two entirely different ways depending on
   *  whether its thread was resting or running: this card at rest, and a second card in ChatView with
   *  its own heading rule, its own glyph rule, its own prose fallback and its own PR chips — so steering
   *  a worker with a follow-up re-drew the card in a different shape (maintainer 2026-09-04: "I'll steer
   *  an agent with a new message, and it'll re-render the awaiting card in a totally different fucking
   *  way. This doesn't make any sense at all"). The fence a bumped thread rested on is not on the board
   *  any more — the tailer clears `lastFence` on the very user record that bumps it — so the caller that
   *  parsed it out of the message hands it in here instead of a second renderer growing around it. */
  fence?: { body: string; hints: readonly AwaitingHint[] }
  // The QUEUE's optimistic card exit, and queue-only: the drawer and the full-screen page have no card
  // to fade. Their absence no longer decides whether the Snooze RENDERS — see AwaitingSnooze.
  onSnooze?: () => void
  onSnoozeFailed?: () => void
  // Set when the card is drawn IN THE TRANSCRIPT at a rest the thread has been bumped past — the fourth
  // surface, since 2026-08-28 (ChatView.Message): a rest on registered rows alone has no fence to leave a
  // card behind, so the message the worker rested on draws this one until the worker rests again. The
  // instant keeps the rows honest to that rest (AwaitingWaitOptions.notAfter).
  notAfter?: string
}) {
  // The thread's live work, as the rows and the heading read it. A card with no owning thread has none
  // of it — no rows, no shell-only heading — rather than a branch at every use below.
  const work = thread ?? NO_LIVE_WORK
  const stated = fence ?? (thread?.lastFence?.kind === "awaiting" ? thread.lastFence : undefined)
  const hints = stated?.hints ?? NO_HINTS
  const waiting = awaitsResults(work)
  // THE WORKER'S OWN HANDOFF, opening the card (maintainer 2026-08-24: "the rendered message at the
  // top of the card, followed by a horizontal divider, followed by all of the awaited items"). Until
  // then the fence's body rendered as a SEPARATE message above this card (ChatView's FenceCard dropped
  // its chrome and left the prose free-standing), and the pair read as two objects about one wait —
  // FenceCard now renders THIS card rather than one of its own, so the prose lives here or nowhere.
  // Null for a rest with no awaiting fence (a bare sub-agent rest, a shell-only rest) or a fence with
  // no prose; the divider comes and goes with it.
  const prose = awaitingProseBlock(stated?.body)
  const proseHtml = useMarkdownHtml(prose ?? "")
  // Live-ticking, so a shell's "running · 4m" keeps counting while the board sends nothing (a quiet
  // child pushes no delta). One clock read for the whole card rather than one per row.
  const now = useNowMs()
  // The fence's own `shells:` ride along at rest too. The board already rows them then, so this is
  // idle in that case — it is what keeps the card whole at a rest the thread was bumped past, where the
  // board has forgotten the fence (see AwaitingWaitOptions).
  const groups = awaitingWaitGroups(work, now, { hints, notAfter })
  const unrowed = unrowedWatchRefs(work, hints)
  // THE SNOOZE IS THE ONE THING THAT VARIES WITH THE RUNTIME, and the maintainer ruled it the only
  // thing that may (2026-09-04: "you can remove the snooze button and stuff because the interactive
  // elements obviously are no longer interactive, you should not be changing whether or not you
  // truncate or don't truncate, or changing the rendering of the title or the description").
  //
  // It renders exactly when the thread is PARKED ON THIS REST — the same predicate the queue and the
  // transcript tail already gate the card on, so nothing changes for them. What it excludes is the two
  // shapes that now reach this card through ChatView's fence block: a thread running past the rest, and
  // one the human has already bg-snoozed. Both would offer a park the mutation refuses
  // (router.snoozeAwaitingBackground guards on the rest instant). `notAfter` says the same thing from
  // the other side for a historical rest drawn in the transcript.
  const snoozable = notAfter === undefined && thread !== undefined && showsRestingCard(thread) && threadLifecycleAvailability(thread).snooze
  return (
    // The SAME shell as every transcript card (TranscriptCard). This card stacks directly under an
    // awaiting fence card on a queue card, and it used to be a visibly different object there —
    // smaller radius, a washed-out fill, its own padding, no kind header — for the same job.
    <TranscriptCard
      data-awaiting-background
      // THE GLYPH FOLLOWS THE TITLE, and there are exactly two of each. The terminal square goes with
      // the one kind-naming heading ("Background shells running"); everything else takes the generic
      // heading and the hourglass, which is honest for it — a thread holding a sub-agent or a PR
      // watcher genuinely IS waiting on something to come back. A per-kind glyph would rebuild the
      // per-kind card the consolidation removed, exactly as a per-kind title did.
      icon={shellsAlone(work) ? TerminalSquare : Hourglass}
      // WRAPPED AT ANY CHARACTER, because this heading can now be WORKER-AUTHORED. Every other card in
      // the family carries a code-authored label, so the header's wrap-don't-truncate rule never had to
      // survive an unbreakable token; a `title:` naming a branch, a URL or a base64 id is one. Measured
      // at the queue card's narrowest (368px content box, sans): a 40-character single token bled 135.64px
      // PAST the card's right edge without this, and wraps inside it with it.
      label={<span className="[overflow-wrap:anywhere]">{awaitingBackgroundLabel(work, hints)}</span>}
      // ONE watched PR the table does not already row rides the title, as the GitHub wake card's ref
      // does; SEVERAL take a row of their own under the prose (see unrowedWatchRefs).
      aside={unrowed.length === 1 ? <WatchedRef watch={unrowed[0]} /> : undefined}
      // The recessed footer band below sits flush against the card's bottom edge, so the shell's own
      // bottom padding has to go when one renders — the band carries its own.
      className={snoozable ? "pb-0" : ""}
    >
      {/* THE WORKER'S PROSE — the fence's whole Markdown body, block-rendered, exactly as the old
          free-standing message drew it (md-body inside card-md; QUEUE_WRAP so a long unbreakable token
          wraps on a narrow queue card instead of bleeding past the edge).

          QUEUE_WRAP UNCONDITIONALLY, on every surface. The fence card used to apply it on the queue
          alone, which is the transcript's ordinary rule (a roomy column scrolls on overflow) and the
          wrong one INSIDE a card: a card is a narrow column wherever it is drawn, and the same fence
          then wrapped in the queue and bled past the edge in the drawer. */}
      {prose
        ? <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={proseHtml} />
        // NEITHER SHAPE MAY CARD AS BLANK. A fence whose body is empty — or is nothing but machinery
        // lines, which never reach the reader — has no handoff to open on, and if it has no rows either
        // the card would be a bare heading. That is reachable only off a thread with nothing live (a
        // sub-agent's own transcript above all), and the sentence below is what it says instead.
        : groups.length === 0 && !hasUnrowedWork(work) ? <p className={CARD_BODY}>{AWAITING_NO_PROSE}</p>
        : null}
      {unrowed.length > 1 && (
        // `gap-x-3` rather than a punctuation separator: the refs are a set of targets, not a sentence,
        // and a wrapped "·" stranded at a line end reads as a typo. They wrap onto as many lines as the
        // card's width needs — six refs take three rows on a phone-width queue card without overflowing
        // it. `mt-2` (against the prose's own 20px leading) is what makes the block read as its own
        // group rather than as one more line of the paragraph.
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {unrowed.map((watch) => (
            <WatchedRef key={watch.ref} watch={watch} />
          ))}
        </div>
      )}
      {/* The sentence is BODY text (maintainer 2026-07-24): the self-return is a fact about the thread,
          not a caption for the button, so it reads as prose rather than as a label the Snooze control
          drags around with it — and it therefore stays on the surfaces that have no button.

          AND IT ONLY SURVIVES WHEN THERE ARE NO ROWS AT ALL, which since 2026-08-15 means almost never:
          every kind the card can be waiting on now has a row that names it, and a sentence counting the
          same things above them is one fact written twice ("this looks busy and shitty"). It stays as
          the honest fallback for the one reachable gap — a declared wait whose rows all failed to
          resolve — because a card with a heading and nothing under it says less than a sentence. */}
      {groups.length === 0 && hasUnrowedWork(work) && (
        <p className={CARD_BODY}>
          {waiting ? (
            // The subject never counts a watcher: a watcher is PARKED ON rather than dispatched, and
            // folding it in made the sentence claim the thread had dispatched a pull request.
            //
            // "It’s awaiting", not "Awaiting": the heading one line above already opens on that word,
            // and two lines starting with it read as a stutter. The verb still has to be AWAIT, which is
            // the distinction this branch exists for — a dispatched sub-agent returns and re-invokes its
            // parent, while a launched shell returns nothing there is anything to await.
            <>
              It’s awaiting the results from {awaitingBackgroundSubject(work, { watchers: false })} it dispatched. It
              returns to the queue on its own when the work comes back.
            </>
          ) : (
            // NOT "it returns to the queue" — this card IS the queue card now, and telling the human it
            // will arrive somewhere they are already looking is the one sentence that cannot be true
            // here. What is true is the resumption: a finished shell notifies its worker, which picks
            // the thread back up on its own. Kept SHORT because the Snooze beside it says the longer
            // version — the body and its action's caption are two surfaces, not one sentence twice.
            <>
              {awaitingBackgroundSubject(work, { watchers: false })}{" "}
              {liveShellCount(work) === 1 ? "is" : "are"} still running. It resumes on its own when{" "}
              {liveShellCount(work) === 1 ? "it finishes" : "one of them finishes"}.
            </>
          )}
        </p>
      )}
      <WaitGrid groups={groups} divider={!!prose} />
      {/* THE FOOTER BAND — the card's snooze, in a recessed full-width strip flush with the card's
          bottom corners (the queue card's own footer idiom), so the control reads as chrome under the
          content rather than as one more row of it. It draws on EVERY surface the card is live on as of
          2026-08-31; a historical rest (`notAfter`) draws the card with the shell's normal padding. */}
      {snoozable ? (
        <div data-awaiting-snooze className={`-mx-4 mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border bg-fg/[0.03] px-4 py-2.5 ${BLOCK_RADIUS_INNER_BOTTOM}`}>
          <AwaitingSnooze thread={thread} onSnooze={onSnooze} onSnoozeFailed={onSnoozeFailed} />
        </div>
      ) : null}
    </TranscriptCard>
  )
}
