import type { BgShellView, ThreadView } from "@frizz/shared"
import type { TranscriptShellRecord } from "../lib/childOps.ts"
import type { SurfaceExit } from "../lib/threadContexts.ts"
import { QueueOpsSummary } from "./QueueOpsSummary.tsx"
import { ThreadLifecycleActions } from "./ThreadLifecycle.tsx"

// THE TONGUE: a strip hanging under the one-thread pane's prompt box (prototype; maintainer 2026-11-07:
// "add a tongue under the prompt box. put the artifact/watcher/subagent chips left justified and action
// icon right justified"). It carries what the thread HAS on the left — the live-op counts, each opening
// its panel of rows (QueueOpsSummary) — and what to DO with it on the right: snooze and mark as done,
// which leave the header for it.
//
// It is tucked under the box rather than stacked below it: inset from both corners so it meets the box's
// straight bottom edge, no top border of its own (the box's bottom border is the line between them), and
// the box's own fill, so the two read as one object with a tab pulled out of it.
//
// ITS TWO ENDS ARE SET BY INK: a count's chip pads 6px before its dot, and the check's 28px button holds
// 8px of empty box beside its stroke, so `pl-0.5 pr-0.5` puts 9.25px of space between the left border and
// the first dot and 9.5px between the check and the right border (measured at dsf 4, sans, 2026-11-07).
// The counts' cap band and the icons' ink both sit centred in the 32px, within 0.5px.
export function ThreadTongue({ thread, transcriptShells, exit }: {
  thread: ThreadView
  transcriptShells: readonly (BgShellView & TranscriptShellRecord)[]
  exit: SurfaceExit
}) {
  return (
    <div
      data-thread-tongue
      className="relative mx-3 -mt-px flex h-8 min-w-0 items-center rounded-b-[10px] border border-t-0 border-border bg-bg pl-0.5 pr-0.5"
    >
      <QueueOpsSummary thread={thread} transcriptShells={transcriptShells} variant="tongue" />
      <span className="ml-auto flex shrink-0 items-center">
        <ThreadLifecycleActions thread={thread} rule={false} onArchived={exit.dismiss} onDismissCancel={exit.cancel} onSnoozed={exit.dismiss} />
      </span>
    </div>
  )
}
