import type { QueryClient } from "@tanstack/react-query"
import type { BoardState, ServerEvent } from "@frizz/shared"
import { deltaAction } from "@frizz/shared"
import { store, setBoard, applyDelta, openThread } from "../store.ts"
import { noteServerBootId } from "./boot.ts"
import { basePath, projectSlug } from "../lib/base-path.ts"
import { boardThreadHref } from "../lib/router.ts"
import { expandBoardDelta } from "./wirePatch.ts"

// The transport-agnostic board/notify handler — the delta/seq/boot state machine, shared so BOTH
// transports drive it identically: SSE (sse.ts, the fallback) and the /ws multiplex (socket.ts).
// The board arrives whole one of two ways: read over HTTP (`adopt`, what the socket path does — see
// board-resume.ts) or as SSE's connect keyframe (a "board" event). "board-delta" frames carry only the
// threads that changed and must arrive in order (deltaAction). A seq gap can't be trusted, so the owner
// resyncs — the socket by reading the board over HTTP again, SSE by reconnecting for a new keyframe.
// `resync` is injected so this module stays ignorant of the transport.
export class BoardStream {
  // The seq of the last board frame we adopted/applied. -1 = no board yet. A whole board sets it; each
  // delta must be exactly currentSeq+1 (see deltaAction) or we resync.
  private currentSeq = -1
  // The boot the held board and its seq belong to. A seq means nothing across a server restart.
  private boot: string | null = null
  private readonly applied: () => void
  private readonly resync: () => void
  private readonly interactionsInvalidated: (
    event: Extract<ServerEvent, { type: "interactions-invalidated" }>,
  ) => void
  private readonly projectsChanged: () => void

  constructor(
    resync: () => void,
    interactionsInvalidated: (
      event: Extract<ServerEvent, { type: "interactions-invalidated" }>,
    ) => void = () => {},
    projectsChanged: () => void = () => {},
    applied: () => void = () => {},
  ) {
    this.resync = resync
    this.interactionsInvalidated = interactionsInvalidated
    this.projectsChanged = projectsChanged
    this.applied = applied
  }

  // Forget the held board's seq — for a board that no longer applies (another project), so any stray
  // delta arriving before the next whole board forces a resync rather than applying against it.
  reset(): void {
    this.currentSeq = -1
    this.boot = null
  }

  /** What a socket names to resume from: the boot and seq of the board held, or null. */
  held(): { bootId: string; seq: number } | null {
    return this.boot !== null && this.currentSeq >= 0 ? { bootId: this.boot, seq: this.currentSeq } : null
  }

  /**
   * Adopt a board read over HTTP. A read can land after the socket has already carried this stream past
   * it (a delta applied while the read was in flight): the held board is then the newer one, and
   * replacing it would show the board going backwards until the replay caught up. False when the
   * store's door refused the board (it names another project, or this is the Console).
   */
  adopt(state: BoardState): boolean {
    noteServerBootId(state.bootId)
    if (this.boot === state.bootId && this.currentSeq >= state.seq) return true
    if (!setBoard(state.board)) return false
    this.boot = state.bootId
    this.currentSeq = state.seq
    return true
  }

  handle(event: ServerEvent): void {
    switch (event.type) {
      case "board":
        noteServerBootId(event.bootId)
        setBoard(event.board)
        // Keyframe: adopt its seq. A pre-restart server omits seq → -1 (it only ever sends full frames,
        // never deltas, so seq tracking is moot against it — we just keep taking whole boards).
        this.currentSeq = typeof event.seq === "number" ? event.seq : -1
        this.boot = event.bootId ?? null
        break
      case "board-delta":
        noteServerBootId(event.bootId)
        // A delta from another boot than the held board's counts from another start: its seq says
        // nothing about this board. Never sent by a socket that resumed us, so a guard, not a path.
        if (this.boot !== null && event.bootId && event.bootId !== this.boot) {
          this.resync()
          break
        }
        switch (deltaAction(this.currentSeq, event.seq)) {
          case "apply": {
            // A socket that takes patches sends changed threads as edits to the view held (wirePatch.ts);
            // they are made whole against this board here, and only for a delta that applies to it.
            const whole = expandBoardDelta(event, (id) => store.board?.threads.find((t) => t.id === id))
            if (!whole) {
              this.resync()
              break
            }
            if (applyDelta(whole)) {
              this.currentSeq = event.seq
              this.applied()
            } else this.resync() // no base board yet — fetch one
            break
          }
          case "ignore":
            break // a delta the held board already includes (a replay overlapping a read)
          case "resync":
            this.resync() // a delta was dropped (seq gap) — incremental state is untrustworthy; get a keyframe
            break
        }
        break
      case "notify":
        notify(event)
        break
      case "interactions-invalidated":
        this.interactionsInvalidated(event)
        break
      case "projects-changed":
        // Not about this stream's board at all, and so not sequenced with it: the machine's project
        // list changed in SOME tab, and this one re-reads it (see `refreshProjectList` below).
        this.projectsChanged()
        break
    }
  }
}

/**
 * Re-read the machine's project list — the rail's squares and the grid's cards.
 *
 * Called for the server's `projects-changed`, which is how a reorder, a rename or a new icon made in
 * one tab reaches every other: nothing else refetches this list (refetchOnWindowFocus is off
 * app-wide), so before the event a second tab kept the order it had loaded until somebody reloaded it.
 * Also called when a feed comes back from a drop, because an announcement published while this tab
 * had no stream was never delivered and nothing will repeat it.
 *
 * An invalidation, not a write: the list is one cheap read, the squares on screen stay put until the
 * answer lands, and a tab holding an optimistic order of its own (ProjectRail) keeps showing it.
 */
export function refreshProjectList(queryClient: QueryClient | null | undefined): void {
  void queryClient?.invalidateQueries({ queryKey: ["projectsList"] })
}

// Fire a desktop notification for a server-pushed event, but only when the user opted in
// (settings.notifications, mirrored on the store) and the app isn't the focused/visible window —
// we never notify for what the user is already looking at. Clicking focuses the thread.
export function notify(event: Extract<ServerEvent, { type: "notify" }>): void {
  if (!store.notificationsEnabled) return
  if (!document.hidden) return
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return
  // The tag is the browser's REPLACE key, so a bare slug collapses two projects' identically-named
  // threads into one notification — and the click would open whichever tab happened to fire it.
  const n = new Notification(event.title, { body: event.body, tag: `${basePath()}/${event.slug}` })
  // THE PROJECT THIS NOTIFICATION IS ABOUT, frozen now — the last place in the client where "which
  // project" was resolved at the moment of USE rather than travelling with the thing that needed it.
  // A notification is clicked when the operator gets back to their machine, which can be long after it
  // was raised and in a tab that has since switched projects. `openThread` opens a slug in whatever
  // project is showing, and slugs are unique only WITHIN a project (see `rebindProject`), so the click
  // opened a DIFFERENT thread that happened to share the name rather than failing and saying so.
  const project = projectSlug() ?? store.board?.projectSlug
  n.onclick = () => {
    window.focus()
    // Same project (the overwhelmingly common case): the in-app drawer, no reload. Otherwise a real
    // navigation, because the destination is another project's page — one document load, which is
    // what switching projects by URL has always been.
    if (project === undefined || projectSlug() === project) {
      openThread(event.slug) // side drawer: chat, or the frizz doc for a never-spawned thread
    } else {
      location.assign(boardThreadHref(event.slug, project))
    }
    n.close()
  }
}
