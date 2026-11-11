import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { createPortal } from "react-dom"
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import {
  ArrowUp, Check, ChevronDown, ChevronLeft, ChevronUp, FileText, Maximize2, MessageSquare, MessageSquarePlus,
  Paperclip, Pencil, Plus, RefreshCw, Trash2, X,
} from "lucide-react"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import {
  boxesOf, fullText, HIGHLIGHT_CSS, HIGHLIGHTS, inUi, MESSAGES, NOTE, offsetsToRange, paints, rangeToOffsets, repaint,
  S1, S2, S3, SEEDS, trimmed, wireText, type Box, type PaintKind, type Seed,
} from "./inline-comments-mockup-kit.ts"
import { VSpace } from "./components/rhythm.tsx"
import { BoxSpinner, STATUS_BOX } from "./components/BoxSpinner.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { HEADER_ICON_CLASS } from "./lib/headerIcon.ts"
import "./styles.css"

// MOCKUP SHEET — INLINE COMMENTS ON THE TRANSCRIPT: select a passage, leave a comment on it, and it
// waits as PENDING; every pending comment goes out with the next send, as ONE steer.
//
// Not shipped UI and not a test: a design surface in the pin/pause mockup shape. The ask (maintainer
// 2026-10-01): "highlight any part of the chat transcript and leave a sort of inline comment that gets
// kind of staged … send everything at once as a unified steer … we also need a way for it to be clear
// to the user how many pending comments there are."
//
// The transcript is the REAL `Message` renderer (md-body prose, the user bubble, the tool digest) fed
// fixture messages. The header, prompt box and lifecycle footer are copies of ThreadHeader / Composer /
// ThreadLifecycleFooter, because most of what is drawn here are states those components cannot reach.
//
// The transcript data, the anchors and the highlight engine live in inline-comments-mockup-kit.ts.
//
//   http://localhost:5478/inline-comments-mockup-fixture.html   (?theme=light for the light palette)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

type Placement = "inline" | "margin" | "pins" | "chips"
type CountStyle = "strip" | "badge" | "label" | "header" | "none"
type Status = "draft" | "pending" | "sent"
interface Comment {
  id: string
  start: number
  end: number
  quote: string
  text: string
  status: Status
  /** Set while an existing comment is re-opened for editing: Cancel restores it. */
  prevText?: string
  /** A draft the human just opened: its editor takes focus. Seeded drafts do not, or the sheet would scroll. */
  fresh?: boolean
  sentIn?: string
}
interface SentReview { id: string; note: string; items: { id: string; quote: string; text: string }[]; queued: boolean }
// ── the pieces a pending comment can wear ───────────────────────────────────────────────────────────

const GHOST_BUTTON = "rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-panel-2 hover:text-fg"
const PRIMARY_BUTTON = "rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
const TINY_ICON = "flex h-5 w-5 items-center justify-center rounded text-muted-60 transition-colors hover:bg-panel-2 hover:text-fg"

function CommentEditor({ initial, editing, focus, onSave, onCancel }: { initial: string; editing?: boolean; focus?: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  useEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: true })
  }, [focus])
  return (
    <div data-ic-ui>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder="Comment on this passage…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (value.trim()) onSave(value.trim())
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        className="block min-h-[38px] w-full resize-none bg-transparent text-[13px] leading-[19px] text-fg outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-auto text-[10.5px] text-muted-55">⌘⏎ adds · Esc cancels</span>
        <button type="button" className={GHOST_BUTTON} onClick={onCancel}>Cancel</button>
        <button type="button" className={PRIMARY_BUTTON} disabled={!value.trim()} onClick={() => onSave(value.trim())}>
          {editing ? "Save" : "Add comment"}
        </button>
      </div>
    </div>
  )
}

interface CommentActions {
  hover: (id: string | null) => void
  edit: (id: string) => void
  remove: (id: string) => void
  save: (id: string, text: string) => void
  cancel: (id: string) => void
}

// A · the comment as a REPLY BUBBLE under its passage: the human's own bubble, drawn dashed and unfilled
// because it has not been sent. Right-aligned like every human word in the transcript.
function InlineCard({ c, active, actions }: { c: Comment; active: boolean; actions: CommentActions }) {
  const editing = c.status === "draft"
  return (
    <div data-ic-ui className="flex justify-end" onMouseEnter={() => actions.hover(c.id)} onMouseLeave={() => actions.hover(null)}>
      <div
        className={`group/card w-[min(100%,440px)] rounded-xl rounded-tr-sm border px-3 py-2 text-[13px] leading-[19px] transition-colors ${
          editing
            ? "border-accent bg-bg"
            : active
              ? "border-accent/70 bg-panel-2/70"
              : "border-dashed border-muted-45 bg-panel-2/40"
        }`}
      >
        {editing ? (
          <CommentEditor initial={c.prevText ?? c.text} editing={c.prevText !== undefined} focus={c.fresh} onSave={(t) => actions.save(c.id, t)} onCancel={() => actions.cancel(c.id)} />
        ) : (
          <>
            <div className="mb-0.5 flex h-5 items-center gap-1.5 text-[11px] text-muted-65">
              {/* 1px down: petite caps sit on the x band, and the glyph's box centre rode 1.5px above it. */}
              <MessageSquare size={11} className="translate-y-px text-accent" />
              <span className="petite-caps tracking-wide">Pending</span>
              <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover/card:opacity-100">
                <button type="button" title="Edit" className={TINY_ICON} onClick={() => actions.edit(c.id)}><Pencil size={11} /></button>
                <button type="button" title="Delete" className={TINY_ICON} onClick={() => actions.remove(c.id)}><Trash2 size={11} /></button>
              </span>
            </div>
            <div className="whitespace-pre-wrap text-fg/90">{c.text}</div>
          </>
        )}
      </div>
    </div>
  )
}

// B · a MARGIN NOTE, level with its passage (Google Docs). Positioned by the frame.
function MarginNote({ c, active, actions, top, left, width, measure }: { c: Comment; active: boolean; actions: CommentActions; top: number; left: number; width: number; measure: (el: HTMLDivElement | null) => void }) {
  const editing = c.status === "draft"
  return (
    <div
      ref={measure}
      data-ic-ui
      onMouseEnter={() => actions.hover(c.id)}
      onMouseLeave={() => actions.hover(null)}
      className={`group/card absolute rounded-lg border px-3 py-2 text-[12.5px] leading-[18px] shadow-sm transition-[top,border-color,transform] duration-200 ${
        editing ? "border-accent bg-bg" : active ? "-translate-x-1.5 border-accent/70 bg-panel-2" : "border-border bg-panel-2"
      }`}
      style={{ top, left, width }}
    >
      {editing ? (
        <CommentEditor initial={c.prevText ?? c.text} editing={c.prevText !== undefined} focus={c.fresh} onSave={(t) => actions.save(c.id, t)} onCancel={() => actions.cancel(c.id)} />
      ) : (
        <>
          <div className="mb-0.5 flex h-5 items-center gap-1.5 text-[11px] text-muted-65">
            <span className="h-1.5 w-1.5 translate-y-px rounded-full bg-accent" />
            <span className="petite-caps tracking-wide">Pending</span>
            <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover/card:opacity-100">
              <button type="button" title="Edit" className={TINY_ICON} onClick={() => actions.edit(c.id)}><Pencil size={11} /></button>
              <button type="button" title="Delete" className={TINY_ICON} onClick={() => actions.remove(c.id)}><Trash2 size={11} /></button>
            </span>
          </div>
          <div className="whitespace-pre-wrap text-fg/90">{c.text}</div>
        </>
      )}
    </div>
  )
}

// C · a numbered PIN in the transcript's left gutter.
function Pin({ n, active, top, onClick }: { n: number; active: boolean; top: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-ic-ui
      onClick={onClick}
      className={`absolute left-[5px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-[3px] text-[9.5px] font-semibold tabular-nums leading-none transition-colors ${
        active ? "bg-accent text-bg" : "bg-accent/25 text-accent hover:bg-accent/40"
      }`}
      style={{ top }}
    >
      {n}
    </button>
  )
}

// The SENT steer, as the transcript shows it afterwards: the human's bubble carrying the note, then each
// comment under the passage it quotes. A quote is a link back to its passage.
function ReviewBubble({ review, onQuote }: { review: SentReview; onQuote: (commentId: string) => void }) {
  return (
    <div data-ic-sent={review.id} className="flex max-w-[85%] flex-col items-end self-end">
      <div className={`rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] leading-[20px] text-user-bubble-fg transition-opacity duration-500 ${review.queued ? "opacity-50" : ""}`}>
        {review.note && <p className="whitespace-pre-wrap">{review.note}</p>}
        {review.note && review.items.length > 0 && <div className="my-2.5 h-px bg-bg/15" />}
        <div className="flex flex-col gap-2.5">
          {review.items.map((it) => (
            <div key={it.id}>
              <button
                type="button"
                title="Show this passage"
                onClick={() => onQuote(it.id)}
                className="line-clamp-2 block border-l-2 border-bg/25 pl-2 text-left text-[12px] leading-[17px] text-user-bubble-fg/60 transition-colors hover:border-bg/50 hover:text-user-bubble-fg/85"
              >
                {it.quote}
              </button>
              <p className="mt-1 whitespace-pre-wrap">{it.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── the drawer's chrome (copies) ──────────────────────────────────────────────────────────────────

function HeaderStrip({ running, count, pending, onNav }: { running: boolean; count: CountStyle; pending: number; onNav: (dir: 1 | -1) => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-3">
      <div className="min-w-0 flex-1 pl-1 leading-tight">
        <div className="truncate text-[13px] font-medium text-fg/90">Fix the cache collision in the resolver</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-75">{running ? "Running · 4m 12s" : "Rested 2m ago"}</div>
      </div>
      {count === "header" && pending > 0 && (
        <span className="flex h-7 shrink-0 items-center rounded-md border border-accent/40 bg-accent/10 text-[12px] text-accent">
          <span className="flex items-center gap-1.5 pl-2 pr-1.5"><MessageSquare size={12} /><span className="font-medium tabular-nums">{pending}</span> pending</span>
          <span className="h-3.5 w-px bg-accent/30" />
          <button type="button" title="Previous comment" className="flex h-7 w-6 items-center justify-center hover:text-fg" onClick={() => onNav(-1)}><ChevronUp size={13} /></button>
          <button type="button" title="Next comment" className="flex h-7 w-6 items-center justify-center rounded-r-md hover:text-fg" onClick={() => onNav(1)}><ChevronDown size={13} /></button>
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <span className={HEADER_ICON_CLASS}><RefreshCw size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><FileText size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><Maximize2 size={13} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><X size={15} strokeWidth={2} /></span>
      </div>
    </div>
  )
}

function PhoneHeader() {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
      <span className="flex h-9 w-9 items-center justify-center text-fg/80"><ChevronLeft size={20} /></span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg/90">Fix the cache collision in the resolver</span>
    </div>
  )
}

const PILL = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80"
function LifecycleFooter() {
  return (
    <footer className="flex min-h-10 shrink-0 items-center justify-end gap-3 border-t border-border/70 bg-panel/95 px-3 pb-2 pt-2 text-[12px]">
      <svg width="1em" height="1em" viewBox="0 0 16 16" className="mr-auto text-muted-60" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="14 38" transform="rotate(-90 8 8)" />
      </svg>
      <span className="inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60">
        <span className="flex items-center rounded-l-md px-2.5 py-1 font-medium text-fg/75">Snooze 1d</span>
        <span aria-hidden className="my-1 w-px bg-border" />
        <span className="flex items-center px-2 text-fg/75"><ChevronDown size={12} /></span>
      </span>
      <span className={`flex items-center gap-1 font-medium ${PILL}`}><Check size={12} />Mark as done</span>
    </footer>
  )
}

function ProfileChip() {
  return (
    <span className="inline-flex items-center gap-[3px] rounded-md border border-border/50 px-2 py-1 text-muted">
      <span className="petite-caps text-[11px] tracking-wide">Claude Opus 5.5 › high</span>
      <ChevronDown size={12} className="text-fg/65" />
    </span>
  )
}

interface ComposerProps {
  count: CountStyle
  placement: Placement
  running: boolean
  pending: Comment[]
  activeId: string | null
  text: string
  setText: (t: string) => void
  onSend: () => void
  onNav: (dir: 1 | -1) => void
  onOpen: (id: string) => void
  confirmDiscard: boolean
  setConfirmDiscard: (v: boolean) => void
  onDiscardAll: () => void
  trayOpen: boolean
  setTrayOpen: (v: boolean) => void
  actions: CommentActions
  phone?: boolean
}

function placeholderFor(running: boolean, n: number): string {
  if (n === 0) return running ? "Steer…" : "Reply…"
  return `Add a note to go with ${n === 1 ? "the comment" : `the ${n} comments`} (optional)…`
}

function sendTitle(running: boolean, n: number): string {
  if (n === 0) return "Send (Enter · ⌘⏎ sends now)"
  return `${running ? "Steer" : "Send"} with ${n} comment${n === 1 ? "" : "s"} (Enter)`
}

// The pending count, as a band across the top of the prompt box: count · walk them · discard.
function PendingStrip({ p }: { p: ComposerProps }) {
  const n = p.pending.length
  const tray = p.placement === "pins"
  return (
    <div data-ic-ui className="flex h-8 items-center gap-1 rounded-t-[11px] border-b border-border/70 bg-panel-2/50 pl-3 pr-1.5 text-[12px]">
      <MessageSquare size={12} className="shrink-0 text-accent" />
      <button
        type="button"
        className="flex items-center gap-1 text-fg/80 transition-colors hover:text-fg"
        onClick={() => (tray ? p.setTrayOpen(!p.trayOpen) : p.onNav(1))}
      >
        <span className="font-medium tabular-nums text-fg">{n}</span> pending comment{n === 1 ? "" : "s"}
        {tray && <ChevronUp size={12} className={`text-muted transition-transform ${p.trayOpen ? "" : "rotate-180"}`} />}
      </button>
      {p.confirmDiscard ? (
        <span className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-muted">Discard {n === 1 ? "it" : `all ${n}`}?</span>
          <button type="button" className="rounded-md bg-danger-button px-2 py-0.5 text-[12px] font-medium text-white hover:opacity-90" onClick={p.onDiscardAll}>Discard</button>
          <button type="button" className={GHOST_BUTTON} onClick={() => p.setConfirmDiscard(false)}>Keep</button>
        </span>
      ) : (
        <span className="ml-auto flex items-center">
          <button type="button" title="Previous comment" className={TINY_ICON + " h-6 w-6"} onClick={() => p.onNav(-1)}><ChevronUp size={13} /></button>
          <button type="button" title="Next comment" className={TINY_ICON + " h-6 w-6"} onClick={() => p.onNav(1)}><ChevronDown size={13} /></button>
          <span className="mx-1 h-3.5 w-px bg-border" />
          <button type="button" className="rounded-md px-1.5 py-0.5 text-muted transition-colors hover:bg-panel-2 hover:text-fg" onClick={() => p.setConfirmDiscard(true)}>Discard</button>
        </span>
      )}
    </div>
  )
}

// C's tray: every pending comment, in transcript order, under the strip.
function Tray({ p }: { p: ComposerProps }) {
  return (
    <div data-ic-ui className="max-h-[188px] overflow-y-auto border-b border-border/70 px-1.5 py-1.5">
      {p.pending.map((c, i) => (
        <div
          key={c.id}
          onMouseEnter={() => p.actions.hover(c.id)}
          onMouseLeave={() => p.actions.hover(null)}
          onClick={() => p.onOpen(c.id)}
          className={`group/row flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 ${p.activeId === c.id ? "bg-panel-2" : "hover:bg-panel-2/60"}`}
        >
          <span className={`mt-[2px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-[3px] text-[9.5px] font-semibold tabular-nums ${p.activeId === c.id ? "bg-accent text-bg" : "bg-accent/25 text-accent"}`}>{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] leading-[17px] text-muted-70">“{c.quote}”</span>
            <span className="block text-[12.5px] leading-[18px] text-fg/90">{c.text}</span>
          </span>
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100">
            <button type="button" title="Delete" className={TINY_ICON} onClick={(e) => { e.stopPropagation(); p.actions.remove(c.id) }}><Trash2 size={11} /></button>
          </span>
        </div>
      ))}
    </div>
  )
}

function SendButton({ p, enabled }: { p: ComposerProps; enabled: boolean }) {
  const n = p.pending.length
  if (p.count === "label" && n > 0) {
    return (
      <button type="button" title={sendTitle(p.running, n)} onClick={p.onSend} className="flex h-7 items-center gap-1 rounded-lg bg-fg pl-2.5 pr-2 text-[12px] font-medium text-bg hover:opacity-90 active:scale-95">
        {p.running ? "Steer" : "Send"} {n}<ArrowUp size={13} strokeWidth={2.5} />
      </button>
    )
  }
  return (
    <button
      type="button"
      title={sendTitle(p.running, n)}
      disabled={!enabled}
      onClick={p.onSend}
      className={`relative flex h-7 w-7 items-center justify-center rounded-lg transition-all ${enabled ? "bg-fg text-bg hover:opacity-90 active:scale-95" : "bg-panel-2 text-muted"}`}
    >
      <ArrowUp size={14} strokeWidth={2.5} />
      {p.count === "badge" && n > 0 && (
        <span className="absolute -right-[7px] -top-[7px] flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-bg ring-2 ring-bg">{n}</span>
      )}
    </button>
  )
}

function ComposerBox({ p }: { p: ComposerProps }) {
  const n = p.pending.length
  const enabled = Boolean(p.text.trim()) || n > 0
  const textarea = (
    <textarea
      value={p.text}
      rows={2}
      placeholder={placeholderFor(p.running, n)}
      onChange={(e) => p.setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          p.onSend()
        }
      }}
      className={`relative block w-full resize-none bg-transparent text-fg outline-none placeholder:text-muted ${p.phone ? "px-3 py-2 text-[15px] leading-[21px]" : "px-3.5 py-2.5 pb-3 text-[13px] leading-relaxed"}`}
    />
  )
  if (p.phone) {
    return (
      <div className="shrink-0 bg-bg px-2.5 pb-3 pt-2">
        {n > 0 && p.count !== "none" && (
          <div data-ic-ui className="mb-2 flex h-9 items-center gap-2 rounded-full border border-border bg-panel pl-3.5 pr-1.5 text-[13px]">
            <MessageSquare size={13} className="text-accent" />
            <span className="text-fg/85"><span className="font-medium tabular-nums text-fg">{n}</span> pending comment{n === 1 ? "" : "s"}</span>
            <span className="ml-auto flex items-center">
              <button type="button" className="flex h-7 w-8 items-center justify-center text-muted" onClick={() => p.onNav(-1)}><ChevronUp size={16} /></button>
              <button type="button" className="flex h-7 w-8 items-center justify-center text-muted" onClick={() => p.onNav(1)}><ChevronDown size={16} /></button>
            </span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-fg"><Plus size={19} strokeWidth={2.2} /></span>
          <div className="min-w-0 flex-1 rounded-[21px] border border-border-strong bg-panel">{textarea}</div>
          <button type="button" onClick={p.onSend} disabled={!enabled} className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-fg text-bg disabled:opacity-35">
            <ArrowUp size={19} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="shrink-0 px-3 pb-3 pt-2">
      <div className="group relative rounded-xl border border-border bg-bg transition-colors focus-within:border-accent">
        {p.count === "strip" && n > 0 && <PendingStrip p={p} />}
        {p.placement === "pins" && p.trayOpen && n > 0 && <Tray p={p} />}
        {textarea}
        <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-1.5 pr-28"><ProfileChip /></div>
        {/* right-2 + gap-2 reproduces the rail's own offsets (send right-2, paperclip right-[44px]) and
            keeps that 8px gap when the send button widens to a label. */}
        <div className="absolute bottom-2 right-2 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
          <SendButton p={p} enabled={enabled} />
        </div>
      </div>
    </div>
  )
}

// D · the ⌘I idiom as it ships today: the selection becomes a chip at the caret and the remark is the
// prose after it. Drawn static — the live prototype covers A, B and C.
function ChipComposer({ seeds }: { seeds: Seed[] }) {
  const chip = (q: string) => (
    <span className="mx-[1px] rounded bg-panel-2 px-1 py-0.5 text-[12px] ring-1 ring-inset ring-border">“{q.length > 22 ? `${q.slice(0, 21)}…` : q}”</span>
  )
  return (
    <div className="shrink-0 px-3 pb-3 pt-2">
      <div className="relative rounded-xl border border-accent bg-bg">
        <div className="px-3.5 pb-3 pt-2.5 text-[13px] leading-[26px] text-fg">
          {NOTE}{" "}
          {seeds.map((s, i) => (
            <Fragment key={i}>{chip(s.quote)} {s.text}{" "}</Fragment>
          ))}
          <span className="-ml-0.5 inline-block h-[15px] w-px translate-y-[3px] animate-pulse bg-fg" />
        </div>
        <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-1.5 pr-28"><ProfileChip /></div>
        <span className="absolute bottom-2 right-[44px] flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
        <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-fg text-bg"><ArrowUp size={14} strokeWidth={2.5} /></span>
      </div>
    </div>
  )
}

// ── one drawer, live ────────────────────────────────────────────────────────────────────────────────

interface FrameProps {
  placement: Placement
  count: CountStyle
  width?: number
  height?: number
  running?: boolean
  seeds?: Seed[]
  /** Index into `seeds` drawn hovered/active. */
  activeSeed?: number
  /** Draw the post-send state: the seeds were sent with this note. */
  sentNote?: string
  sentQueued?: boolean
  /** A passage drawn selected, with the Comment button over it. */
  selectQuote?: string
  confirmDiscard?: boolean
  trayOpen?: boolean
  ticks?: boolean
  phone?: boolean
  scroll?: "bottom" | "first"
  footer?: boolean
  onSent?: (review: SentReview) => void
}

let seq = 0
const nextId = () => `c${++seq}`

function Frame(props: FrameProps) {
  const { placement, count, running = false, phone = false } = props
  const width = props.width ?? (placement === "margin" ? 900 : 600)
  const height = props.height ?? 640
  const frameKey = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [sent, setSent] = useState<SentReview[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [toolbar, setToolbar] = useState<{ start: number; end: number; fake?: boolean } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(Boolean(props.confirmDiscard))
  const [trayOpen, setTrayOpen] = useState(Boolean(props.trayOpen))
  const [geo, setGeo] = useState<{ boxes: Record<string, Box[]>; sel: Box[]; rootW: number; rootH: number }>({ boxes: {}, sel: [], rootW: 0, rootH: 0 })
  const [slots, setSlots] = useState<{ el: Record<string, HTMLElement>; msg: Record<string, string> }>({ el: {}, msg: {} })
  const [noteTops, setNoteTops] = useState<Record<string, number>>({})
  const noteHeights = useRef(new Map<string, number>())
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const seeded = useRef(false)
  const pinned = useRef(true)

  // Seeds resolve against the rendered text, so they wait for the DOM.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || seeded.current) return
    seeded.current = true
    const text = fullText(root)
    const made: Comment[] = []
    for (const s of props.seeds ?? []) {
      const at = text.indexOf(s.quote)
      if (at < 0) continue
      made.push({ id: nextId(), start: at, end: at + s.quote.length, quote: s.quote, text: s.text, status: s.status ?? "pending" })
    }
    if (props.sentNote !== undefined) {
      const review: SentReview = { id: nextId(), note: props.sentNote, items: made.map((c) => ({ id: c.id, quote: c.quote, text: c.text })), queued: Boolean(props.sentQueued) }
      made.forEach((c) => { c.status = "sent"; c.sentIn = review.id })
      setSent([review])
    }
    setComments(made)
    if (props.activeSeed !== undefined && made[props.activeSeed]) setActiveId(made[props.activeSeed].id)
    if (props.selectQuote) {
      const at = text.indexOf(props.selectQuote)
      if (at >= 0) setToolbar({ start: at, end: at + props.selectQuote.length, fake: true })
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => bump())
    ro.observe(root)
    void document.fonts.ready.then(() => bump())
    return () => {
      ro.disconnect()
      paints.delete(frameKey)
      repaint()
    }
  }, [frameKey])

  // A · reply bubbles hang under the passage's own block: appended inside a list item, or after the
  // top-level block of the prose. Prose is innerHTML, so the slot is a plain element there and the card
  // reaches it through a portal; anything React owns (a user bubble, a tool row) gets the slot after its
  // message instead.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const el: Record<string, HTMLElement> = {}
    const msg: Record<string, string> = {}
    const used = new Set<HTMLElement>()
    if (placement === "inline") {
      for (const c of comments) {
        if (c.status === "sent") continue
        const r = offsetsToRange(root, Math.max(c.start, c.end - 1), c.end)
        const node = r?.endContainer
        const at = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)
        if (!at) continue
        const md = at.closest(".md-body")
        if (md && root.contains(md)) {
          const li = at.closest("li")
          let slot: HTMLElement | null = null
          if (li && md.contains(li)) {
            slot = li.querySelector<HTMLElement>(":scope > [data-ic-slot]")
            if (!slot) li.appendChild((slot = makeSlot()))
          } else {
            let top: Element = at
            while (top.parentElement && top.parentElement !== md) top = top.parentElement
            const next = top.nextElementSibling
            slot = next instanceof HTMLElement && next.hasAttribute("data-ic-slot") ? next : null
            if (!slot) top.after((slot = makeSlot()))
          }
          el[c.id] = slot
          used.add(slot)
        } else {
          const owner = at.closest("[data-frizz-msg]")?.getAttribute("data-frizz-msg")
          if (owner) msg[c.id] = owner
        }
      }
    }
    root.querySelectorAll<HTMLElement>("[data-ic-slot]").forEach((s) => { if (!used.has(s)) s.remove() })
    setSlots((prev) => (sameRecord(prev.el, el) && sameRecord(prev.msg, msg) ? prev : { el, msg }))
  })

  // Geometry and paint, after every render; state only moves when a box actually moved.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const boxes: Record<string, Box[]> = {}
    const paint: Partial<Record<PaintKind, Range[]>> = {}
    for (const c of comments) {
      const r = offsetsToRange(root, c.start, c.end)
      if (!r) continue
      boxes[c.id] = boxesOf(root, r)
      const kind: PaintKind = c.status === "draft" ? "draft" : c.id === activeId || c.id === hoverId ? "active" : c.status === "sent" ? "sent" : "pending"
      ;(paint[kind] ??= []).push(r)
    }
    let sel: Box[] = []
    if (toolbar) {
      const r = offsetsToRange(root, toolbar.start, toolbar.end)
      if (r) {
        sel = boxesOf(root, r)
        if (toolbar.fake) (paint.fakesel ??= []).push(r)
      }
    }
    paints.set(frameKey, paint)
    repaint()
    const next = { boxes, sel, rootW: root.clientWidth, rootH: root.scrollHeight }
    setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  })

  // B · notes stack top-down from their passages, never overlapping.
  useLayoutEffect(() => {
    if (placement !== "margin") return
    const items = comments
      .filter((c) => c.status !== "sent" && geo.boxes[c.id]?.length)
      .map((c) => ({ id: c.id, want: geo.boxes[c.id][0].top - 7, h: noteHeights.current.get(c.id) ?? 64 }))
      .sort((a, b) => a.want - b.want)
    const tops: Record<string, number> = {}
    let floor = -Infinity
    for (const it of items) {
      const top = Math.max(it.want, floor + 8)
      tops[it.id] = top
      floor = top + it.h
    }
    setNoteTops((prev) => (sameRecord(prev, tops) ? prev : tops))
  })

  // Hold the frame on its point (the selection, the first comment, or the tail) while fonts and slots
  // settle, until the human scrolls or clicks in it.
  useEffect(() => {
    const sc = scrollerRef.current
    if (!sc) return
    const release = () => { pinned.current = false }
    sc.addEventListener("wheel", release, { passive: true })
    sc.addEventListener("touchstart", release, { passive: true })
    sc.addEventListener("pointerdown", release)
    return () => {
      sc.removeEventListener("wheel", release)
      sc.removeEventListener("touchstart", release)
      sc.removeEventListener("pointerdown", release)
    }
  }, [])
  useEffect(() => {
    const sc = scrollerRef.current
    if (!sc || !pinned.current || !seeded.current) return
    if (props.selectQuote && geo.sel[0]) {
      sc.scrollTop = geo.sel[0].top - 150
      return
    }
    const first = comments.map((c) => geo.boxes[c.id]?.[0]).filter((b): b is Box => Boolean(b)).sort((a, b) => a.top - b.top)[0]
    sc.scrollTop = props.scroll === "first" && first ? first.top - 48 : sc.scrollHeight
  }, [geo, comments, noteTops])

  // A real selection inside this frame's transcript puts the Comment button over it.
  useEffect(() => {
    const onSelection = () => {
      const root = rootRef.current
      const s = window.getSelection()
      if (!root) return
      if (!s || s.isCollapsed || !s.rangeCount) {
        setToolbar((t) => (t && !t.fake ? null : t))
        return
      }
      const r = s.getRangeAt(0)
      if (!root.contains(r.commonAncestorContainer) || inUi(r.startContainer) || inUi(r.endContainer)) {
        setToolbar((t) => (t && !t.fake ? null : t))
        return
      }
      const offs = rangeToOffsets(root, r)
      if (!offs) return
      const [start, end] = trimmed(root, offs)
      if (end - start < 1) return
      setToolbar({ start, end })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "i" || !(e.metaKey || e.ctrlKey)) return
      const root = rootRef.current
      const s = window.getSelection()
      if (!root || !s || s.isCollapsed || !s.rangeCount || !root.contains(s.getRangeAt(0).commonAncestorContainer)) return
      e.preventDefault()
      const offs = rangeToOffsets(root, s.getRangeAt(0))
      if (offs) openDraft(...trimmed(root, offs))
    }
    document.addEventListener("selectionchange", onSelection)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("selectionchange", onSelection)
      document.removeEventListener("keydown", onKey)
    }
  })

  function openDraft(start: number, end: number) {
    pinned.current = false
    const root = rootRef.current
    if (!root || placement === "chips") return
    const quote = fullText(root).slice(start, end).replace(/\s+/g, " ")
    const id = nextId()
    setComments((cs) => [...cs.filter((c) => c.status !== "draft" || c.prevText !== undefined), { id, start, end, quote, text: "", status: "draft", fresh: true }])
    setActiveId(id)
    setToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  const pending = useMemo(() => comments.filter((c) => c.status === "pending").sort((a, b) => a.start - b.start), [comments])

  function reveal(id: string) {
    pinned.current = false
    const sc = scrollerRef.current
    const b = geo.boxes[id]?.[0]
    if (sc && b) sc.scrollTo({ top: Math.max(0, b.top - sc.clientHeight * 0.3), behavior: "smooth" })
  }

  function nav(dir: 1 | -1) {
    if (!pending.length) return
    const at = pending.findIndex((c) => c.id === activeId)
    const next = pending[at < 0 ? (dir > 0 ? 0 : pending.length - 1) : (at + dir + pending.length) % pending.length]
    setActiveId(next.id)
    reveal(next.id)
  }

  const actions: CommentActions = {
    hover: setHoverId,
    edit: (id) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, status: "draft", prevText: c.text, fresh: true } : c))),
    remove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
    save: (id, t) => {
      setComments((cs) => cs.map((c) => (c.id === id ? { ...c, text: t, status: "pending", prevText: undefined, fresh: false } : c)))
      setActiveId(null)
    },
    cancel: (id) => {
      setComments((cs) => cs.flatMap((c) => (c.id !== id ? [c] : c.prevText !== undefined ? [{ ...c, status: "pending" as const, prevText: undefined, fresh: false }] : [])))
      setActiveId(null)
    },
  }

  function open(id: string) {
    const c = comments.find((x) => x.id === id)
    if (!c) return
    if (c.status === "sent") {
      const root = rootRef.current
      const sc = scrollerRef.current
      const bubble = root?.querySelector<HTMLElement>(`[data-ic-sent="${c.sentIn}"]`)
      if (root && sc && bubble) sc.scrollTo({ top: bubble.getBoundingClientRect().top - root.getBoundingClientRect().top - 40, behavior: "smooth" })
      return
    }
    setActiveId(id)
    if (placement === "pins") setTrayOpen(true)
  }

  function send() {
    if (!text.trim() && !pending.length) return
    pinned.current = false
    const review: SentReview = { id: nextId(), note: text.trim(), items: pending.map((c) => ({ id: c.id, quote: c.quote, text: c.text })), queued: running }
    const ids = new Set(pending.map((c) => c.id))
    setComments((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, status: "sent", sentIn: review.id } : c)))
    setSent((s) => [...s, review])
    setText("")
    setActiveId(null)
    setTrayOpen(false)
    props.onSent?.(review)
    if (running) setTimeout(() => setSent((s) => s.map((r) => (r.id === review.id ? { ...r, queued: false } : r))), 2400)
    requestAnimationFrame(() => {
      const sc = scrollerRef.current
      if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" })
    })
  }

  // Hover/click on a highlight.
  function hitTest(e: ReactMouseEvent): string | null {
    const root = rootRef.current
    if (!root) return null
    const o = root.getBoundingClientRect()
    const x = e.clientX - o.left
    const y = e.clientY - o.top
    for (const c of comments) {
      if (c.status === "draft") continue
      if (geo.boxes[c.id]?.some((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height)) return c.id
    }
    return null
  }

  const colWidth = placement === "margin" ? width - 300 : width
  const ordered = [...comments].filter((c) => c.status !== "sent").sort((a, b) => a.start - b.start)
  const numberOf = (id: string) => ordered.findIndex((c) => c.id === id) + 1
  const selBox = geo.sel.length
    ? {
        left: Math.min(...geo.sel.map((b) => b.left)),
        right: Math.max(...geo.sel.map((b) => b.left + b.width)),
        top: Math.min(...geo.sel.map((b) => b.top)),
        bottom: Math.max(...geo.sel.map((b) => b.top + b.height)),
      }
    : null

  const composerProps: ComposerProps = {
    count, placement, running, pending, activeId, text, setText, onSend: send, onNav: nav, onOpen: (id) => { setActiveId(id); reveal(id) },
    confirmDiscard, setConfirmDiscard,
    onDiscardAll: () => { setComments((cs) => cs.filter((c) => c.status === "sent")); setConfirmDiscard(false); setActiveId(null) },
    trayOpen, setTrayOpen, actions, phone,
  }

  return (
    <div className={`flex flex-col overflow-hidden border border-border bg-panel ${phone ? "rounded-[28px]" : "rounded-xl"}`} style={{ width, height }}>
      {phone ? <PhoneHeader /> : <HeaderStrip running={running} count={count} pending={pending.length} onNav={nav} />}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} className="absolute inset-0 overflow-y-auto">
          <div
            className="relative"
            style={{
              width: placement === "margin" ? width : undefined,
              // A stack of notes can run past the transcript's last line; the column has to scroll that far.
              minHeight: placement === "margin" ? Math.max(0, ...Object.entries(noteTops).map(([id, top]) => top + (noteHeights.current.get(id) ?? 64) + 20)) : undefined,
            }}
          >
            <div
              ref={rootRef}
              data-ic-root
              className={`relative flex min-h-full flex-col py-5 ${phone ? "px-4" : "px-6"} ${hoverId ? "cursor-pointer" : ""}`}
              style={{ width: placement === "margin" ? colWidth : undefined }}
              onMouseMove={(e) => {
                const id = hitTest(e)
                if (id !== hoverId) setHoverId(id)
              }}
              onMouseLeave={() => setHoverId(null)}
              onClick={(e) => {
                const s = window.getSelection()
                if (s && !s.isCollapsed) return
                if (inUi(e.target as Node)) return
                const id = hitTest(e)
                if (id) open(id)
                else setActiveId(null)
              }}
            >
              {withMessageSpacers(MESSAGES, (m) => (
                <Fragment key={m.sourceId}>
                  <Message m={m} />
                  {Object.entries(slots.msg).filter(([, owner]) => owner === m.sourceId).map(([id]) => {
                    const c = comments.find((x) => x.id === id)
                    return c ? <div key={id} data-ic-ui className="mt-2"><InlineCard c={c} active={activeId === id || hoverId === id} actions={actions} /></div> : null
                  })}
                </Fragment>
              ))}
              {sent.map((r) => (
                <Fragment key={r.id}>
                  <VSpace h={22} />
                  <ReviewBubble review={r} onQuote={(id) => { setActiveId(id); reveal(id) }} />
                </Fragment>
              ))}
              {running && (
                <>
                  <VSpace h={18} />
                  <div className="flex items-center gap-2 text-[13px] text-muted">
                    <span className="animate-pulse">Working</span>
                    <span className="tabular-nums text-[11px] text-muted-55">{sent.length ? "8s" : "4m 12s"}</span>
                  </div>
                </>
              )}

              {placement === "inline" && comments.map((c) => (slots.el[c.id] ? createPortal(<InlineCard key={c.id} c={c} active={activeId === c.id || hoverId === c.id} actions={actions} />, slots.el[c.id], c.id) : null))}

              {(placement === "pins" || placement === "chips") && ordered.map((c) => {
                const b = geo.boxes[c.id]?.[0]
                return b && placement === "pins" && c.status !== "draft" ? <Pin key={c.id} n={numberOf(c.id)} active={activeId === c.id || hoverId === c.id} top={b.top + b.height / 2 - 7.5} onClick={() => open(c.id)} /> : null
              })}

              {placement === "pins" && comments.filter((c) => c.status === "draft").map((c) => {
                const bs = geo.boxes[c.id]
                if (!bs?.length) return null
                const last = bs[bs.length - 1]
                const left = Math.max(16, Math.min(bs[0].left - 12, geo.rootW - 336))
                return (
                  <div key={c.id} data-ic-ui className="absolute z-20 w-[320px] rounded-xl border border-accent bg-bg px-3 py-2 shadow-xl shadow-black/40" style={{ top: last.top + last.height + 8, left }}>
                    <CommentEditor initial={c.prevText ?? c.text} editing={c.prevText !== undefined} focus={c.fresh} onSave={(t) => actions.save(c.id, t)} onCancel={() => actions.cancel(c.id)} />
                  </div>
                )
              })}

              {!HIGHLIGHTS && comments.flatMap((c) => (geo.boxes[c.id] ?? []).map((b, i) => (
                <span key={`${c.id}-${i}`} data-ic-ui className="pointer-events-none absolute border-b-[1.5px] border-accent/70 bg-accent/15" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
              )))}

              {toolbar && selBox && (
                <div
                  data-ic-ui
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute z-30 flex items-center rounded-lg border border-border-strong bg-elevated p-0.5 shadow-lg shadow-black/40"
                  style={{
                    left: Math.max(4, Math.min((selBox.left + selBox.right) / 2 - 62, geo.rootW - 128)),
                    top: phone ? selBox.bottom + 10 : selBox.top - 38,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => openDraft(toolbar.start, toolbar.end)}
                    className={`flex items-center gap-1.5 rounded-md font-medium text-fg/90 hover:bg-panel-2 ${phone ? "px-3 py-2 text-[14px]" : "px-2 py-1 text-[12px]"}`}
                  >
                    <MessageSquarePlus size={phone ? 15 : 13} />
                    {placement === "chips" ? "Quote in reply" : "Comment"}
                    {!phone && <kbd className="ml-1 font-sans text-[10.5px] font-normal text-muted-60">⌘I</kbd>}
                  </button>
                </div>
              )}
            </div>

            {placement === "margin" && comments.filter((c) => c.status !== "sent" && noteTops[c.id] !== undefined).map((c) => (
              <MarginNote
                key={c.id}
                c={c}
                active={activeId === c.id || hoverId === c.id}
                actions={actions}
                top={noteTops[c.id]}
                left={colWidth + 4}
                width={268}
                measure={(el) => { if (el) noteHeights.current.set(c.id, el.offsetHeight) }}
              />
            ))}
          </div>
        </div>
        {props.ticks && geo.rootH > 0 && (
          <div data-ic-ui className="pointer-events-none absolute inset-y-1 right-0.5 w-[5px]">
            {pending.map((c) => {
              const b = geo.boxes[c.id]?.[0]
              const sc = scrollerRef.current
              if (!b || !sc) return null
              return <span key={c.id} className={`absolute right-0 h-[3px] w-[5px] rounded-full ${activeId === c.id ? "bg-accent" : "bg-accent/70"}`} style={{ top: `${(b.top / geo.rootH) * 100}%` }} />
            })}
          </div>
        )}
      </div>
      {placement === "chips" ? <ChipComposer seeds={props.seeds ?? []} /> : <ComposerBox p={composerProps} />}
      {!phone && props.footer !== false && <LifecycleFooter />}
    </div>
  )
}

function makeSlot(): HTMLElement {
  const d = document.createElement("div")
  d.setAttribute("data-ic-ui", "")
  d.setAttribute("data-ic-slot", "")
  return d
}

function sameRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

// ── the rail (copies of ThreadRow / StatusBox / SectionHeader, Sidebar.tsx) ─────────────────────────

function StatusBox({ children }: { children?: ReactNode }) {
  return <span className="inline-flex items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>{children}</span>
}
function RailRow({ indicator, title, age, comments }: { indicator: ReactNode; title: string; age?: string; comments?: number }) {
  return (
    <div className="group relative flex min-w-0 items-start rounded-md hover:bg-white/[0.04]">
      <div className="flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1">
        <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">{indicator}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg/90">{title}</span>
          {comments ? (
            <span title={`${comments} pending comments, not sent`} className="flex h-[19px] shrink-0 items-center gap-[3px] self-start text-[10.5px] font-medium tabular-nums text-accent">
              <MessageSquare size={10} strokeWidth={2.4} />{comments}
            </span>
          ) : null}
          {age && <span className="shrink-0 tabular-nums text-[10.5px] leading-[19px] text-muted-55">{age}</span>}
        </span>
      </div>
    </div>
  )
}
function Rail() {
  const atRest = <StatusBox><span className="h-[3px] w-[3px] rounded-full bg-muted-70 shadow-[4px_0_0_var(--color-muted-70),-4px_0_0_var(--color-muted-70)]" /></StatusBox>
  return (
    <div className="w-[340px] rounded-xl border border-border bg-panel p-3">
      <div className="mb-5 rounded-lg border border-border/60 bg-bg px-3 py-2.5 text-[13px] text-muted-40">Dispatch a new thread…</div>
      <RailRow indicator={atRest} title="Fix the cache collision in the resolver" comments={3} age="2m" />
      <RailRow indicator={atRest} title="Triage the dependabot queue" age="1d 3h" />
      <hr className="my-3 border-border/50" />
      <RailRow indicator={<BoxSpinner />} title="Verify the relay pin mechanics on staging" comments={1} />
      <RailRow indicator={<BoxSpinner />} title="Port the v2 drivers to the new broker socket" />
    </div>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

function Section({ id, title, note, children }: { id: string; title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mb-16 scroll-mt-20">
      <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-fg/95">{title}</h2>
      <p className="mb-6 max-w-[860px] text-[12.5px] leading-[19px] text-muted">{note}</p>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-12">{children}</div>
    </section>
  )
}
function Candidate({ letter, title, note, pick, children }: { letter: string; title: string; note: ReactNode; pick?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="w-4 font-mono text-[11px] text-muted-55">{letter}</span>
        <h3 className="text-[13px] font-medium text-fg/90">{title}</h3>
        {pick && <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">Recommended</span>}
      </div>
      <p className="mb-3 ml-6 max-w-[600px] text-[12px] leading-[18px] text-muted-80">{note}</p>
      <div className="ml-6">{children}</div>
    </div>
  )
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span>{label}</span>
      <div className="flex rounded-md border border-border p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} className={`rounded px-2 py-0.5 transition-colors ${o.value === value ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Playground() {
  const [placement, setPlacement] = useState<Placement>("inline")
  const [count, setCount] = useState<CountStyle>("strip")
  const [running, setRunning] = useState(true)
  const [resetKey, reset] = useReducer((x: number) => x + 1, 0)
  const [last, setLast] = useState<SentReview | null>(null)
  return (
    <div className="w-full">
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Seg label="Comment lives" value={placement} onChange={setPlacement} options={[{ value: "inline", label: "A · under the passage" }, { value: "margin", label: "B · in the margin" }, { value: "pins", label: "C · in a tray" }]} />
        <Seg label="Count" value={count} onChange={setCount} options={[{ value: "strip", label: "Strip" }, { value: "badge", label: "Send badge" }, { value: "label", label: "Send label" }, { value: "header", label: "Header" }]} />
        <Seg label="Worker" value={running ? "running" : "rested"} onChange={(v) => setRunning(v === "running")} options={[{ value: "running", label: "Running" }, { value: "rested", label: "At rest" }]} />
        <button type="button" onClick={() => { reset(); setLast(null) }} className="rounded-md border border-border px-2 py-0.5 text-[12px] text-muted hover:text-fg">Reset</button>
      </div>
      <div className="flex flex-wrap items-start gap-8">
        <Frame key={`${resetKey}-${placement}`} placement={placement} count={count} running={running} height={720} ticks onSent={setLast} seeds={[S1]} scroll="first" />
        <div className="min-w-[320px] max-w-[460px] flex-1">
          <h3 className="mb-2 text-[12px] font-medium text-fg/85">How to drive it</h3>
          <ol className="mb-5 list-decimal space-y-1 pl-4 text-[12px] leading-[18px] text-muted">
            <li>Select any text in the transcript — prose, the code line, your own message.</li>
            <li>Click <b className="font-medium text-fg/85">Comment</b>, or press <b className="font-medium text-fg/85">⌘I</b>.</li>
            <li>Write it and press ⌘⏎. It turns pending and the count goes up.</li>
            <li>Walk them with ↑ ↓ in the strip, or click a highlight.</li>
            <li>Type an optional note and press Enter: one message carries all of them.</li>
          </ol>
          <h3 className="mb-2 text-[12px] font-medium text-fg/85">What the worker reads</h3>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-inset p-3 font-mono text-[11.5px] leading-[17px] text-fg/80">
            {last ? wireText(last.note, last.items) : "Nothing sent yet."}
          </pre>
        </div>
      </div>
    </div>
  )
}

function Page() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark")
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <main className="min-h-screen bg-bg pb-24 text-fg">
      <style>{HIGHLIGHT_CSS}</style>
      <header className="mx-auto max-w-[1500px] px-8 pb-6 pt-9">
        <h1 className="text-[22px] font-semibold tracking-tight">Inline comments on the transcript</h1>
        <p className="mt-1.5 max-w-[860px] text-[13px] leading-[20px] text-muted">
          Select any passage in a thread, leave a comment on it, and the comment waits as <i>pending</i>. Every pending comment goes out with your next send, as one message: your note on top, then each comment under the passage it quotes. Every frame on this page is live — select text in any of them.
        </p>
      </header>
      <nav className="sticky top-0 z-40 border-y border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-2.5 text-[12px]">
          <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          <span className="ml-auto flex gap-5 text-muted">
            <a href="#try" className="hover:text-fg">Try it</a>
            <a href="#where" className="hover:text-fg">Where a comment lives</a>
            <a href="#count" className="hover:text-fg">How many are pending</a>
            <a href="#send" className="hover:text-fg">One steer</a>
            <a href="#moments" className="hover:text-fg">In between</a>
            <a href="#rules" className="hover:text-fg">Rules</a>
          </span>
        </div>
      </nav>
      <div className="mx-auto max-w-[1500px] px-8 pt-10">
        <Section id="try" title="Try it" note="One thread, fully working: A, B or C for where a comment sits, four ways to show the count, and a worker that is either running (your send is a steer) or at rest (it is a reply). The right column shows the exact text the worker receives.">
          <Playground />
        </Section>

        <Section id="where" title="1 · Where a pending comment lives" note="The same three comments in each frame. The question is where the words sit while they wait: beside the passage, or gathered by the Send button.">
          <Candidate letter="A" pick title="Under the passage, as an unsent reply" note="The comment hangs under the paragraph or list item it is about, as your own bubble drawn dashed — the transcript's existing shape for your words, marked as not sent. Nothing to look up, and it works at every width. The transcript grows a little while comments wait.">
            <Frame placement="inline" count="strip" seeds={SEEDS} scroll="first" height={660} />
          </Candidate>
          <Candidate letter="B" title="In the margin, level with the passage" note="Google Docs: the transcript does not move, and every comment is visible at once. It needs about 300px of spare width, so it fits the fullscreen view only; the drawer and the phone would fall back to A.">
            <Frame placement="margin" count="strip" seeds={SEEDS} scroll="first" height={660} />
          </Candidate>
          <Candidate letter="C" title="A numbered pin in the gutter, the words in a tray" note="The transcript keeps only a highlight and a number; the comments gather in a tray on the prompt box, next to Send. The cleanest transcript, but each comment is one click from its passage — and the tray is close to the chip row under the prompt box that ⌘I dropped on 2026-09-03.">
            <Frame placement="pins" count="strip" seeds={SEEDS} trayOpen scroll="first" height={660} />
          </Candidate>
          <Candidate letter="D" title="A quote chip in the prompt box (⌘I as it ships)" note="No new transcript UI: the selection becomes a chip at the caret, exactly like ⌘I in the file viewer, and the remark is whatever you type after it. Cheapest to build. The comment never sits beside its passage, and the count is the chips themselves.">
            <Frame placement="chips" count="none" seeds={SEEDS} scroll="first" height={660} />
          </Candidate>
        </Section>

        <Section id="count" title="2 · How many are pending" note="Pending comments are easy to forget — they are not in the prompt box, and they wait silently until you send. Four places for the count, then two that work alongside any of them.">
          <Candidate letter="1" pick title="A strip across the top of the prompt box" note="The count, ↑ ↓ to walk them in transcript order, and Discard. It sits where you press Send, and it is the only one that can also navigate.">
            <Frame placement="inline" count="strip" seeds={SEEDS} activeSeed={1} scroll="first" height={600} footer={false} />
          </Candidate>
          <Candidate letter="2" title="A badge on Send" note="The smallest change: a count on the send arrow. Readable at a glance, but it cannot navigate or discard, and a badge on a primary button reads as a notification.">
            <Frame placement="inline" count="badge" seeds={SEEDS} scroll="first" height={600} footer={false} />
          </Candidate>
          <Candidate letter="3" title="Send says it" note="The arrow becomes “Steer 3” (or “Send 3” at rest). Impossible to miss at the moment it matters; widens the prompt box's right-hand controls while comments wait.">
            <Frame placement="inline" count="label" running seeds={SEEDS} scroll="first" height={600} footer={false} />
          </Candidate>
          <Candidate letter="4" title="In the thread header" note="GitHub's “Finish your review”: the count and ↑ ↓ live in the header, visible while you scroll. Far from Send, and the header strip is already full.">
            <Frame placement="inline" count="header" seeds={SEEDS} scroll="first" height={600} footer={false} />
          </Candidate>
          <Candidate letter="+" title="With any of them: a mark in the rail" note="A thread you walked away from still says it has unsent comments — a speech mark and the count in its row, beside the rest time. Without this, comments left on a thread you closed are lost from sight.">
            <Rail />
          </Candidate>
          <Candidate letter="+" title="With any of them: ticks on the scroll track" note="One tick per pending comment at the transcript's right edge, so a long thread shows where they are. Visible in every frame above, at the right edge.">
            <Frame placement="inline" count="strip" seeds={SEEDS} ticks scroll="bottom" width={420} height={420} footer={false} />
          </Candidate>
        </Section>

        <Section id="send" title="3 · One steer" note="Enter sends the prompt box text and every pending comment as one message. While a turn runs it is a steer and waits dimmed like any queued send; at rest it is a reply. Afterwards the passages keep a dotted underline, and each quote in the bubble jumps back to its passage.">
          <Candidate letter="" title="Sent while the worker runs — queued, then delivered" note="The bubble carries your note, then each comment under its quote, in transcript order.">
            <Frame placement="inline" count="strip" running seeds={SEEDS} sentNote={NOTE} sentQueued scroll="bottom" height={720} />
          </Candidate>
          <div className="min-w-[360px] max-w-[560px] flex-1">
            <h3 className="mb-1 text-[13px] font-medium text-fg/90">What the worker reads</h3>
            <p className="mb-3 text-[12px] leading-[18px] text-muted-80">Plain text in one user message. The note first, then one blockquote per comment — the same quotation shape ⌘I's selected context sends, so the transcript can render it back as the bubble on the left and an old client still shows readable text.</p>
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-inset p-4 font-mono text-[12px] leading-[18px] text-fg/85">{wireText(NOTE, SEEDS)}</pre>
          </div>
        </Section>

        <Section id="moments" title="4 · The moments in between" note="Selecting, writing, finding a comment again, throwing them away, and the phone.">
          <Candidate letter="i" title="Selecting" note="A small Comment button rides above any selection in the transcript. ⌘I does the same from the keyboard — the shortcut that already means “take this selection into my message” in the file viewer.">
            <Frame placement="inline" count="strip" seeds={[S3]} selectQuote="Drop the byName fast path, since it is the thing that collides." scroll="first" height={480} footer={false} />
          </Candidate>
          <Candidate letter="ii" title="Writing" note="The editor opens where the comment will live. ⌘⏎ adds it; Esc throws the draft away.">
            <Frame placement="inline" count="strip" seeds={[{ ...S2, status: "draft" }, S3]} scroll="first" height={480} footer={false} />
          </Candidate>
          <Candidate letter="iii" title="Finding one again" note="Hovering a passage or its comment lights both. ↑ ↓ in the strip scroll to each in turn; edit and delete appear on hover.">
            <Frame placement="inline" count="strip" seeds={SEEDS} activeSeed={2} scroll="first" height={480} footer={false} />
          </Candidate>
          <Candidate letter="iv" title="Throwing them away" note="Discard asks once, in place — no dialog. Comments also survive closing the drawer, like the prompt box draft.">
            <Frame placement="inline" count="strip" seeds={SEEDS} confirmDiscard scroll="first" height={480} footer={false} />
          </Candidate>
          <Candidate letter="v" title="On a phone" note="The Comment button sits under the selection, clear of the system's own Copy menu above it; the count floats over the prompt bar.">
            <Frame placement="inline" count="strip" phone seeds={[S2, S3]} selectQuote="Drop the byName fast path" scroll="first" width={390} height={720} />
          </Candidate>
        </Section>

        <Section id="rules" title="Rules the frames assume" note="">
          <ul className="max-w-[860px] list-disc space-y-1.5 pl-5 text-[12.5px] leading-[19px] text-muted">
            <li>Anything in the transcript takes a comment: the agent's prose, code, tool output, and your own messages.</li>
            <li>Pending comments belong to the thread, like the prompt box draft — they survive closing the drawer and switching threads, and the rail says they are there.</li>
            <li>The next send carries every pending comment. The prompt box text becomes the note on top; an empty prompt box still sends the comments alone.</li>
            <li>On the wire the comments go in transcript order, not the order you wrote them, each opening with its passage as a blockquote.</li>
            <li>A comment is anchored to its message and the text it quotes, so it survives new messages arriving and the transcript re-rendering. If the passage scrolls out of the loaded window, the count still includes it.</li>
            <li>A comment is never sent on its own and never edits the transcript: until Enter, nothing reaches the worker.</li>
          </ul>
        </Section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </QueryClientProvider>,
)
