import type { McpTarget } from "@frizz/shared"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { useConsoleDispatchTarget } from "./ConsoleProjectChip.tsx"
import { GithubTrigger } from "./GithubTrigger.tsx"
import { McpPlug } from "./McpPlug.tsx"

// THE NEW-THREAD BOX'S TWO DOORS, in the line above it rather than in its icon rail (maintainer
// 2026-11-05, from a mockup sheet): the rail keeps what acts on the message being typed, the paperclip
// and send, and these open something else, the GitHub picker and the agent's MCP servers. StatusRow draws
// them beside the gear, and ⌘K's new-thread dialog, which has no such row, at the right of its title.
//
// A thread's own box keeps its plug in the rail (ThreadComposerBox.tsx): no row runs above it. A phone
// keeps its tool row (PhoneNewThreadPage), which is where GitHub is a labelled chip.
//
// Each is a bare mark on STATUS_ROW_ACTION, so the row's one `gap-3` is their ink rhythm too. Each renders
// nothing until it has something to open.

export function PromptBoxActions() {
  return (
    <>
      <GithubTrigger />
      <NewThreadPlug />
    </>
  )
}

/** The Console's row sits outside the box's own scope, so it reads the project the box's chip points at. */
export function ConsolePromptBoxActions() {
  const { project } = useConsoleDispatchTarget()
  return <ProjectScope project={project?.slug}><NewThreadPlug /></ProjectScope>
}

function NewThreadPlug() {
  const { resolved } = useDispatchProfile()
  // What the plug asks about: the agent the model chip picks, since there is no thread yet. Undefined while
  // the profile is still loading, so the plug never reads one agent's servers under another's chip.
  const target: McpTarget | undefined = resolved
    ? { backend: resolved.backend, ...(resolved.backend === "acp" ? { model: resolved.model } : {}) }
    : undefined
  return target ? <McpPlug target={target} placement="row" /> : null
}
