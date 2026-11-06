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

export function AgentMarks({ gauge, mcp, side }: {
  /** The model to read usage for. Absent for an agent that reports no quota. */
  gauge?: GaugeModel
  /** What the plug asks about. Absent until there is something to ask. */
  mcp?: McpTarget
  /** Which way their panels open: away from whatever the box sits against. */
  side: "top" | "bottom"
}) {
  return (
    <div data-agent-marks="" className={AGENT_MARKS}>
      {gauge && <QuotaGauge selected={gauge} side={side} />}
      {mcp && <McpPlug target={mcp} side={side} />}
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
