import type { SubAgentView } from "@frizz/shared"
import { pushSubAgentDrawer } from "../store.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// A queue handoff should name the work still running beneath the parent without turning it into a
// second operations toolbar. Live AND stale children render here (visibleChildOps "card", unified onto
// the rail's policy — a stale child is unresolved work, not gone, and a card that hid it read as "done
// underneath" while the rail still showed it); background shells/Monitors remain in BackgroundOpsStrip
// below as a separate runtime concern. The row itself is the shared ChildOpRow at "card" density — the
// same component, tokens and glyph the sidebar rail and the drawer's ops strip render. The dispatch's
// model+effort tag was REMOVED from these lines on 2026-07-27 (maintainer): the profile belongs to the
// prompt box's own control one line up, not repeated on every child line. It still rides the drill-in
// so the drawer knows which cell it opened.
//
// It DOES carry the dismiss × (maintainer 2026-07-30 — "the X button to stop a sub-agent should show up
// everywhere sub-agents are listed"). That is not the "second operations toolbar" this comment has
// always warned against: the card names the live work, and retiring a child that finished without
// signalling is the one action that reading provokes. The counters and the profile still stay off the
// card. The kind tag does not, since 2026-10-03: the shell, watcher and File/Link rows that continue this
// column below are tagged, so an untagged agent line here started a tag's width left of all of them —
// and the same child lost its tag every time its thread moved from the drawer to the queue (see
// ChildOpRow).
// They are the whole of the "agents" panel over a prompt box (QueueOpsSummary) since 2026-10-11; until
// then they opened one column the strip's rows continued, in a panel that listed every kind.
export function QueueSubAgentLines({
  slug,
  subAgents,
  // The ops COLUMN's padding, which is positional and therefore the caller's to set — the same prop
  // BackgroundOpsStrip takes, for the same reason.
  // Default = the column's opening padding with no bottom air, i.e. what a lone fixture wants.
  className = "px-1 pt-1.5",
  density = "card",
}: {
  slug: string
  subAgents: readonly SubAgentView[]
  className?: string
  density?: "card" | "panel"
}) {
  const visible = visibleChildOps(subAgents, "card")
  if (visible.length === 0) return null
  return (
    <div data-queue-subagents className={`flex min-w-0 flex-col ${density === "panel" ? "" : "gap-0.5"} ${className}`}>
      {visible.map((agent, index) => (
        <ChildOpRow
          key={agent.id ?? `${agent.startedAt}-${index}`}
          kind="AGENT"
          label={agent.label}
          state={agent.state}
          density={density}
          depth={agent.depth}
          startedAt={agent.startedAt}
          // What the child is DOING right now. The counters stay off a handoff card (see ChildOpRow).
          parentSlug={slug}
          onOpen={agent.id ? () => pushSubAgentDrawer(slug, agent.id!, { label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
          onDismiss={childOpDismisser(slug, agent)}
        />
      ))}
    </div>
  )
}
