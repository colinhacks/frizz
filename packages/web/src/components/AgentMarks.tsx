import { useState } from "react"
import { flushSync } from "react-dom"
import type { McpTarget } from "@frizz/shared"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { AGENT_MARKS } from "../lib/iconRhythm.ts"
import { McpPlug } from "./McpPlug.tsx"
import { QuotaGauge, useSelectedModel, type GaugeModel } from "./QuotaBar.tsx"

// THE AGENT'S MARKS: usage and MCP, to the right of a prompt box's model chip, in every box on a desktop
// (maintainer 2026-11-06: "the move is just to put the agent-specific icons to the right of the chip"). Both
// answer for whichever model the chip has selected, so they read as subordinate to it. They were split until
// then, the gauge in the status row above the box and the plug in the row or the rail depending on the box.
//
// A phone has neither: its model chip shares a tool row with the box's other tools, and its Settings sheet
// carries the account's quota.
//
// ONE OPEN AT A TIME, SO ONE LIT AT A TIME (maintainer 2026-11-09: "it shouldn't be possible to hover in the middle
// of them and have them both show up at once"). The two squares overlap a little (lib/iconRhythm.ts) and each stays
// lit while its panel is open, so the strip holds ONE open mark rather than one each. Two rules decide who has it:
//
//   - The pointer reaching the plug shuts the gauge's panel in that same frame. The gauge's panel opens on a hover
//     and survives 150ms of the pointer leaving, for the crossing into the panel, and that grace is what kept the
//     gauge lit under a pointer already on the plug.
//   - The plug's menu stays while the pointer passes over the gauge. It was clicked open and can hold a sign-in in
//     progress, so the gauge lights nothing and opens nothing until a click on it takes over.

type AgentMark = "gauge" | "plug"

/** One mark's share of the strip's single open panel. */
export interface MarkPanel {
  open: boolean
  /** The other mark's panel is open, so this mark takes no hover. */
  neighbourOpen: boolean
  setOpen: (next: boolean) => void
  /** Shuts the other mark's panel before the next paint. */
  shutNeighbour: () => void
}

export function AgentMarks({ gauge, mcp, side }: {
  /** The model to read usage for. Absent for an agent that reports no quota. */
  gauge?: GaugeModel
  /** What the plug asks about. Absent until there is something to ask. */
  mcp?: McpTarget
  /** Which way their panels open: away from whatever the box sits against. */
  side: "top" | "bottom"
}) {
  const [openMark, setOpenMark] = useState<AgentMark | null>(null)
  const panel = (mark: AgentMark): MarkPanel => ({
    open: openMark === mark,
    neighbourOpen: openMark !== null && openMark !== mark,
    // Only its owner can clear it: the gauge's grace timer can land after the plug has taken over.
    setOpen: (next) => setOpenMark((current) => (next ? mark : current === mark ? null : current)),
    // Synchronous: left to the scheduler, the gauge's fill can outlive the plug's first lit frame.
    shutNeighbour: () => flushSync(() => setOpenMark((current) => (current === mark ? current : null))),
  })
  return (
    <div data-agent-marks="" className={AGENT_MARKS}>
      {gauge && <QuotaGauge selected={gauge} side={side} panel={panel("gauge")} />}
      {mcp && <McpPlug target={mcp} side={side} panel={panel("plug")} />}
    </div>
  )
}

/** A new-thread box's marks. There is no thread yet, so they answer for what the model chip has selected. The
 *  plug waits for the profile to load, so it never reads one agent's servers under another's chip. */
export function NewThreadAgentMarks() {
  const gauge = useSelectedModel()
  const { resolved } = useDispatchProfile()
  const mcp: McpTarget | undefined = resolved
    ? { backend: resolved.backend, ...(resolved.backend === "acp" ? { model: resolved.model } : {}) }
    : undefined
  // Down: this box is at the top of its column, with the sidebar's rows or the dialog's own space below it.
  return <AgentMarks gauge={gauge} mcp={mcp} side="bottom" />
}
