import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { showToast, store } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import {
  frizzBuildIdentity,
  IDLE_RESTART_HOLD,
  nextControlPlane,
  nextRestartHold,
  readyBelieved,
  RELOAD_AFTER_UPDATE_RESTART,
  restartFailureCopy,
  restartFailureOutcome,
  shouldReloadForNewBuild,
  UPDATE_RESTART_FROM_VERSION,
  type RestartHold,
} from "../api/restart.ts"
import { formatCompactElapsed } from "../lib/durationLabels.ts"
import { RestartOverlay } from "./RestartOverlay.tsx"
import type { BootView } from "@frizz/shared"

// THE FRAME BOTH PAGE SHELLS STAND IN: what a tab does about the SERVER it is talking to, whichever
// page it is showing. The app has two shells — the board (App.tsx, the Console included) and the
// full-screen thread page (StandaloneThreadPage.tsx), which sits outside the board's layout — and all
// of this lived in App.tsx alone until 2026-10-13. So a tab on `/thread/<slug>/full` did not follow a
// restart: no overlay while the server was down, and after "Update & restart" it kept running the old
// bundle against the new server, because the reload onto a new build was the board's. Cold-loaded
// there it also never raised a desktop notification, because the setting those are gated on was
// mirrored onto the store by the board and by nothing else.
//
// Both shells render THROUGH this component now: it is their root element, so neither can have the
// overlay without going inert under it and deaf to Escape, or follow the supervisor without mirroring
// the setting.
// PageFrame.guard.test.ts fails when the overlay is mounted, or the mirror written, anywhere else, and
// pageFrame.e2e.test.ts drives both shells through a restart on a real stack. Something a tab owes the
// server on every page belongs here. (The all-projects grid is not one of the two and has never
// followed a restart.)
export function PageFrame({ className, style, children }: { className: string; style?: CSSProperties; children: ReactNode }) {
  const { restarting, message, hold, progress } = useControlPlane()
  // The overlay BLOCKS until the hold stalls; past that it is a notice over a page that is interactive
  // again (RestartOverlay.tsx).
  const blocking = restarting && !hold.stalled
  useEscapeSwallowed(blocking)
  useNotificationsMirror()
  return (
    <>
      <RestartOverlay
        open={restarting}
        message={message}
        stalled={hold.stalled}
        silentFor={hold.silentSince === null ? undefined : formatCompactElapsed(hold.silentForMs)}
        progress={progress}
      />
      {/* While restarting, the whole page subtree goes inert so nothing behind the scrim is focusable or
          clickable; the overlay above is a sibling OUTSIDE it so it stays interactive. Once the hold has
          stalled the overlay stops blocking, and so does this. The overlay is `fixed`, and a sibling of
          the page's root is also clear of anything inside the page that is transformed (the full-screen
          page's sliding row would otherwise be its containing block). */}
      <div inert={blocking} className={className} style={style}>
        {children}
      </div>
    </>
  )
}

function useControlPlane(): { restarting: boolean; message: string | null; hold: RestartHold; progress: BootView | undefined } {
  const snap = useSnapshot(store)
  // The public supervisor survives replacement of the app child. It is consequently the only
  // trustworthy transition signal: an old child can still say ready while the next artifact builds.
  // The READ is shared — api/supervisorStatus.ts owns the one poll (gentle at rest, prompt across a
  // handoff) that this frame, the Restart Frizz button and the dev-build probe all observe; this effect
  // is only what the PAGE does with each answer. Writes are gated in rpc.ts but drafts remain
  // session-backed and editable throughout.
  const { data: supervisorStatus, dataUpdatedAt: supervisorAnsweredAt } = useSupervisorStatus()
  const announcedFailure = useRef<string | null>(null)
  // The hold's clock (finding 1, audit 2026-09-11): how long the supervisor has been silent while the
  // page shows "restarting", and whether that has run past the deadline. Stepped once per poll by the
  // pure reducer in api/restart.ts; a null answer used to be ignored here outright, which is how a
  // successor that never came up left every tab behind the blocking overlay forever.
  const [hold, setHold] = useState<RestartHold>(IDLE_RESTART_HOLD)
  // The build this page was served by (finding 8): the first identity any answer named. A later READY
  // answer naming a different one means a new server is up under an old bundle — reload, whichever
  // tab clicked. Cleared by the reload itself, since the next page captures the new identity first.
  const seenBuild = useRef<string | null>(null)
  const reloading = useRef(false)
  useEffect(() => {
    const status = supervisorStatus
    if (status) {
      // An optimistic, user-initiated restart raised the overlay before the supervisor confirmed the
      // transition. HOLD it until a poll actually OBSERVES a server-confirmed non-"ready" status: a
      // "ready" read while pending is either the pre-flip state or a stale in-flight response, and
      // applying it would drop the overlay and (with a destination armed) reload onto the old child.
      // And not just any non-"ready": one whose request STARTED after the supervisor acked the POST.
      // A "failed" that was already in flight at the click — real, because the board offers retry
      // from "failed" — used to clear the guard for the new attempt, after which the launcher's
      // deliberate "ready" (`preparing`) reloaded the tab onto the old bundle (pullfrog on #35,
      // 2026-09-11). The verdict is the pure reducer's; this effect only applies it.
      const plane = nextControlPlane({ state: store.controlPlaneState, message: store.controlPlaneMessage, attempt: store.controlPlaneRestartAttempt }, status)
      store.controlPlaneState = plane.state
      store.controlPlaneMessage = plane.message
      store.controlPlaneRestartAttempt = plane.attempt
      if (seenBuild.current === null) seenBuild.current = frizzBuildIdentity(status)
    }
    // Step the hold on EVERY answer, null included — the null ones are the whole point. `restarting`
    // is what the page shows after applying this poll, so silence only ever accrues under the overlay.
    setHold((prev) => nextRestartHold(prev, { restarting: store.controlPlaneState === "restarting", answered: status != null, at: Date.now() }))
    if (!status || reloading.current) return
    const destination = sessionStorage.getItem(RELOAD_AFTER_UPDATE_RESTART)
    if (readyBelieved({ state: store.controlPlaneState, message: store.controlPlaneMessage, attempt: store.controlPlaneRestartAttempt }, status)) {
      if (destination) {
        sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
        sessionStorage.removeItem(UPDATE_RESTART_FROM_VERSION)
        reloading.current = true
        window.location.replace(destination)
        return
      }
      // Every OTHER tab: no destination was armed here, but the server answering is not the one that
      // served this bundle. `reload()` rather than `replace(href)`, which is a same-document jump when
      // the URL carries a fragment and would load nothing.
      if (shouldReloadForNewBuild(seenBuild.current, status)) {
        reloading.current = true
        window.location.reload()
        return
      }
    }
    if (status.state === "failed" && destination) {
      const fromVersion = sessionStorage.getItem(UPDATE_RESTART_FROM_VERSION) ?? undefined
      sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
      sessionStorage.removeItem(UPDATE_RESTART_FROM_VERSION)
      if (announcedFailure.current !== status.message) {
        // Announce the failure, never its REASON: the supervisor's message is raw build output —
        // a `nub run typecheck` failure arrives as several hundred characters of absolute
        // snapshot paths — and pasting that into a toast stretched a strip across the entire
        // viewport, four lines deep, saying the same thing the failure panel beside the reload
        // button was already showing properly. The panel owns the detail; this owns the attention.
        // Which failure it was (the old version giving up, or the new one failing to start) is judged
        // by the version the failed answer names against the one at click — finding 11.
        announcedFailure.current = status.message ?? "Update & Restart failed"
        showToast(`Update & Restart failed — ${restartFailureCopy(restartFailureOutcome(fromVersion, status)).summary}`, { duration: 7000 })
      }
    }
    // `supervisorAnsweredAt`, not the status alone: react-query's structural sharing hands back the SAME
    // object when a poll's answer is unchanged, and this body has to run on EVERY answer the way the
    // interval loop it replaces did — the reload destination is armed between two reads, so a run keyed
    // on the status object could miss it.
  }, [supervisorStatus, supervisorAnsweredAt])
  // The checklist the launcher reports while a server boots (api/restart.ts `progress`). Only a
  // "restarting" answer's: an update's "prepare" view rides on "ready" and belongs to the update button.
  const progress = supervisorStatus?.state === "restarting" ? supervisorStatus.progress : undefined
  return { restarting: snap.controlPlaneState === "restarting", message: snap.controlPlaneMessage, hold, progress }
}

// ESCAPE DOES NOTHING UNDER THE BLOCK. `inert` keeps focus and the pointer out of the page, but the
// Escape chain is not in the page: DrawerStack unwinds from a `window` listener and Radix dismisses its
// layers from one on the document, and neither asks whether the page under them is inert. So with the
// overlay up, Escape still closed a drawer behind the scrim on the board, and on the full-screen page it
// left the page altogether, since the chain's last step there is "exit fullscreen" (seen 2026-10-13:
// the tab went from `/thread/<slug>/full` to the board under the overlay). CAPTURE on `window` is the
// first stop a key makes, ahead of Radix's document-capture listener and DrawerStack's bubble one, so
// stopping it here stops every one of them. Installed only while the overlay BLOCKS: once the hold has
// stalled the page is interactive again, and Escape has to close its drawers and leave full screen.
// (The other keys the block swallows are RestartOverlay's own guard; this one is here because it is
// about the page's layers, which are the frame's to protect on both shells.)
function useEscapeSwallowed(blocking: boolean): void {
  useEffect(() => {
    if (!blocking) return
    const swallow = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener("keydown", swallow, { capture: true })
    return () => window.removeEventListener("keydown", swallow, { capture: true })
  }, [blocking])
}

// Mirror settings.notifications onto the store so the (React-free) SSE handler can gate desktop
// notifications. Refetched whenever the settings query is invalidated (e.g. after a save). Two tabs
// that both mirror it both raise a thread's notification, under one `tag`, so the browser shows one.
function useNotificationsMirror(): void {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  useEffect(() => {
    store.notificationsEnabled = settings.data?.notifications ?? false
  }, [settings.data?.notifications])
}
