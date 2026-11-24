import type { CompletionHold } from "@frizz/shared"
import { completionHoldSummary } from "../lib/threadLifecycle.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// THE BODY OF "End this session?", on the desktop header's check (ThreadLifecycle) and the phone bar's
// Done (PhoneDoneButton) alike. Ending a session kills its whole process tree, so this names what is about
// to die: the executing turn and/or every live sub-agent and background shell. The human clicked Done
// believing the thread was finished, and the specific work listed here is the correction.
//
// THE ROWS ARE THE OPS PANEL'S OWN (ChildOpRow, "panel"): its kind-hued live dot, the label, and how long
// it has been running, in a panel-like well. They were a "1 BACKGROUND SHELL" heading over a ⤷ line of
// bare text until 2026-11-24 (maintainer: "the rendering looks kind of weird … we have better ways of
// rendering these kinds of running tasks"). A row here opens nothing and stops nothing: the answer to this
// dialog is the act, and a drawer opened under a modal would be out of reach.
export function CompletionHoldBody({ hold, phone = false }: { hold: CompletionHold | undefined; phone?: boolean }) {
  const summary = completionHoldSummary(hold)
  return (
    <div data-completion-hold className={`flex flex-col gap-3 p-4 leading-relaxed text-muted ${phone ? "text-[14px]" : "text-[12.5px]"}`}>
      <p>{summary.lead}</p>
      {summary.rows.length > 0 && (
        // `pr-[3px]`: a panel row's dot sits in a 1em slot, 3px of it empty either side, so its ink stood 13px
        // inside the well's left border while the clock's ink stood 10px inside the right (measured
        // 2026-11-24, sans, desktop and phone). The 3px evens the two.
        <div data-completion-hold-rows className="flex min-w-0 flex-col rounded-lg border border-border bg-bg/40 py-1 pr-[3px] leading-normal">
          {summary.rows.map((row, index) => (
            <ChildOpRow
              key={`${row.kind}-${row.label}-${index}`}
              kind={row.kind}
              label={row.label}
              state={row.state}
              startedAt={row.startedAt}
              density="panel"
            />
          ))}
          {summary.overflow > 0 && (
            // Under the labels: the mark slot's 1em and the row's 8px gap.
            <div className="py-1 pr-2.5 pl-[calc(0.625rem+1em+8px)] text-[12px] text-muted-60">+{summary.overflow} more</div>
          )}
        </div>
      )}
      <p>{summary.trailer}</p>
    </div>
  )
}
