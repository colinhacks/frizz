import { useEffect, useRef } from "react"
import { useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { closeGithubPicker, store, pushDrawer, resolveRoutedThread, topDrawer, topThreadSlug, showToast } from "./store.ts"
import { useBoard, useBoardIsEmpty } from "./hooks.ts"
import { closeDrawerAnimated } from "./lib/overlays.ts"
import { pageScrollY } from "./lib/pageScrollLock.ts"
import { captureReaderPin, readerPinDrift } from "./lib/readerPin.ts"
import { startRouter } from "./lib/router.ts"
import { CONSOLE_MIRROR, nextSidebarPresence, readSidebarMirror, writeSidebarMirror, type SidebarPresence } from "./lib/sidebarPresence.ts"
import { consoleFeedPending } from "./api/consoleFeed.ts"
import { isConsolePath, projectSlug } from "./lib/base-path.ts"
import { BOARD_PAIR_CLASS, WORKPANE_WIDTH_CLASS } from "./lib/boardColumns.ts"
import { CONSOLE_SIDEBAR_COLUMN_CLASS, ConsoleSidebar } from "./components/ConsoleSidebar.tsx"
import { SIDEBAR_COLUMN_CLASS, Sidebar } from "./components/Sidebar.tsx"
import { MobileBoard } from "./components/MobileBoard.tsx"
import { useIsMobile } from "./lib/mobile.ts"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { preloadThreadSurfaces } from "./components/lazySurfaces.tsx"
import { FirstTaskView } from "./components/FirstTaskView.tsx"
import { PaneLayout } from "./components/ThreadPane.tsx"
import { setPaneFolded } from "./lib/threadPane.ts"
import { NewThreadDialog } from "./components/NewThreadModal.tsx"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { useGithubStatus } from "./components/GithubTrigger.tsx"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { StatusListView } from "./components/StatusListView.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary.tsx"
import { PageFrame } from "./components/PageFrame.tsx"
import { FrizzLoader } from "./components/FrizzLoader.tsx"

// The not-signed-in hint fires at most once per page load. A module-scoped flag (not React state)
// keeps it from re-firing across re-renders, effect re-runs, or a StrictMode double-invoke.
let signInHintShown = false
function maybeShowSignInHint() {
  if (signInHintShown) return
  signInHintShown = true
  showToast("Frizz isn't signed in to GitHub, so PR and issue watchers are off. Sign in from the GitHub button by the prompt box.", { duration: 6000 })
}

export function App() {
  const snap = useSnapshot(store)
  // THE CONSOLE is this same board shell over every project's threads (routes.tsx ConsoleRoute): its own
  // sidebar and its own feed (each project's board read and merged by api/consoleFeed.ts). A project page's
  // board is read by api/socket.ts as the page loads.
  const onConsole = isConsolePath()
  const sidebarPresence = useRef<SidebarPresence>({ projectDir: null, hasBeenVisible: false })

  // STORE → URL (opening a drawer writes the address bar). The other direction is the route tree's —
  // see routes.tsx useRouteToStore. Navigation goes through the router so its history stack and its
  // rendered match stay the same thing.
  const navigate = useNavigate()
  useEffect(() => startRouter((path, options) => navigate(path, options)), [navigate])

  // While ANY overlay is open (thread sheet, doc drawer, settings, new-thread modal, palette), the
  // PAGE must not scroll — only the overlay's own pane does.
  const overlayOpen = snap.drawers.length > 0 || snap.showSettings || snap.showNewThread || snap.showGithubPicker || snap.showPalette
  useEffect(() => {
    // Scroll lock via the body-fixed dance, NOT overflow:hidden on the root — hiding root overflow
    // dropped the scrollbar (and with it the layout width) every time a drawer opened. With the
    // track permanently reserved (html overflow-y: scroll) and the body pinned at its scroll
    // offset, locking is pixel-invisible; unlocking restores the exact scroll position.
    if (!overlayOpen) return
    const y = window.scrollY
    const body = document.body
    // The phone row the reader was in as the overlay opened. Nothing anchors a pinned page, so whatever
    // arrives, grows or leaves above it meanwhile would otherwise hand the reader a different row on the
    // way back (lib/readerPin).
    const reader = captureReaderPin()
    body.style.position = "fixed"
    body.style.top = `-${y}px`
    body.style.left = "0"
    body.style.right = "0"
    body.style.width = "100%"
    return () => {
      // Read while still pinned: the body's offset (moved by shiftLockedPage if the list held the reader
      // through a change), and how far the reader's row has drifted beyond that.
      const held = pageScrollY() + (reader ? readerPinDrift(reader) : 0)
      body.style.position = ""
      body.style.top = ""
      body.style.left = ""
      body.style.right = ""
      body.style.width = ""
      window.scrollTo(0, Math.max(0, held))
    }
  }, [overlayOpen])

  // GitHub availability drives two things: the picker TRIGGER (in the sidebar / brand-new view, gated
  // in GithubTrigger off this same cached query) and — when the repo IS a GitHub repo but gh is NOT
  // signed in — ONE subtle, self-fading hint on app open pointing at that trigger, which opens the sign-in. The hint
  // fires at most once per page load (a module flag survives re-renders / StrictMode double-invoke),
  // stays a beat longer than a normal toast so it's readable, and never nags again.
  const github = useGithubStatus()
  useEffect(() => {
    if (github.data?.inRepo && !github.data.authed) maybeShowSignInHint()
  }, [github.data?.inRepo, github.data?.authed])

  // THE KEYBOARD MODEL (post-machine): the sidebar is mouse-driven and text surfaces own their own
  // keys, so the app-level keyboard reduces to global chords + Esc unwinding:
  //   ⌘K palette (its "New thread" item opens the modal) · ⌘I frizz-doc drawer for the topmost thread
  //   NOTE: no ⌘N binding. ⌘N is the BROWSER's new-window shortcut — reserved, and ours to leave
  //   alone. Hijacking it either loses to the browser outright (a plain tab never delivers the event)
  //   or, in a standalone/PWA window, steals a system shortcut the user expects. New-thread keeps
  //   three doors that cost us nothing: ⌘K → "New thread", the sidebar pill, and the visible composer.
  //   Esc — overlays first (palette/modal/settings), then the drawer stack topmost-first. That chain
  //   belongs to <DrawerStack> (the standalone /full page needs the identical unwinding), so only the
  //   chords are handled here.
  //   ⌘/Ctrl-Enter submits in a composer; every other Enter newlines (Composer's own handler)
  // (The xstate focus machine — nav selection, arrow-walk, chevron, step-in/out, focus registry — was
  // DELETED when the sidebar went mouse-only: the queue is always visible, clicking a row opens its
  // drawer, and a composer's Esc simply blurs it. No virtual focus, no zombie states.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === "k") {
        e.preventDefault()
        store.showPalette = !store.showPalette
      } else if (key === "i") {
        // ⌘I: frizz document for the topmost open thread (stacks another layer / pops its own).
        const top = topDrawer()
        const target = topThreadSlug()
        if (top?.kind === "doc") {
          e.preventDefault()
          if (!closeDrawerAnimated(top.id)) store.drawers.pop()
        } else if (target) {
          e.preventDefault()
          pushDrawer("doc", target)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const board = useBoard()
  // The phone gets its own shell. Everything BELOW the layout — the drawer stack, the modals, the
  // restart overlay — is shared, so only the standing surfaces branch (see the return below).
  const isMobile = useIsMobile()

  // Settle a parked `?thread=<slug>` URL. It waits for the board, which says whether the thread exists in
  // this project and so whether the pane can show it. (resolveRoutedThread no-ops unless there is a parked
  // slug AND a board.)
  useEffect(() => { resolveRoutedThread() }, [board, snap.routeThreadSlug])
  // The board has painted: fetch the thread surfaces while the browser is idle (components/lazySurfaces).
  useEffect(() => { if (board) preloadThreadSurfaces() }, [board])

  const boardEmpty = useBoardIsEmpty()
  // THE CONSOLE TAKES THE SAME RULE: a machine that has never run a thread gets the centred prompt box, not
  // a sidebar beside an empty inbox (maintainer 2026-11-10: "If there are no threads in the project at all,
  // then it should be showing the sort of centered alignment … This is on the All Projects page"). Its
  // sidebar was always up until then, because it held the Console's only prompt box. The merged board is
  // shown once every project has answered or a deadline passes (api/consoleFeed.ts), so an empty one with a
  // project still on its way decides nothing: the last answer stands until that project arrives.
  const mirrorKey = onConsole ? CONSOLE_MIRROR : projectSlug()
  if (sidebarPresence.current.projectDir === null && onConsole) sidebarPresence.current = { projectDir: null, hasBeenVisible: readSidebarMirror(mirrorKey) }
  const undecided = onConsole && boardEmpty && consoleFeedPending()
  sidebarPresence.current = nextSidebarPresence(sidebarPresence.current, board && !undecided ? { projectDir: board.projectDir, threadCount: boardEmpty ? 0 : 1 } : null)
  const showSidebar = board !== null && sidebarPresence.current.hasBeenVisible
  // Before the first board lands, hold the sidebar's column open if this board had one last time — the
  // workpane then renders in its final place on the first frame instead of centering alone and jumping
  // when the sidebar mounts. Written back on every board so the mirror tracks the answer.
  const reserveSidebar = board === null && readSidebarMirror(mirrorKey)
  const hasBeenVisible = sidebarPresence.current.hasBeenVisible
  useEffect(() => {
    if (board !== null && !undecided) writeSidebarMirror(mirrorKey, hasBeenVisible)
  }, [board, hasBeenVisible, mirrorKey, undecided])
  // Window title carries the project identity. In the INSTALLED APP window (display-mode:
  // standalone) Chrome prefixes the title bar with the app name itself ("Frizz - <title>"), so the
  // page title must NOT repeat the wordmark — just the repo label ("Frizz - nubjs/nub"). In an
  // ordinary browser tab there's no prefix, so the title carries it as a trailing mark
  // ("nubjs/nub — Frizz") — the repo LEADS because a tab truncates from the end, and it is the repo
  // that tells two open boards apart. StandaloneThreadPage uses the same trailing mark.
  const projectLabel = board?.projectLabel ?? board?.projectName
  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    document.title = standalone ? (projectLabel ?? "Frizz") : projectLabel ? `${projectLabel} — Frizz` : "Frizz"
  }, [projectLabel])

  // NOTE: there is deliberately NO "this repo has no .frizz/" branch here. Threads are session-first
  // (the registry in ui.db IS the board); `.frizz/` only holds thread scratch dirs, and dispatch
  // creates it on the way (writeScratchDir → ensureSafeDirectDirectory). Gating the shell on it
  // inverted the fresh-repo experience: a repo with an EMPTY `.frizz/` got the real first-run view,
  // while a repo without one got a dead end that said "dispatch a first thread" with no composer to
  // do it in. A `.frizz`-less repo is simply a board with zero threads — FirstTaskView renders exactly
  // the right thing for it (centered prompt box, sidebar hidden).
  return (
    // THE FRAME, not a bare root: following the supervisor (the restart overlay, this subtree going
    // inert under it, the reload onto a new build) and mirroring the notifications setting are what a
    // tab does on EVERY page, so they are components/PageFrame.tsx's and the full-screen thread page
    // stands in the same one. They were this file's alone until 2026-10-13, and that page had neither.
    <PageFrame
      className="relative min-h-screen bg-bg text-fg text-sm"
    >
      {/* NO FIXED CHROME IN EITHER TOP CORNER. Identity, settings, reload and both quota chips used to
          be a bar pinned to the upper-left, a screen's width from the column they describe; they are
          the StatusRow along the top of the prompt box now (Sidebar.tsx, and FirstTaskView's centered
          first-task box on a brand-new project). Everything flows; the PAGE is the one and only scroll
          container — a tall card simply runs off both edges. On a phone none of it renders at all: the
          project and the way to settings are already in the mobile nav bar. */}
      {/* (The old fixed "New thread" pill moved INTO the sidebar's top — one entry point, same modal
          flow; the ⌘K palette's "New thread" item and the always-visible dispatch box are the
          other doors — deliberately NOT ⌘N, which belongs to the browser.) */}

      {isMobile ? (
        <MobileBoard />
      ) : (
        <>
      {/* CENTERED PAIR with a SCALING GUTTER: the floating sidebar column and the workpane sit side by
          side ("space-around looked weird" — a deliberate gutter reads calmer), and the PAIR as a unit
          centers horizontally — leftover space distributes on the far sides. The sidebar is VERTICALLY
          CENTERED in the viewport (sticky, set in Sidebar.tsx) and scales clamp(272px → 34vw → 680px)
          so titles get real room on large screens; the workpane keeps its readable 720px measure
          (shrinking first when space runs out) and scrolls as normal top-anchored page flow.
          TABLET BAND (801px–~1170px) — the pair used to be WIDER than the viewport there, so both
          outer edges sat FLUSH against it while a 52px gutter ate the middle (maintainer 2026-08-01:
          "we should never have it so the left and right edges are flush against the viewport", and
          "reduce the gap between the sidebar and the Queue on smaller screens"). Two things keep that
          from recurring, both CONTINUOUS so nothing jumps at a breakpoint:
            · px-5 on the container at EVERY width — the pair centers inside the padded box and the
              workpane (min-w-0) shrinks into it, so a side margin can never reach 0. Above ~1170px
              there is leftover space anyway and the padding stops binding.
            · the gutter scales clamp(28px → 3.4vw → 52px): ~28px where space is scarce, back to the
              tuned 52px by ~1530px, where the pair has margins to spare. Wide layouts are unchanged.
          The classes are lib/boardColumns.ts's. */}
      {/* THE ONE-THREAD PANE, on every board that has had a thread, read as the sidebar reads it
          (lib/sidebarPresence): an empty keyframe while the live stream reconnects or catches up must not
          unmount the pane and the thread open in it. A brand-new project keeps its centered first-task
          view below. */}
      {board && snap.view === "todos" && hasBeenVisible ? (
        <PaneLayout sidebar={<ErrorBoundary label="the sidebar">{onConsole ? <ConsoleSidebar /> : <Sidebar />}</ErrorBoundary>} />
      ) : (
      <div className={`${BOARD_PAIR_CLASS} min-h-screen`}>
        {/* A genuinely fresh project keeps its centered first-task view. Once this project has had a
            Frizz-owned thread, the sidebar remains mounted through transient empty keyframes;
            navigation must not vanish while the live board stream reconnects or catches up. */}
        {/* Each of the three standing surfaces catches its OWN render errors (see ErrorBoundary.tsx):
            a bad row in the sidebar must not take the workpane with it, and vice versa. */}
        {showSidebar && (
          <ErrorBoundary label="the sidebar">
            {onConsole ? <ConsoleSidebar /> : <Sidebar />}
          </ErrorBoundary>
        )}
        {reserveSidebar && <aside aria-hidden className={onConsole ? CONSOLE_SIDEBAR_COLUMN_CLASS : SIDEBAR_COLUMN_CLASS} data-sidebar-reserved />}
        <main
          id="workpane"
          // min-h-screen where content is vertically CENTERED: the first-task prompt box (FirstTaskView's
          // auto margins need a full-height parent). Before the board it holds the page at the height the
          // board will give it. Threads render in the pane or in DRAWERS, never here.
          className={`${WORKPANE_WIDTH_CLASS} flex flex-col py-5 ${
            snap.view === "todos" || !board ? "min-h-screen" : ""
          } ${
            // Status lists (URL-only views) draw in a panel; the first-task box stands on the page.
            snap.view === "todos" ? "" : "rounded-lg border border-border bg-panel"
          }`}
        >
          {/* Only board !== null renders real views: before it, the loader below — NEVER a view's empty
              state, which would flash "Nothing pending" on every hard reload. */}
          {board && (
            <ErrorBoundary label="the workpane" resetKeys={[snap.view]}>
              {snap.view.startsWith("status:") && <StatusListView status={snap.view.slice(7)} />}
              {snap.view === "todos" && <FirstTaskView onConsole={onConsole} />}
            </ErrorBoundary>
          )}
        </main>
      </div>
      )}
      {/* Until the first board snapshot lands, the mark writing itself (FrizzLoader), centred on the
          PAGE — the box beside the project rail, one window tall — not on the workpane. It sat in the
          workpane until 2026-11-02, and a reload with the sidebar column reserved put it 269px right of
          centre at 1440px (187px at 1000px), and 64px low where the pair stacks, under the reserved
          column's top padding. */}
      {!board && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-screen items-center justify-center">
          <FrizzLoader label="Loading project" />
        </div>
      )}
        </>
      )}

      {/* The side-drawer STACK — and the Escape chain that unwinds it — lives in <DrawerStack> so the
          standalone `/thread/<slug>` page can mount the identical thing. See DrawerStack.tsx. */}
      <DrawerStack onEscapeAtRest={() => { if (store.paneSlug) setPaneFolded(false) }} />
      {snap.showSettings && <SettingsDrawer offerUpdate />}
      {snap.showNewThread && <NewThreadDialog onClose={() => { store.showNewThread = false }} />}
      {snap.showGithubPicker && <GithubPickerModal onClose={closeGithubPicker} />}
      <CommandPalette />
    </PageFrame>
  )
}
