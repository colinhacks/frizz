// EVERY WAKE FRIZZ DELIVERS, rendered as frizz speaking rather than as the human's own words.
//
// Named for the whole family since 2026-08-19, when the last two members joined it: it was
// `GithubWakeCard` back when a review steer was the only thing it drew, and the name outlived the job by
// two features. What arrives here is any user turn the server flagged `wake` — a PR watcher's review
// activity, its status lines, a background shell that finished while nobody was awake, and whatever the
// parsers below do not recognize.
//
// THE RULE THE WHOLE FILE FOLLOWS: a wake frizz composed ITSELF is a hairline, because it is one line of
// news about something outside the turn. A wake carrying prose someone else WROTE — a worker's own timer
// text, a message this build cannot parse — keeps the card, because a card is the shape with a body in
// it. The agent-facing trailer that frizz appends to its own messages is dropped in every case: it
// instructs the worker about its own registrations, and the human reading the transcript has none.
//
// The wake is recorded as an ordinary user turn (it is pasted into the worker's composer), so the chat
// rendered it in the off-white right-justified bubble the human's messages wear — which claimed the
// operator had typed a message the PR watcher composed. This is the correction.
//
// It is a WAKE DIVIDER, not a card (maintainer 2026-07-31, after a gallery of ten alternatives: "I hate
// the design of the new comment notification card… it just feels wrong"). The diagnosis that picked
// this shape: the transcript already had one idiom for this class of event, and this was the only
// holdout. A background shell coming to rest, a Monitor timing out, a sub-agent finishing and a
// sub-agent reporting up all render as WakeDivider — and a PR-watcher wake is the same class, an external
// event the worker was waiting on that reached a notable state and re-invoked it. It alone still wore a
// full TranscriptCard, which is what made it read as a different, louder kind of thing than it is.
//
// Three defects went with the card and are gone with it: ~350px of dead air between a left-pinned title
// and a right-pinned ref; a p-4 inset wrapped around a SINGLE 20px line, when every other card in that
// shell has a body; and three marks on one row that all looked clickable (an underlined title, an
// accent ref, the corner glyph) with no hierarchy between them.
import { useId, useState } from "react"
import { AlarmClock, Bell, Github, Hourglass, MessageCircleOff, TerminalSquare } from "lucide-react"
import { isGithubWakeBacklog, parseGithubWakeSteer, parseLimitModelSwitchWake, parseLimitResumeWake, parseParkWake, parsePrWatchExpiredWake, parsePrWatchStateWake, parsePrWatchWake, parseQuestionsCancelledWake, parseShellDoneWake, parseTimerWake, stripWakeTrailer, type GithubWakeSteer, type LimitWindow, type ParkWake, type PrWatchStateWake, type PrWatchWake, type ShellDoneWake, type TimerWake } from "@frizz/shared"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { VSpace } from "./rhythm.tsx"
import { WakeDivider } from "./WakeDivider.tsx"
import { githubRefUrl } from "../lib/githubRef.ts"
import { wakeCardTitle } from "../lib/githubWakeCard.ts"

// The divider's own link language. It is NOT the accent `CARD_LINK` the cards use: a divider is quiet
// transcript punctuation, and an accent-gold link inside one shouts louder than the event does. This is
// the same muted underline the sub-agent divider's drill-in title wears, so every divider's link reads
// the same way.
const DIVIDER_LINK = "rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"

// ---- THE ROW LIST IS GONE (2026-08-13) -----------------------------------------------------------
// A burst used to hang one row per item under the divider — actor, kind, age, each its own permalink.
// Two things killed it, and they point the same way.
//
// IT DID NOT SCALE, and the case that broke it is the common one. The first park on a PR replays
// everything already sitting there, so a PR that has been open a while rendered its whole review history
// into a queue card: "For PRs that have been around for a long time, it's going to render like a hundred
// reviews, so let's hide all of that on the initial watcher registration" (maintainer 2026-08-13).
//
// AND NOBODY NEEDED IT HERE. The full detail still reaches the WORKER — every item, with its permalink
// and its read-the-inline-comments instruction, in the delivered steer — which is where it is acted on:
// "we could certainly surface all of those things to the agent quietly, just so the agent knows the
// history… the agent can kind of handle it itself". What the transcript owes a human is one line saying
// the watcher fired and roughly what landed, with the PR one click away. That is the divider.

// `at` is the DELIVERY's instant — when frizz pasted this wake into the composer — and it is what every
// hairline here dates itself by, with two exceptions that carry a better one of their own: a single
// review item dates by GitHub's clock (when the comment was filed, which is the news), and a timer by
// the instant it was set to fire.
export function FrizzWake({ steer: served, text, sourceId, at, wrap }: { steer?: GithubWakeSteer; text: string; sourceId?: string; at?: string; wrap?: boolean }) {
  // THE WHOLE-DELIVERY WAKES, settled first and each on its own: none is ever a PART of a message, and
  // none shares anything with the GitHub grammar below.
  const shell = parseShellDoneWake(text)
  if (shell) return <ShellDoneDivider wake={shell} sourceId={sourceId} at={at} />
  const timer = parseTimerWake(text)
  if (timer) return <TimerDivider wake={timer} sourceId={sourceId} />
  const limit = parseLimitResumeWake(text)
  if (limit) return <LimitResumeDivider window={limit.window} sourceId={sourceId} at={at} />
  const switched = parseLimitModelSwitchWake(text)
  if (switched) return <LimitModelSwitchDivider capped={switched.capped} to={switched.to} sourceId={sourceId} at={at} />
  const park = parseParkWake(text)
  if (park) return <ParkDivider wake={park} sourceId={sourceId} at={at} />
  const lapsed = parsePrWatchExpiredWake(text)
  if (lapsed) return <PrWatchExpiredDivider watchRef={lapsed.ref} sourceId={sourceId} at={at} />
  // The ONE wake on the registered-question path frizz writes in its own voice. Its sibling — the human's
  // ANSWER — never reaches this component at all: it is written in the answers wire form, which Message
  // recognizes and draws as the human's own card before it ever asks whether frizz delivered the turn.
  const cancelled = parseQuestionsCancelledWake(text)
  if (cancelled) return <QuestionsCancelledDivider count={cancelled.count} sourceId={sourceId} at={at} />
  // ONE DELIVERY, UP TO THREE PARTS. A poll that saw CI flip, a label move AND a comment land composes
  // all of it into one message (prWatchWakeMessage), and each is its own event, so each gets its own
  // hairline. They render in the order the scheduler wrote them: verdict, PR state, review activity.
  const status = parsePrWatchWake(text)
  // The SERVER's parse wins, because it is the only one that cannot be a build behind the formatter
  // that wrote this text (see TranscriptMessage.wakeSteer). Parsing here is the fallback for a legacy
  // transcript or a server too old to send the field — it is also what this component did exclusively
  // until a steer grew two lines the shipped parsers had never seen and every open tab lost its divider.
  //
  // The COMBINED case is the one exception, and it is deliberate that the server does not serve it: the
  // steer's parser reads line 0 and nothing else, so a status line above it means no served steer — and
  // that is what keeps an already-open tab on an older bundle rendering the whole text rather than
  // silently dropping the CI verdict it would not know to draw. Here the status lines come off first
  // (each is exactly what `parsePrWatchWake` recognizes on its own) and the remainder is the steer.
  // The PR's own state moving is a THIRD part of the same delivery, on the same footing: its own line,
  // its own hairline, stripped from the steer's input like the status line beside it.
  const state = parsePrWatchStateWake(text)
  const steer = served ?? parseGithubWakeSteer(
    status || state ? text.split("\n").filter((line) => !parsePrWatchWake(line) && !parsePrWatchStateWake(line)).join("\n") : text,
  )
  // Neither part recognized — a legacy transcript, a timer or limit wake, a format this build predates —
  // still gets first-party chrome. Only the structured lines are lost, never the text. This one stays a
  // CARD: there is arbitrary prose to show, and a divider is a one-line shape.
  // NOT `self-end`: right-justification is the human's side of the conversation, and that placement is
  // most of what made a watcher notification read as something the operator sent.
  if (!steer && !status && !state) {
    return (
      <div data-frizz-msg={sourceId} data-frizz-wake className="min-w-0 max-w-[85%]">
        <TranscriptCard icon={Bell} label="Frizz">
          {/* The trailer comes off HERE too, so the file's rule ("dropped in every case") is true of the
              one branch that renders arbitrary text. The server strips it in the display projection and
              this is normally a no-op — but this branch exists precisely for a delivery the parsers
              missed, and that is exactly when the boilerplate used to reach the operator. */}
          <div className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`}>{stripWakeTrailer(text)}</div>
        </TranscriptCard>
      </div>
    )
  }
  if (status || state) {
    // ONE ELEMENT, AND A REAL STEP BETWEEN THE TWO HAIRLINES. This branch used to return a bare
    // fragment, which got both of them wrong at once. Every surface that stacks messages charges the
    // gap BETWEEN them itself — the queue card and the virtualized thread with an explicit VSpace, the
    // wake fixture with a container `gap` — so a fragment handed its two parts to that machinery as if
    // they were two separate messages: in a gapped container they were pushed a whole step further
    // apart than the hairlines they were nested in, and in a gap-less one they collapsed to the 8px
    // their own `my-1` margins leave, against the 22px every other pair of successive dividers stands
    // at. Three hairlines in a row therefore drew two different pitches — 40px then 26px — depending
    // only on which of them happened to arrive in one delivery (maintainer 2026-08-19, on a card whose
    // fold, CI verdict and review comment stacked exactly that way).
    //
    // A wrapper makes the delivery ONE block to whatever stacks it, and the VSpace inside it charges
    // the same STEP a message boundary would. The two parts are two events either way — the file's
    // whole premise — so the pitch between them must not say which delivery carried them.
    return (
      <div data-frizz-wake className="flex flex-col">
        {/* Only the FIRST part takes the sourceId: `data-frizz-msg` is the chat's per-message handle
            (scroll anchor, React key) and two rendered nodes must never claim one id. The parts render
            in the order the scheduler wrote them — CI verdict, then PR state, then review activity. */}
        {status && <PrWatchStatusDivider wake={status} sourceId={sourceId} at={at} />}
        {state && (
          <>
            {status && <VSpace />}
            <PrWatchStateDivider wake={state} sourceId={status ? undefined : sourceId} at={at} />
          </>
        )}
        {steer && (
          <>
            <VSpace />
            <GithubSteerDivider steer={steer} text={text} at={at} />
          </>
        )}
      </div>
    )
  }
  return <GithubSteerDivider steer={steer!} text={text} sourceId={sourceId} at={at} />
}

// ---- THE FIRED-TIMER HAIRLINE, WHICH IS THE ONE THAT KEEPS A BODY -----------------------------------
// Every other wake here is frizz's own sentence about something outside the turn, and a hairline says all
// of it. This one carries the WORKER'S OWN prose — whatever it asked frizz to hand back at this instant —
// so a bare hairline would be the only place in the app that text has ever been rendered, and it would
// destroy it. The Goal prompt collapses to a bare label for a reason that does not reach here: its text
// is the ARMED text, still sitting legible and editable in the footer panel (see RecurringPromptLine).
// A one-off's registration is gone the moment it delivers.
//
// So: the family's shape, with the body one click away (maintainer 2026-08-19, over both a card and a
// bare line). The TOGGLE is real — the two clickable dividers that came before this one expand ONE WAY
// and unmount — which is why `WakeDivider` grew `ariaExpanded`/`ariaControls` for it.
//
// The affordance rides the LABEL, not the icon, and that is deliberate: every wake divider's glyph says
// what KIND of event this is, and a fired alarm is an event. The two elision dividers wear a chevron
// glyph instead precisely because they stand for nothing that happened. "Click to expand" is spelled the
// way `MiddleRunsSummary` already spells it, so the transcript has one phrase for this and not two.
function TimerDivider({ wake, sourceId }: { wake: TimerWake; sourceId?: string }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <div data-frizz-msg={sourceId} className="flex flex-col">
      <WakeDivider
        icon={AlarmClock}
        marker="timer"
        // The timer's OWN instant, not the delivery's: the exact reading on hover is the only thing that
        // says WHICH timer this was when several were armed at once.
        at={wake.at}
        onClick={() => setOpen((v) => !v)}
        ariaExpanded={open}
        ariaControls={bodyId}
        ariaLabel={`${open ? "Collapse" : "Expand"} the text this timer handed back`}
      >
        <span className="shrink-0">Timer</span>
        <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        <span className="shrink-0">{open ? "Click to collapse" : "Click to expand"}</span>
      </WakeDivider>
      {open && (
        // The same ruled aside the reasoning disclosure uses, and PLAIN pre-wrapped text rather than
        // markdown: this is what the worker typed into `mcp__frizz__timer`, and rendering it as markdown
        // would restyle a sentence that was never written as any.
        // Flush LEFT, unlike the reasoning aside this borrows its rule from: that one indents to sit
        // under its own left-flush label, and this divider's label is centred, so 5px of inset would be
        // aligned to nothing. The transcript's own edge is the only reference on the row.
        <div id={bodyId} className="mt-1.5 whitespace-pre-wrap border-l border-border/70 pl-3 text-[13px] text-muted [overflow-wrap:anywhere]">
          {wake.prompt}
        </div>
      )}
    </div>
  )
}

// ---- THE PARK-INTEGRITY HAIRLINES ------------------------------------------------------------------
// A declared wait that ran out, or one whose work finished. Both are the same class as every other
// divider in this file — an external event the worker was waiting on reached a notable state and
// re-invoked it — and they belong to the family for the same reason a shell finishing does.
//
// They arrived as CARDS until 2026-08-24, printing their whole body: which tool to call, which fence to
// write, "end in ```done or ask a ```question". None of that is addressed to the reader (maintainer:
// "frizz cards that seem to be exposing internals"). What IS theirs is the one line of news plus, on
// the expired one, WHICH items are still outstanding — so the item list is the disclosure and the
// instruction paragraph is dropped, exactly as the timer's agent-facing trailer is.
// `Hourglass` deliberately, and it is NOT borrowed from the limit-resume line below: the hourglass is
// already this app's mark for a parked thread — the rail's Snoozed band wears it — so a park ending is
// exactly what it should draw. The limit line is the one that shares it.
// QUESTIONS TAKEN AWAY, not answered: the thread went autonomous while registrations were still open, so
// they were cancelled wholesale and nobody is coming. One line, because that is the whole of the news and
// the instruction that rides with it to the worker ("decide it yourself") is not addressed to the reader.
function QuestionsCancelledDivider({ count, sourceId, at }: { count: number; sourceId?: string; at?: string }) {
  const label = `${count} question${count === 1 ? "" : "s"} cancelled — the worker decides ${count === 1 ? "it" : "them"} itself`
  return (
    <WakeDivider icon={MessageCircleOff} sourceId={sourceId} marker="event" ariaLabel={label} at={at}>
      <span className="min-w-0 truncate">{label}</span>
    </WakeDivider>
  )
}

function ParkDivider({ wake, sourceId, at }: { wake: ParkWake; sourceId?: string; at?: string }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // Terse, because every sibling on this rule is ("PR merged on …", "Background task «…» finished"). The
  // first draft read "The declared wait is over — its work finished" and was the longest line on the
  // page by half again.
  const label = wake.kind === "expired" ? "Wait expired — nothing resolved" : "Wait over — its work finished"
  // No disclosure without items: an empty aside is a control that opens onto nothing.
  if (!wake.items.length) {
    return (
      <WakeDivider icon={Hourglass} sourceId={sourceId} marker="event" ariaLabel={label} at={at}>
        <span className="min-w-0 truncate">{label}</span>
      </WakeDivider>
    )
  }
  return (
    <div data-frizz-msg={sourceId} className="flex flex-col">
      <WakeDivider
        icon={Hourglass}
        marker="event"
        at={at}
        onClick={() => setOpen((v) => !v)}
        ariaExpanded={open}
        ariaControls={bodyId}
        ariaLabel={`${open ? "Collapse" : "Expand"} what this wait named`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        <span className="shrink-0">{open ? "Click to collapse" : "Click to expand"}</span>
      </WakeDivider>
      {open && (
        <div id={bodyId} className="mt-1.5 whitespace-pre-wrap border-l border-border/70 pl-3 text-[13px] text-muted [overflow-wrap:anywhere]">
          {wake.items.join("\n")}
        </div>
      )}
    </div>
  )
}

// A registered watcher whose own `for:` ran out. One line, and the ref is the only thing on it a reader
// can act on — so it is the link, the same muted underline every other divider's link wears.
function PrWatchExpiredDivider({ watchRef, sourceId, at }: { watchRef: string; sourceId?: string; at?: string }) {
  const url = githubRefUrl(watchRef)
  const label = `Watcher on ${watchRef} expired`
  return (
    <WakeDivider icon={Github} sourceId={sourceId} marker="event" ariaLabel={label} at={at}>
      <span className="min-w-0 truncate">
        Watcher on{" "}
        {url
          ? <a href={url} target="_blank" rel="noreferrer" className={DIVIDER_LINK}>{watchRef}</a>
          : watchRef}
        {" "}expired
      </span>
    </WakeDivider>
  )
}

// ---- THE USAGE-LIMIT RESUME HAIRLINE -----------------------------------------------------------------
// The counterpart to the amber pause card, and deliberately much quieter than it. The PAUSE is the
// notable state — the turn was cut off mid-work and the human may want to act — and it keeps its card.
// This is only "the window rolled and the thread is going again", which is one line of news (maintainer
// 2026-08-19). The agent-facing half of the sentence, "Continue exactly where you left off", is dropped
// like every other trailer here: it is an instruction to the worker, and the human has nothing to
// continue.
function LimitResumeDivider({ window, sourceId, at }: { window: LimitWindow; sourceId?: string; at?: string }) {
  const which = window === "weekly" ? "Weekly usage limit" : window === "session" ? "Session usage limit" : "Usage limit"
  const label = `${which} reset — resuming`
  return (
    <WakeDivider icon={Hourglass} sourceId={sourceId} marker="limit-resume" ariaLabel={label} at={at}>
      <span className="min-w-0 truncate">{label}</span>
    </WakeDivider>
  )
}

// The MODEL-SCOPED cap's other answer, and the reason it cannot borrow the hairline above: nothing
// reset. The cap is still standing and frizz moved the thread onto the next model down instead, so the
// line names BOTH models — the second one is what the composer's selector now reads, and this is the
// only place the transcript says why it changed.
//
// TERSER THAN THE STEER IT IS DRAWN FROM, and the narrow width is why. "Fable 5 limit reached —
// restarted on Opus" truncates at 420px to "…RESTARTED ON …", losing the destination — the one word
// the line exists to carry. This wording is shorter than the resume hairline beside it, so it survives
// intact at every width the drawer renders at.
function LimitModelSwitchDivider({ capped, to, sourceId, at }: { capped: string; to: string; sourceId?: string; at?: string }) {
  const label = `${capped} limit — switched to ${to}`
  return (
    <WakeDivider icon={Hourglass} sourceId={sourceId} marker="limit-model-switch" ariaLabel={label} at={at}>
      <span className="min-w-0 truncate">{label}</span>
    </WakeDivider>
  )
}

// ---- THE BACKGROUND-SHELL HAIRLINE -----------------------------------------------------------------
// Deliberately INDISTINGUISHABLE from the divider the runtime-reported completion draws — same glyph,
// same «guillemets», same outcome words as the server's own `backgroundWakeLabel`. That is the entire
// point: one shell finishing is one event, and which of the two reporters saw it is an accident of
// whether the worker happened to be at rest.
//
// The TASK ID is parsed but not drawn. It is the handle the worker names on an `awaiting` fence, not
// something a reader correlates by eye, and the runtime's own line has never carried one — printing it
// on only the half of the cases frizz reports would put the difference back on the screen.
function ShellDoneDivider({ wake, sourceId, at }: { wake: ShellDoneWake; sourceId?: string; at?: string }) {
  // The server truncates its own label at 64 chars for the same reason: a divider is a hairline, and a
  // 400-character shell description wraps it into a paragraph.
  const desc = wake.label.length > 64 ? `${wake.label.slice(0, 63)}…` : wake.label
  const label = `Background task «${desc}» ${wake.outcome}`
  return (
    <WakeDivider icon={TerminalSquare} sourceId={sourceId} marker="event" ariaLabel={label} at={at}>
      <span className="min-w-0 truncate">{label}</span>
    </WakeDivider>
  )
}

// ---- THE STATUS HAIRLINE ---------------------------------------------------------------------------
// A PR reaching a terminal state, or CI reaching a terminal verdict. Same watcher, same PR and the same
// class of event as the review divider below, so it wears the same chrome — which it did not until
// 2026-08-18, when it was the last thing a registered watcher said that still arrived as a full-width
// bordered card. Two of them stacked under a run of hairlines is what prompted the fix ("these callouts
// should obviously be hairlines"), and the card was carrying LESS news than the hairlines above it: the
// only thing under its title was one line of state and a parenthetical addressed to the worker.
//
// THE TRAILER IS DROPPED, not rendered. "This watcher is spent" and "STILL ARMED — drop it with
// mcp__frizz__watch_pr" are instructions to the agent about its own registration; a human reading the
// transcript has no watcher to re-register and no tool to call.
//
// STATE FIRST, ref second, matching the review divider's `{title} on {ref}` — so the news survives the
// truncation at queue-rail width, where the label clips from the right.
function PrWatchStatusDivider({ wake, sourceId, at }: { wake: PrWatchWake; sourceId?: string; at?: string }) {
  const href = githubRefUrl(wake.ref)
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={DIVIDER_LINK}>
      {wake.ref}
    </a>
  ) : (
    <span>{wake.ref}</span>
  )
  // ONE CASE TREATMENT ON THE LINE — petite caps end to end, ref included (see the note on the review
  // divider's label). `PR` and `CI` are already uppercase, so they render as full caps and stay legible
  // as the acronyms they are.
  // `gated` is neither of the two verdicts and must not be drawn as one — the ternary that stood here
  // read "passing ? passed : failed", so an approval-gated line would have said CI FAILED.
  const ciLead = wake.kind === "ci"
    ? wake.verdict === "passing" ? "passed" : wake.verdict === "failing" ? "failed" : "awaiting approval"
    : ""
  const lead = wake.kind === "ci" ? `CI ${ciLead} on ` : `PR ${wake.kind} on `
  // The failing jobs — and the held workflows, which are the same thing said about a gate — ride INSIDE
  // the truncating span: naming them is the most useful thing either line can do, and losing the tail of
  // a long list costs nothing the verdict has not already said.
  const jobs = wake.kind !== "ci" ? ""
    : wake.verdict === "failing" && wake.failing.length ? `: ${wake.failing.join(", ")}`
    : wake.verdict === "gated" && wake.gating.length ? `: ${wake.gating.join(", ")}`
    : ""
  const checks = wake.kind !== "ci" ? null
    : wake.verdict === "passing" && wake.passed !== undefined
      // The skips ride with the tally rather than replacing it. A green line that hides them is how "15
      // checks green" got said about 3 real successes (nodejs/node#65795, 2026-09-04).
      ? `${wake.passed} ${wake.passed === 1 ? "check" : "checks"} green${wake.skipped ? `, ${wake.skipped} skipped` : ""}`
    : wake.verdict === "gated"
      ? `${wake.gated} ${wake.gated === 1 ? "workflow" : "workflows"} held`
    : null
  return (
    <WakeDivider
      icon={Github}
      sourceId={sourceId}
      marker="github"
      at={at}
      // Only the inert form takes the separator role — a divider carrying a focusable link may not.
      ariaLabel={href ? undefined : `${lead}${wake.ref}${jobs}${checks ? ` · ${checks}` : ""}`}
    >
      <span className="min-w-0 truncate">
        {lead}
        {ref}
        {jobs}
      </span>
      {checks && (
        // Outside the truncating span, like the age on the tail: when the sentence clips, the tally is
        // the one field small enough to always survive it. Dot and tally are two flex items on the
        // label's gap, the same rhythm the age behind them takes (see DividerAge).
        <>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
          <span className="shrink-0 tabular-nums">{checks}</span>
        </>
      )}
    </WakeDivider>
  )
}

// ---- THE PR-STATE HAIRLINE -------------------------------------------------------------------------
// The PR itself moving — a conflict appearing, a label added or dropped, a reviewer requested. Same
// watcher, same chrome and the same one-line shape as the two dividers around it, because it is the
// same class of event: something happened on a PR nobody in this thread was looking at.
//
// The detail is rendered as frizz WROTE it, one opaque string, and it rides INSIDE the truncating span:
// the clauses are ordered by how much they matter (a conflict first, then labels, then a review
// request), so clipping from the right loses the least important one — which is the whole reason
// `prStateChanges` builds them in that order.
function PrWatchStateDivider({ wake, sourceId, at }: { wake: PrWatchStateWake; sourceId?: string; at?: string }) {
  const href = githubRefUrl(wake.ref)
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={DIVIDER_LINK}>{wake.ref}</a>
  ) : (
    <span>{wake.ref}</span>
  )
  return (
    <WakeDivider
      icon={Github}
      sourceId={sourceId}
      marker="github"
      at={at}
      ariaLabel={href ? undefined : `PR updated on ${wake.ref}: ${wake.detail}`}
    >
      <span className="min-w-0 truncate">
        {"PR updated on "}
        {ref}
        {`: ${wake.detail}`}
      </span>
    </WakeDivider>
  )
}

// ---- THE REVIEW-ACTIVITY HAIRLINE ------------------------------------------------------------------
function GithubSteerDivider({ steer, text, sourceId, at }: { steer: GithubWakeSteer; text: string; sourceId?: string; at?: string }) {
  const refUrl = githubRefUrl(steer.ref)
  const total = steer.items.length + steer.omitted
  // THE FIRST-PARK REPLAY IS NOT NEWS, and saying "2 new items" about a PR's existing history is a lie
  // the reader acts on. It reads as what it is — the watcher catching the worker up — and it never
  // names an actor or an age, because "who filed it" and "how stale" are questions about an EVENT.
  const backlog = isGithubWakeBacklog(text)
  // A wake carrying exactly ONE item is the common case by far, and it is said entirely by the divider's
  // label: the kind, who filed it, which PR, and how stale. Several items read as a count — naming three
  // kinds in one line is worse than counting them, and the worker has the full list either way.
  const only = !backlog && steer.items.length === 1 && steer.omitted === 0 ? steer.items[0] : null
  // ONE link on the line, and it is the ref. The card this replaced put a link on the title AND on the
  // ref AND a glyph beside them — three marks that all looked interactive, with no hierarchy saying
  // which one to press.
  //
  // So the two collapse into one: the visible text stays `owner/repo#N`, but for a single item the href
  // is that ITEM'S PERMALINK. "Read that exact comment" is the whole point of the wake, and a comment
  // permalink IS a url on that PR — following the ref lands you on the PR *at the comment*, which is
  // strictly what you wanted from either of the two links. A burst has no single item to deep-link, so
  // it points at the PR and its rows carry their own permalinks.
  const href = only?.url ?? refUrl
  // "ALREADY on", not "caught up ON … ON": the ref is appended with `on` below, so any title ending in a
  // preposition says it twice. `already` is also the word doing the work — it is what tells the reader
  // this is history the watcher handed over, not something that just happened.
  const title = backlog
    ? `${total} ${total === 1 ? "item" : "items"} already`
    : wakeCardTitle(total, steer.items[0]?.label ?? "item", only?.actor)
  // ONE CASE TREATMENT ON THE LINE, and that is the whole fix (maintainer 2026-08-13: "the rendering on
  // '2 new items …' Looks fucking insane because it's mixing small caps with regular font").
  //
  // The label used to escape three of its own runs back to ordinary case with `WAKE_DIVIDER_IDENT` — the
  // login, the ref and the age — on the reasoning that a GitHub token is something you match by eye and
  // small capitals make it read as prose. Each escape was defensible alone; together they alternated the
  // line's casing FOUR times in twelve words, and the line stopped reading as a line.
  //
  // So it wears its family's treatment whole, like every other divider in the transcript (the shell
  // wake, the sub-agent wake, the collapsed-run summary — all petite-caps end to end). The ref keeps its
  // link underline, which is what marks it as the thing to press; it no longer needs a second signal in
  // a different alphabet. `WAKE_DIVIDER_IDENT` survives for callers with a genuinely mixed line.
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={DIVIDER_LINK}>
      {steer.ref}
    </a>
  ) : (
    <span>{steer.ref}</span>
  )
  return (
    <WakeDivider
      icon={Github}
      sourceId={sourceId}
      marker="github"
      // A single item dates by GITHUB's clock — when the comment was filed is the news, and how stale it
      // is answers whether to hurry. A burst or a backlog has no one instant to name, so it dates by the
      // delivery like every other wake; a backlog above all must not carry an item's age, because "how
      // stale" is a question about an event and a first-park replay is not one.
      at={only?.at ?? at}
      // Only the inert form takes the separator role — a divider carrying a focusable link may not.
      // The sentence here must stay in step with the nodes below.
      ariaLabel={href ? undefined : `${title} on ${steer.ref}`}
    >
      {/* The label TRUNCATES rather than wrapping. At queue-rail width the full sentence does not fit,
          and a divider whose label wraps to four lines stops being a hairline at all — it was the first
          thing that broke when this shape was tried. */}
      <span className="min-w-0 truncate">
        {title} on {ref}
      </span>
    </WakeDivider>
  )
}
