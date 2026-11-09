import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import { SEND_SOLO_WIDTH, SEND_SPLIT_CARET_WIDTH, SEND_SPLIT_LABEL_WIDTH, SEND_SPLIT_SEAM_WIDTH, SEND_SPLIT_WIDTH } from "../lib/iconRhythm.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import type { SendMode } from "../lib/sendMode.ts"

// THE THREAD PROMPT BOX'S SEND (maintainer 2026-10-11). One button for everything the box can send —
// the typed message, the answers staged on the question cards above it, or both as one turn — so it
// always reads "Send": "broad enough to encapsulate the fact that it may also be sending question
// answers". The caret beside it opens the two ways a send can go out while the agent is working; the
// ticked one is what the button and Enter do. The third way, the forced send that interrupts the
// turn, is not a row: it stays on ⌘/Ctrl-Enter and on the Send now under the queued messages.
//
// IT IS WHITE WHENEVER THERE IS SOMETHING TO SEND, which includes an answer staged on a card with the
// box still empty. The caret stays live when the button is dim: choosing how the next message goes
// does not need a message.
//
// THE SPACING IS MEASURED, not padded to taste. The four gaps the eye reads are ink distances and
// none of them is a padding: the word wears ~0.7px of side bearing and the 13px chevron paints ~7.8px
// of its box. The maintainer chose this set from eight drawn candidates (steer-button-mockup-fixture,
// candidate C), after "it looks like there's more space to the left of 'send' than to the right of
// it" and then, of the correction, "overcompensated". What it paints, read from pixels in sans with
// the button right-anchored and drawn as a 2x screen draws it:
//
//     left edge → S   9.6px      d → hairline   8.0px
//     hairline → chevron   7.1px      chevron → right edge   8.1px
//
// Every box value is on the half-pixel grid, so on a 2x screen the hairline and the chevron land on
// device pixels. The three widths live in lib/iconRhythm.ts, beside the rail that has to clear them;
// the word's left padding and the chevron's are the two below. Re-measure (scripts/ink-gaps.mjs) if
// the font, the type size or the glyph changes.
const LABEL_PAD_LEFT = 9
const CARET_PAD_LEFT = 4.5

const ROWS: readonly { mode: SendMode; name: string; says: string }[] = [
  { mode: "steer", name: "Send as steer", says: "The agent reads it at its next step." },
  // The queue goes out one message per turn (2026-10-20), and the row says so: until then it read "Frizz
  // holds it until the agent comes to rest", and everything queued went out at that one rest.
  { mode: "queue", name: "Send to queue", says: "Each queued message gets a turn of its own." },
]
const ROW_NAME: Record<SendMode, string> = { steer: "Send as steer", queue: "Send to queue" }

export function SendSplitButton({
  armed,
  busy,
  mode,
  running,
  steerable = true,
  right,
  bottom,
  onMode,
  onSend,
  onMenuClosed,
}: {
  /** There is something to send: typed text, or an answer staged on any card. */
  armed: boolean
  busy?: boolean
  mode: SendMode
  /** There is something to queue behind — the only time the two rows differ. */
  running: boolean
  /** The agent can read a message inside a running turn (shared BACKEND_FOLLOW_UPS). Without that there
   *  is one way to send, so there is no menu to choose it from: just the button, and its tooltip says
   *  what happens to the message. */
  steerable?: boolean
  /** The rail offset (lib/iconRhythm composerRail). */
  right: number | undefined
  /** The rail's inset from the box's bottom edge (lib/iconRhythm PROMPT_ROW_INSET). */
  bottom: number
  onMode: (mode: SendMode) => void
  onSend: () => void
  /** The menu closed: put the caret back in the prompt box, where the next keystroke belongs. */
  onMenuClosed?: () => void
}) {
  const tone = armed ? "bg-fg text-bg" : "bg-panel-2 text-muted"
  // A hovered half tints toward the page rather than fading: the fill under it is the pill's own, so a
  // fade would show the same colour through and nothing would change. The divider wears the same tint.
  const hover = armed ? "hover:bg-bg/10" : ""
  const title = !running ? "Send (Enter)" : steerable ? `${ROW_NAME[mode]} (Enter · ⌘⏎ sends now)` : "Send to queue: it waits for this turn to end (Enter)"
  return (
    // THE PILL PAINTS THE FILL, ONCE, and its halves paint only their hover tint. With each piece painting
    // its own, the press put the edges between them between device pixels, both edges were antialiased over
    // the dark prompt box, and a dark line showed down each side of the seam. Now what shows through is the
    // fill itself.
    //
    // THE PRESS SHRINKS THE WHOLE PILL, never the half under the pointer. Scaled alone, the word's half
    // pulled in from the seam and the caret, which stayed full size: a short pill with a tall square-cornered
    // stub stuck to its right (maintainer 2026-10-13: "This animation when you do a mouse down"). Only a
    // press on Send shrinks it: the caret opens its menu on pointer-down, and a pill shrinking under a
    // menu that just appeared reads as a wobble.
    <span
      data-send-split
      data-send-mode={mode}
      className={`absolute flex h-6 rounded-md transition-[color,background-color,scale] ${tone} ${armed ? "has-[[data-send]:active]:scale-95" : ""}`}
      style={{ right, bottom, width: steerable ? SEND_SPLIT_WIDTH : SEND_SOLO_WIDTH }}
    >
      <button
        type="button"
        data-send
        // Never blur the textarea on the click path (the repo's idiom for every submit affordance that
        // sits beside a live input).
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSend}
        disabled={!armed}
        // The shut button names its way of sending here and in the placeholder, never on its face.
        title={title}
        aria-label="Send"
        style={{ width: steerable ? SEND_SPLIT_LABEL_WIDTH : SEND_SOLO_WIDTH, paddingLeft: LABEL_PAD_LEFT }}
        // Never `transition-all`: it animates box-shadow, which holds the hover edge back (styles.css).
        className={`flex items-center ${steerable ? "rounded-l-md" : "rounded-md"} text-[12px] font-medium leading-none outline-none transition-[color,background-color] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${hover}`}
      >
        {/* The word never changes, so nothing beside the button moves when the way of sending does. */}
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <span data-send-label>Send</span>}
      </button>
      {steerable && <>
      {/* THE DIVIDER IS THE HOVER COLOUR: a full-height 1px column wearing the same tint as a lit half
          (`bg-bg/10`, the `hover` above), so whichever half lights up, on hover or mouse-down, swallows it
          and the line is gone. The maintainer picked this from eleven mockups (2026-10-13, after "the
          divider line needs to disappear whenever there's a mouse down. I feel like it should be the same
          color as the hover color"). It runs the full height because a short one stuck out of the lit
          half as a notch. A dim button has no hover tint to melt into, so it keeps its short rule. */}
      <span aria-hidden className={`flex items-center ${armed ? "bg-bg/10" : ""}`} style={{ width: SEND_SPLIT_SEAM_WIDTH }}>
        {!armed && <span className="h-3.5 w-px bg-fg/15" />}
      </span>
      <RadixMenu.Root modal={false}>
        <RadixMenu.Trigger asChild>
          <button
            type="button"
            data-send-menu
            aria-label="Choose how this is sent"
            style={{ width: SEND_SPLIT_CARET_WIDTH, paddingLeft: CARET_PAD_LEFT }}
            className={`flex items-center rounded-r-md outline-none transition-[color,background-color] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${armed ? hover : "hover:text-fg"}`}
          >
            <ChevronDown data-send-caret size={13} strokeWidth={2.5} />
          </button>
        </RadixMenu.Trigger>
        <RadixMenu.Portal>
          <RadixMenu.Content
            data-send-modes
            side="top"
            align="end"
            sideOffset={6}
            onCloseAutoFocus={(e) => {
              if (!onMenuClosed) return
              e.preventDefault()
              onMenuClosed()
            }}
            className={`${OPAQUE_PORTAL_SURFACE_CLASS} w-[304px] rounded-lg p-1`}
          >
            <RadixMenu.RadioGroup value={mode} onValueChange={(next) => onMode(next as SendMode)}>
              {ROWS.map((row) => {
                const on = row.mode === mode
                return (
                  <RadixMenu.RadioItem
                    key={row.mode}
                    value={row.mode}
                    data-send-mode-row={row.mode}
                    className="flex cursor-pointer select-none items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors data-[highlighted]:bg-panel-2"
                  >
                    <span className="flex h-[18px] w-3.5 shrink-0 items-center justify-center text-fg">{on && <Check size={13} strokeWidth={2.5} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-4 leading-[18px]">
                        <span className="text-[12px] font-medium text-fg">{row.name}</span>
                        {/* Enter sends the ticked row. */}
                        {on && <span className="text-[11px] text-muted-70">⏎</span>}
                      </span>
                      <span className="block text-[11.5px] leading-[16px] text-muted">{row.says}</span>
                    </span>
                  </RadixMenu.RadioItem>
                )
              })}
            </RadixMenu.RadioGroup>
            {!running && <div className="px-2 pb-1 pt-1.5 text-[11px] leading-[15px] text-muted-70">The agent is at rest, so both send now.</div>}
          </RadixMenu.Content>
        </RadixMenu.Portal>
      </RadixMenu.Root>
      </>}
    </span>
  )
}
