import type { ThreadView } from "@frizz/shared"
import { useThreadRename } from "../hooks/useThreadRename.ts"
import { AiRenameButton } from "./AiRenameButton.tsx"

// THE THREAD'S NAME, AND BOTH WAYS OF CHANGING IT — click the name to type a new one, or point at it
// and press the refresh mark to have Claude re-derive one. Rendered by the thread header (ChatView);
// the queue card's header drew it too, from this ONE component, until the card went (2026-11-10). The
// two had drifted before that: the queue card carried only the refresh mark until 2026-09-13 — its title was a
// plain div, on the theory that the queue is a triage surface and a manual rename belongs in the
// drawer — and the maintainer met the asymmetry on the first card they wanted to retitle ("It only
// lets me rename. I should be able to click on it to retitle it.").
//
// The editor is the title's OWN box: the name is a button, the click swaps in an input. What a commit,
// a cancel and a refusal do is hooks/useThreadRename.ts, shared with the rail row's double-click editor.
//
// Foreign rows and legacy docs have no registry row to rename, so the name is plain text there; the
// refresh mark makes its own call (AiRenameButton) and hides while the editor is open.
export function ThreadTitle({ thread, className = "" }: { thread: ThreadView; className?: string }) {
  const rename = useThreadRename<HTMLInputElement>(thread)
  const { shown } = rename
  // `group/thread-title` is the refresh mark's hover zone. `min-w-0 shrink` on the name rather than
  // `flex-1`, so a short title does not push the mark to the far side of the row — and so a short
  // name does not claim the whole row as a click target.
  return (
    <div className="group/thread-title flex min-w-0 items-center gap-2">
      {rename.editing ? (
        <input
          {...rename.editorProps}
          // The box grows OUT from the name, not the name into the box: `-mx-1.5` cancels the padding
          // and `-my-px` the border, so the text stays where the button drew it (a 1px shift, the
          // border's own width) and the row keeps its height while the editor is open. The drawer's
          // editor used to jump the text 8px right and the "Last active" line 3px down.
          className={`min-w-0 flex-1 -mx-1.5 -my-px rounded-md border border-border bg-elevated px-1.5 py-0 font-semibold text-[15px] text-fg outline-none focus:border-accent ${className}`}
        />
      ) : rename.canRename ? (
        <button
          type="button"
          title="Edit title"
          aria-label={`Edit thread title: ${shown}`}
          disabled={rename.pending}
          onClick={rename.start}
          className={`min-w-0 max-w-full shrink truncate rounded px-0.5 -mx-0.5 font-semibold text-[15px] text-left outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        >
          {shown}
        </button>
      ) : (
        <div className={`min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px] ${className}`} title={shown}>
          {shown}
        </div>
      )}
      <AiRenameButton thread={thread} hidden={rename.editing} />
    </div>
  )
}
