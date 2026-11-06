import type { ReactNode } from "react"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"

// What a read-and-answer session gets in place of what it may not do: see useReadAndAnswerHost. Neither says
// anything until the supervisor has said what this session may do, because on a full-control session it would
// not be true.

/** The one line in place of a prompt box, which holds that box's place while it waits. */
export function ReadAndAnswerNote({ host }: { host: string }) {
  const known = useSupervisorStatus().data !== undefined
  return <p data-remote-note className="min-w-0 text-[13px] text-muted">{known ? `Starting or steering a thread happens on ${host}.` : "\u00a0"}</p>
}

/** The line on a card that names where it has to be answered. */
export function ReadAndAnswerCardNote({ className, children }: { className: string; children: ReactNode }) {
  const known = useSupervisorStatus().data !== undefined
  return known ? <p data-remote-note className={className}>{children}</p> : null
}
