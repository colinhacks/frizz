import { proxy, ref, snapshot, unstable_replaceInternalFunction } from "valtio"
import type { BoardSnapshot, ThreadView, BoardDelta } from "@frizz/shared"
import { applyBoardDelta } from "@frizz/shared"
import type { ComposerContextItem } from "./lib/composerContext.ts"
import type { LightboxImage } from "./lib/lightbox.ts"
import { disarmFullscreenMorph } from "./lib/fullscreenMorph.ts"
import { closeDrawerAnimated, focusDrawer } from "./lib/overlays.ts"
import { isPageScrollLocked, pageScrollY, requestScrollAfterUnlock } from "./lib/pageScrollLock.ts"
import { holdQueueCardLanding } from "./lib/queueLandingHold.ts"
import { resolveThreadRoute } from "./lib/threadRouteState.ts"
import { standaloneThreadHref } from "./lib/standaloneThreadRoute.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"
import { isConsolePath } from "./lib/base-path.ts"
import { holdsCardHere } from "./lib/consoleBoard.ts"
import { CONSOLE_TOP_PX } from "./lib/homeView.ts"
import { bareSlug, splitThreadKey } from "./lib/threadKey.ts"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { resetGithubCards } from "./lib/githubHovercards.ts"
import { setLocalPathBase } from "./lib/localPathBase.ts"
import { basename } from "./lib/paths.ts"
import { prefersReducedMotion, SHEET_CLOSE_MS } from "./lib/sheet.ts"
import type { RestartAttempt } from "./api/restart.ts"

// Where a scroll-to-card lands a card's outer border below the viewport top (px). Exported because the
// sidebar's reading rail watches for that same landing to know a click-to-card has arrived.
// 40px is the queue's own rhythm: the hairline rule between two cards carries `my-10` (40px) on each
// side, so a landed card sits under the viewport edge with exactly the space it has under its
// predecessor's rule. It was 12px until 2026-08-25, which read as the card being pressed against the
// top of the window (maintainer: "we should leave the full 40 px").
export const QUEUE_CARD_VIEWPORT_TOP = 40

/**
 * The landing, measured from the window's top. On the Console's wide layout it is the line its content
 * opens on under the home switcher (lib/homeView.ts CONSOLE_TOP_PX), the same line the top card rests on.
 */
export function queueCardViewportTop(): number {
  const wide = typeof window === "undefined" || typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 800px)").matches
  return isConsolePath() && wide ? CONSOLE_TOP_PX : QUEUE_CARD_VIEWPORT_TOP
}

// The BORDERED CARD ROOT inside a queue slot. The outer `[data-queue-card]` slot is the fade wrapper:
// it also spans the root's own bottom scroll-reserve margin, and it is not the element that draws the
// border, so anything visual — the scroll landing, the arrival ring — targets this root. (Until
// 2026-08-25 the slot also wrapped the inter-card hairline rule and its 40px margins; the rule is a
// sibling of the slots now, see TodosView's queue list.)
// Falls back to the slot itself for a slot that renders no root (fixtures, future card shapes).
function queueCardSlot(slug: string): HTMLElement | null {
  if (typeof document === "undefined") return null
  return document.querySelector<HTMLElement>(`[data-queue-card="${CSS.escape(slug)}"]`)
}
function queueCardRoot(slug: string): HTMLElement | null {
  const el = queueCardSlot(slug)
  if (!el) return null
  return el.querySelector<HTMLElement>(`[data-queue-card-root="${CSS.escape(slug)}"]`) ?? el
}

// Whether `slug` is the FIRST card in the queue — the topmost slot that isn't fading out. A fading
// predecessor still holds its row for the exit's duration, but it is already gone from the reader's
// point of view (and the dismissal landing runs after it unmounts), so it doesn't count.
function isFirstQueueCard(slug: string): boolean {
  const first = document.querySelector<HTMLElement>('[data-queue-card]:not([data-queue-leaving="true"])')
  return first !== null && first === queueCardSlot(slug)
}

// Absolute scrollY that lands `slug`'s bordered card root at the standard viewport-top landing.
// Shared by the sidebar's scroll-to-card and the queue's dismissal auto-scroll. Accounts for the
// narrow-layout fixed chrome the cards' sticky headers also dodge (max-[800px]:top-10 → 40px), so a
// landed card's header sits at its natural position instead of being pushed down into the body.
// null when the card isn't mounted.
// `pageScrollY()`, not `window.scrollY`: with a drawer open the page is scroll-LOCKED and window.scrollY
// reads 0 while the body sits shifted at the real offset, which would put every landing short by
// however far the reader had scrolled before opening the drawer.
//
// The FIRST card lands at the very top of the page instead. At rest its box sits 52px below the page
// top (main's py-5 plus the queue column's py-8, measured 2026-08-28), so the standard landing is
// scrollY 12: clearing a card whose successor headed the queue left the page scrollable by that sliver
// (maintainer 2026-08-28: "it scrolls me like there's like 10 pixels that I could scroll up from where
// it scrolls me to, and it's very annoying").
export function queueCardTargetY(slug: string): number | null {
  const root = queueCardRoot(slug)
  if (!root) return null
  if (isFirstQueueCard(slug)) return 0
  // matchMedia guarded: unit tests stub a minimal window without it (store.queue-navigation.test.ts).
  const navOffset = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 800px)").matches ? 40 : 0
  return Math.max(0, pageScrollY() + root.getBoundingClientRect().top - queueCardViewportTop() - navOffset)
}

export type ConnectionState = "connecting" | "open" | "closed"
export interface SocketPayloadFallback {
  actualBytes: number
  maxBytes: number
}
export type SocketTranscriptFallback =
  | ({ kind: "payload-too-large" } & SocketPayloadFallback)
  | { kind: "read-budget"; scope: "origin" | "global"; retryAfterMs: number }

// What the workpane (the centered main column) shows: "todos" (the queue — cards + dispatch box, the
// resting page) or "status:<s>" (URL-only per-status lists). THREADS render in the side-drawer stack
// over the queue; there is no main-view thread surface and no nav selection (the focus machine and
// the sidebar arrow-walk were deleted — the sidebar is mouse-driven). The router is the writer.
export type View = "todos" | `status:${string}`

// The whole app renders off this single valtio proxy. Board is a full snapshot
// pushed over SSE (no diff protocol); everything else is local UI state.
export const store = proxy({
  board: null as BoardSnapshot | null,
  view: "todos" as View,
  connection: "connecting" as ConnectionState,
  // The durable supervisor, rather than a disposable board child, owns this truth. While it is
  // restarting, all text remains in the session-backed draft store but write RPCs are held locally.
  // This prevents a successful-looking old UI from racing a successor artifact.
  controlPlaneState: "ready" as "ready" | "restarting" | "failed",
  controlPlaneMessage: null as string | null,
  // A user-initiated update+restart flips the overlay on OPTIMISTICALLY (before the POST is acked) so
  // the block is instant. While an attempt is recorded here, the status poll must not apply a "ready"
  // it reads — that would tear the overlay down and could reload onto the old child — and it must not
  // believe ANY answer whose request started before the ack, whichever state it names: a "failed" that
  // was already in flight when the operator clicked retry used to clear this guard for the new attempt
  // (pullfrog on #35, 2026-09-11). `ackedAt` is set when the supervisor accepts the transition; the
  // record is cleared by PageFrame's poll effect once an answer requested after that ack observes it
  // (nextControlPlane in api/restart.ts), or by the button when the POST is rejected.
  controlPlaneRestartAttempt: null as RestartAttempt | null,
  showSettings: false,
  showPalette: false,
  // The anywhere-modal behind the "New thread" pill (Gmail-compose style).
  showNewThread: false,
  // The GitHub picker modal (Issues/PRs tabs → multi-select → batch dispatch), or the sign-in while
  // Frizz is signed out. Its trigger appears in a GitHub repo; see GithubTrigger + openGithubPicker.
  // The modal reads the durable new-thread profile live and carries its own selector for it, so
  // nothing about the dispatch tuple is captured here.
  showGithubPicker: false,
  // Left-sidebar section collapse (true = collapsed). Only Active leads expanded — it is the live
  // work and has no header to collapse from. Snoozed and Done start collapsed: each is a band
  // whose header count already says how much is parked there, so the rail opens on what is running.
  // Session-scoped UI state (deliberately not persisted).
  // `external` is the External band — the human's own terminals. Collapsed by default like
  // Snoozed/Done: nothing in it is frizz's work or waiting on the rail's reader, so the count is
  // the glance.
  sidebarCollapsed: { active: false, snoozed: true, inactive: true, external: true } as Record<"active" | "snoozed" | "inactive" | "external", boolean>,
  // The SIDE-DRAWER STACK — arbitrary depth. `thread` layers are full thread views (the Open-thread
  // sheet); `doc` layers are the frizz-document markdown; `markdown` layers are the built-in reader for
  // a `.md` FILE on disk, opened from any link to one (on a phone, for any file — as source); `subagent` and `shell` layers are read-only
  // operation drill-ins that overlay a thread. A drill-in within one thread's family
  // (its doc, its sub-agents) stacks OVER the previous layer (higher z, slight inset); any lateral open
  // REPLACES the layers it doesn't stack over (one drawer at a time — see openOrRaiseDrawer). Esc /
  // backdrop / browser-Back unwind the TOP layer first. There is no
  // standalone thread page — this stack is the only thread surface. Operation-only fields ride the
  // same entry so App can render its sheet without a board lookup after the operation finishes.
  drawers: [] as {
    id: number
    kind: "thread" | "doc" | "subagent" | "shell" | "monitor" | "markdown"
    slug: string
    routed?: boolean // URL/deep-link-created thread: visible on first paint, never an invisible animated backdrop
    subId?: string // subagent/shell: the launch tool_use id (the RPC handle + dedupe key); monitor: its `cmw_…` id
    label?: string // subagent: the dispatch description (header title) / markdown: the basename
    path?: string // markdown: the absolute file path
    subagentType?: string // subagent: the model+effort cell tag
    startedAt?: string // subagent: ISO8601 dispatch time (drives the header's running elapsed)
    openedAt?: number // bumped when an existing logical layer is focused/reopened
    closing?: boolean // set the instant this layer's slide-OUT begins, so URL/topThreadSlug stop
    // counting it before its 210ms removal (prevents a phantom /thread history push when a view
    // change races the close — see markDrawerClosing).
  }[],
  // Mirrors settings.notifications so the (React-free) SSE handler can gate desktop
  // notifications without reaching into TanStack Query. Kept in sync by PageFrame, on the
  // board and on the full-screen thread page alike.
  notificationsEnabled: false,
  // True once the /ws multiplex confirms it's live (server pushes transcript updates into the query
  // cache). useTranscript reads this to DROP its 1.5s poll + subscribe instead; false before the socket
  // confirms and on SSE fallback (a pre-restart server without /ws), where polling stays exactly as today.
  socketTranscripts: false,
  // Explicit transport downgrades reported by the multiplex server: a transcript overflow/read-budget
  // rejection pauses only that slug's live subscription while the last complete copy remains visible and
  // manually refreshable. All reset on reload. (The board has none: it never rides the socket whole, so
  // nothing about its size can downgrade it — see api/board-resume.ts.)
  socketTranscriptFallbacks: {} as Record<string, SocketTranscriptFallback>,
  // A `/thread/<slug>` URL whose destination is not settled yet. The router cannot decide it alone:
  // a QUEUED thread already has its full card in the main column, so the URL belongs to that card,
  // not to a drawer over it — and on a cold load the board hasn't arrived, so `needsYou` is unknown.
  // The router parks the slug here and App resolves it the first render the board is authoritative
  // (see resolveRoutedThread). Snoozed slugs keep the address bar on /thread/<slug> meanwhile.
  routeThreadSlug: null as string | null,
  // The slug whose BOARD surface (thread drawer or queue card) is currently wearing
  // `view-transition-name: thread-chat`, so the /full page's thread column has somewhere to morph
  // back into when the fullscreen page is left for the board (browser Back, or the collapse icon).
  // Set render-phase by primeFullscreenReturn and cleared on a timer just past the animation — a
  // surface that KEPT the name would collide with the next door click's imperative tag, and duplicate
  // view-transition-names abort the whole transition.
  vtReturnTarget: null as string | null,
  // Transient bottom-center toast (e.g. "Steer failed …" when an eager reply is rejected). `id` bumps per call so
  // repeat toasts re-trigger the fade. Rendered by <Toaster>; null when nothing is showing.
  toast: null as { id: number; text: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string }; action?: ToastAction } | null,
  // The open image LIGHTBOX — one ```lightbox gallery's pictures and which of them is on screen. Here
  // rather than in the gallery's own state because the gallery is a transcript row: the virtualizer
  // unmounts it once it scrolls out of the window, and a worker still writing below a gallery the
  // human is looking through scrolls it there. Rendered by <LightboxHost>; null when closed.
  lightbox: null as { images: LightboxImage[]; index: number } | null,
  // The /full page's SPLIT file viewer. True only while StandaloneThreadPage is mounted; while it is,
  // a `.md` click renders BESIDE the thread (the thread column slides left) instead of as an overlay
  // drawer — the whole point of /full is seeing the transcript, and a sheet over it defeated that.
  // The queue page keeps the drawer: its main column is the queue, not the thread being read.
  splitFileViewer: false,
  // Keep each reader mounted under the next so following a link preserves its scroll and view mode.
  // Instance ids (not paths) also let A → B → A unwind through both visits independently.
  filePanels: [] as { id: number; path: string; closing?: boolean }[],
  // SELECTED-CONTEXT items staged for a thread's next message (⌘I over a selection in the file
  // viewer). Rendered as chips above the thread's composer — every surface showing that composer shows
  // them — and serialized into the outgoing text on send. Session-scoped on purpose: unlike the typed
  // draft these are quotes of files on disk, re-creatable in two keystrokes.
  composerContext: {} as Record<string, ComposerContextItem[]>,
})

export function openNewThread(): void {
  store.showNewThread = true
}

// Open the GitHub picker modal (batch-dispatch from issues/PRs). The trigger that calls this is
// itself gated on gh being authed + in a GitHub repo, so the modal only opens when the RPCs can serve.
export function openGithubPicker(): void {
  store.showGithubPicker = true
}

export function closeGithubPicker(): void {
  store.showGithubPicker = false
}

let toastSeq = 0
// A toast's own verb — "Undo" on the phone's Done. `run` is called once, and the toast clears with it.
export interface ToastAction {
  label: string
  run: () => void
}

export function showToast(text: string, opts?: { spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string }; action?: ToastAction }) {
  store.toast = { id: ++toastSeq, text, ...opts }
}

export function openLightbox(images: LightboxImage[], index: number): void {
  if (images.length === 0) return
  store.lightbox = { images, index: Math.min(Math.max(index, 0), images.length - 1) }
}

export function closeLightbox(): void {
  store.lightbox = null
}

// Step to a neighbouring picture. It stops at either end rather than wrapping: the overlay counts
// "3 / 3", and a wrap would make the next press read as a jump back to the start.
export function stepLightbox(delta: number): void {
  const box = store.lightbox
  if (!box) return
  box.index = Math.min(Math.max(box.index + delta, 0), box.images.length - 1)
}

// ── drawer stack ─────────────────────────────────────────────────────────────────────────────────
let drawerSeq = 0
let drawerOpenSeq = 0
type Drawer = (typeof store.drawers)[number]

// Kind is part of the identity: a chat thread and its document can deliberately stack, while a
// second request for that same chat (or document) must reuse the existing layer.
function sameDrawer(a: Drawer, b: Pick<Drawer, "kind" | "slug" | "path" | "subId">): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "markdown") return a.path === b.path
  if (a.kind === "subagent" || a.kind === "shell" || a.kind === "monitor") return a.subId === b.subId
  return a.slug === b.slug
}

// The only layers a new drawer legitimately stacks OVER are its own thread's family: a sub-agent
// transcript over its parent thread/doc, and a thread⇄doc pair sharing a slug. Everything else —
// sibling threads, sibling sub-agents — is a lateral move, not a drill-in.
function stacksOver(below: Drawer, next: Pick<Drawer, "kind" | "slug">): boolean {
  // A `.md` reader is always a DRILL-IN: it is opened by clicking a link inside whatever is already
  // showing (a chat message, another document), so replacing that layer would close the very
  // prose the link was read from. It stacks over anything, its own kind included — following a doc's
  // link to a sibling doc and pressing Esc to come back is the whole point of a reader.
  if (next.kind === "markdown") return true
  if (next.kind === "subagent" || next.kind === "shell" || next.kind === "monitor") return (below.kind === "thread" || below.kind === "doc") && below.slug === next.slug
  if (next.kind === "doc") return below.kind === "thread" && below.slug === next.slug
  if (next.kind === "thread") {
    if (below.kind === "doc" && below.slug === next.slug) return true
    // A CHILD THREAD opened from its parent (lib/childThreads) is a drill-in like a sub-agent: its drawer
    // stacks over the parent's thread or doc drawer, so closing it lands back on the parent. Any other
    // thread over a thread is a lateral move and replaces it. (On the Console both ids are keys: the
    // feed keys `parentSlug` with the thread's own id, api/consoleFeed keyThread.)
    const parent = threadSnapshotBySlug(next.slug)?.parentSlug
    return parent !== undefined && (below.kind === "thread" || below.kind === "doc") && below.slug === parent
  }
  return false
}

// ONE-DRAWER POLICY (maintainer 2026-07-21): opening a layer REPLACES every live layer it doesn't
// logically stack over, so lateral moves (sidebar sibling thread/sub-agent clicks) swap the
// open drawer instead of piling up; only drilling into the open thread's own child/doc stacks.
//
// Exported for the router, which applies the same displacement when Back or Forward lands on a thread
// the stack no longer holds (lib/router applyPath). That thread was REPLACED by this policy when the
// lateral move happened, so the layer that replaced it is still on top; left there, it kept the store
// saying "the other thread" while the address bar said this one, and the store→URL sync pushed the
// other thread's URL straight back — every Back press grew the history and flipped between the two.
export function closeLayersDisplacedBy(next: Pick<Drawer, "kind" | "slug" | "path" | "subId">): void {
  const displaced = store.drawers.filter((d) => !d.closing && !sameDrawer(d, next) && !stacksOver(d, next)).map((d) => d.id)
  if (displaced.length) closeDrawersById(displaced)
}

function openOrRaiseDrawer(next: Omit<Drawer, "id" | "closing" | "openedAt">): void {
  closeLayersDisplacedBy(next)

  const matches = store.drawers.filter((drawer) => sameDrawer(drawer, next))
  if (!matches.length) {
    store.drawers.push({ ...next, id: ++drawerSeq, openedAt: ++drawerOpenSeq })
    return
  }

  // Keep the newest non-closing instance. This heals old duplicate state too: one logical layer
  // remains, so closing a drawer can never reveal an identical one beneath it.
  const existing = [...matches].reverse().find((drawer) => !drawer.closing) ?? matches[matches.length - 1]!
  const { closing: _closing, ...liveExisting } = existing
  const reopened = { ...liveExisting, ...next, openedAt: ++drawerOpenSeq }
  store.drawers = [...store.drawers.filter((drawer) => !sameDrawer(drawer, next)), reopened]
  // Existing layers are already mounted. Let their local focus manager restore focus after Valtio
  // publishes the reordered/reopened stack without manufacturing another component instance.
  queueMicrotask(() => focusDrawer(existing.id))
}

export function pushDrawer(kind: "thread" | "doc", slug: string, opts?: { routed?: boolean }): void {
  openOrRaiseDrawer({ kind, slug, routed: opts?.routed })
}

// Open a sub-agent's transcript as a new drawer layer OVER whatever's on top (typically the thread it
// was dispatched from). `slug` is the PARENT thread; `subId` is the dispatch tool_use id (the RPC
// handle). Deduped on subId so a double-click / re-click doesn't stack duplicates.
export function pushSubAgentDrawer(slug: string, subId: string, opts: { label: string; subagentType?: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "subagent", slug, subId, label: opts.label, subagentType: opts.subagentType, startedAt: opts.startedAt })
}

export function pushBackgroundShellDrawer(slug: string, id: string, opts: { label: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "shell", slug, subId: id, label: opts.label, startedAt: opts.startedAt })
}

/** A monitor's drawer (MonitorSheet): its script and what it printed, stacked over its thread like a shell's. */
export function pushMonitorDrawer(slug: string, id: string, opts: { label: string }): void {
  openOrRaiseDrawer({ kind: "monitor", slug, subId: id, label: opts.label })
}

// Open a thread from a listing/notification click-through. A QUEUED thread short-circuits to its own
// card (see scrollToQueueCard below) — every affordance that asks to "show me this thread" obeys the
// one rule, so nothing can stack a drawer on top of the identical panel. Otherwise routing is by
// runtime: a thread with NO session ever spawned (runtime "none" — no transcript, the chat drawer
// would be an empty placeholder) opens its frizz DOCUMENT drawer instead — there
// the doc IS the substance. Anything with a session (live or exited — exited transcripts are worth
// seeing) opens the chat drawer. The doc drawer carries the adopt ("Start a session") affordance.
/**
 * On the Console, the KEY a bare slug names — the one thread on the merged board with that slug — or
 * null when no thread or several have it. A bare slug reaches the Console from a link a worker wrote
 * (`/thread/<slug>`, the shape its prompt teaches) and from an old bookmark; everywhere else, and for a
 * key, the answer is the slug itself.
 */
export function consoleThreadKey(slug: string): string | null {
  if (!isConsolePath() || splitThreadKey(slug)) return slug
  const hits = store.board?.threads.filter((t) => bareSlug(t.id) === slug) ?? []
  return hits.length === 1 ? hits[0]!.id : null
}

export function openThread(slugOrKey: string): void {
  const slug = consoleThreadKey(slugOrKey)
  // A bare slug the Console cannot place: its own project's full page finds it (MissingThread).
  if (slug === null) {
    if (typeof location !== "undefined") location.assign(`/thread/${encodeURIComponent(slugOrKey)}/full`)
    return
  }
  const t = store.board?.threads.find((x) => x.id === slug)
  if (t?.needsYou && scrollToQueueCard(slug)) return
  pushDrawer(t && t.runtime === "none" ? "doc" : "thread", slug)
}

// Is the board still waiting on part of itself? The Console's merged board is shown once its projects
// answer or a deadline passes (api/consoleFeed.ts), so a slow project can still be on its way — and a
// thread URL naming it is not MISSING yet. The feed registers this rather than the store importing a
// transport; on a project's page nothing is ever pending.
let boardPending: (project?: string) => boolean = () => false
export function setBoardPendingCheck(check: (project?: string) => boolean): void {
  boardPending = check
}

// Settle a parked `/thread/<slug>` URL, now that the board can say whether the thread is queued.
// A deep link deliberately asks for the CHAT surface even for a session-less thread (unlike
// openThread's doc-routing), so this pushes the thread layer rather than delegating — but it obeys
// the same queue-card rule: a needsYou thread renders its whole panel inline in the main column, and
// opening the routed drawer over it painted that panel TWICE, one half-occluding the other.
// `routed` so a cold page paints the sheet already open instead of animating a phantom backdrop in.
export function resolveRoutedThread(): void {
  const routed = store.routeThreadSlug
  if (!routed || !store.board) return
  // On the Console, a key waits for its project's first keyframe, and a bare slug for every project's —
  // it could belong to any of them. It stays parked, and the board's next change asks again (App.tsx).
  if (isConsolePath() && boardPending(splitThreadKey(routed)?.project)) return
  store.routeThreadSlug = null
  // The Console's URL names a thread by key; a bare one is placed by the merged board, or handed to the
  // unprefixed full page, whose MissingThread asks the server which project owns it.
  const slug = consoleThreadKey(routed)
  if (slug === null) {
    if (typeof location !== "undefined") location.replace(`/thread/${encodeURIComponent(routed)}/full`)
    return
  }
  const route = resolveThreadRoute(store.board, slug, threadBySlug)
  // A slug THIS project does not have. Since one server started serving every project that is usually
  // a thread another project has — and `/thread/<slug>` is the exact shape every pre-singleton
  // bookmark and every agent-written cross-reference uses, so it is not a rare typo. Pushing the
  // drawer anyway opened an empty sheet over the board that said nothing and offered nothing.
  // The `/full` page already knows how to recover: <MissingThread> asks `threadLocate` which project
  // owns the slug and relocates there. Hand it over rather than growing a second copy of that.
  if (route.kind === "missing") {
    if (typeof location !== "undefined") location.replace(standaloneThreadHref(slug))
    return
  }
  // `settlingRoute`: the address bar already holds this thread's entry, so the board URL that follows
  // REPLACES it — a push would leave `/thread/<slug>` and the board behind each other as two entries.
  if (route.kind === "found" && route.thread.needsYou && scrollToQueueCard(slug, { settlingRoute: true })) return
  pushDrawer("thread", slug, { routed: true })
}

// THE FULLSCREEN DOOR, PLAYED BACKWARDS. react-router re-arms the door's view transition for the POP
// back out of /full (it remembers which path pairs transitioned), and the collapse icon opts in
// explicitly — but the transition can only morph the /full thread column into a board surface that
// EXISTS and IS NAMED in the board's FIRST commit, the one the new-state snapshot reads. Left to the
// ordinary flow, the drawer arrives two effects later (applyPath parks the slug, resolveRoutedThread
// settles it) and no board surface ever wears the name, so Back played as a bare crossfade
// (maintainer 2026-09-02: "when I hit the back button on full-screen view, it doesn't undo the
// animation"). StandaloneRoute records its slug on every render; BoardRoute consumes it in a
// render-phase initializer — the mirror of StandaloneRoute's own render-phase drawer clear.
let lastStandaloneSlug: string | null = null
export function noteStandaloneThreadRender(slug: string): void {
  lastStandaloneSlug = slug
}

export function primeFullscreenReturn(routedSlug: string | undefined): void {
  // The forward door started its morph from the visible part of the board surface; this render is
  // inside the REVERSE transition's update callback, so dropping that here — before the browser builds
  // the reverse leg's pseudo-elements — is what hands the return morph back to the browser's own
  // keyframes. Unconditional: any way back to the board retires it (lib/fullscreenMorph).
  disarmFullscreenMorph()
  const slug = lastStandaloneSlug
  lastStandaloneSlug = null
  if (!slug) return
  // Name whichever surface this slug renders as — ThreadSheet and the queue card both check this.
  // Cleared well past the 200ms animation: clearing in an effect could beat the new-state capture
  // and un-name the element mid-transition.
  store.vtReturnTarget = slug
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      if (store.vtReturnTarget === slug) store.vtReturnTarget = null
    }, 600)
  }
  // The drawer itself, only when the return URL names this thread and the board can already say it
  // is NOT queued (a queued thread's surface is its card, which the queue mounts in this same pass).
  // The same painted-open push resolveRoutedThread would make — just in the commit the snapshot
  // actually reads; applyPath then finds the layer already present and leaves it be.
  if (routedSlug !== slug || !store.board) return
  const route = resolveThreadRoute(store.board, slug, threadBySlug)
  if (route.kind !== "found" || holdsCardHere(route.thread)) return
  if (store.drawers.some((d) => d.kind === "thread" && d.slug === slug && !d.closing)) return
  pushDrawer("thread", slug, { routed: true })
}

// A thread that's ALREADY in the queue (needsYou) has its full card in the main column — clicking its
// sidebar row SCROLLS to that card and stops there; it does NOT open a redundant drawer over it
// (maintainer 2026-07-09: "the queue is how you know"; 2026-07-15: "just auto-scroll to the item in the
// queue"). Returns false if no card is mounted (not queued / not rendered), so the caller falls back to
// opening the drawer instead.
//
// Any drawer already on screen is DISMISSED here (maintainer 2026-08-11: "clicking a queued item in the
// sidebar should both DISMISS the current drawer and autoscroll"). It has to happen in this one place
// rather than at the sidebar's call site: a drawer over the queue is precisely what stops you seeing the
// card, so every "show me this card" door — the rail, the palette, a deep link, a notification
// click-through — wants it gone. The plain sheets also spread a full-screen scrim, which the click
// would otherwise land on instead of the row.
//
// And that dismissal is a NAVIGATION, so it PUSHES history (takeQueueCardNavigation). Every other
// drawer close replaces — the router's rule — and this one used to as well: A's drawer, a link to queued
// B, and A's `/thread/a` entry was rewritten to the board, sitting on top of the board it was opened
// from. Back then did nothing visible and A was gone (desktop, 2026-10-08). Pushed, Back returns to A.
// A routed `/thread/<slug>` settling here (resolveRoutedThread) is the exception: that entry already
// names this thread, and the board replaces it.
export function scrollToQueueCard(slug: string, opts?: { settlingRoute?: boolean }): boolean {
  const root = queueCardRoot(slug)
  if (!root) return false
  const targetY = queueCardTargetY(slug)
  const open = store.drawers.filter((drawer) => !drawer.closing).map((drawer) => drawer.id)
  if (open.length) {
    queueCardNavigation = !opts?.settlingRoute
    closeDrawersById(open)
  }
  // Absolute scroll is intentional. A narrow layout may have just changed document geometry while a
  // drawer finished closing; a relative scroll in that transition can be applied to the old root and
  // strand the reader midway through a tall card. Land the bordered root atomically.
  //
  // But the scroll LOCK outlives this click: a dismissed drawer keeps its stack slot for the ~210ms
  // slide-out, so the body is still pinned and `window.scrollTo` would be clamped to a no-op — and the
  // unlock would then restore the pre-click offset over the top of it. Park the landing instead and let
  // the unlock apply it, which is also what makes the scroll land in ONE step rather than visibly
  // jumping back to where the reader was first.
  if (targetY !== null) {
    if (isPageScrollLocked()) requestScrollAfterUnlock(targetY)
    else if (Math.abs(window.scrollY - targetY) > 0.5) window.scrollTo({ top: targetY, left: 0, behavior: "auto" })
  }
  // And KEEP it there while the queue above is still settling, until the reader scrolls for themselves
  // (lib/queueLandingHold). A cold `/thread/<slug>` deep link lands before the cards above it have
  // their transcripts or pictures, and those then pushed the routed card ~1,400px out of view
  // (2026-10-05). Armed for every door, not only the deep link: a sidebar click into a queue whose
  // pictures are still decoding has the same race, just a smaller one.
  holdQueueCardLanding(() => queueCardRoot(slug), () => queueCardTargetY(slug))
  flashQueueCard(slug, root)
  return true
}

// Set by scrollToQueueCard as it dismisses the stack for a door, read once by the store→URL sync on the
// notification that carries that dismissal (lib/router startRouter). Taking it clears it, so a door
// that changed no URL (a markdown reader over the board) leaves nothing armed for the next plain close.
let queueCardNavigation = false

export function takeQueueCardNavigation(): boolean {
  const taken = queueCardNavigation
  queueCardNavigation = false
  return taken
}

// Pending ring teardowns, keyed by slug. A RE-CLICK inside the window must replay the ring and own the
// single removal; without this the first click's timer would cut the second ring short.
const queueFlashTimers = new Map<string, number>()

// The arrival ring. It goes on the bordered card ROOT, never the outer `[data-queue-card]` slot: the
// slot is the fade wrapper, not the bordered box — and while it still wrapped the inter-card hairline
// rule and its margins, ringing it drew the card AND ~80px of gutter plus that rule as one highlighted
// box (maintainer, 2026-07-21).
// An ATTRIBUTE rather than a class, because the root's className is REACT-OWNED (it flips on the card's
// `resolving` state) — a re-render rewrites className wholesale and would silently wipe an imperatively
// added class mid-flash. React never touches an attribute absent from its props.
function flashQueueCard(slug: string, root: HTMLElement): void {
  const pending = queueFlashTimers.get(slug)
  if (pending !== undefined) window.clearTimeout(pending)
  // Re-setting an attribute that is already present does NOT restart a CSS animation, so clicking the
  // same sidebar row twice would produce no visible response at all (the scroll is already at the
  // landing, and the caller deliberately doesn't fall through to a drawer). Drop it and force a reflow.
  root.removeAttribute("data-queue-flash")
  void root.offsetWidth
  root.setAttribute("data-queue-flash", "")
  queueFlashTimers.set(slug, window.setTimeout(() => {
    queueFlashTimers.delete(slug)
    root.removeAttribute("data-queue-flash")
  }, 1100))
}

// Open a `.md` file that lives on disk in Frizz's OWN reader, rather than handing the path to the
// desktop opener. Every link to one routes here (lib/local-file-links.ts): agent prose citing a repo
// doc, an inline-code path that resolved to one, an attached `.md`. `path` is the absolute POSIX path
// the server will re-gate; the basename is the header title. Queue drawers are deduped on path.
// On a phone EVERY file opens here, not only `.md` — the desktop opener would launch it on the machine
// Frizz runs on — and the drawer shows anything that is not markdown as source (MarkdownDrawer).
export function pushMarkdownDrawer(path: string): void {
  // On /full the reader is a SPLIT PANEL beside the thread, not a sheet over it — route every
  // markdown open there while that page is mounted, stacking links from the transcript AND reader.
  if (store.splitFileViewer) {
    openFilePanel(path)
    return
  }
  openOrRaiseDrawer({ kind: "markdown", slug: path, path, label: basename(path) })
}

// ── the /full split file viewer ──────────────────────────────────────────────────────────────────
let filePanelSeq = 0

export function openFilePanel(path: string): void {
  store.filePanels.push({ path, id: ++filePanelSeq })
}

export function closeFilePanel(): void {
  const top = store.filePanels.at(-1)
  // A closing layer still owns the top until its slide finishes, like the drawer stack.
  if (!top || top.closing) return
  top.closing = true
  const id = top.id
  window.setTimeout(() => {
    store.filePanels = store.filePanels.filter((panel) => panel.id !== id)
  }, prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
}

// ── selected-context items (⌘I in the file viewer) ───────────────────────────────────────────────
let contextSeq = 0

export function addContextItem(slug: string, item: Omit<ComposerContextItem, "id">): void {
  const items = store.composerContext[slug] ?? (store.composerContext[slug] = [])
  items.push({ ...item, id: ++contextSeq })
}

// There is no remove-by-id: an item leaves the roster when its `@` token leaves the draft prose
// (ThreadComposerBox's token sweep) — the token in the text is the only handle the human has on it.

// Take (and clear) a thread's staged items at send time. Returns plain copies so the caller can
// restore them on a rejected send — the proxy entries themselves are gone from the store by then.
export function takeContextItems(slug: string): ComposerContextItem[] {
  const items = (store.composerContext[slug] ?? []).map((item) => ({ ...item }))
  delete store.composerContext[slug]
  return items
}

export function restoreContextItems(slug: string, items: ComposerContextItem[]): void {
  if (!items.length) return
  // Never clobber items staged while the failed send was in flight — put the old ones first.
  store.composerContext[slug] = [...items, ...(store.composerContext[slug] ?? [])]
}

export function popDrawer(): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top) closeDrawersById([top.id])
}

export function topDrawer() {
  return store.drawers[store.drawers.length - 1]
}

// Mark a drawer-stack entry as animating-OUT the instant its slide begins, so the URL sync and
// topThreadSlug stop counting it BEFORE the ~210ms removal lands. Without this, a synchronous view
// change during the close window (e.g. browser-Back into a status list, or the palette's Queue
// action) would still see the present-but-closing layer and push a phantom /thread history entry.
export function markDrawerClosing(id: number): void {
  const d = store.drawers.find((x) => x.id === id)
  if (d) d.closing = true
}

// Exit timers are intentionally conditional. If the same logical drawer is reopened before its
// transition finishes, `openOrRaiseDrawer` clears closing and this old timer becomes a no-op.
export function removeDrawerAfterExit(id: number): void {
  const drawer = store.drawers.find((entry) => entry.id === id)
  if (drawer?.closing) store.drawers = store.drawers.filter((entry) => entry.id !== id)
}

// Unwind drawer-stack entries by id THROUGH their registered animated closers (the slide-out plays)
// instead of an instant `store.drawers = …` splice — the fix for "drawers animate in but not out"
// on the non-component close paths (router back/forward unwind, palette Queue). Any id whose drawer
// isn't mounted (no registered closer — e.g. at boot before components mount) is raw-filtered so the
// stack still settles correctly.
export function closeDrawersById(ids: number[]): void {
  const orphans: number[] = []
  for (const id of ids) if (!closeDrawerAnimated(id)) orphans.push(id)
  if (orphans.length) {
    const drop = new Set(orphans)
    store.drawers = store.drawers.filter((d) => !drop.has(d.id))
  }
}

// The slug of the topmost THREAD layer (for ⌘I, the URL, and other "current thread" consumers).
// Layers mid-close are skipped: they're sliding out and must not keep the URL pinned to /thread.
export function topThreadSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const d = store.drawers[i]
    if (d.kind === "thread" && !d.closing) return d.slug
  }
  return null
}

// THE DOOR. Every board that reaches the UI comes through one of these two functions, so this is where
// "is this even our project's board?" is asked — on the board's OWN evidence (the server stamps it with
// `projectSlug`), not on any client bookkeeping. Bookkeeping is what failed in `0fb8574`; a payload that
// names its own project cannot be talked into belonging here by a stale ref, a missed effect or a
// transport nobody re-pointed. See lib/projectOwnership.ts.
//
// Dropping is silent on purpose: the commonest way to arrive here foreign is a perfectly healthy race —
// a board read or a keyframe already on the wire when the operator switched projects — and a
// console warning per switch would be noise about the system working.

// A THREAD IS A VALUE IN THE STORE, NEVER A PROXY. valtio turns every object assigned into the store
// into a proxy, recursively, and every snapshot of the store into a frozen copy of each one. A thread
// is never edited in place — the server sends a whole new ThreadView for any change (delta.ts), and
// the doors below swap it in by slot — so tracking its fields bought nothing, and paid for every thread
// the project has ever finished: the startup seed and the keyframe each proxied every thread (182ms and
// 200ms of a CPU profile at 5,000), the first snapshot copied each one, and a delta's slot lookup walked
// them all. Measured with a seeded board, production bundle, three runs each (2026-10-14):
//
//                                          1,000 threads          5,000 threads
//   page load, keyframe task                125-127 → 61-64ms      540-558 → 285-308ms
//   page load, main thread                  453-477 → 329-339ms    1,274-1,324 → 740-797ms
//   heap after load                         31 → 19MB              113 → 52MB
//   streaming turn, task per board delta    6.6-8.5 → 3.3-3.7ms    18.4-19.9 → 6.3-7.4ms
//
// `ref` marks the object so valtio leaves it as it is: a thread is read as the plain object the server
// sent, and a snapshot holds that same object. The array holding them is replaced as a whole by every
// delta that touches it (plainArray, below), which is what notifies — on a project's board and on the
// Console's merged one alike (api/consoleFeed.ts).
//
// So NOTHING MAY WRITE INTO A THREAD ON THE BOARD. A write would reach no subscriber. Replace the slot.
export function plainThreads<T extends ThreadView>(threads: T[]): T[] {
  for (const t of threads) ref(t)
  return threads
}

// THE THREADS ARRAY IS A PLAIN VALUE TOO, replaced whole by every delta that touches a thread. As a
// valtio proxy it was the last thing on the board that scaled with history: replacing one slot made the
// next snapshot copy the whole array, defining one frozen property per thread (~2.1ms of every delta at
// 5,000 threads, CPU profile of a streaming turn, production bundle), and every tracking view over that
// frozen copy made proxy-compare copy it again (`needsToCopyTargetObject`, ~1.1ms more on a thread
// page). A plain array is shared by the snapshot as it is, so a delta costs one `slice` (copy-on-write,
// applyDelta below) and nothing per thread.
//
// What a reader sees is unchanged in kind. A snapshot still holds a value that never changes under it:
// the array an old snapshot holds is never written again. A tracking view (useSnapshot) still re-renders
// only for what it read: proxy-compare tracks a plain array like any object, and when the array is
// replaced it compares just the slots the render read — so a card that looked up its own thread with
// threadBySlug re-renders when THAT thread changes, as it did with the proxy (store.plainThreads.test.ts
// pins both). Threads read through it are tracked field by field now, which is finer, not coarser.
//
// valtio has no public way to keep an array out of the store unproxied but TRACKABLE — `ref` also marks
// it untrackable, which would re-render every card on every delta — so the board's arrays are named to
// its `canProxy` hook here. Only arrays passed to plainArray are affected; every other value proxies
// exactly as before.
//
// The Console's merged board (api/consoleFeed.ts) holds its threads the same way, through the same two
// doors: plainArray for an array it builds whole, threadsWithDelta for one project's delta.
const plainArrays = new WeakSet<object>()
unstable_replaceInternalFunction("canProxy", (canProxy) => (value) => !(typeof value === "object" && value !== null && plainArrays.has(value)) && canProxy(value))
export function plainArray<T>(threads: T[]): T[] {
  plainArrays.add(threads)
  return threads
}
/** Is this the board's plain threads array (exported for its test)? */
export function isPlainThreadArray(threads: unknown): boolean {
  return typeof threads === "object" && threads !== null && plainArrays.has(threads)
}

// A full board KEYFRAME arrives from SSE (React-free) — on connect and on resync. Just store it;
// every surface derives its own view of the thread list per render (there is no selection state to
// reconcile — the focus machine that needed one is gone).
// True when the board was taken, false when the door refused it.
export function setBoard(board: BoardSnapshot): boolean {
  // The Console's board is EVERY project's, merged by its own feed (api/consoleFeed.ts). One project's
  // board arriving through this door on the Console is a page connection that has not finished closing.
  if (isConsolePath() || !ownedByThisPage(board.projectSlug)) return false
  setGithubRepo(board.githubRepo)
  setLocalPathBase(board.projectDir, board.homeDir)
  plainArray(plainThreads(board.threads))
  store.board = board
  return true
}

/**
 * Forget everything that belonged to the project we are leaving.
 *
 * The rail switches projects WITHOUT a document load, which used to do this for free. Every field
 * here is per-project, and carrying any of it across is a visible bug rather than stale data: a
 * drawer would stay open over a board that has never heard of its thread, and the row above the
 * prompt box would name — and link to — the repo you just left.
 *
 * Machine-wide state (the settings/notification mirror, the control-plane status, whether the palette
 * is open) is deliberately NOT touched — none of it changes when the project does.
 */
export function resetProjectState() {
  setGithubRepo(null)
  setLocalPathBase(null)
  resetGithubCards()
  store.board = null
  store.view = "todos"
  store.connection = "connecting"
  store.drawers = []
  store.filePanels = []
  store.composerContext = {}
  store.routeThreadSlug = null
  store.socketTranscriptFallbacks = {}
  store.showSettings = false
  store.showNewThread = false
  store.showGithubPicker = false
  store.lightbox = null
}

// The slot of each thread on the live board, kept across deltas so an upsert is one lookup and not a
// walk of every thread (applyBoardDelta checks every entry it uses). Keyed on the threads array itself:
// a new board brings a new array, and with it an empty table that the first delta fills.
const boardPositions = new WeakMap<object, Map<string, number>>()
function positionsFor(threads: ThreadView[]): Map<string, number> {
  let positions = boardPositions.get(threads)
  if (!positions) boardPositions.set(threads, (positions = new Map()))
  return positions
}

// Apply a per-thread delta IN PLACE (upsert/remove threads, patch board-level meta) — valtio's
// fine-grained reactivity means only the changed rows re-render (the audit's S2 fix), vs. setBoard's
// wholesale replace. Returns false when there's no base board to apply onto (caller must resync).
export function applyDelta(delta: BoardDelta): boolean {
  // Consumed, not applied: the Console's merged board takes deltas only from its own feed, keyed.
  if (isConsolePath()) return true
  const board = store.board
  if (board === null) return false
  plainThreads(delta.upserts)
  const current = board.threads
  // A board that came through setBoard holds a plain array: the delta is applied to a COPY, which then
  // replaces it, so the array an earlier snapshot holds never changes (see plainArray). Its slot table
  // moves with it — a copy has the same slots. Any other board (one a test assigned directly) is a
  // valtio proxy and takes the delta in place, as every board once did.
  if (isPlainThreadArray(current) && (delta.upserts.length > 0 || delta.removed.length > 0)) {
    board.threads = threadsWithDelta(current, delta.upserts, delta.removed)
    if (delta.meta) applyBoardDelta(board, { upserts: [], removed: [], meta: delta.meta })
    return true
  }
  applyBoardDelta(board, delta, positionsFor(current))
  return true
}

/**
 * A threads array with a delta's upserts and removals applied, as a NEW plain array: `threads` itself is
 * never written, so a snapshot holding it keeps the board it saw. The slot table moves to the copy, which
 * has the same slots, so the next delta's lookups stay one each. Upserts must be plain already
 * (plainThreads). The project page's applyDelta and the Console's merged board both apply deltas here.
 */
export function threadsWithDelta(threads: ThreadView[], upserts: ThreadView[], removed: string[]): ThreadView[] {
  const positions = positionsFor(threads)
  const next = { threads: threads.slice() } as BoardSnapshot
  applyBoardDelta(next, { upserts, removed }, positions)
  boardPositions.delete(threads)
  boardPositions.set(next.threads, positions)
  return plainArray(next.threads)
}

// ONE LOOKUP TABLE PER BOARD STATE, so finding a thread does not cost a walk of every thread the project
// has ever finished. Keyed on the threads array a SNAPSHOT holds, which is never written and is replaced
// exactly when a thread changes (plainArray), so a table can never describe a board that has moved on; a
// WeakMap, so it goes with the snapshot it describes.
//
// A new array whose every slot holds the same id as the last one indexed shares that table rather than
// building its own. That is every delta that only replaces threads, which is nearly all of them: a delta
// replaces the threads array, and building 5,000 map entries for it was ~1ms of every delta (CPU
// profile, a streaming turn on a 5,000-thread board). Comparing the ids is a read per
// slot and no allocation; a slot added, removed or moved builds a table of its own.
const slugIndexes = new WeakMap<object, Map<string, number>>()
let lastIndexed: { threads: readonly ThreadView[]; index: Map<string, number> } | undefined
function slugIndex(threads: readonly ThreadView[]): Map<string, number> {
  let index = slugIndexes.get(threads)
  if (index) return index
  const last = lastIndexed?.threads
  if (last && last.length === threads.length) {
    let same = true
    for (let i = 0; i < threads.length; i++) {
      if (threads[i] !== last[i] && threads[i].id !== last[i].id) {
        same = false
        break
      }
    }
    if (same) index = lastIndexed!.index
  }
  if (!index) {
    index = new Map()
    for (let i = 0; i < threads.length; i++) index.set(threads[i].id, i)
  }
  slugIndexes.set(threads, index)
  lastIndexed = { threads, index }
  return index
}

/** The store's board as valtio's immutable snapshot: plain objects, replaced only along a path that
 *  changed. What the untracked readers in hooks.ts subscribe to. */
export function boardThreadsNow(): readonly ThreadView[] | undefined {
  return (snapshot(store).board?.threads as ThreadView[] | undefined) ?? undefined
}

/** A thread of the live board as a plain snapshot object, by table. */
export function threadSnapshotBySlug(slug: string | null | undefined): ThreadView | undefined {
  const threads = slug ? boardThreadsNow() : undefined
  if (!threads) return undefined
  const at = slugIndex(threads).get(slug!)
  return at === undefined ? undefined : threads[at]
}

export function threadBySlug(board: BoardSnapshot | null, slug: string | null): ThreadView | undefined {
  if (!board || !slug) return undefined
  // THE TABLE SAYS WHERE TO LOOK, AND THE BOARD IN HAND CONFIRMS IT. `find` reads `id` off every thread
  // ahead of the one it wants, each read through a proxy, and it is asked once per card per render —
  // by a transcript query's staleTime and its watchdog, by every send, and by each component of a card
  // that needs its own thread. On a board with 1,000 Done threads that was 7ms of a send's click handler
  // through the live board (CPU profile, production bundle, 2026-10-13), and through useBoard()'s
  // TRACKING view every one of those reads is also recorded, so a card that looked itself up subscribed
  // to the id of every thread ahead of it. One indexed read instead: the row at the table's position, kept
  // only if its id matches. A board the table does not describe (a tracked view of an older state, a
  // fixture's own board) fails that check and is searched as before, so the answer is never the table's
  // word alone — except on the live board, which the snapshot always describes exactly.
  const threads = boardThreadsNow()
  const at = threads ? slugIndex(threads).get(slug) : undefined
  if (at !== undefined) {
    const row = board.threads[at]
    if (row?.id === slug) return row
  } else if (board === store.board) return undefined
  return board.threads.find((t) => t.id === slug)
}
