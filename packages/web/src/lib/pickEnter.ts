import { shouldSubmitStagedEnter, type ComposerKeyboardEvent } from "./composerKeyboard.ts"

// ENTER AFTER A PICK SENDS, WHEREVER THE FOCUS ENDED UP (maintainer 2026-11-12: "If I click on an answer
// inside of a question card and then I hit Enter, it should just submit it, always … It shouldn't matter
// if I've focused the prompt box. It shouldn't matter if questions remain").
//
// A pick parks the focus on the card's options (QuestionBlockCard), whose own Enter sends, and that holds
// only while the card stays mounted. A card is replaced as a whole when the transcript moves it: above all
// when a thread opens, where the questions draw at the bottom of the transcript until it loads and then
// move into the message that asked them. A pick made before the move left the focus on <body> (or on the
// drawer's container, where Radix's focus trap catches it), the pick itself survived in the draft store,
// and Enter did nothing. Measured on a real stack with the transcript held back 5s: the option stayed
// picked, `document.activeElement` was <body>, and Enter sent nothing.
//
// So the PICK arms the next Enter, not the focus. The arm is one keystroke long: Enter sends through the
// card's own submit (the surface's prompt box, so whatever is typed there goes too, and every staged answer
// whether or not other questions are still open), and any other key or any other click spends it. An Enter
// on something with an Enter of its own (a text box, the prompt box, a button, a link, another card's
// options) is left to that element: each of those either sends the same staged answers itself or means
// something else.

/** What a keystroke does to an armed pick. `keep`: a bare modifier, on its way to a chord. `spend`: the
 *  arm goes and nothing is sent. `send`: the arm goes and the answers are sent. */
export function pickEnterStep(
  event: ComposerKeyboardEvent & { repeat?: boolean; defaultPrevented?: boolean },
  where: { keepsOwnEnter: boolean; surfaceGone: boolean },
): "keep" | "spend" | "send" {
  if (MODIFIER_KEYS.has(event.key)) return "keep"
  if (event.repeat || event.defaultPrevented || !shouldSubmitStagedEnter(event)) return "spend"
  if (where.keepsOwnEnter || where.surfaceGone) return "spend"
  return "send"
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"])

// Everything that answers Enter itself. A question card's options grid and the to-do list's frame are here
// because their own handlers send; a container that merely holds the focus (the transcript's scroller, a
// drawer's dialog) is not, and that is where a removed card's focus lands.
const KEEPS_OWN_ENTER = [
  "input", "textarea", "select", "[contenteditable]:not([contenteditable='false'])",
  "button", "a[href]", "summary",
  "[role=button]", "[role=link]", "[role=menuitem]", "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]",
  "[data-question-grid]", "[data-awaiting-steps]",
].join(", ")

function keepsOwnEnter(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) return false
  return target.closest(KEEPS_OWN_ENTER) !== null
}

type Armed = { submit: () => void; surface: Element | null }
let armed: Armed | null = null

// CAPTURE, on the window: ahead of every element's own handler and of the page-level ⌘⏎ (lib/sendNowKey),
// which stands down for a key this marks handled. Ahead of the options grid's own Enter too, which is why
// the grid is in KEEPS_OWN_ENTER rather than this relying on the grid to stop the key.
function onKeyDown(event: KeyboardEvent): void {
  if (!armed) return
  const entry = armed
  const step = pickEnterStep(event, {
    keepsOwnEnter: keepsOwnEnter(event.target),
    // The thread the pick was made in is no longer on screen (the pane moved to another thread): its
    // answers are not what this Enter is about.
    surfaceGone: entry.surface !== null && !entry.surface.isConnected,
  })
  if (step === "keep") return
  armed = null
  if (step !== "send") return
  event.preventDefault()
  entry.submit()
}

function onPointerDown(): void {
  armed = null
}

let installed = false

/**
 * Arm the next Enter to send, after a pick on a question card. `submit` is read when Enter comes, so it
 * should resolve the card's latest send. `anchor` is the card, which names the thread surface the pick
 * belongs to: an Enter after that surface has gone sends nothing.
 */
export function armEnterAfterPick(submit: () => void, anchor: Element | null): void {
  armed = { submit, surface: anchor?.closest("[data-thread-surface]") ?? null }
  if (installed || typeof window === "undefined") return
  installed = true
  window.addEventListener("keydown", onKeyDown, true)
  // A click's pointerdown comes before its click, so the click that arms is never the one that disarms.
  window.addEventListener("pointerdown", onPointerDown, true)
}
