// WHAT AN ARCHIVED THREAD'S ```done FENCE CARRIES ON THE BOARD: its body's head, not its body.
//
// The board read sends every thread of a project, the archived ones included, and on a copy of the
// maintainer's boards (22 projects, 606 archived threads) their done-fence bodies were 521 KB of the 2 MB
// a cold Console reads — 188 KB of its 465 KB on the wire, for text no row draws (2026-11-10). Two things
// read an archived done body, and neither needs it in the board:
//
//   · the phone's Done tab, whose second line is the body's FIRST LINE (web lib/mobileBoardRow.ts
//     `handoffLine`). `doneFenceBodyHead` keeps exactly what that reading looks at, so the line is the
//     same from the head as from the body (fence-head.test.ts holds it to that over random bodies);
//   · the thread's own surfaces, which draw a REGISTERED done (`frizzctl done`) as a card at the bottom of
//     the transcript, because it is in no message. They read the whole body per thread when they open one
//     (the `threadRegisteredDone` query, web lib/registeredDone.ts), as they read its answered questions.
//
// A fenced done is drawn from the message that holds it, so its body in the view was only ever read by
// the phone row. An ```awaiting fence is not touched: its prose is drawn on rows and cards alike.

import type { ThreadFence } from "./index.ts"

/** Block markers at the head of a message: a fence opener, a heading's `#`, a quote's `>`, a bullet.
 *  The phone row strips these before it reads a line (web lib/mobileBoardRow.ts), and the head below has
 *  to know where they end — so this is the one copy both read. */
export const HEAD_MARKERS = /^(?:```[\w-]*\s*|#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/

/** The leading part of a fence body that a reader of its first line needs: everything through the first
 *  line of content after the block markers (which may themselves span blank lines), and on through the
 *  first character of the next line's content. That character is part of the reading: the row ends the
 *  line where a block would begin (`\s1. ` with the newline as its last space), and a head cut at the
 *  newline itself would be trimmed back to "…1." and read on past it. */
export function doneFenceBodyHead(body: string): string {
  const text = body.trim()
  const lead = HEAD_MARKERS.exec(text)?.[0].length ?? 0
  const end = text.indexOf("\n", lead)
  if (end < 0) return text
  // `text` is trimmed, so content follows the newline.
  return text.slice(0, end + text.slice(end).search(/\S/) + 1)
}

/** An archived thread's fence as the board carries it: a ```done fence's body cut to its head, with
 *  `bodyElided` saying how long the whole body is. Anything else, and a body already no longer than its
 *  head, is returned as it is (the same object). */
export function elideArchivedDoneFence<F extends ThreadFence | undefined>(fence: F): F {
  if (!fence || fence.kind !== "done" || fence.bodyElided !== undefined) return fence
  const head = doneFenceBodyHead(fence.body)
  if (head.length >= fence.body.length) return fence
  return { ...fence, body: head, bodyElided: fence.body.length }
}
