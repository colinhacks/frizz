import { useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { displayTitle } from "../groups.ts"
import { THREAD_TITLE_MAX_LENGTH, manualThreadTitleSeed, threadTitleToCommit } from "../lib/threadTitle.ts"
import { AiRenameButton } from "./AiRenameButton.tsx"

// THE THREAD'S NAME, AND BOTH WAYS OF CHANGING IT — click the name to type a new one, or point at it
// and press the refresh mark to have Claude re-derive one. Rendered by the thread header (ChatView)
// and by the queue card's header (TodosView) from this ONE component, so the two surfaces cannot
// drift. They did: the queue card carried only the refresh mark until 2026-09-13 — its title was a
// plain div, on the theory that the queue is a triage surface and a manual rename belongs in the
// drawer — and the maintainer met the asymmetry on the first card they wanted to retitle ("It only
// lets me rename. I should be able to click on it to retitle it.").
//
// The editor is the title's OWN box: the name is a button, the click swaps in an input seeded with
// the current title (never the slug or a placeholder — lib/threadTitle.ts), Enter or blur commits,
// Escape cancels. Empty and unchanged commits are no-ops, so a stray click cannot erase a good name.
//
// Foreign rows and legacy docs have no registry row to rename, so the name is plain text there; the
// refresh mark makes its own call (AiRenameButton) and hides while the editor is open.
export function ThreadTitle({ thread, className = "" }: { thread: ThreadView; className?: string }) {
  const slug = thread.id
  const renameTitle = useMutation({ mutationFn: (title: string) => rpc.renameThread({ slug, title }) })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing])
  // A drawer can switch slugs without remounting this header. Never carry a half-entered title into
  // another thread; changing selection has the same semantics as cancelling with Escape.
  useEffect(() => {
    setEditing(false)
    setDraft("")
  }, [slug])
  // Manual rename is registry metadata for either backend; the AI rename is Claude-only and gated
  // inside AiRenameButton.
  const canRename = thread.kind === "session" && thread.foreign !== true
  const shown = displayTitle(thread)
  function cancel(): void {
    setEditing(false)
    setDraft("")
  }
  function commit(): void {
    const title = threadTitleToCommit(draft, shown)
    setEditing(false)
    if (!title) {
      setDraft("")
      return
    }
    renameTitle.mutate(title, {
      onSuccess: () => {
        setDraft("")
        showToast("Thread renamed")
      },
      onError: (error) => {
        setDraft(title)
        setEditing(true)
        showToast(error instanceof Error ? error.message : "Could not rename thread")
      },
    })
  }
  // `group/thread-title` is the refresh mark's hover zone. `min-w-0 shrink` on the name rather than
  // `flex-1`, so a short title does not push the mark to the far side of the row — and so a short
  // name does not claim the whole row as a click target.
  return (
    <div className="group/thread-title flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Thread title"
          value={draft}
          maxLength={THREAD_TITLE_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          // Every key stops here. Above this input sit handlers that would otherwise read the
          // editor's keys as their own: the queue card's root submits staged answers on an Enter from
          // any non-button target, and the drawer stack's window listener unwinds a drawer on Escape
          // — so "cancel the rename" would also have closed the thread. The drawer's Radix dialog
          // sees Escape BEFORE this handler (document capture), so it is told by the attribute.
          data-claims-escape
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
          // The box grows OUT from the name, not the name into the box: `-mx-1.5` cancels the padding
          // and `-my-px` the border, so the text stays where the button drew it (a 1px shift, the
          // border's own width) and the row keeps its height while the editor is open. The drawer's
          // editor used to jump the text 8px right and the "Last active" line 3px down.
          className={`min-w-0 flex-1 -mx-1.5 -my-px rounded-md border border-border bg-elevated px-1.5 py-0 font-semibold text-[15px] text-fg outline-none focus:border-accent ${className}`}
        />
      ) : canRename ? (
        <button
          type="button"
          title="Edit title"
          aria-label={`Edit thread title: ${shown}`}
          disabled={renameTitle.isPending}
          onClick={() => {
            setDraft(manualThreadTitleSeed(shown, slug))
            setEditing(true)
          }}
          className={`min-w-0 max-w-full shrink truncate rounded px-0.5 -mx-0.5 font-semibold text-[15px] text-left outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        >
          {shown}
        </button>
      ) : (
        <div className={`min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px] ${className}`} title={shown}>
          {shown}
        </div>
      )}
      <AiRenameButton thread={thread} hidden={editing} />
    </div>
  )
}
