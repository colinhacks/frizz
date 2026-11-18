import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { ChevronDown, ChevronUp, MessageSquare, MessageSquarePlus } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent, POPOVER_COLLISION_PADDING } from "./ui/Popover.tsx"
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
// draws them on a thread's surface: the Comment button over a selection in an agent message, the highlight
// each pending comment leaves on its passage, the card that writes a comment and shows and edits one left
// (a note in the margin where there is room), the count on the line above the prompt box, and the quotes
// in a sent bubble.
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

/** A passage a new comment is being written on. */
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

// THE CARD IS A NOTE IN THE MARGIN where the window has room for one: beside the passage, right of the
// thread's column, over the artifacts rail when that is showing (maintainer 2026-11-18: "floating to the
// right, if there's room for that, as a marginal note. It can go over the top of the artifact right
// sidebar"). The pane's 720 column leaves the rail's 340 at 1440, room for the card; at 1280, and in the
// drawer, the column runs to the window's edge, and the card opens under the passage instead.
const CARD_WIDTH = 300
const MARGIN_GAP = 16
const BELOW_GAP = 6
// The card's first line of words sits this far below its top edge (its 1px border, 10px padding and half
// its 19px line), so in the margin that line is centred on the passage's first line.
const CARD_FIRST_LINE_CENTRE = 20.5

type Placement = "margin" | "below"
function placementIn(root: HTMLElement): Placement {
  if (COARSE) return "below"
  const room = window.innerWidth - POPOVER_COLLISION_PADDING - (root.getBoundingClientRect().right + MARGIN_GAP)
  return room >= CARD_WIDTH ? "margin" : "below"
}

/**
 * The card's anchor in the margin: the passage's first line, run out to the column's edge, so the card
 * stands right of the column on the passage's line. Its edge stays a pixel inside the column, and its
 * height is the line's: Radix hides a card whose anchor is clipped away, and a rect on the scroller's own
 * edge, or above the line, read as clipped while the passage was in view.
 */
function marginRect(range: Range, root: HTMLElement): DOMRect {
  const line = range.getClientRects()[0] ?? range.getBoundingClientRect()
  const top = line.top + line.height / 2 - CARD_FIRST_LINE_CENTRE
  const right = root.getBoundingClientRect().right - 1
  return new DOMRect(line.left, top, Math.max(1, right - line.left), line.bottom - top)
}

/** The card's virtual anchor: its passage, or the passage's line out to the column's edge in the margin.
 *  The layer sets `placement` on each render; Radix reads the rect every frame. */
function useCardAnchor(root: HTMLElement | null, read: () => Range | null) {
  const live = useRef({ root, read })
  live.current = { root, read }
  const [anchor] = useState(() => {
    const self = {
      placement: "below" as Placement,
      current: {
        getBoundingClientRect: (): DOMRect => {
          const range = live.current.read()
          if (!range) return new DOMRect()
          return self.placement === "margin" && live.current.root ? marginRect(range, live.current.root) : range.getBoundingClientRect()
        },
        get contextElement() {
          return elementOf(live.current.read()?.startContainer ?? null) ?? undefined
        },
      },
    }
    return self
  })
  return anchor
}

/** Points on the way from a passage to its card, so the pointer can cross the prose between them. */
function convexHull(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: [number, number][]) => {
    const out: [number, number][] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...half(sorted), ...half([...sorted].reverse())]
}
function onTheWay(x: number, y: number, rects: DOMRect[]): boolean {
  const corners = rects.flatMap((r): [number, number][] => [[r.left - 2, r.top - 2], [r.right + 2, r.top - 2], [r.right + 2, r.bottom + 2], [r.left - 2, r.bottom + 2]])
  const hull = convexHull(corners)
  if (hull.length < 3) return false
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i]
    const [bx, by] = hull[(i + 1) % hull.length]
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false
  }
  return true
}

/**
 * THE LAYER, one per surface, mounted by ThreadSurface inside its root. It owns no comment: it reads the
 * surface's controller, paints, and draws the Comment button and the card.
 */
export function TranscriptCommentLayer({ root }: { root: HTMLElement | null }): ReactElement | null {
  const controller = useTranscriptComments()
  const [paintKey] = useState(() => Symbol("transcript-comments"))
  const [selected, setSelected] = useState<Selected | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [draft, setDraft] = useState<Selected | null>(null)
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
      ;(comment.id === focus.id ? active : soft).push(range)
    }
    ranges.current = next
    draftRange.current = null
    if (draft) {
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
    setDraft(from)
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

  // POINTING AT A HIGHLIGHT shows its comment's card; a click on it, or into the card's box, pins it open.
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
  const cardRef = useRef<HTMLDivElement>(null)
  // The close a pointer leaving the passage schedules asks, when it fires, whether the card is under the
  // pointer: the card's own pointerenter cannot be what cancels it, because React makes that event out of
  // the browser's `pointerout`, which comes BEFORE the surface's native `pointerleave` — the card vanished
  // under every pointer on its way to it (2026-11-18, 20 of 20 sweeps).
  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!focusRef.current.pinned && !cardRef.current?.matches(":hover")) setFocus?.(NO_FOCUS)
    }, HOVER_CLOSE_MS)
  }, [setFocus])
  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), [])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const hasComments = Boolean(comments?.length)
  useEffect(() => {
    if (!root || !setFocus || !hasComments || draft) return
    let frame = 0
    let last: PointerEvent | null = null
    // THE WHOLE PAGE'S POINTER, not the surface's: a card in the margin stands outside the surface, over
    // the artifacts rail, and the pointer crosses the column's last words and the rail to reach it. While
    // it is anywhere between the passage and its card, the card stays.
    const move = (event: PointerEvent) => {
      last = event
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!last || last.buttons) return
        // A passage under the card is not under the pointer: the card covers the prose below it.
        const id = root.contains(last.target as Node) ? hitTest(last.clientX, last.clientY) : null
        root.toggleAttribute("data-comment-hover", id !== null)
        if (id) {
          cancelClose()
          if (!focusRef.current.pinned && focusRef.current.id !== id) setFocus({ id, pinned: false })
          return
        }
        const open = focusRef.current
        if (!open.id || open.pinned) return
        const passage = ranges.current.get(open.id)?.getBoundingClientRect()
        const card = cardRef.current?.getBoundingClientRect()
        if (passage && card && onTheWay(last.clientX, last.clientY, [passage, card])) cancelClose()
        else scheduleClose()
      })
    }
    // Out of the window altogether.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget) return
      root.removeAttribute("data-comment-hover")
      if (focusRef.current.id && !focusRef.current.pinned) scheduleClose()
    }
    const click = (event: MouseEvent) => {
      // A card whose words are being changed keeps the pointer's clicks from opening another.
      if (window.getSelection()?.isCollapsed === false || dirty.current) return
      const id = hitTest(event.clientX, event.clientY)
      if (id) setFocus({ id, pinned: true })
    }
    document.addEventListener("pointermove", move, { passive: true })
    document.addEventListener("pointerout", out)
    root.addEventListener("click", click)
    return () => {
      cancelAnimationFrame(frame)
      root.removeAttribute("data-comment-hover")
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerout", out)
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
  const draftAnchor = useCardAnchor(root, () => draftRange.current)
  const focusAnchor = useCardAnchor(root, () => (focus.id ? ranges.current.get(focus.id) ?? null : null))
  // Margin or below is read again when the window changes width under an open card.
  const cardOpen = Boolean(draft || focus.id)
  const [, setWidth] = useState(0)
  useEffect(() => {
    if (!cardOpen) return
    const resize = () => setWidth(window.innerWidth)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [cardOpen])

  if (!controller || !root) return null
  const open = focus.id && !draft ? controller.comments.find((c) => c.id === focus.id) : undefined
  const placement = placementIn(root)
  draftAnchor.placement = placement
  focusAnchor.placement = placement
  const card = {
    side: placement === "margin" ? "right" : "bottom",
    align: "start",
    sideOffset: placement === "margin" ? MARGIN_GAP + 1 : BELOW_GAP,
    updatePositionStrategy: "always",
    // CARD_WIDTH, spelled out for Tailwind.
    className: "w-[min(300px,calc(100vw-24px))] px-3 py-2.5",
    "data-comment-placement": placement,
    [COMMENT_UI_ATTR]: "",
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
    // A press elsewhere closes a card whose words are as they were, and keeps one being changed: Cancel or
    // Esc throws changes away, never a stray click.
    onInteractOutside: (event: Event) => {
      if (dirty.current) event.preventDefault()
    },
  } as const
  const onDirty = (next: boolean) => {
    dirty.current = next
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
          <PopoverContent {...card} data-comment-editor="">
            <CommentCard
              key={`${draft.sourceId}:${draft.start}:${draft.end}`}
              saved=""
              onDirty={onDirty}
              onSave={(text) => {
                controller.add({ sourceId: draft.sourceId, start: draft.start, end: draft.end, quote: draft.quote, text })
                setDraft(null)
              }}
              onCancel={() => setDraft(null)}
            />
          </PopoverContent>
        )}
      </Popover>

      <Popover open={Boolean(open)} onOpenChange={(next) => { if (!next) controller.setFocus(NO_FOCUS) }}>
        <PopoverAnchor virtualRef={focusAnchor} />
        {open && (
          <PopoverContent
            {...card}
            ref={cardRef}
            hideWhenDetached
            data-comment-popover={open.id}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <CommentCard
              key={open.id}
              saved={open.text}
              onDirty={onDirty}
              // Clicking into the words is how they are edited, and it holds the card open: the pointer may
              // wander off while the hand is on the keyboard.
              onEngage={() => controller.setFocus({ id: open.id, pinned: true })}
              onSave={(text) => {
                controller.update(open.id, text)
                controller.setFocus(NO_FOCUS)
              }}
              onCancel={() => controller.setFocus(NO_FOCUS)}
              onDelete={() => controller.remove(open.id)}
            />
          </PopoverContent>
        )}
      </Popover>
    </>
  )
}

// THE TWO ARROWS ARE ONE CONTROL, so they stand closer to each other than to the words either side. A
// 12px chevron paints 6px of its box, so on 20px squares the pair stood 13.00px apart in ink, as far as
// the label stood from the first (13.53) — four marks at one spacing, nothing grouped (scripts/ink-gaps.mjs,
// dsf 4, sans). On 14px squares: 8px between the arrows, 10px from the label, 12px to Discard.
const NAV_ICON = "flex h-5 w-3.5 items-center justify-center rounded text-muted-60 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"

/**
 * THE CARD, one shape for a comment being written and one already left: its words in a box, and a footer
 * band under them. A comment's words are edited by clicking into them, with no Edit button (maintainer
 * 2026-11-18: "You should just be able to click into the box and start editing"), so the band holds
 * Delete until the words change, and Cancel and Save once they have.
 */
function CommentCard({ saved, onSave, onCancel, onDelete, onDirty, onEngage }: {
  /** The words as they stand, "" for a new comment. */
  saved: string
  onSave: (text: string) => void
  onCancel: () => void
  /** Absent for a new comment, which has nothing to delete. */
  onDelete?: () => void
  onDirty: (dirty: boolean) => void
  onEngage?: () => void
}): ReactElement {
  const isNew = !onDelete
  const [value, setValue] = useState(saved)
  const text = value.trim()
  const changed = text !== saved.trim()
  useEffect(() => {
    onDirty(changed)
    return () => onDirty(false)
  }, [changed, onDirty])
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])
  // A new comment takes the caret; one shown because the pointer came by does not take it from the prompt box.
  useEffect(() => {
    const el = ref.current
    if (!el || !isNew) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the card opens
  }, [])
  const save = () => {
    if (text && changed) onSave(text)
  }
  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label={isNew ? "Comment on this passage" : "Comment"}
        placeholder={isNew ? "Comment on this passage…" : undefined}
        data-1p-ignore
        onFocus={onEngage}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // The surface's own keys (⌘⏎ is Send now there) are not this box's: React carries a portal's
          // events up the component tree, to the surface's root.
          event.stopPropagation()
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save()
          }
        }}
        className={`block max-h-[220px] w-full resize-none bg-transparent text-[13px] leading-[19px] text-fg outline-none [overflow-wrap:anywhere] placeholder:text-muted ${isNew ? "min-h-[38px]" : ""}`}
      />
      {/* The footer band of the transcript cards (CardActions): a full-width hairline and tint, out to the
          panel's edges, so its corners take the panel's inner radius (rounded-lg less the 1px border).
          10px from the text to the hairline, the same as the panel's own top padding. Buttons stay on the
          right, where a comment box's submit is and where typing ends (maintainer 2026-11-16, picked from
          a mockup over the cards' left-aligned rule; the comment's own card took the same band 2026-11-18). */}
      <div className="-mx-3 -mb-2.5 mt-2.5 flex items-center justify-end gap-1 rounded-b-[7px] border-t border-border bg-fg/[0.03] px-3 py-[7px]">
        {isNew || changed ? (
          <>
            <button type="button" onClick={onCancel} className={GHOST_BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!text || !changed}
              onClick={save}
              className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-30"
            >
              {isNew ? "Add comment" : "Save"}
            </button>
          </>
        ) : (
          <button type="button" onClick={onDelete} className={GHOST_BUTTON}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

const GHOST_BUTTON = "rounded-md px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"

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
        onClick={() => controller.nav(1)}
        onMouseDown={(event) => event.preventDefault()}
        className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        {/* On the cap band, as the counts beside it are (QueueOpsSummary's OpsCount). */}
        <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
          <span className="absolute inset-0 flex items-center justify-center"><MessageSquare className="h-[1em] w-[1em]" strokeWidth={2.2} /></span>
        </span>
        <span><span className="font-medium tabular-nums">{n}</span> comment{n === 1 ? "" : "s"}</span>
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
          <button type="button" onClick={() => setConfirming(true)} className="ml-0.5 rounded-md px-1.5 py-0.5 text-[11.5px] outline-none transition-colors hover:bg-panel-2 hover:text-fg/85 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
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
