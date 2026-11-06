import type { ReactElement, ReactNode } from "react"
import { X } from "lucide-react"
import { BoxSpinner } from "./BoxSpinner.tsx"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { PRIMER } from "../lib/primer.ts"
import {
  CHILD_ARROW,
  CHILD_ARROW_CLASS,
  CHILD_DISMISS_NOUN,
  CHILD_DISMISS_TITLE,
  CHILD_DISMISS_VERB,
  CHILD_KIND_TAG_CLASS,
  CHILD_MARK_SLOT_CLASS,
  CHILD_OPEN_TITLE,
  CHILD_RESTED_DOT_CLASS,
  CHILD_RESTED_TITLE,
  CHILD_STALE_DOT_CLASS,
  CHILD_STALE_SHELL_TITLE,
  CHILD_STALE_TITLE,
  CHILD_THREAD_RESTED_TITLE,
  CHILD_THREAD_STALE_TITLE,
  PANEL_ROW_MARK_SLOT_CLASS,
} from "../lib/childOps.ts"

// GITHUB is a PR watcher the worker parked on. It is a child op in every way that matters to this row —
// something running underneath the thread that will wake it — even though nothing of ours is executing:
// it is GitHub that is being watched (maintainer 2026-08-13: "now GitHub watchers can be included in the
// ranks of those"). COMMAND and TIMER are the other two waits a worker parks on — a check the server
// re-runs until it passes, and a clock — and they joined on 2026-10-15, when the line of counts over the
// prompt box became where a steps card's waits are listed. Both are parked waits as a PR watch is, so
// they take its hue, and neither has anything to open or stop.
//
// CHILD is a CHILD THREAD (`frizzctl spawn-child`, 2026-11-04): a whole thread this one started, drawn
// under it wherever its sub-agents are (lib/childThreads). It takes the sub-agent's hue — it is an agent
// doing this thread's work — and opens the child's own drawer, stacked over the parent's (store.ts
// stacksOver). It carries no ×: a thread is stopped or archived from its own drawer, not from a row.
export type ChildOpKind = "AGENT" | "SHELL" | "GITHUB" | "COMMAND" | "TIMER" | "CHILD"

// The ONE surface knob, and the only thing any caller may vary. It encodes REAL information-density
// differences between the three places a child row appears — not styling preference:
//   rail  — the sidebar's indented child rows. The [ ]/[/] checkbox motif (BoxSpinner) that the whole
//           rail speaks, at 12px, indented to clear the parent row's indicator column. NEVER swap this
//           for the pulsing dot: matching the parent rows is the point. The rail keeps carrying the raw
//           subagent type in its tooltip, which is now the only place it appears at all. No kind tag.
//   card  — a queue card's live child lines: dot + petite-caps kind tag + label, like the sheet.
//   sheet — the drawer's background-ops strip: dot + petite-caps kind tag + label.
// THE CARD CARRIES THE KIND TAG TOO (maintainer 2026-10-03: "sometimes that little small caps AGENT
// label shows up and other times it doesn't, and I don't know why"). It used to be left off as "ops
// chrome", but the card's column was never agents alone: the shell, watcher and File/Link rows beneath
// these lines render through the drawer's own strip, tag and all. So one card mixed tagged and untagged
// rows — the agent labels starting a tag's width left of every other label in the column — and the same
// child gained and lost its tag as the thread moved between the queue and the drawer. The two prompt-box
// densities now differ only in the indicator hook and the press handling below.
// The dismiss × is NOT one of those differences any more — see `onDismiss`.
//   panel — a panel over the prompt box (QueueOpsSummary), which holds one kind of row, and the triangle
//           on it points at the count naming that kind. So no ⤷ and no kind tag: a mark, the label, the ×
//           and the readings, on one line. It is THE MENU'S ROW (ui/Menu.tsx): 12px text in `py-1.5 px-2.5`,
//           30px tall, and the whole row takes the fill and the press, so going straight up from a count
//           lands on it. 36px rows read as "weirdly spacious. Nothing else in Frizz is that spacious"
//           (maintainer 2026-11-06), and 17px ones gave the pointer nothing to hit.
// All of them carry the light-gray DURATION the child has been working — right-justified at the end of the
// row (maintainer 2026-07-27), so a column of rows reads its numbers down one edge instead of at
// whatever ragged offset each label happens to end. It reads at the SAME size as the title and every
// other reading on the row; the size lives on the container for exactly that reason.
export type ChildOpDensity = "rail" | "card" | "sheet" | "panel"

// ONE row for "a thing running underneath this thread", rendered identically everywhere it appears.
// Before this component existed the same row was written four times and the copies drifted — two arrow
// alphas six pixels apart on one queue card, two stale-dot alphas, and three different answers for a
// child with no id. Every token it draws comes from lib/childOps.ts.
//
// WHAT THE ROW DELIBERATELY NO LONGER CARRIES (maintainer 2026-07-27, on the rows under the prompt box):
//   • the ↗ hover glyph — the drill-in affordance is the TITLE itself (it underlines on hover and is
//     the button), so a second, quieter icon saying the same thing was noise;
//   • the bracketed model+effort tag — the profile belongs to the prompt box's own control one line up,
//     not repeated on every child line.
//
// POLICY for a child with no `id` (nothing to drill into): a NON-INTERACTIVE row — a plain <div> with
// the same layout, no hover, no focus stop. Never a `disabled` button (which announces an affordance
// that isn't there) and never a dropped row (which silently hides live work). Same rule on all three
// densities: `onOpen` absent ⇒ non-interactive, present ⇒ a real button.
export function ChildOpRow({
  kind,
  label,
  state,
  density,
  depth,
  startedAt,
  counter,
  counterTitle,
  counterTone,
  parentSlug,
  onOpen,
  onDismiss,
  title,
}: {
  kind: ChildOpKind
  label: string
  // "rested" is a sub-AGENT only reading: its own run ended while the fan-out it dispatched kept going
  // (see CHILD_RESTED_TITLE). It draws a hollow dot in place of the live/stale one and nothing else on
  // the row changes — the live children still pulse, indented one step beneath it.
  state: "running" | "stale" | "rested"
  density: ChildOpDensity
  // How far down the dispatch tree this row sits: 1 (or absent) = a child the THREAD dispatched, 2 = a
  // child of that child, and so on. Each level past the first steps the row right by one indent, so a
  // fanned-out branch reads as the tree it is. The arrow glyph already says "hangs off the line above";
  // the indent says WHICH line. Absent ⇒ renders exactly as it did before nesting existed.
  depth?: number
  // ISO of the child's DISPATCH. Rendered as a light-gray compact duration ("38s", "12m", "1hr 5m"),
  // live-ticking; absent ⇒ no
  // reading (never a fabricated one). Deliberately not a "last active" recency: anything still listed
  // here is running or stale-but-tracked, so "recently active" is already implied and the recency read
  // as near-zero information (maintainer 2026-07-28). How long it has been WORKING is the number that
  // tells you whether to go look at it.
  startedAt?: string
  // A LIVE COUNTER for this row, rendered immediately left of the duration — "142 lines" for a
  // background shell (see shellLinesLabel). The duration keeps the right edge it established, so a
  // column of rows still reads its ages down one line; the counter forms a second column inside it.
  // Absent ⇒ the row renders exactly as it did before this existed, which is the case for every row
  // whose surface does not poll for one.
  counter?: string
  counterTitle?: string
  // THE ONE COUNTER THAT MAY OUTRANK THE ROW'S OWN DIMNESS. Every reading in this column is `text-muted-40`,
  // deliberately — a strip of live work is scanned, not read, and "1.2k lines" earns no more ink than the
  // age beside it. A watched PR whose CI has gone RED is the exception: it is the number that decides what
  // the human does next, and rendered in the column's uniform grey it was indistinguishable from a
  // timestamp (caught reading back this row's own first screenshot, 2026-09-04). Absent ⇒ the column's
  // grey, which is what every other row still takes.
  counterTone?: "danger"
  // Drill-in marker: keeps an open ThreadSheet for this slug from self-dismissing on the pointer-down,
  // so the child transcript STACKS over its parent instead of replacing it (see ThreadSheet).
  parentSlug?: string
  // Absent ⇒ a non-interactive row (never a dropped one).
  onOpen?: () => void
  // The dismiss ×, on EVERY density (maintainer 2026-07-30: "the X button to stop a sub-agent should
  // show up everywhere sub-agents are listed"). It used to be an ops-strip-only affordance, which meant
  // the rail and the queue card listed the same live child and offered no way to retire it — you had to
  // find the one surface that had the control. Absence is now a property of the ROW, not the surface:
  // a descendant or an id-less child has nothing to dismiss (see lib/dismissChildOp.ts), everything
  // else carries it. Absent ⇒ no ×.
  onDismiss?: () => void
  // Tooltip override. The rail passes "[subagent-type] label" — the type reading it has no room to render.
  title?: string
}): ReactElement {
  const running = isRunningOperation(state)
  // ONE HUE PER RUNTIME CONCERN, and the row is the only place they are named. A sub-agent pulses the
  // accent-yellow, a background shell the azure blue, a PR watcher the green.
  const LIVE_DOT_HUE = { AGENT: "frizz-live-dot--agent", SHELL: "frizz-live-dot--shell", GITHUB: "frizz-live-dot--github", COMMAND: "frizz-live-dot--github", TIMER: "frizz-live-dot--github", CHILD: "frizz-live-dot--agent" } as const
  // THE TAG IS FIVE CHARACTERS ON EVERY KIND. `GITHUB` is six, and before this column had a track of
  // its own it pushed that row's label 4.3px right of every other row under the mono stack (where
  // five-letter tags are pixel-identical at 21.39px). `WATCH` is also the more accurate word: the row is
  // a watch on a PR, and the green dot beside it already says which service.
  //
  // The column IS a shared track now: CHILD_KIND_TAG_CLASS carries `.frizz-kind-tag` (styles.css), a
  // fixed per-font width, so the labels line up whatever a tag measures — on these rows and on the
  // File/Link rows that share the strip beneath them. That is what closed the ~2px AGENT-vs-SHELL
  // raggedness the sans stack used to carry. Keep the words five letters anyway: the mono track is
  // sized to exactly that width.
  const KIND_TAG = { AGENT: "AGENT", SHELL: "SHELL", GITHUB: "WATCH", COMMAND: "WATCH", TIMER: "TIMER", CHILD: "CHILD" } as const
  const clickable = !!onOpen
  const rail = density === "rail"
  const sheet = density === "sheet"
  const panel = density === "panel"
  // Live-ticking recency, on every density. useNowMs re-renders this row ~every 30s so the reading
  // keeps counting up even while the board sends nothing (a steadily-quiet child pushes no delta).
  const now = useNowMs()
  const elapsed = compactElapsedSince(startedAt, now)
  // One indent step per level below the first. 13px is the arrow glyph's own advance plus its gap, so a
  // nested row's arrow lands under its parent's LABEL — the same relationship the rail's child rows
  // already have with their thread row. Clamped: a runaway depth must step the row, never push the label
  // out of a narrow rail entirely.
  // A panel's rows have no arrow, so its step is what puts a nested row's mark under its parent's label:
  // the 12px mark slot and the 8px gap.
  const nestIndent = Math.min(Math.max((depth ?? 1) - 1, 0), 4) * (panel ? 20 : 13)
  // Which of the ×'s two honest meanings this row's control carries. A running row only ever receives
  // an `onDismiss` when the server said it is stoppable (lib/dismissChildOp.ts), so "running" here is
  // always a real kill; everything else is retiring a finished op.
  const dismissTone = running ? "running" : "settled"
  const openTitle = CHILD_OPEN_TITLE[kind]
  const rowTitle = title ?? (clickable ? openTitle : undefined)

  // The liveness mark. The rail speaks the rail's checkbox language; the card and the drawer share the
  // pulsing-dot language, in a fixed-width column so their labels line up across both surfaces. A row
  // that is not running is FLAT on every density and every kind — a stale SHELL is a process the OS has
  // confirmed gone, so only its words differ (see CHILD_STALE_SHELL_TITLE).
  const quiet = state === "rested"
    ? <span className={CHILD_RESTED_DOT_CLASS} title={kind === "CHILD" ? CHILD_THREAD_RESTED_TITLE : CHILD_RESTED_TITLE} />
    : <span className={CHILD_STALE_DOT_CLASS} title={kind === "SHELL" ? CHILD_STALE_SHELL_TITLE : kind === "CHILD" ? CHILD_THREAD_STALE_TITLE : CHILD_STALE_TITLE} />
  const liveDot = (
    <span
      aria-hidden
      className={`frizz-live-dot ${LIVE_DOT_HUE[kind]}`}
      data-running-indicator={density === "card" ? "queue-subagent" : "operation"}
    />
  )
  const indicator = rail ? (
    <span className="flex w-3.5 shrink-0 items-center justify-center">
      {running ? <BoxSpinner size={12} /> : quiet}
    </span>
  ) : panel ? (
    // ON THE CAP BAND, computed by the browser: the count over the box draws its mark the same way, and
    // QueueOpsSummary carries the reasoning. The slot's width is the file and link rows' icon column.
    <span className={PANEL_ROW_MARK_SLOT_CLASS}>
      <span className="absolute inset-0 flex items-center justify-center">{running ? liveDot : quiet}</span>
    </span>
  ) : (
    // THE DOT IS LIFTED OFF THE FLEX CENTRE — see `.frizz-op-dot-slot` in styles.css for the readings
    // and for why the correction is font-scoped. `items-center` centres the dot's BOX on the line; the
    // eye reads it against the CAP BAND of the label beside it, and the two are not the same place.
    <span className={`frizz-op-dot-slot ${CHILD_MARK_SLOT_CLASS}`}>
      {/* A running SHELL pulses blue, a running sub-AGENT pulses the accent-yellow. */}
      {running ? liveDot : quiet}
    </span>
  )

  // `ml-auto` is what right-justifies them: the readings are the LAST item in the row's flex line, so
  // they take every pixel the (truncating) label leaves behind and sit flush at the right edge. The
  // DURATION stays rightmost whatever else joins it — that column is what a stack of rows is read down
  // — and the counter falls in beside it, separated by the same `·` the progress label already uses.
  const reading: ReactNode = counter || elapsed ? (
    <span className={panel ? "ml-auto flex shrink-0 items-baseline gap-1 pl-1.5 text-[11px] text-muted-50" : "ml-auto flex shrink-0 items-center gap-1 pl-1.5 text-muted-40"}>
      {counter && (
        // The tone rides a Primer colour rather than a Tailwind red, because the same fact is drawn in
        // the same colour on the awaiting card two surfaces away (ChecksGlyph → PRIMER.fgDanger).
        <span data-child-op-counter title={counterTitle} style={counterTone === "danger" ? { color: PRIMER.fgDanger } : undefined}>{counter}</span>
      )}
      {counter && elapsed && <span aria-hidden className="text-muted-25">·</span>}
      {elapsed && <span title={`Working for ${elapsed}`}>{elapsed}</span>}
    </span>
  ) : null

  const identity = panel ? (
    <>
      {indicator}
      <span className={`min-w-0 truncate text-fg/85 ${clickable ? "group-hover:text-fg" : ""}`}>{label}</span>
    </>
  ) : (
    <>
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      {indicator}
      {!rail && <span className={CHILD_KIND_TAG_CLASS}>{KIND_TAG[kind]}</span>}
      <span className={`min-w-0 truncate text-muted-70 ${rail ? "leading-[16px]" : clickable ? "group-hover:text-fg/80 group-hover:underline" : ""}`}>{label}</span>
    </>
  )

  // THE LABEL TAKES EVERY PIXEL THE ROW HAS, on every density: the × and the reading are shrink-0 and
  // the reading is `ml-auto`, so the label sits at its natural width and truncates only where the row
  // actually runs out. The prompt-box densities used to cap it at `max-w-[60%]`, which left room for a
  // "current step" reading after it; the step left the row, the cap stayed, and a 440px panel cut
  // "Building the validate/is schema…" off with a third of the line empty (maintainer 2026-10-20:
  // "There's no reason for them to get truncated there").
  const rowClass = panel
    // The row's press lands on the wrapper below; this button is what a keyboard reaches, and its label
    // truncates inside it.
    ? `flex min-w-0 items-baseline gap-2 overflow-hidden text-left outline-none ${clickable ? "cursor-pointer" : ""}`
    : rail
    // The rail's 26px INDENT stays on the identity element, not on the row wrapper: it is the gutter
    // that clears the parent thread row's indicator column, and it has always been part of the click
    // target. Putting it on the wrapper renders identically (the duration is `ml-auto`, so the right
    // edge does not move) while quietly carving that gutter out of the drill-in — for no gain.
    ? "group flex min-w-0 items-center gap-2 pl-[26px] text-left outline-none"
    // `overflow-hidden` is load-bearing at a narrow width: the arrow/dot/kind tag inside are shrink-0,
    // so once the row runs out of room the button's own content used to SPILL and the × landed on top
    // of the "AGENT" tag. Clipping keeps the collapse graceful. The ring goes inset to survive it.
    : `group flex min-w-0 items-center gap-1.5 overflow-hidden text-left text-[11.5px] ${clickable ? "cursor-pointer rounded-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60" : ""}`

  // The rail indents with PADDING, not margin: a margin would carve the row wrapper's full-width hover
  // highlight back on every nested row. The two prompt-box densities have no such highlight, so they
  // shift the whole LINE (on the wrapper, below), keeping the × and the duration in step with the label.
  const identityStyle = rail && nestIndent > 0 ? { paddingLeft: 26 + nestIndent } : undefined

  const row = clickable ? (
    <button
      type="button"
      style={identityStyle}
      onClick={panel ? undefined : onOpen}
      // Only the ops strip swallows the press: it can sit inside a card/drawer whose own mousedown
      // handler would otherwise act on it. The rail and card rows must let the pointer-down through —
      // ThreadSheet reads it (via data-subagent-parent) to decide to STACK rather than dismiss.
      onMouseDown={sheet ? (e) => e.stopPropagation() : undefined}
      title={rowTitle}
      aria-label={`${openTitle}: ${label}`}
      className={rowClass}
    >
      {identity}
    </button>
  ) : (
    <div style={identityStyle} title={rowTitle} className={rowClass}>
      {identity}
    </div>
  )

  // ONE line shape for all three densities: [ identity button ] [ × ] [ duration ]. The identity is a
  // button and the × is a button, so they can only ever be SIBLINGS — a button cannot nest inside a
  // button, which is what forced this wrapper in the first place. The × sits DIRECTLY AFTER the title
  // (maintainer 2026-07-27: at the far right it read as too subtle to find) with the duration pushed to
  // the right edge behind it, and it is always visible, quietly — a control you have to discover by
  // hovering is exactly the complaint.
  //
  // text-[11.5px] sits on the CONTAINER, not only on the label button: the ×, the counters and the
  // reading are all SIBLINGS of that button, so a size set only on it leaves them inheriting
  // the parent's larger one. That is exactly what happened when the reading moved to the right edge
  // (maintainer 2026-07-28: "why did you make the 5 min ago labels bigger… it should be the same font
  // size as the title"). One size here keeps every reading on the row in step.
  //
  // The RAIL's row box — its padding and its full-width hover highlight — moved to this wrapper when
  // the × arrived, because the button no longer spans the row and a highlight on the button would stop
  // short of the × and the duration. The indent stayed on the button (see rowClass).
  const wrapperClass = panel
    ? `flex min-w-0 items-baseline gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${clickable ? "group cursor-pointer hover:bg-hover-strong has-[:focus-visible]:bg-hover-strong" : ""}`
    : rail
    ? "flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-[11.5px] transition-colors hover:bg-hover"
    : "flex min-w-0 items-center gap-1.5 text-[11.5px]"
  const wrapperStyle = !rail && nestIndent > 0 ? { marginLeft: nestIndent } : undefined

  // The two row markers ride the WRAPPER, not the identity button, because they describe the ROW.
  // `data-subagent-parent` is the one that does work: ThreadSheet resolves an outside pointer-down with
  // `closest("[data-subagent-parent]")` and keeps itself open when the press landed on one of its own
  // child rows. On the rail the button used to span the row, so every pixel of it answered that query;
  // the × and the duration now sit outside it, so the marker moved out with them to keep the coverage
  // the rail already had.
  //
  // MEASURED, so the comment does not overclaim (adhoc stack, thread sheet open over the board): with
  // the marker on the button ALONE, pressing the × still did not dismiss the sheet — that press never
  // reaches Radix's outside-dismiss — while clicking a plainly-outside sidebar control did dismiss it.
  // So this restores coverage on principle (the duration strip is the part that actually loses it),
  // not a reproduced bug.
  return (
    <div
      className={wrapperClass}
      style={wrapperStyle}
      data-op-row={onDismiss ? "" : undefined}
      data-subagent-depth={depth && depth > 1 ? depth : undefined}
      data-subagent-parent={parentSlug}
      // THE WHOLE PANEL ROW IS THE TARGET, its readings included, so the press lands here rather than on
      // the button. A keyboard's Enter on the button arrives here too, as a click that bubbles.
      onClick={panel && clickable ? onOpen : undefined}
      // As the ops strip's button does below: a panel is portaled, but a press in it still bubbles through
      // React to the card or drawer it was opened from.
      onMouseDown={panel ? (e) => e.stopPropagation() : undefined}
    >
      {row}
      {onDismiss && (
        <button
          type="button"
          onClick={(e) => {
            if (panel) e.stopPropagation()
            onDismiss()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={CHILD_DISMISS_TITLE[dismissTone]}
          aria-label={`${CHILD_DISMISS_VERB[dismissTone]} ${CHILD_DISMISS_NOUN[kind]}: ${label}`}
          className={`shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${panel ? "-ml-1 self-center" : ""}`}
        >
          <X size={11} />
        </button>
      )}
      {reading}
    </div>
  )
}
