import { useCallback, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { isRetryableRpcError, rpc } from "../api/rpc.ts"
import { appendQueuedMessage, removeQueuedMessage } from "../hooks.ts"
import { showToast, store, threadBySlug } from "../store.ts"
import { markSteered, clearSteered } from "./steering.ts"

let fallbackDeliverySequence = 0

function newDeliveryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  fallbackDeliverySequence += 1
  return `browser-${Date.now()}-${fallbackDeliverySequence}`
}

// The message surfaces all obey the same ordering: make the local UI truthful before beginning
// network work.  In particular, `onOptimistic` clears the controlled draft before the mutation
// starts, so an Enter cannot feel gated on an RPC round-trip.  Failure reverses that local work and
// lets the caller restore its exact draft (without overwriting any newer text).
export type EagerFollowUpCallbacks = {
  onOptimistic?: () => void
  onSuccess?: () => void
  onRollback?: () => void
  scrollToBottom?: boolean
}

export function beginEagerSubmission({
  optimistic,
  request,
  success,
  failure,
}: {
  optimistic: () => void
  request: () => Promise<unknown>
  success?: () => void
  failure: (error: Error) => void
}): void {
  // Do not make this function async: callers need `optimistic` to finish before the first awaitable
  // operation is even started. That ordering is the entire perceived-latency contract.
  optimistic()
  void request().then(
    () => success?.(),
    (error: unknown) => failure(error instanceof Error ? error : new Error(String(error))),
  )
}

// ── per-thread send serialization ────────────────────────────────────────────────────────────────
// The composer no longer locks while a send is in flight (a steer must feel instant, and half a
// second of dead textarea is the single biggest reason it did not — see Composer's `busy`). That
// removes the accidental serialization the lock used to provide, and TWO things depended on it:
//
//   · ORDER. Two follow-ups fired 200ms apart are two independent HTTP requests; nothing but arrival
//     order decides which reaches the worker's stdin first. The operator typed them in an order and
//     means it.
//   · The server's runtime-control CAS. `resumeThread` claims the row (beginRuntimeControl) for the
//     duration of the injection; a second follow-up arriving inside that window loses the CAS
//     and comes back "another runtime control is in progress" — a hard failure for a message the
//     human already watched appear in the transcript.
//
// So the QUEUE moves from the UI to the network: every surface bound to a slug shares one FIFO chain,
// keyed at module scope because the same thread is steerable from several mounted composers at once
// (queue card + drawer + a second tab's board). Each link runs regardless of its predecessor's
// outcome — a failed send rolls back only its own bubble and must not strand the sends behind it.
const sendChains = new Map<string, Promise<void>>()

export function enqueueThreadSend(slug: string, run: () => Promise<void>): Promise<void> {
  const tail = sendChains.get(slug) ?? Promise.resolve()
  const next = tail.then(run, run)
  // The stored tail must never reject, or every later `.then(run, run)` would still run but leave an
  // unhandled rejection behind it. The RETURNED promise keeps its rejection for the caller's failure path.
  sendChains.set(slug, next.then(() => {}, () => {}))
  return next
}

// ── delivery retry ───────────────────────────────────────────────────────────────────────────────
// A follow-up used to get exactly ONE attempt: any rejection handed the operator's message straight
// back to the composer under "Steer failed". But what actually fires here is CONTENTION, not refusal —
// resumeThread owns the row for the 300-830ms its synchronous injection takes, and a second writer
// arriving inside that window (the wakers scheduler, another tab, the submit-confirmer) loses the
// runtime-control CAS. The per-slug FIFO above only orders THIS tab's sends; it cannot see those. A
// build promotion is the same story from the other end: the mutation is refused before it is ever put
// on the wire while the control plane restarts.
//
// So a refusal that provably took NO EFFECT is now waited out instead of surfaced. Only errors the
// transport marked replayable are retried (isRetryableRpcError); an ambiguous failure — where the text
// may already have reached the worker — is never re-sent. The server independently dedups a replayed
// deliveryId against its delivery ledger, so even a misclassification here cannot paste a second copy.
//
// The retry deliberately runs INSIDE the FIFO link: a later send must not overtake the one being
// retried, because the operator typed them in an order and means it.
export const DELIVERY_RETRY_BACKOFF_MS = [300, 800, 1_800, 3_500] as const

// ── the send deadline ────────────────────────────────────────────────────────────────────────────
// A follow-up is a bare `fetch` with no deadline of its own, and it runs INSIDE the per-slug FIFO
// above whose links are `tail.then(run, run)`. So a request the server never answers does not merely
// lose its own message: it wedges the chain, and every steer typed into that thread afterwards waits
// behind it forever — optimistic bubble painted, no toast, no rollback, nothing on the wire. Only a
// reload clears it, and nothing on screen suggests one.
//
// Measured 2026-09-05 on `design-nub-static-server`: one `turn/start` blocked server-side for 1h 18m
// (see codex-app-server.ts `ensureCurrentAuth`), and from the operator's side every later steer was
// swallowed in silence — "my steers that I was typing into the box were not reopening the thread".
//
// The deadline is deliberately far longer than any healthy send: a cold session resume plus a turn
// start is seconds, and codex sends were measured at p50 3.3s with tails into the minutes. This is not
// a latency budget, it is the difference between one lost message and a permanently dead composer. An
// abort is AMBIGUOUS — the text may already have reached the worker — so it is never marked
// retryable; it rolls back one bubble, and the server's deliveryId ledger dedups a manual re-send.
export const DELIVERY_SEND_TIMEOUT_MS = 120_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

// `reanchor` runs on every attempt boundary — after a landed send, and again before each backoff.
// It re-stamps the optimistic steer so a card steered under load asserts "working" continuously:
// the hint's window must cover the wait for the TAILER to observe the turn, and that wait starts when
// delivery lands, not when the operator hit Enter, which under contention can be seconds and several
// attempts earlier. Without it a queue card leaves, reappears when the hint expires mid-flight, and
// leaves again once truth arrives — the exact flicker the operator reported.
export async function withDeliveryRetry(
  send: () => Promise<void>,
  reanchor: () => void,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await send()
    } catch (error) {
      // Only a REFUSAL the transport proved took no effect is replayable; an ambiguous failure
      // (the text may already have reached the worker) falls straight through to the caller's rollback.
      if (attempt >= DELIVERY_RETRY_BACKOFF_MS.length || !isRetryableRpcError(error)) throw error
      reanchor()
      await sleep(DELIVERY_RETRY_BACKOFF_MS[attempt])
      continue
    }
    // Re-anchor ONLY on the success path, and OUTSIDE the try: a delivered send must never be
    // reclassified as a failure just because re-stamping the optimism threw. `send()` has returned,
    // so the message is in — nothing after this may undo that.
    reanchor()
    return
  }
}

/** One attempt, under DELIVERY_SEND_TIMEOUT_MS — so a request the server never answers cannot hold the
 *  per-slug FIFO open behind it. Exported for the test that pins exactly that. */
export function sendFollowUpAttempt(
  slug: string,
  message: string,
  deliveryId: string,
  freshProcess?: boolean,
  interrupt?: boolean,
  timeoutMs: number = DELIVERY_SEND_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("Frizz did not answer this send")), timeoutMs)
  // Resolve the session id per ATTEMPT from the live board rather than once up front: a thread
  // re-dispatched mid-retry must bind to its CURRENT session, and the guarded followUp is what turns
  // a stale id into a clean refusal instead of a misdelivery.
  return (rpc.followUp(
    { slug, sessionId: threadBySlug(store.board, slug)?.sessionId ?? "", message, deliveryId, freshProcess, interrupt },
    { signal: controller.signal },
  ) as Promise<void>).finally(() => clearTimeout(timer))
}

function deliverFollowUp(slug: string, message: string, deliveryId: string, freshProcess?: boolean, interrupt?: boolean): Promise<void> {
  return withDeliveryRetry(
    () => sendFollowUpAttempt(slug, message, deliveryId, freshProcess, interrupt),
    () => markSteered(slug),
  )
}

// THE follow-up send, hook-free so that EVERY surface which starts a turn goes through it — including
// the ones that aren't a composer. A caller that reaches for `rpc.followUp` directly silently opts out
// of all four things below, and the operator sees the difference immediately: no optimistic bubble, no
// working spinner, no rail reorder, and no place in the per-slug FIFO chain (so it can lose the
// server's runtime-control CAS to a concurrent composer send and fail outright). Retry did exactly
// that and read as a dead button for ~2.2s — see lib/retrySession.ts.
//
// `failureToast` lets a non-composer caller name its own verb ("Retry failed: …"); everything else,
// including the rollback, is identical by construction. `freshProcess` rides along for the one verb
// that needs the message to land in a just-started worker (lib/restartWorker.ts) — it changes only
// what the SERVER does with the delivery, so the optimistic bubble, the FIFO chain and the rollback
// are unchanged and shared.
export function sendEagerFollowUp(
  queryClient: QueryClient,
  slug: string,
  text: string,
  callbacks: EagerFollowUpCallbacks & { failureToast?: (message: string) => string; freshProcess?: boolean; interrupt?: boolean } = {},
): boolean {
  const message = text.trim()
  if (!message) return false
  const deliveryId = newDeliveryId()
  beginEagerSubmission({
    optimistic: () => {
      callbacks.onOptimistic?.()
      appendQueuedMessage(queryClient, slug, message, { scrollToBottom: callbacks.scrollToBottom, deliveryId })
      // The row is working again the instant the operator commits, not when the injection
      // returns ~half a second later — see lib/steering.ts.
      markSteered(slug)
      rpc.markRead({ slug }).catch(() => {})
    },
    // Resolve the session id at SEND time from the live board (not render time), so a re-dispatch
    // between mount and send still binds the guarded followUp to the current session. Contention
    // refusals are retried in place — the composer only gets the message back once they are exhausted.
    request: () => enqueueThreadSend(slug, () => deliverFollowUp(slug, message, deliveryId, callbacks.freshProcess, callbacks.interrupt)),
    success: () => callbacks.onSuccess?.(),
    failure: (error) => {
      removeQueuedMessage(queryClient, slug, message, deliveryId)
      clearSteered(slug)
      callbacks.onRollback?.()
      // A transport rejection is not enough evidence to expose terminal-recovery machinery.
      // Restore the draft and leave the provider untouched.
      showToast(callbacks.failureToast?.(error.message) ?? `Steer failed — ${error.message.slice(0, 90)}`)
    },
  })
  return true
}

export function useEagerFollowUp(slug: string): {
  submit: (text: string, callbacks?: EagerFollowUpCallbacks & { interrupt?: boolean }) => boolean
  pending: boolean
} {
  const queryClient = useQueryClient()
  // Retained for surfaces that want a spinner on their own send BUTTON. It is deliberately NOT wired
  // into any composer's `busy` anymore: an optimistic send has already committed locally, so gating
  // the textarea on the round-trip only made the box go dead (and lose the caret) for the exact half
  // second the operator wanted to keep typing.
  const [pending, setPending] = useState(0)

  const submit = useCallback((text: string, callbacks: EagerFollowUpCallbacks & { interrupt?: boolean } = {}) =>
    sendEagerFollowUp(queryClient, slug, text, {
      ...callbacks,
      // The counter rides the same three edges the send already has, so an empty (rejected) submit
      // never touches it and every started send is balanced by exactly one settle.
      onOptimistic: () => { setPending((n) => n + 1); callbacks.onOptimistic?.() },
      onSuccess: () => { setPending((n) => Math.max(0, n - 1)); callbacks.onSuccess?.() },
      onRollback: () => { setPending((n) => Math.max(0, n - 1)); callbacks.onRollback?.() },
    }), [queryClient, slug])

  return { submit, pending: pending > 0 }
}
