import type { ReactNode } from "react"
import { messageStamp } from "../lib/activityTime.ts"
import type { StampHost } from "../lib/stampHost.ts"

// The transcript's per-message time reading: invisible at rest, revealed at the message's own trailing
// edge on hover. It answers the one question the thread header cannot — the header's "Last active 12
// minutes ago" speaks for the WHOLE thread, so with a dozen sessions open there was no way to tell when
// any individual message came out (maintainer 2026-08-25).
//
// Chosen from a four-variant sheet (`src/message-timestamp-mockups-fixture.tsx`) as the least
// invasive: a tooltip on the message body draws OVER the transcript and hides the message above the
// one you are reading, a reserved gutter spends ~56px of prose width on every row forever for a
// reading that is blank almost always, and a hairline rule borrows the wake dividers' chrome, which
// elsewhere means "something happened here".
//
// THREE INVARIANTS, all load-bearing:
//
//   1. IT MUST NOT CHANGE THE ROW'S HEIGHT. The transcript is virtualized and measures every row
//      (`virtualizer.measureElement`), so a reveal that grew the row on hover would re-measure it and
//      shove the scroll position out from under the pointer — while the pointer is what is holding the
//      reveal open. Hence `absolute` + `top-full`: the reading is laid on the gap the next row already
//      owns as its top padding, and contributes nothing to this row's box.
//
//      That overflow is why the virtualizer's row wrapper carries a `hover:z-[1]` lift (see ChatView).
//      Rows are transform-positioned, so each is its own stacking context and the `z-10` below cannot
//      lift this above the NEXT row — among siblings at z-auto the later one always wins. The gap it
//      lands in is `STEP` (14px) at best and `META_CARD_STEP` (6px) at worst, against a 16px reading,
//      so on the tight rows it overflows most it would otherwise be painted underneath.
//
//   2. IT MUST NOT EAT A CLICK OR A SELECTION. `pointer-events-none` keeps it out of the way of the
//      text underneath, and it is `aria-hidden` — the same instant is already on the `<time>` element's
//      machine-readable `dateTime`, and announcing a timestamp on every message would make the
//      transcript unreadable to a screen reader for a reading sighted users only see on purpose.
//
//   3. ITS HOST MUST MATCH `MessageRow`'s BOX ON BOTH AXES — no padding below the message, and no
//      horizontal inset. Every offset below is calibrated against `MessageRow`'s `relative flex
//      flex-col px-6`, and `absolute` resolves `top-full` and `right-6` alike against the
//      containing block's PADDING box: a host with bottom padding pushes the reading down by exactly
//      that padding, and a host nested inside another `px-6` doubles the inset. The pinned band
//      violated this once on each axis, one commit apart (2026-08-28), which is why it is written
//      down rather than left as something the next host is expected to know.

/**
 * The reading itself. Rendered by `MessageRow` for every ordinary row, and DIRECTLY by the pinned
 * current-ask band.
 *
 * It is its own component because that pinned row never passes through `MessageRow`: it is hoisted out
 * of the virtualizer's absolute layer into normal flow, so that `sticky top-0` has the full transcript
 * as a containing block to pin across (see ChatView). Without this it would be the ONE message in the
 * transcript with no reading — and it is the message a reader is most likely to want dated, since it is
 * the ask the whole reply is answering. The band already carries `group/ts` and sits at `z-[9]`, so its
 * reveal is drawn over the content scrolling beneath it and needs no lift of its own.
 *
 * Renders nothing when the instant is missing or unparseable — the common path on legacy transcripts
 * recorded before `at` was on the wire.
 */
/**
 * What the reading hangs below. `prose` is agent text, whose ink ends inside its line box; `bubble` is
 * the user's off-white bubble, whose BOX ends exactly where the row ends. The offset below is a
 * measurement against the host's ink edge, and the two hosts do not share one.
 *
 * REQUIRED, with no default — the 7px between the two is the difference between air and a collision,
 * and a default cannot be right for both. It was optional (defaulting to `prose`) for one day, and in
 * that day the transcript's QUEUED row shipped without it: a bubble wearing the prose offset, whose
 * cap tops landed on the device row directly under the bubble's bottom edge. A missing host is now a
 * type error at the call site instead of a silent 7px.
 *
 * WHICH host a row takes is `stampHostFor` (lib/stampHost.ts), not a role test — four message shapes
 * are recorded as the user's and draw no bubble at all.
 */
export type { StampHost }

export function MessageStamp({ at, host }: { at: string | undefined; host: StampHost }) {
  const stamp = messageStamp(at)
  if (!stamp || !at) return null
  return (
    <time
      dateTime={at}
      aria-hidden="true"
      // Under PROSE, `-mt-[5px]` — not the `-mt-0.5` (2px) this shipped with, and the 3px is a
      // MEASUREMENT rather than taste. At -0.5 the reading's ink sat 6.66px below its own message and
      // 4.67px above the next one — CLOSER TO THE MESSAGE IT DOES NOT BELONG TO, which is worse than no
      // reading at all, because a timestamp that reads as the next message's is confidently wrong. At
      // -5px it sits 3.65px below its own message and 7.66px above the next, so proximity says plainly
      // which one it belongs to; that holds in the mono face too (3.04 / 7.96).
      //
      // Under a BUBBLE, `mt-[2px]`. The bubble's box ends where the row ends, with no line-box slack
      // beneath its ink — and unlike prose it ends on a HARD FILLED EDGE, which needs more clearance
      // than a ragged text edge before the eye reads "separate". This shipped at -2px, where the caps
      // cleared the bubble by 2.25px / 0.98px (sans / mono) against ~12px of air below — glued to the
      // box (maintainer 2026-08-31: "there's no gap between the time stamp and the bottom of the
      // bubble. it needs optical balance"). At +2px the caps clear by 6.25px / 4.98px with 7.8px /
      // 8.45px left below — real air on both sides, matching the ~5–6px ink rhythm the divider ages
      // keep, and still nearer its own bubble than the next row (14px away at the least — `STEP`;
      // +`USER_TAIL_EXTRA` before agent prose).
      //
      // Measured on the real component (`message-timestamp-verify-fixture.tsx`) at 13px prose in a 24px
      // line box, in BOTH fonts; re-measure if either type scale moves. The canvas probe runs ~1.5px
      // tight against the rendered picture, so read the RATIO rather than the absolute.
      //
      // `!pointer-events-none`, not the plain utility. On the PINNED band this element is a DIRECT
      // child of a wrapper carrying `[&>*]:pointer-events-auto` — the rule that re-enables the bubble's
      // hover-to-expand under a click-through band — and that arbitrary variant wins on specificity, so
      // the plain utility lost and the reading took the pointer. Invisible at rest and `top-full`, it
      // would have been a transparent 16px strip eating clicks on whatever scrolled beneath it. Measured
      // in the fixture: elementFromPoint over the reading returned the reading itself before this.
      className={`!pointer-events-none absolute right-6 top-full z-10 ${host === "bubble" ? "mt-[2px]" : "-mt-[5px]"} select-none text-[11px] leading-4 [font-variant-numeric:tabular-nums] text-muted-70 opacity-0 transition-opacity group-hover/ts:opacity-100`}
    >
      {stamp}
    </time>
  )
}

export function MessageRow({ at, host, gap, children }: { at: string | undefined; host: StampHost; gap: number; children: ReactNode }) {
  return (
    // A NAMED group (`group/ts`), not a bare one: the transcript nests plenty of its own `group`
    // hovers (the retractable bubble's unqueue control, the clickable dividers), and an unnamed group
    // here would be captured by whichever of them a variant happens to sit inside.
    <div className="group/ts relative flex flex-col px-6" style={{ paddingTop: gap }}>
      {children}
      <MessageStamp at={at} host={host} />
    </div>
  )
}
