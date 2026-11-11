// A MESSAGE FROM ANOTHER THREAD — one top-level session's `SendMessage` into this one, most often the
// coordinator thread that spawned it steering its work.
//
// It reached the chat as an ordinary user turn whose text was Claude Code's raw wrapper, so it rendered
// in the human's own right-justified bubble with `<cross-session-message from="uds:/tmp/cc-socks/2908.sock"
// from-name="frizz-11" from-mode="bypass">` printed above the body (maintainer 2026-10-08: "There should
// be a link to the originating thread, and it should not look like fucking XML"). The server now
// unwraps it (`sessionPeer`, displayText = the body) and names the sending thread.
//
// AN EXPANDABLE HAIRLINE (maintainer 2026-10-09, over the card it first shipped as: "this should
// probably just be an expandable hairline"). It is the same class as a sub-agent reporting up — another
// agent reaching into this thread's turn — so it wears that divider's shape, and like the fired timer it
// keeps a body one click away, because the instruction is text nobody else in the app renders.
//
// …THAT OPENS INTO A FRAME (maintainer 2026-11-07, choosing it from five redesigns in
// session-message-mockups-fixture.tsx). Expanded, the hairline's rules turn down into a box and the label
// stays on its top edge, as the box's <legend>. What it replaced, from the screenshot that asked for it:
//   - a centred label over a flush-left body on a faint rule, so the body hung off nothing. The frame is
//     the label's own rule, so the body plainly belongs to it — and, set apart that firmly, it can be
//     near-full-strength text rather than another muted aside;
//   - "Click to collapse" in words, which survived whole while the sender's title was cut to "ONE-FILE
//     MIGRATI…". A chevron is the toggle now, and the title is the label's elastic part;
//   - the title in petite caps, underlined AND inside guillemets. It is a name, so it keeps its own case
//     (as identifiers on a divider do), and one underline is enough to say it is a link.
//
// THE WHOLE LABEL TOGGLES, except the title. The title links to the sending thread (the in-project link
// opens it in the drawer — thread-links.ts intercepts `/thread/<slug>`; a sender in another project
// navigates to its full-screen page), and HTML forbids a link inside a button, so the row cannot BE the
// button. A click anywhere else on it — the rules too, collapsed — toggles from a handler on the row, and
// the chevron is the real <button> for the keyboard and the screen reader.
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react"
import { ChevronRight, MessagesSquare } from "lucide-react"
import type { TranscriptMessage } from "@frizz/shared"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { DIVIDER_LINK } from "./FrizzWake.tsx"
import { WAKE_DIVIDER_GLYPH, WAKE_DIVIDER_WIDE_ONLY, WakeDivider, WakeDividerLabel } from "./WakeDivider.tsx"
import { displayTitle } from "../groups.ts"
import { outerPath, projectHref } from "../lib/base-path.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { useThreadSnapshot } from "../hooks.ts"

type SessionPeer = NonNullable<TranscriptMessage["sessionPeer"]>

export function sessionPeerHref(thread: NonNullable<SessionPeer["thread"]>): string {
  return thread.project ? `${projectHref(thread.project)}/thread/${thread.slug}` : outerPath(`/thread/${thread.slug}`)
}

export function SessionMessageLine({ peer, text, queued, sourceId, at }: { peer: SessionPeer; text: string; queued?: boolean; sourceId?: string; at?: string }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const sender = peer.thread
  // A sender on THIS board takes the title the sidebar shows, live — the server's copy is the row's
  // title at read time, which is all it can offer for a thread in another project.
  const local = useThreadSnapshot(sender && !sender.project ? sender.slug : undefined)
  const title = local ? displayTitle(local) : sender?.title
  const html = useMarkdownHtml(text)
  const body = useInnerHtml(html)
  // A ```mermaid fence in the message is a diagram, as it would be in the sender's own transcript.
  const bodyRef = useRef<HTMLDivElement>(null)
  const diagrams = useMermaidIslands(bodyRef, html)

  // The collapsed hairline and the open frame are different elements, so the chevron is a NEW button
  // after every toggle. A keyboard user who toggled it keeps their place on it; a mouse never focused it
  // (the mousedown is cancelled), so nothing is moved for them.
  const toggleRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const toggle = () => {
    refocus.current = document.activeElement === toggleRef.current
    setOpen((v) => !v)
  }
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    toggleRef.current?.focus()
  }, [open])
  // The row's own handler: the title is a link and the chevron handles itself.
  const onRowClick = (e: MouseEvent) => {
    if ((e.target as Element).closest("a, button")) return
    toggle()
  }
  // Keep the reader's text selection where it was, as every transcript toggle does.
  const keepSelection = (e: MouseEvent) => e.preventDefault()

  const label = sender ? (
    <>
      {/* WIDE ONLY (see WAKE_DIVIDER_WIDE_ONLY): on a narrow row the glyph says a thread wrote in, and the
          room goes to which one. The trailing space is for the text, not the layout (a flex item's edge
          whitespace draws nothing): without the guillemets that used to separate them, the row's
          `textContent` — find-in-page, a copy — ran "Message fromCoordinate…" together. */}
      <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>Message from </span>
      <a href={sessionPeerHref(sender)} data-session-peer-link title="Open the thread that sent this" onMouseDown={keepSelection} className={`min-w-0 truncate [font-variant-caps:normal] ${DIVIDER_LINK}`}>
        {title}
      </a>
    </>
  ) : (
    // Not a Frizz thread, or one that exited before Frizz could trace it: the session's own name is all
    // there is, said as a name rather than dressed up as a link.
    <span className="min-w-0 truncate">{peer.name ? `Message from session ${peer.name}` : "Message from another session"}</span>
  )
  const chevron = (
    <button
      ref={toggleRef}
      type="button"
      data-session-message-toggle
      onClick={toggle}
      onMouseDown={keepSelection}
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={open ? "Collapse the message" : "Expand the message"}
      className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
    >
      {/* TRIMMED TO ITS INK, both sides. Lucide's chevron paints 4px of its 12px box shut and 7px open
          (rotated), so on the label's 4px gap it stood 8.86px of ink from the age (7.36px open) where every
          other pair in the label reads 5.1–6.1px, and its right-hand dead space put 16px of ink between it
          and the right rule against 12.64px on the left, pulling the label's ink off centre. Measured with
          scripts/ink-gaps.mjs at 12px, sans, dsf 4, these margins leave 5.11px to the age shut and 6.11px
          open, and 14.41px to the right rule against 12.44px on the left — 1px of that is the label's
          `pr-px` (WakeDividerLabel, with a trailing control), which keeps the focus ring inside its clip.
          The margins are on the svg, so the button's box, and the ring, hug the trimmed footprint. A new
          button mounts on each toggle, so the rotation is not animated. */}
      <ChevronRight aria-hidden="true" size={12} className={`${WAKE_DIVIDER_GLYPH} ${open ? "-mx-[0.15em] rotate-90" : "-mx-[0.275em]"}`} />
    </button>
  )

  return (
    <div data-frizz-msg={sourceId} data-session-message className={`flex flex-col ${queued ? "opacity-50" : ""}`}>
      {open ? (
        // A real <fieldset>: the legend cuts the top border itself, so the label sits ON the rule exactly
        // where it sat collapsed, over any surface (a thread page, a drawer, a queue card's panel) with
        // nothing painted behind it. `my-1` is the hairline's own margin, so opening it moves nothing above.
        <fieldset className="@container/wake my-1 min-w-0 rounded-xl border border-border/70 px-4 pb-3.5 pt-1 transition-colors has-[>legend:hover]:border-border">
          {/* The legend leaves 50px of edge either side of its gap, the floor every hairline's rule keeps, so
              a title truncates at the same width open as shut. Its own 12px padding is the hairline's 12px
              gap, so its box may take all but 2×50px of the border it sits on — and its percentage is of
              the content box, 34px narrower than that border (1px border and 16px padding a side):
              100% + 34px − 100px. */}
          <legend onClick={onRowClick} onMouseDown={keepSelection} className="group/wake mx-auto max-w-[calc(100%-66px)] cursor-pointer px-3">
            <WakeDividerLabel icon={MessagesSquare} at={at} trailing={chevron}>{label}</WakeDividerLabel>
          </legend>
          {/* Markdown, like any other agent prose: this is an agent's message, written with lists and code
              spans. `card-md` sets it on the cards' 13px scale with an inherited colour, a step under full
              strength, so it reads as quoted rather than as this worker's own 14px prose. */}
          <div id={bodyId} className="card-md text-fg/85">
            <div ref={bodyRef} className="md-body [overflow-wrap:anywhere]" dangerouslySetInnerHTML={body} />
            {diagrams}
          </div>
        </fieldset>
      ) : (
        <div onClick={onRowClick} onMouseDown={keepSelection} className="group/wake cursor-pointer">
          <WakeDivider icon={MessagesSquare} marker="session-message" at={at} trailing={chevron}>{label}</WakeDivider>
        </div>
      )}
    </div>
  )
}
