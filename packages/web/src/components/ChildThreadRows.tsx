import type { ThreadView } from "@frizz/shared"
import { displayTitle } from "@frizz/shared"
import { CHILD_THREAD_NEEDS_YOU } from "../lib/childOps.ts"
import { childThreadStartedAt, childThreadState } from "../lib/childThreads.ts"
import { openThread } from "../store.ts"
import { ChildOpRow, type ChildOpDensity } from "./ChildOpRow.tsx"

// A THREAD'S CHILD THREADS, as rows under it — the rail's indented rows (Sidebar SubAgentRows, "rail")
// and the "child threads" panel over its prompt box (QueueOpsSummary, "card"), both drawn by the one
// child row every surface speaks (ChildOpRow, kind CHILD). The full page's rail draws them in its own
// table instead (AwaitingBackgroundCard ChildThreadRow), as it does sub-agents.
//
// EACH ROW OPENS THE CHILD (store.ts openThread): its card when it is queued for the human, else its
// drawer — stacked over this thread's drawer when that is the one open (stacksOver), so closing the child
// lands back on its parent. `parentSlug` marks the row as the parent drawer's own child row, which keeps
// that drawer from dismissing itself on the press (ThreadSheet onPointerDownOutside).
//
// The reading at the right edge: how long a running child has been at its current stretch of work, and
// "needs you" for a child held at a gate only the human can settle — the one rest of a child that
// reaches the human, and the reason its parent may be waiting. A child resting on a handoff to its
// parent reads nothing there; its hollow mark says it.
export function ChildThreadRows({ parent, childThreads, density }: { parent: string; childThreads: readonly ThreadView[]; density: ChildOpDensity }) {
  if (childThreads.length === 0) return null
  return (
    <>
      {childThreads.map((child) => {
        const title = displayTitle(child)
        return (
          <ChildOpRow
            key={child.id}
            kind="CHILD"
            label={title}
            state={childThreadState(child)}
            density={density}
            startedAt={childThreadStartedAt(child)}
            counter={child.needsYou ? CHILD_THREAD_NEEDS_YOU : undefined}
            parentSlug={parent}
            onOpen={() => openThread(child.id)}
            title={`Open child thread: ${title}`}
          />
        )
      })}
    </>
  )
}
