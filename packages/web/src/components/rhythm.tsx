// THE TRANSCRIPT'S VERTICAL RHYTHM — the between-block units and the spacer element that draws them.
//
// Extracted from ChatView so any surface can charge the same gaps without importing the whole thread
// view, and specifically so the frizz wake renderer can: ChatView imports that renderer, so it cannot
// reach back into ChatView for a number (the same reason WakeDivider lives in its own file). ChatView
// re-exports everything here, so no existing call site had to move.

// BETWEEN-BLOCK RHYTHM is expressed as explicit spacer ELEMENTS, never margins/padding/gap on the
// blocks themselves. An explicit element is visible in the tree, one uniform size, and can't collapse
// or double the way adjacent margins silently do. Padding INSIDE a block (its own chrome) is fine;
// the space BETWEEN sibling blocks is always a VSpace. STEP is the single between-block unit.
export const STEP = 14
// The tight run, and the ONE thing it is for: erasing the seam between two adjacent CARDS. A tool row carries
// its own 2px of padding and a node that marks where it starts, so 6px of clear space beside one already
// reads as a separation — which is why two bursts of tool calls can sit this close without turning to mush.
// Rows of ONE burst sit closer still, at no gap at all: they share a rail (ChatView ToolRailRows).
//
// It was never for two bare LABEL rows — `Ran N tool calls`, a collapsed `Reasoning` row, the live
// shimmer. A label has no border and no inset, so the gap is the ONLY separation there is,
// and two labels are not one batch: they are two separate statements. Those take the ordinary STEP (see
// messageGap). At 6px they sat 26px apart — the rows are 14px/20px and assistant prose is 14px/1.7 =
// 23.8px — so three stacked read as one wrapped paragraph of grey rather than as three lines (maintainer
// 2026-08-01, on `Ran 8 tool calls` / `Thought for 33s` / the shimmer: "All of these labels are way too
// close together", and again after a first pass only reached 10px: "the issue I was most concerned with
// was the fact that those three labels were all stacked so closely together").
//
// STEP is also the CEILING, measured rather than assumed: at 18px the labels stand further apart than
// the prose→label boundary above them, which inverts the hierarchy and reads as three orphaned lines.
// What makes these rows recede is their tone and size, never their spacing.
export const META_CARD_STEP = 6
// The gap a PICTURE takes, on whichever side it has a neighbour. A rendered screenshot is the one tool
// row that is not a compact band, and the tight run's premise ("6px apart already reads as two objects")
// fails twice over on it: the frame is tall enough to be its own region, and the picture inside is usually
// dark UI whose own edges sit within a few px of the frame's faint one. At 6px the
// next row lands on the image — measured 6.19px from the frame's bottom border to the shimmer's box
// (maintainer 2026-08-11: "we need better spacing under the screenshots … it's too close").
//
// It is BIGGER than STEP rather than equal to it because STEP separates rows of one weight class from
// each other; a picture outweighs everything around it, and matching the ordinary between-block gap
// still reads as the shimmer captioning the image. Symmetric — the air above a picture and the air
// below it are the same air, and splitting them made the frame look dropped rather than spaced.
export const PICTURE_STEP = 22
// The extra air beneath what the human said, on top of the ordinary STEP. A user message opens a turn,
// and a little more room under its bottom edge is what separates "what I asked" from "what happened
// next" (maintainer 2026-07-31: "a little more space underneath each user message, maybe 3 px more").
//
// It lands on the LAST message of a run, never on each one: consecutive user messages are one utterance
// the human split across sends, and spacing them apart internally would break up the very thing this
// exists to set off.
export const USER_TAIL_EXTRA = 3
// The pitch between two consecutive things the HUMAN sent — the run USER_TAIL_EXTRA closes. They are
// one utterance split across sends, so they stack like one: at STEP each bubble stood as far from the
// next as from the agent's prose, and three messages typed while the agent worked read as three
// separate turns (maintainer 2026-10-15: "they have a weird amount of space between them, even though
// they're all queued and you sent them all yourself"). Charged in the flow AND in the queued tail, so
// a run keeps its pitch when it lands.
export const HUMAN_RUN_STEP = 6

export function VSpace({ h = STEP }: { h?: number }) {
  return <div aria-hidden className="shrink-0" style={{ height: h }} />
}
