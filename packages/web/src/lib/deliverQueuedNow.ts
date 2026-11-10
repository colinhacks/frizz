import { backendFollowUps } from "@frizz/shared"
import { useCallback, useSyncExternalStore } from "react"
import { subscribe } from "valtio"
import { rpc } from "../api/rpc.ts"
import { showToast, store, threadBySlug } from "../store.ts"
import type { QueuedRun } from "./restReply.ts"

// PUSH IT THROUGH NOW.
//
// A follow-up sent to a working agent waits in the provider's queue until the current turn ends —
// measured p50 13.8s, p90 49s, p99 2.5m, and the tail is a real 90s tool call. The operator can already
// pay for that wait up front (⌘⏎ sends AND interrupts), but that forces the decision at the moment of
// typing, before they know how long the worker is going to take. This is the same capability offered
// AFTERWARDS, from the one place on screen for the whole wait: under the queued messages
// (ChatView QueuedSendNow), and on ⌘⏎ with nothing typed (lib/sendNowKey).
//
// There is nothing to send here — the words are already queued. All that is left is asking the runtime
// to push them through: it moves a running command or sub-agent to the background and the turn takes
// the queue in, or — with nothing it can move — aborts the turn, which leaves queued input intact for
// the next one to open on (router deliverQueuedNow). Either way no new delivery path was needed.
//
// It acts on the QUEUE, so it is one control under the run rather than one per bubble (maintainer
// 2026-10-15). Queued steers all go at once; messages Frizz is holding for the rest go one per press,
// the next each time, because the queue goes out one message per turn (2026-10-20).

/** What one press of Send now does, one step at a time: messages Frizz is HOLDING for the rest go to the
 *  agent's next step without interrupting it (`release`); once nothing is held, a queued steer is pushed
 *  through now (`interrupt`) where the runtime can be preempted. Null when there is nothing it can do,
 *  which is also when the control draws nothing. A release is a steer, so a backend with none has no
 *  first step either: every message on it waits for the turn to end (shared BACKEND_FOLLOW_UPS). */
export type SendNowStep = "release" | "interrupt"
export function sendNowStep(run: QueuedRun, interruptible: boolean, steerable = true): SendNowStep | null {
  if (run.held > 0 && steerable) return "release"
  if (run.steered > 0 && interruptible) return "interrupt"
  return null
}

// Which surfaces can push a steer through at all: the same broker-backed-Claude boundary as unqueue (a
// codex steer goes straight into the running turn, so there is no queue to jump), plus a turn that is
// actually RUNNING — with the worker at rest there is nothing to interrupt and the button would be a
// dead click. Mirrors `canInterrupt` in ThreadComposerBox, which gates ⌘⏎ on the same two facts.
export function deliverQueuedNowSupported(slug: string | null): boolean {
  if (!slug) return false
  const thread = threadBySlug(store.board, slug)
  return backendFollowUps(thread?.backend).interrupt && thread?.runtime === "running"
}

/** Can this thread's agent read a message inside a running turn at all? */
export function threadCanSteer(slug: string | null): boolean {
  return backendFollowUps(slug ? threadBySlug(store.board, slug)?.backend : undefined).steer
}

export function useThreadCanSteer(slug: string | null): boolean {
  // A scalar, for the reason useDeliverQueuedNowSupported gives below.
  return useSyncExternalStore((onChange) => subscribe(store, onChange), () => threadCanSteer(slug), () => true)
}

export function useDeliverQueuedNowSupported(slug: string | null): boolean {
  // useSyncExternalStore over a SCALAR, not useSnapshot — the same reason useUnqueueSupported does it:
  // this runs in every user bubble in the transcript, and a snapshot proxy would re-render all of them
  // on every board push.
  return useSyncExternalStore(
    (onChange) => subscribe(store, onChange),
    () => deliverQueuedNowSupported(slug),
    () => false,
  )
}

// IN FLIGHT, PER THREAD — not per control. The click and the keystroke are one press, and one thread
// can be drawn by two surfaces at once (its queue card and its drawer), so the spinner and the guard
// against a second press both read this one set.
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
function setInFlight(slug: string, on: boolean): void {
  if (on === inFlight.has(slug)) return
  if (on) inFlight.add(slug)
  else inFlight.delete(slug)
  for (const notify of listeners) notify()
}

export function useSendNowPending(slug: string | null): boolean {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    }, []),
    () => (slug ? inFlight.has(slug) : false),
    () => false,
  )
}

/** PRESS SEND NOW for this thread: the step its queued run is at (sendNowStep), asked of the server.
 *  The click and ⌘⏎ both come here. Returns whether a press was made, so a keystroke with nothing to
 *  press can be left to whatever else wants it. */
export function pressSendNow(slug: string, run: QueuedRun): boolean {
  const step = sendNowStep(run, deliverQueuedNowSupported(slug), threadCanSteer(slug))
  if (!step) return false
  if (inFlight.has(slug)) return true
  // Resolved at PRESS time, not render time — a thread re-dispatched under an open drawer must not
  // interrupt the session the bubble was painted for. The server enforces this too.
  const sessionId = threadBySlug(store.board, slug)?.sessionId
  if (!sessionId) {
    showToast("This thread has no live session to send to")
    return true
  }
  setInFlight(slug, true)
  const releaseOnly = step === "release"
  void rpc.deliverQueuedNow({ slug, sessionId, ...(releaseOnly ? { releaseOnly: true } : {}) }).then(
    (result) => {
      setInFlight(slug, false)
      // Nothing optimistic here, and nothing needed: the server moves the queue's delivery-ledger
      // entries to `delivered` under the same landed interrupt and pushes a transcript frame, so the
      // bubbles un-gray on this round trip rather than on the tailer. Keeping the claim server-side
      // is what makes it survive a reload and reach every other open tab. A refusal is spoken, since
      // the operator asked for something and did not get it.
      // `released`: messages Frizz was holding for the rest went to the runtime. On a runtime with
      // no interrupt that is the whole of "send now", and it is not a refusal.
      if (releaseOnly) {
        if (!result.released) showToast(result.reason ?? "That message could not be sent now")
      } else if (!result.interrupted && !result.released) {
        showToast(result.reason ?? "That message could not be pushed through")
      }
    },
    (error: unknown) => {
      setInFlight(slug, false)
      const why = (error instanceof Error ? error.message : String(error)).slice(0, 160)
      showToast(releaseOnly ? `Couldn't send it now — ${why}` : `Couldn't push it through — ${why}`)
    },
  )
  return true
}
