import type { QueryClient } from "@tanstack/react-query"
import type { BoardDelta, JsonPatchOp, SocketServerMsg, ThreadView, TranscriptMessage } from "@frizz/shared"
import { applyJsonPatch, applyWindowSplice } from "@frizz/shared"
import { sameContent } from "../lib/transcript-sync.ts"

// THE CLIENT HALF OF THE SOCKET'S PATCHES (server: app-socket.ts, shared: wire-patch.ts).
//
// A socket opened with `?patch=1` is sent each change as the difference from what it already holds: a
// transcript as a `transcript-tail` frame, a board delta with `patches`. Both are rebuilt here into the
// whole values every other part of the app already handles, so nothing past the socket knows a patch
// was ever sent: a tail becomes a `transcript` frame, a patched delta becomes upserts.
//
// Measured on the maintainer's real boards (2026-11-09, the Console, three busy scripted workers and one
// thread open): 69 MB of transcript JSON in two minutes, every frame the whole 300-message window for a
// change of one or two messages at its tail, and board deltas of ~2 KB per thread for four changed
// fields. See the server's header for the numbers after.

/** The query a socket that takes patches opens with. A server from before patches ignores it. */
export const WS_PATCH_QUERY = "?patch=1"

type TranscriptTail = Extract<SocketServerMsg, { t: "transcript-tail" }>

/**
 * The last whole window each subscribed slug received on ONE socket — what its next tail is spliced
 * onto. Keyed by the slug as the socket names it. Forget a slug on unsubscribe and everything when the
 * socket goes: the server starts each new subscription, and each new socket, with a whole window.
 */
export class TranscriptTails {
  private readonly held = new Map<string, TranscriptMessage[]>()

  whole(slug: string, messages: TranscriptMessage[]): void {
    this.held.set(slug, messages)
  }

  /** The whole window a tail stands for, or null when it was not made against the window held. */
  tail(msg: TranscriptTail): TranscriptMessage[] | null {
    const base = this.held.get(msg.slug)
    if (!base || base.length !== msg.from || msg.drop < 0 || msg.keep < 0 || msg.drop + msg.keep > base.length) {
      this.held.delete(msg.slug)
      return null
    }
    const messages = applyWindowSplice(base, msg, msg.messages)
    this.held.set(msg.slug, messages)
    return messages
  }

  /**
   * Hold the CACHE's object for every message that says the same thing, once a frame has been written to
   * it (`cachedMessages`). The query cache keeps the previous object of each unchanged message
   * (lib/transcript-sync.ts preserveMessageIdentity), so a window held as received was a second copy of
   * the transcript the cache already held: 1.5–3 MB per live thread on the real boards (2026-11-09). The
   * window keeps its positions and length, which are all a splice reads; only which object fills a slot
   * changes, and only to one with the same content.
   */
  adopt(slug: string, cached: readonly TranscriptMessage[] | undefined): void {
    const held = this.held.get(slug)
    if (!held || !cached?.length) return
    const bySource = new Map<string, TranscriptMessage>()
    for (const message of cached) if (message.sourceId) bySource.set(message.sourceId, message)
    let out: TranscriptMessage[] | null = null
    for (let i = 0; i < held.length; i++) {
      const message = held[i]!
      const same = message.sourceId ? bySource.get(message.sourceId) : undefined
      if (!same || same === message || !sameContent(same, message)) continue
      ;(out ??= held.slice())[i] = same
    }
    if (out) this.held.set(slug, out)
  }

  forget(slug: string): void {
    this.held.delete(slug)
  }

  clear(): void {
    this.held.clear()
  }

  get size(): number {
    return this.held.size
  }
}

/** The messages the query cache holds for a transcript, as `TranscriptTails.adopt` takes them. */
export function cachedMessages(qc: QueryClient | null, key: string): readonly TranscriptMessage[] | undefined {
  return (qc?.getQueryData(["transcript", key]) as { messages?: TranscriptMessage[] } | undefined)?.messages
}

/**
 * A board delta with its `patches` turned back into upserts, each applied to the view of that thread
 * the caller holds (`viewOf`). Null when one cannot be: no such thread held, or a path that does not
 * lead through it — the delta was not made against this board, and the caller must read it again.
 * A delta without patches comes back as it is.
 */
export function expandBoardDelta(event: BoardDelta, viewOf: (id: string) => ThreadView | undefined): BoardDelta | null {
  if (!event.patches?.length) return event
  const upserts = event.upserts.slice()
  for (const patch of event.patches) {
    const base = viewOf(patch.id)
    if (!base) return null
    try {
      upserts.push(applyJsonPatch(base, patch.ops as JsonPatchOp[]))
    } catch {
      return null
    }
  }
  const { patches: _patches, ...rest } = event
  return { ...rest, upserts }
}
