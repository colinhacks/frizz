import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { ChevronDown, ChevronUp, MessageSquare, MessageSquarePlus, Pencil, Trash2 } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import {
  COMMENT_UI_ATTR,
  COMMENTABLE_ATTR,
  findPassage,
  inTranscriptOrder,
  messageProseText,
  normalizePassage,
  offsetsToRange,
  parseStoredComments,
  rangeToOffsets,
  resolveComment,
  serializeStoredComments,
  trimOffsets,
  type SentComment,
  type TranscriptComment,
} from "../lib/transcriptComments.ts"

// INLINE COMMENTS, DRAWN. lib/transcriptComments.ts says what a comment is and what a send carries; this
// draws them on a thread's surface: the Comment button over a selection in an agent message, the editor,
// the highlight each pending comment leaves on its passage, the popover that shows its words, the count
// on the line above the prompt box, and the quotes in a sent bubble.
//
// ONE CONTROLLER PER SURFACE (useTranscriptCommentsController, called by useThreadSurface), so the pane,
// the drawer and the full-screen page each get it from the shell (ThreadSurface.tsx). The comments
// themselves live in the draft store, so every surface showing a thread shows the same ones.

export interface TranscriptComments {
  /** The pending comments, in transcript order. */
  comments: readonly TranscriptComment[]
  add(comment: Omit<TranscriptComment, "id">): void
  update(id: string, text: string): void
  remove(id: string): void
  clear(): void
  /** Hand every pending comment to a send, in transcript order, and stop holding them. */
  take(): TranscriptComment[]
  /** A send that failed gives its comments back. */
  restore(comments: readonly TranscriptComment[]): void
  /** The comment whose words are showing, and whether a click pinned it open (hover did not). */
  focus: Focus
  setFocus(next: Focus): void
  /** Show the next or previous pending comment: scroll to its passage and pin its words open. */
  nav(dir: 1 | -1): void
  /** Scroll to a passage a SENT comment quoted, and light it for a moment. */
  revealQuote(quote: string): void
  /** The latest scroll request the layer has to act on. */
  reveal: Reveal | null
}

export interface Focus { id: string | null; pinned: boolean }
type Reveal = { seq: number } & ({ id: string } | { quote: string })

const NO_FOCUS: Focus = { id: null, pinned: false }
const TranscriptCommentsContext = createContext<TranscriptComments | null>(null)
export const TranscriptCommentsProvider = TranscriptCommentsContext.Provider

/** The surface's comments, or null outside a thread's surface (a fixture, a mockup). */
export function useTranscriptComments(): TranscriptComments | null {
  return useContext(TranscriptCommentsContext)
}

let idSeq = 0
const newId = () => `c${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Keep the previous list while it holds the same comments in the same order, so a transcript delta
 *  that moves nothing re-renders nothing that reads the list. */
function useStableList(next: TranscriptComment[]): TranscriptComment[] {
  const previous = useRef(next)
  const same = previous.current.length === next.length && previous.current.every((c, i) => c === next[i])
  if (!same) previous.current = next
  return previous.current
}

export function useTranscriptCommentsController(slug: string, messages: readonly { sourceId?: string }[]): TranscriptComments {
  const projectDir = useProjectDir()
  const key = draftKey.comments(projectDir, slug)
  const [raw] = useDraft(key)
  const stored = useMemo(() => parseStoredComments(raw), [raw])
  const comments = useStableList(useMemo(() => inTranscriptOrder(stored, messages), [stored, messages]))
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [focus, setFocus] = useState<Focus>(NO_FOCUS)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  // Every write reads the store first: another tab, or another surface of this thread, may have written
  // since this render.
  const write = useCallback((change: (list: TranscriptComment[]) => TranscriptComment[]) => {
    draftStore.set(key, serializeStoredComments(change(parseStoredComments(draftStore.get(key)))))
  }, [key])
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const focusRef = useRef(focus)
  focusRef.current = focus
  return useMemo<TranscriptComments>(() => ({
    comments,
    add: (comment) => write((list) => [...list, { ...comment, id: newId() }]),
    update: (id, text) => write((list) => list.map((c) => (c.id === id ? { ...c, text } : c))),
    remove: (id) => {
      write((list) => list.filter((c) => c.id !== id))
      setFocus((f) => (f.id === id ? NO_FOCUS : f))
    },
    clear: () => {
      draftStore.clear(key)
      setFocus(NO_FOCUS)
    },
    take: () => {
      const taken = inTranscriptOrder(parseStoredComments(draftStore.get(key)), messagesRef.current)
      draftStore.clear(key)
      setFocus(NO_FOCUS)
      return taken
    },
    restore: (back) => write((list) => [...back.filter((c) => !list.some((kept) => kept.id === c.id)), ...list]),
    focus,
    setFocus,
    nav: (dir) => {
      const list = commentsRef.current
      if (!list.length) return
      const at = list.findIndex((c) => c.id === focusRef.current.id)
      const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length]
      setFocus({ id: next.id, pinned: true })
      setReveal((r) => ({ seq: (r?.seq ?? 0) + 1, id: next.id }))
    },
    revealQuote: (quote) => setReveal((r) => ({ seq: (r?.seq ?? 0) + 1, quote })),
    reveal,
  }), [comments, focus, reveal, write, key])
}

// ── painting: the CSS Custom Highlight API ──────────────────────────────────────────────────────────────
// One registry for the document (CSS.highlights is per-document), fed by every surface's layer, so a
// thread open in the pane and a drawer at once paints both.

const HIGHLIGHTS = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
type Paint = { soft: Range[]; active: Range[] }
const paints = new Map<symbol, Paint>()
function repaint(): void {
  if (!HIGHLIGHTS) return
  const all = [...paints.values()]
  const soft = new Highlight(...all.flatMap((p) => p.soft))
  const active = new Highlight(...all.flatMap((p) => p.active))
  active.priority = 1
  CSS.highlights.set("frizz-comment", soft)
  CSS.highlights.set("frizz-comment-active", active)
}

function elementOf(node: Node | null): Element | null {
  return node ? (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) : null
}

function messageIn(root: HTMLElement, sourceId: string): Element | null {
  return root.querySelector(`[${COMMENTABLE_ATTR}][data-frizz-msg="${CSS.escape(sourceId)}"]`)
}

/** A passage being written on: where it is, and the comment it edits when it is not a new one. */
interface Draft { sourceId: string; start: number; end: number; quote: string; editing?: string; initial: string }
type Selected = { sourceId: string; start: number; end: number; quote: string }

/**
 * The selection, when it is a passage this surface can take a comment on: inside one agent message's
 * prose, in this surface. A selection that runs on into another message's prose is not one passage.
 */
function readSelection(root: HTMLElement): Selected | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const message = elementOf(range.startContainer)?.closest(`[${COMMENTABLE_ATTR}]`)
  if (!message || !root.contains(message) || elementOf(range.startContainer)?.closest(`[${COMMENT_UI_ATTR}]`)) return null
  const sourceId = message.getAttribute("data-frizz-msg")
  if (!sourceId) return null
  const endMessage = elementOf(range.endContainer)?.closest(`[${COMMENTABLE_ATTR}]`)
  if (endMessage && endMessage !== message && rangeToOffsets(endMessage, range)) return null
  const offsets = rangeToOffsets(message, range)
  if (!offsets) return null
  const text = messageProseText(message)
  const [start, end] = trimOffsets(text, offsets)
  if (end <= start) return null
  return { sourceId, start, end, quote: normalizePassage(text.slice(start, end)) }
}

/** A virtual anchor over a Range the layer keeps current, for a Radix popover. */
function useRangeAnchor(read: () => Range | null) {
  const readRef = useRef(read)
  readRef.current = read
  const [anchor] = useState(() => ({
    current: {
      getBoundingClientRect: () => readRef.current()?.getBoundingClientRect() ?? new DOMRect(),
      get contextElement() {
        return elementOf(readRef.current()?.startContainer ?? null) ?? undefined
      },
    },
  }))
  return anchor
}

const COARSE = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
const HOVER_CLOSE_MS = 180
const FLASH_MS = 1600

/**
 * THE LAYER, one per surface, mounted by ThreadSurface inside its root. It owns no comment: it reads the
 * surface's controller, paints, and draws the three popovers.
 */
export function TranscriptCommentLayer({ root }: { root: HTMLElement | null }): ReactElement | null {
  const controller = useTranscriptComments()
  const [paintKey] = useState(() => Symbol("transcript-comments"))
  const [selected, setSelected] = useState<Selected | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [flash, setFlash] = useState<Range | null>(null)
  const ranges = useRef(new Map<string, Range>())
  const draftRange = useRef<Range | null>(null)
  const selectedRange = useRef<Range | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)
  const comments = controller?.comments
  const focus = controller?.focus ?? NO_FOCUS
  const live = Boolean(root && controller && (comments!.length > 0 || draft || flash))

  const paint = useCallback(() => {
    if (!root || !controller) return
    const next = new Map<string, Range>()
    const soft: Range[] = []
    const active: Range[] = []
    for (const comment of controller.comments) {
      const message = messageIn(root, comment.sourceId)
      const range = message && resolveComment(message, comment)
      if (!range) continue
      next.set(comment.id, range)
      ;(comment.id === focus.id || comment.id === draft?.editing ? active : soft).push(range)
    }
    ranges.current = next
    draftRange.current = null
    if (draft && !draft.editing) {
      const message = messageIn(root, draft.sourceId)
      const range = message && offsetsToRange(message, draft.start, draft.end)
      if (range) {
        draftRange.current = range
        active.push(range)
      }
    }
    if (flash) active.push(flash)
    paints.set(paintKey, { soft, active })
    repaint()
  }, [root, controller, focus.id, draft, flash, paintKey])

  useLayoutEffect(paint, [paint])
  useEffect(() => () => {
    paints.delete(paintKey)
    repaint()
  }, [paintKey])

  // THE PROSE CHANGES UNDER A COMMENT — a streamed message grows, a page of history loads, a message
  // re-renders its HTML — and a Range over replaced text nodes paints nothing. Re-resolve on the next
  // frame after any change in the surface, while there is anything to paint.
  useEffect(() => {
    if (!live || !root) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        paint()
      })
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [live, root, paint])

  // THE COMMENT BUTTON follows the selection, once the pointer that made it is up.
  useEffect(() => {
    if (!root || !controller) return
    const read = () => {
      const next = readSelection(root)
      selectedRange.current = next ? window.getSelection()!.getRangeAt(0).cloneRange() : null
      setSelected((was) => (was && next && was.sourceId === next.sourceId && was.start === next.start && was.end === next.end ? was : next))
    }
    const down = (event: PointerEvent) => {
      if (event.button === 0 && root.contains(event.target as Node)) setSelecting(true)
    }
    const up = () => {
      setSelecting(false)
      read()
    }
    document.addEventListener("selectionchange", read)
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("pointerup", up, true)
    return () => {
      document.removeEventListener("selectionchange", read)
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("pointerup", up, true)
    }
  }, [root, controller])

  const startDraft = useCallback((from: Selected) => {
    setDraft({ ...from, initial: "" })
    setSelected(null)
    controller?.setFocus(NO_FOCUS)
    window.getSelection()?.removeAllRanges()
  }, [controller])

  // ⌘I over a selection in the transcript opens the editor: the chord that already means "take this
  // selection into my message" in the file viewer.
  useEffect(() => {
    if (!root || !controller) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "i" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const passage = readSelection(root)
      if (!passage) return
      event.preventDefault()
      event.stopPropagation()
      startDraft(passage)
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [root, controller, startDraft])

  // POINTING AT A HIGHLIGHT shows its words; a click on it pins them open.
  const hitTest = useCallback((x: number, y: number): string | null => {
    for (const [id, range] of ranges.current) {
      for (const box of range.getClientRects()) {
        if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1) return id
      }
    }
    return null
  }, [])
  const setFocus = controller?.setFocus
  const focusRef = useRef(focus)
  focusRef.current = focus
  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!focusRef.current.pinned) setFocus?.(NO_FOCUS)
    }, HOVER_CLOSE_MS)
  }, [setFocus])
  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), [])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const hasComments = Boolean(comments?.length)
  useEffect(() => {
    if (!root || !setFocus || !hasComments || draft) return
    let frame = 0
    let last: PointerEvent | null = null
    const move = (event: PointerEvent) => {
      last = event
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!last || last.buttons) return
        const id = hitTest(last.clientX, last.clientY)
        root.toggleAttribute("data-comment-hover", id !== null)
        if (id) {
          cancelClose()
          if (!focusRef.current.pinned && focusRef.current.id !== id) setFocus({ id, pinned: false })
        } else if (focusRef.current.id && !focusRef.current.pinned) scheduleClose()
      })
    }
    const leave = () => {
      root.removeAttribute("data-comment-hover")
      if (focusRef.current.id && !focusRef.current.pinned) scheduleClose()
    }
    const click = (event: MouseEvent) => {
      if (window.getSelection()?.isCollapsed === false) return
      const id = hitTest(event.clientX, event.clientY)
      if (id) setFocus({ id, pinned: true })
    }
    root.addEventListener("pointermove", move, { passive: true })
    root.addEventListener("pointerleave", leave)
    root.addEventListener("click", click)
    return () => {
      cancelAnimationFrame(frame)
      root.removeAttribute("data-comment-hover")
      root.removeEventListener("pointermove", move)
      root.removeEventListener("pointerleave", leave)
      root.removeEventListener("click", click)
    }
  }, [root, setFocus, hasComments, draft, hitTest, cancelClose, scheduleClose])

  // A SCROLL REQUEST: the next/previous arrows, or a quote in a sent bubble.
  const reveal = controller?.reveal
  useEffect(() => {
    if (!reveal || !root) return
    let range: Range | null = null
    if ("id" in reveal) range = ranges.current.get(reveal.id) ?? null
    else {
      // The newest message saying it: a quote is most often about what the agent said last.
      const messages = [...root.querySelectorAll(`[${COMMENTABLE_ATTR}]`)].reverse()
      for (const message of messages) {
        const at = findPassage(messageProseText(message), reveal.quote)
        range = at && offsetsToRange(message, at[0], at[1])
        if (range) break
      }
      if (range) setFlash(range)
    }
    elementOf(range?.startContainer ?? null)?.scrollIntoView({ block: "center", behavior: "smooth" })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one scroll per request, keyed by its seq
  }, [reveal?.seq])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  const selectedAnchor = useRangeAnchor(() => selectedRange.current)
  const draftAnchor = useRangeAnchor(() => (draft?.editing ? ranges.current.get(draft.editing) ?? null : draftRange.current))
  const focusAnchor = useRangeAnchor(() => (focus.id ? ranges.current.get(focus.id) ?? null : null))

  if (!controller || !root) return null
  const open = focus.id && !draft ? controller.comments.find((c) => c.id === focus.id) : undefined
  const save = (text: string) => {
    if (!draft) return
    if (draft.editing) controller.update(draft.editing, text)
    else controller.add({ sourceId: draft.sourceId, start: draft.start, end: draft.end, quote: draft.quote, text })
    setDraft(null)
  }
  return (
    <>
      <Popover open={Boolean(selected && !selecting && !draft)} onOpenChange={(next) => { if (!next) setSelected(null) }}>
        <PopoverAnchor virtualRef={selectedAnchor} />
        <PopoverContent
          side={COARSE ? "bottom" : "top"}
          sideOffset={COARSE ? 12 : 6}
          updatePositionStrategy="always"
          hideWhenDetached
          className="p-0.5"
          data-comment-button=""
          {...{ [COMMENT_UI_ATTR]: "" }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <button
            type="button"
            // ON THE PRESS, not the click: the selection must survive until it is read, and on a touch
            // screen the tap that ends on this button can clear it first. Enter or Space (a click with
            // no pointer behind it, `detail` 0) takes the keyboard's way.
            onPointerDown={(event) => {
              event.preventDefault()
              if (selected) startDraft(selected)
            }}
            onClick={(event) => {
              if (event.detail === 0 && selected) startDraft(selected)
            }}
            className={`flex items-baseline gap-1.5 rounded-md font-medium text-fg/90 outline-none transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 ${COARSE ? "px-3 py-2 text-[14px]" : "px-2 py-1 text-[12px]"}`}
          >
            {/* On the cap band, by the browser's own reading of the font (the OpsCount idiom), so the
                icon, the word and the smaller ⌘I share one line of ink rather than three box centres. */}
            <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
              <span className="absolute inset-0 flex items-center justify-center"><MessageSquarePlus className="h-[1.1em] w-[1.1em]" strokeWidth={2} /></span>
            </span>
            Comment
            {!COARSE && <kbd className="ml-1 font-sans text-[10.5px] font-normal text-muted-60">⌘I</kbd>}
          </button>
        </PopoverContent>
      </Popover>

      <Popover open={Boolean(draft)} onOpenChange={(next) => { if (!next) setDraft(null) }}>
        <PopoverAnchor virtualRef={draftAnchor} />
        {draft && (
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={6}
            updatePositionStrategy="always"
            className="w-[min(340px,calc(100vw-24px))] px-3 py-2.5"
            data-comment-editor=""
            {...{ [COMMENT_UI_ATTR]: "" }}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // A press elsewhere drops an empty editor and keeps one with words in it: Cancel or Esc
            // throws those away, never a stray click.
            onInteractOutside={(event) => {
              if (dirty.current) event.preventDefault()
            }}
          >
            <CommentEditor
              onDirty={(next) => {
                dirty.current = next
              }}
              key={draft.editing ?? `${draft.sourceId}:${draft.start}:${draft.end}`}
              initial={draft.initial}
              editing={Boolean(draft.editing)}
              onSave={save}
              onCancel={() => setDraft(null)}
            />
          </PopoverContent>
        )}
      </Popover>

      <Popover open={Boolean(open)} onOpenChange={(next) => { if (!next) controller.setFocus(NO_FOCUS) }}>
        <PopoverAnchor virtualRef={focusAnchor} />
        {open && (
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={6}
            updatePositionStrategy="always"
            hideWhenDetached
            className="w-[min(320px,calc(100vw-24px))] px-3 py-2"
            data-comment-popover={open.id}
            {...{ [COMMENT_UI_ATTR]: "" }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={cancelClose}
            onPointerLeave={() => { if (!focus.pinned) scheduleClose() }}
          >
            <div className="flex h-5 items-center gap-1.5 text-[11px] text-muted-70">
              <span className="petite-caps tracking-wide">Pending · goes with your next message</span>
              <span className="ml-auto flex items-center">
                <button
                  type="button"
                  title="Edit"
                  aria-label="Edit comment"
                  onClick={() => {
                    setDraft({ sourceId: open.sourceId, start: open.start, end: open.end, quote: open.quote, editing: open.id, initial: open.text })
                    controller.setFocus(NO_FOCUS)
                  }}
                  className={TINY_ICON}
                >
                  <Pencil size={11} strokeWidth={2} />
                </button>
                <button type="button" title="Delete" aria-label="Delete comment" onClick={() => controller.remove(open.id)} className={TINY_ICON}>
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </span>
            </div>
            <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-[19px] text-fg/90 [overflow-wrap:anywhere]">{open.text}</div>
          </PopoverContent>
        )}
      </Popover>
    </>
  )
}

const TINY_ICON = "flex h-5 w-5 items-center justify-center rounded text-muted-60 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"
// THE TWO ARROWS ARE ONE CONTROL, so they stand closer to each other than to the words either side. A
// 12px chevron paints 6px of its box, so on 20px squares the pair stood 13.00px apart in ink, as far as
// the label stood from the first (13.53) — four marks at one spacing, nothing grouped (scripts/ink-gaps.mjs,
// dsf 4, sans). On 14px squares: 8px between the arrows, 10px from the label, 12px to Discard.
const NAV_ICON = "flex h-5 w-3.5 items-center justify-center rounded text-muted-60 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"

function CommentEditor({ initial, editing, onSave, onCancel, onDirty }: { initial: string; editing: boolean; onSave: (text: string) => void; onCancel: () => void; onDirty: (dirty: boolean) => void }): ReactElement {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    onDirty(value.trim() !== initial.trim())
    return () => onDirty(false)
  }, [value, initial, onDirty])
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const text = value.trim()
  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        rows={2}
        aria-label="Comment on this passage"
        placeholder="Comment on this passage…"
        data-1p-ignore
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // The surface's own keys (⌘⏎ is Send now there) are not this box's: React carries a portal's
          // events up the component tree, to the surface's root.
          event.stopPropagation()
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (text) onSave(text)
          }
        }}
        className="block max-h-[220px] min-h-[38px] w-full resize-none bg-transparent text-[13px] leading-[19px] text-fg outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-auto text-[10.5px] text-muted-60">⌘⏎ saves · Esc cancels</span>
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2">
          Cancel
        </button>
        <button
          type="button"
          disabled={!text}
          onClick={() => onSave(text)}
          className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-30"
        >
          {editing ? "Save" : "Add comment"}
        </button>
      </div>
    </div>
  )
}

// ── the count, on the line above the prompt box ────────────────────────────────────────────────────────
// What the human has outstanding sits on the left of that line, the agent's live work on the right
// (QueueOpsSummary). Pending comments are easy to forget — they are not in the prompt box, and they wait
// silently until the next send — so the count stays in sight wherever the box is.

export function PendingCommentsCount(): ReactElement | null {
  const controller = useTranscriptComments()
  const [confirming, setConfirming] = useState(false)
  const n = controller?.comments.length ?? 0
  useEffect(() => {
    if (n === 0) setConfirming(false)
  }, [n])
  if (!controller || n === 0) return null
  return (
    <span data-pending-comments={n} className="mr-auto flex min-w-0 items-baseline text-[11.5px] text-attention">
      <button
        type="button"
        title="Show the next pending comment"
        onClick={() => controller.nav(1)}
        onMouseDown={(event) => event.preventDefault()}
        className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        {/* On the cap band, as the counts beside it are (QueueOpsSummary's OpsCount). */}
        <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
          <span className="absolute inset-0 flex items-center justify-center"><MessageSquare className="h-[1em] w-[1em]" strokeWidth={2.2} /></span>
        </span>
        <span><span className="font-medium tabular-nums">{n}</span> pending comment{n === 1 ? "" : "s"}</span>
      </button>
      {confirming ? (
        <span className="flex shrink-0 items-baseline gap-1 whitespace-nowrap pl-1 text-muted-70">
          Discard {n === 1 ? "it" : `all ${n}`}?
          <button type="button" onClick={() => controller.clear()} className="rounded-md px-1.5 py-0.5 font-medium text-danger outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Discard
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-1.5 py-0.5 outline-none hover:bg-panel-2 hover:text-fg/85 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Keep
          </button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center self-center text-muted-60">
          <button type="button" title="Previous comment" aria-label="Previous comment" onMouseDown={(event) => event.preventDefault()} onClick={() => controller.nav(-1)} className={NAV_ICON}>
            <ChevronUp size={12} strokeWidth={2} />
          </button>
          <button type="button" title="Next comment" aria-label="Next comment" onMouseDown={(event) => event.preventDefault()} onClick={() => controller.nav(1)} className={NAV_ICON}>
            <ChevronDown size={12} strokeWidth={2} />
          </button>
          <button type="button" title="Discard every pending comment" onClick={() => setConfirming(true)} className="ml-0.5 rounded-md px-1.5 py-0.5 text-[11.5px] outline-none transition-colors hover:bg-panel-2 hover:text-fg/85 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Discard
          </button>
        </span>
      )}
    </span>
  )
}

// ── a sent message's comments, in its bubble ────────────────────────────────────────────────────────────
// Each comment under the passage it quotes. A quote is a link back to its passage while the transcript
// still draws it. The bubble is the one LIGHT surface in the transcript, so the tints are `bg/…`, as the
// ⌘I chips in it are (ChatView SentContextBody).

export function SentCommentsList({ items, divided }: { items: readonly SentComment[]; divided: boolean }): ReactElement {
  const controller = useTranscriptComments()
  return (
    <div data-sent-comments={items.length} className={`flex flex-col gap-2.5 whitespace-normal ${divided ? "mt-2.5 border-t border-bg/15 pt-2.5" : ""}`}>
      {items.map((item, i) => (
        <div key={i}>
          <button
            type="button"
            title={controller ? "Show this passage" : undefined}
            disabled={!controller}
            onClick={(event) => {
              event.stopPropagation()
              controller?.revealQuote(item.quote)
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="line-clamp-2 block border-l-2 border-bg/25 pl-2 text-left text-[12px] leading-[17px] text-user-bubble-fg/60 outline-none transition-colors enabled:hover:border-bg/50 enabled:hover:text-user-bubble-fg/85 focus-visible:border-bg/60"
          >
            {item.quote}
          </button>
          <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
        </div>
      ))}
    </div>
  )
}
