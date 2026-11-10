// WHAT A THREAD SURFACE DRAWS WHERE ITS TRANSCRIPT WOULD BE, when it has no message to draw.
//
// The order is the point. "No conversation yet." is a statement about the thread, and so is "Session
// starting…"; a read that failed supports neither. Until 2026-11-10 nothing asked whether the read had
// failed, so a thread with hours of history, opened while the server was not answering (the launcher
// killed, a laptop that woke with the process gone, a phone that lost the relay), said "No conversation
// yet." Measured on a real stack: the server killed with the board open, then a thread the page had not
// read yet opened in the pane.

export type EmptyTranscript = "loading" | "failed" | "starting" | "adopt" | "empty"

export function emptyTranscriptState(
  read: { pending: boolean; failed: boolean },
  thread: { running: boolean; adoptable: boolean },
): EmptyTranscript {
  // Not loaded YET: the count is zero only because nothing has arrived, and a long transcript's first
  // read takes a beat. Claiming "Session starting…" there is wrong, since it may have run for hours.
  if (read.pending) return "loading"
  if (read.failed) return "failed"
  if (thread.running) return "starting"
  // A thread Frizz never originated (a pre-existing .frizz board): no session, no transcript.
  if (thread.adoptable) return "adopt"
  return "empty"
}
