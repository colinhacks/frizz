import { FrizzStatus, type ThreadView } from "@frizz/shared"

type RecoveryThread = Pick<ThreadView, "kind" | "foreign" | "runtime">

// CAN this session be resumed at all: an OWNED (non-foreign) session row whose process is gone.
// Recovery works through the ordinary follow-up path — the server reattaches the dead provider
// session, retires any phantom Codex turn, then starts the continuation — and that holds whether the
// exit was a mid-turn crash or an ordinary rest. Foreign sessions are read-only; a live session has
// nothing to retry.
//
// This is a CAPABILITY, not the affordance. It deliberately ignores lifecycle (`state`/fences), so it
// is NOT what any surface should gate a Retry button on: every visible Retry comes from
// groups.ts `offersRetry` (the STALLED rows PLUS the ones killed by an auto-resume usage limit), which
// consults this and then lets archived / done-fenced / answered / snooze-or-timer-held threads keep
// their own mark and affordance. Gating a surface on this directly is exactly how the drawer ended up
// offering Retry on 158 archived threads whose rail rows showed a muted [✓] (maintainer 2026-07-23).
// Its one caller is sessionIndicatorKind.
export function canRetry(thread: RecoveryThread): boolean {
  return thread.kind === "session" && thread.foreign !== true && thread.runtime === "exited"
}

// Lifecycle order for status pickers: planning → planned → active → blocked → done → dismissed.
// This is the shared FrizzStatus enum's own declaration order — single-sourced, never re-listed.
export const STATUS_ORDER: readonly FrizzStatus[] = FrizzStatus.options

// One HUE per status, shared by the picker dots and the listing chips so the color language is a
// single vocabulary. Every status must be tellable apart at a dot's glance — an earlier palette
// gave planned/done/dismissed three near-identical grays. done is deliberately the ONLY gray
// (settled, nothing to see); dismissed reads as "rejected" (rose); YELLOW is reserved for exactly
// `needs-human` — the awaiting-you state — since that is the app's focus/attention motif. `blocked`
// (now a pure machine-wait) keeps its warm orange, adjacent but distinct from the needs-human yellow.
export const STATUS_DOT: Record<string, string> = {
  planning: "bg-planning",
  planned: "bg-planned",
  active: "bg-active-status",
  "needs-human": "bg-needs-human",
  blocked: "bg-blocked",
  done: "bg-zinc-400",
  dismissed: "bg-dismissed",
}

// Chip variant of the same hues (text + border), plus the UI-level "archived" pseudo-status,
// which only ever appears as a chip in the inactive listing.
export const STATUS_CHIP: Record<string, string> = {
  planning: "text-planning border-planning/40",
  planned: "text-planned border-planned/40",
  active: "text-active-status border-active-status/40",
  "needs-human": "text-needs-human border-needs-human/40",
  blocked: "text-blocked border-blocked/40",
  done: "text-zinc-400 border-zinc-400/40",
  dismissed: "text-dismissed border-dismissed/40",
  archived: "text-slate-500 border-slate-500/40",
}
