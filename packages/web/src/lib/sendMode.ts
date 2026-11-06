import { proxy, useSnapshot } from "valtio"

// HOW THE PROMPT BOX'S SEND GOES OUT while the agent is working (maintainer 2026-10-11). The button
// always reads "Send"; its caret menu ticks one of two rows:
//
//   steer — the message is handed to the agent now and read at its next step. The default, and what
//           every send was before the menu existed.
//   queue — Frizz keeps the message until the agent comes to rest, then delivers it as the next turn.
//           The queue goes out ONE message per turn (2026-10-20): the next only once the agent has
//           rested after the one before.
//
// A third way, the FORCED send that interrupts the turn, is deliberately not a row: it stays on
// ⌘/Ctrl-Enter and on the Send now under the queued messages.
//
// ONE CHOICE FOR EVERY PROMPT BOX, KEPT UNTIL THE OPERATOR CHANGES IT (maintainer 2026-10-20: "that
// value needs to be sticky and apply across all tabs"). The tick used to be per thread, in memory, and
// went back to steer whenever the agent rested, so every thread and every reload opened on steer. Now
// it is the operator's way of sending: ticked in one prompt box it holds in every other — every thread,
// every project, every tab of this browser — and through a reload. It is remembered in this browser
// (like lib/homeView.ts), and a tab follows another tab's pick live through the `storage` event.
//
// A backend with no steer (shared BACKEND_FOLLOW_UPS) has only the queue, so its box draws no menu and
// sends as `queue` whichever row is ticked for the others. The tick itself is left alone.
//
// A queue tick left on cannot hold a message back for no reason: a send is only held while there is a
// turn to queue behind (ThreadComposerBox), and the placeholder says "Queue a message…" whenever it
// would be.
export type SendMode = "steer" | "queue"

const KEY = "frizz:send-mode"

function read(): SendMode {
  try {
    return localStorage.getItem(KEY) === "queue" ? "queue" : "steer"
  } catch {
    return "steer"
  }
}

const send = proxy({ mode: typeof window === "undefined" ? ("steer" as SendMode) : read() })

// Guarded for the unit tests, which import the store (and so this) under a stubbed `window`.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Another tab ticked a row: follow it. A null key is that tab clearing all of storage.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) send.mode = read()
  })
}

export function setSendMode(mode: SendMode): void {
  if (send.mode !== mode) send.mode = mode
  try {
    if (mode === "steer") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {
    // Storage refused (a private window): the choice holds for this page and is not remembered.
  }
}

/** The ticked row, the same in every prompt box. */
export function useSendMode(): SendMode {
  return useSnapshot(send).mode
}

/** What the placeholder says an empty prompt box is for. A staged answer outranks everything: the box
 *  is then a note on the answers, whichever way they go. An open question with nothing staged makes
 *  the box the way AROUND it. Otherwise it names how the ticked row will send, which only differs from
 *  an ordinary reply while there is a turn to queue behind. */
export function sendPlaceholder(input: { staged: number; openQuestions: boolean; running: boolean; mode: SendMode; steerable?: boolean }): string {
  if (input.staged > 0) return input.staged === 1 ? "Add a note to send with your answer…" : `Add a note to send with your ${input.staged} answers…`
  if (input.openQuestions) return "Or skip the questions and reply…"
  if (input.running && input.steerable === false) return "Queue a message for when this turn ends…"
  if (input.running && input.mode === "queue") return "Queue a message for when the agent rests…"
  return "Reply to the agent…"
}
