import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react"
import type { ThreadView } from "@frizz/shared"
import { showToast } from "../store.ts"
import { renameThread, useShownTitle } from "../lib/pendingRename.ts"
import { THREAD_TITLE_MAX_LENGTH, manualThreadTitleSeed, threadTitleToCommit } from "../lib/threadTitle.ts"

// TYPING A THREAD'S NEW NAME, wherever its name is drawn: the thread header (ThreadTitle, a click) and the
// rail's row (Sidebar.tsx ThreadRow, a double-click). One hook, so the two editors cannot disagree about
// what a commit, a cancel or a refusal does.
//
// The editor opens seeded with the current title (never the slug or a placeholder — lib/threadTitle.ts),
// Enter or blur commits, Escape cancels. Empty and unchanged commits are no-ops, so a stray click cannot
// erase a good name. A refusal reopens the editor on what was typed, with the server's reason in a toast.
//
// No react-query here: the rail's render tests and fixture pages draw a row with no QueryClientProvider
// mounted, and `useMutation` throws there.

type Editor = HTMLInputElement | HTMLTextAreaElement

export interface ThreadRename<E extends Editor> {
  /** The name to draw: a rename from this tab while the board catches up, else the board's. */
  shown: string
  /** Foreign rows and legacy docs have no registry row to rename. */
  canRename: boolean
  editing: boolean
  /** A commit is on its way to the server. */
  pending: boolean
  /** The draft, for an editor that sizes itself to its text. */
  draft: string
  start(): void
  /** Spread onto the `<input>` or `<textarea>`. */
  editorProps: {
    ref: RefObject<E | null>
    "aria-label": string
    "data-claims-escape": true
    value: string
    maxLength: number
    onChange(event: ChangeEvent<E>): void
    onBlur(): void
    onKeyDown(event: KeyboardEvent<E>): void
  }
}

export function useThreadRename<E extends Editor>(thread: ThreadView): ThreadRename<E> {
  const slug = thread.id
  const shown = useShownTitle(thread)
  // Manual rename is registry metadata for every backend; the AI rename is Claude-only (AiRenameButton).
  const canRename = thread.kind === "session" && thread.foreign !== true
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState(false)
  const ref = useRef<E | null>(null)
  useEffect(() => {
    if (!editing) return
    const frame = requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing])
  // A drawer can switch slugs without remounting its header. Never carry a half-entered title into
  // another thread; changing selection has the same semantics as cancelling with Escape.
  useEffect(() => {
    setEditing(false)
    setDraft("")
  }, [slug])

  function start(): void {
    if (!canRename || pending) return
    setDraft(manualThreadTitleSeed(shown, slug))
    setEditing(true)
  }
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
    setPending(true)
    // The new name shows from the Enter, not from the board delta that confirms it (lib/pendingRename).
    renameThread(slug, title).then(
      () => {
        setPending(false)
        setDraft("")
        showToast("Thread renamed")
      },
      (error: unknown) => {
        setPending(false)
        setDraft(title)
        setEditing(true)
        showToast(error instanceof Error ? error.message : "Could not rename thread")
      },
    )
  }

  return {
    shown,
    canRename,
    editing,
    pending,
    draft,
    start,
    editorProps: {
      ref,
      "aria-label": "Thread title",
      // Above an editor sit handlers that would otherwise read its keys as their own: the drawer stack's
      // window listener unwinds a drawer on Escape, so "cancel the rename" would also close the thread, and
      // the pinned band moves a row on Alt+Arrow. Every key stops at the editor. The drawer's Radix dialog
      // sees Escape BEFORE the editor (document capture), so it is told by this attribute (ThreadSheet).
      "data-claims-escape": true,
      value: draft,
      maxLength: THREAD_TITLE_MAX_LENGTH,
      // A title is one line. A textarea editor would take a pasted newline as text; an input drops it.
      onChange: (event) => setDraft(event.target.value.replace(/\s*[\r\n]+\s*/g, " ")),
      onBlur: commit,
      onKeyDown: (event) => {
        event.stopPropagation()
        // An IME's Enter picks the candidate; it is not the end of the name.
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          commit()
        } else if (event.key === "Escape") {
          event.preventDefault()
          cancel()
        }
      },
    },
  }
}
