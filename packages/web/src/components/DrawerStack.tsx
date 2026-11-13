import { useEffect, useRef } from "react"
import { useSnapshot } from "valtio"
import { closeFilePanel, closeGithubPicker, store, threadBySlug } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { displayTitle } from "../groups.ts"
import { closeDrawerAnimated, closeSettingsAnimated } from "../lib/overlays.ts"
import { dismissOpenSelect } from "../lib/selectOverlay.ts"
import { ThreadSheet } from "./ThreadSheet.tsx"
import { BackgroundShellSheet, MarkdownDrawer, MonitorSheet, SubAgentSheet, ThreadDrawer, TimerSheet } from "./lazySurfaces.tsx"
import { ErrorBoundary, DrawerErrorSheet } from "./ErrorBoundary.tsx"
import { ProjectScope } from "../lib/projectScope.tsx"
import { keyProject } from "../lib/threadKey.ts"

// The side-drawer STACK, and the Escape chain that unwinds it. Lives in its own component because
// BOTH page shells need it: the queue (App) and the standalone `/thread/<slug>` page. It used to
// be inlined in App, which made every drawer affordance a DEAD CLICK on /full — the sub-agent rows,
// the background-shell rows and the frizz-doc button all pushed a layer onto `store.drawers` that
// nothing was mounted to render.
//
// Two DIFFERENT depths: `depth` = the layer's true stack position (array index) drives z-index — it must
// stay strictly monotonic so a layer always paints above everything below it, including the ~210ms window
// while a lower layer slides OUT. `widthDepth` = the count of layers below that are STAYING (non-closing)
// drives the width/inset (each step 28px narrower). A closing layer keeps its array slot for its
// slide-out, so counting it toward WIDTH made the layer above open one step too narrow, then JUMP wider
// (content reflow) the instant the closer was removed; excluding it lets the new layer render at its
// FINAL width and slide in from off-screen with no end-of-animation reflow. z and width are decoupled
// because ThreadSheet alone is portaled + split-z (overlay/content) while the others are single-z inline
// — tying z to the non-closing count let a closing ThreadSheet outrank a drawer opened above it.
//
// `onEscapeAtRest` is the chain's LAST step, for a shell whose page itself is something Escape can
// leave: /full passes "exit fullscreen". It runs only when no layer above took the key.
export function DrawerStack({ onEscapeAtRest }: { onEscapeAtRest?: () => void } = {}) {
  const snap = useSnapshot(store)
  const board = useBoard()
  const onEscapeAtRestRef = useRef(onEscapeAtRest)
  onEscapeAtRestRef.current = onEscapeAtRest

  // Esc unwinding, for whichever shell mounted us. Exactly ONE of these is ever live per page, so the
  // whole overlay precedence chain lives here rather than being split across two window listeners that
  // would both fire on the same physical Escape. (App keeps the ⌘K/⌘I chords; those are its own.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      // Portaled selectors are not descendants of their owning dialog/drawer. Give the topmost
      // model/effort matrix or Select this physical Escape before unwinding the app overlay stack.
      if (dismissOpenSelect()) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return
      }
      // Overlays soak up Esc first (outermost wins). A focused composer handles its own Esc (blur)
      // and stops propagation — except /full's own, which lets it through to the steps below — so
      // reaching here otherwise means the page is at rest. Settings + the
      // open-thread sheet route through their OWN animated close (fall back to the store write if
      // nothing registered) so Esc slides them out instead of unmounting instantly.
      if (store.showPalette) store.showPalette = false
      else if (store.showNewThread) store.showNewThread = false
      else if (store.showGithubPicker) closeGithubPicker()
      else if (store.showSettings) { if (!closeSettingsAnimated()) store.showSettings = false }
      // The drawer STACK unwinds topmost-first, one layer per Esc.
      else if (store.drawers.length > 0) {
        const top = store.drawers[store.drawers.length - 1]
        if (!closeDrawerAnimated(top.id)) store.drawers.pop()
      }
      // The /full page's split file viewer sits UNDER any drawer (it is part of the page, not an
      // overlay), so it unwinds last. A no-op on the queue page, where filePanels is empty.
      else if (store.filePanels.length > 0) closeFilePanel()
      // Nothing is open over the page, so the page itself goes (maintainer 2026-10-01: "hitting the
      // escape key should always minimize a session that's in full screen view" — and the layers above
      // still come first: "respect the hierarchy"). A Radix popover, menu or dialog that dismissed on
      // this same press marked it defaultPrevented at document capture, before this bubble listener;
      // an IME's Escape cancels the composition, not the page.
      else if (!e.defaultPrevented && !e.isComposing) onEscapeAtRestRef.current?.()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  let below = 0
  return (
    <>
      {snap.drawers.map((d, i) => {
        const widthDepth = below
        if (!d.closing) below++
        const layer = d.kind === "thread" ? (
          <ThreadSheet key={d.id} id={d.id} slug={d.slug} depth={i} widthDepth={widthDepth} initiallyOpen={d.routed} />
        ) : d.kind === "subagent" ? (
          <SubAgentSheet
            key={d.id}
            id={d.id}
            slug={d.slug}
            subId={d.subId ?? ""}
            label={d.label ?? d.slug}
            subagentType={d.subagentType}
            startedAt={d.startedAt}
            depth={i}
            widthDepth={widthDepth}
          />
        ) : d.kind === "shell" ? (
          <BackgroundShellSheet
            key={d.id}
            id={d.id}
            slug={d.slug}
            shellId={d.subId ?? ""}
            label={d.label ?? "Background shell"}
            startedAt={d.startedAt}
            depth={i}
            widthDepth={widthDepth}
          />
        ) : d.kind === "monitor" ? (
          <MonitorSheet
            key={d.id}
            id={d.id}
            slug={d.slug}
            monitorId={d.subId ?? ""}
            label={d.label ?? "Monitor"}
            depth={i}
            widthDepth={widthDepth}
          />
        ) : d.kind === "timer" ? (
          <TimerSheet
            key={d.id}
            id={d.id}
            slug={d.slug}
            timerId={d.subId ?? ""}
            label={d.label ?? "Timer"}
            depth={i}
            widthDepth={widthDepth}
          />
        ) : d.kind === "markdown" ? (
          <MarkdownDrawer key={d.id} id={d.id} path={d.path ?? d.slug} title={d.label ?? d.slug} depth={i} widthDepth={widthDepth} />
        ) : (
          <ThreadDrawer
            key={d.id}
            id={d.id}
            slug={d.slug}
            depth={i}
            widthDepth={widthDepth}
            title={(() => { const t = threadBySlug(board, d.slug); return t ? displayTitle(t) : d.slug })()}
          />
        )
        // A drawer that throws while rendering used to blank the whole window — the board it was
        // opened FROM included. Now the failure stays inside its own layer: the fallback re-mounts
        // the same Sheet geometry, so it still slides in, still closes, and still leaves everything
        // underneath it alive. Reset on the layer's identity so re-opening it is a real retry.
        return (
          <ErrorBoundary
            key={d.id}
            label="this drawer"
            resetKeys={[d.kind, d.slug, d.subId, d.path]}
            fallback={(error, retry) => (
              <DrawerErrorSheet id={d.id} depth={i} widthDepth={widthDepth} error={error} onRetry={retry} />
            )}
          >
            {/* A Console drawer belongs to its thread's project (lib/projectScope.tsx); a file drawer
                is named by its path, not a key, and asks by path (lib/consoleProjects.ts fileRpc). */}
            <ProjectScope project={d.kind === "markdown" ? undefined : keyProject(d.slug)}>{layer}</ProjectScope>
          </ErrorBoundary>
        )
      })}
    </>
  )
}
