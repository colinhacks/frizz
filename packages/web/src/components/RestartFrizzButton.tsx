import React, { useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import {
  canRestart,
  canUpdateRestart,
  FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT,
  RELOAD_AFTER_UPDATE_RESTART,
  requestFrizzRestart,
  requestFrizzUpdateRestart,
  restartFailureCopy,
  restartFailureOutcome,
  UPDATE_RESTART_FROM_VERSION,
  type RestartFailureOutcome,
  frizzBuildIdentity,
} from "../api/restart.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import { showToast, store } from "../store.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"

// RefreshCw's arrowheads advance clockwise, matching Tailwind's clockwise animate-spin keyframes.
// Keep this exported contract covered by the focused component test when either icon or animation changes.
export const UPDATE_RESTART_ICON_ROTATION = "clockwise"

/**
 * The update stays actionable for every newer package, but the passive badge is reserved for a new
 * release line: 0.12.x -> 0.13.0, or 1.x -> 2.0.0. Unknown versions fail quiet rather than turning
 * the status-row accent into a permanent generic update light.
 */
export function isBadgeRelease(currentVersion: string | undefined, updateVersion: string | undefined): boolean {
  const releaseLine = (value: string | undefined): [major: number, minor: number] | null => {
    const match = value && /^v?(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value)
    return match ? [Number(match[1]), Number(match[2])] : null
  }
  const current = releaseLine(currentVersion)
  const update = releaseLine(updateVersion)
  return current !== null && update !== null && (current[0] !== update[0] || current[1] !== update[1])
}

// The generic spelling, kept for the launchers that cannot name versions: frizz-dev (an update
// rebuilds from source, so there is no version to name) and a registry launcher whose registry probe
// has not answered yet. A registry launcher that HAS observed a newer version gets the specific
// sentence below instead, which is what actually tells the operator they are behind.
const updateCopy = "Install the latest version of Frizz. Your running threads will not be affected."
const newerVersionCopy = "A newer version of Frizz is available. Your running threads will not be affected."
const restartCopy = "Restart Frizz. Your running threads will not be affected."

// The one anchor both panels that hang off this button use. Desktop: anchored to the button's LEFT
// edge and opening RIGHTWARD, into the gutter and the workpane beyond it. The button sits at the
// right end of the status row above the prompt box, so there is always a workpane's width to its
// right and never enough room to its left for a 23rem panel — a right-0 anchor pushed it off-screen
// back when this control was corner chrome, and would still push it across the sidebar now. z-50 is
// a ROOT-level z now: the status row is loose on the page and carries no stacking context of its own
// (it was a z-20 chip until 2026-08-19), and the sidebar deliberately has no z-index, so z-50 is what
// puts either panel over the rail and the composer.
//
// The `fixed left-3 right-3 top-12` full-width strip below `sm:` (640px) is unreachable and kept only
// as a floor: this button renders only on the desktop shell, which the phone shell replaces at 700px.
//
// `sm:-left-[17px]` is DERIVED from the arrow, not chosen: PANEL_ARROW below carries the arithmetic
// and the readings. It is not the offset that lines the panel's own edge up with anything — the panel
// hangs 11px further left than the button's box, which is what it costs to put the arrow's base on a
// straight run of border while its apex stays on the mark.
const ANCHORED_PANEL =
  "fixed left-3 right-3 top-12 z-50 w-auto text-left font-sans sm:absolute sm:right-auto sm:-left-[17px] sm:top-[calc(100%+0.65rem)]"

// ONE arrow for both panels; only the border tone differs. Every number is measured, and the two that
// look arbitrary are the two the old spelling (`-top-1.5 left-1.5`) got wrong — it drew the left foot
// 4.51px from the panel's edge, 7.5px INSIDE the card's own 12px corner arc, so the tent grew straight
// out of the curve with no flat border to its left and the corner read as bent (maintainer, 2026-08-26).
//
// `left-4`: a 12px square rotated 45° spans 16.97px, so its feet sit 8.49px either side of the apex.
//   An absolute offset is measured from the PADDING edge, 1px inside the border, so the left foot lands
//   1 + 16 - 8.49 = 14.51px from the panel's left edge and clears the `rounded-xl` 12px arc by 2.5px.
// `-top-[7px]`: 1px border + 6px half-square puts the square's CENTRE on the panel's border-box top, so
//   the base diagonal lies along the top border and the arrow's own fill covers it. `-top-1.5` sat that
//   centre 1px lower, leaving 1px of border painted across the base as a notch at each foot.
// `sm:-left-[17px]` follows: the apex is at panelLeft + 1 + 16 + 6, and the mark it points at is the
//   button's 12px glyph centre, 6px into the wrapper that STATUS_ROW_ACTION's `-mx-1.5` ink trim
//   (lib/statusRow.ts) leaves behind — so panelLeft = 6 - 23 = -17.
//
// RE-DERIVE, don't re-guess, if the corner radius, the arrow size, the panel border or that ink trim
// moves. `nub scripts/shot.mjs http://localhost:<vite>/restart-frizz-button-fixture.html?failure
// out.png --clip=.rotate-45 --pad=18 --dsf=8` is the crop that shows the join.
const PANEL_ARROW = "absolute -top-[7px] left-4 h-3 w-3 rotate-45 border-l border-t bg-elevated"

/**
 * The same geometry as numbers, in CSS px, so the focused test can check the ARITHMETIC above rather
 * than the literals it happens to compile to. Keep the two in step — the test asserts both.
 */
export const PANEL_ARROW_GEOMETRY = {
  /** `h-3 w-3`: the square `rotate-45` turns into the tent. */
  square: 12,
  /** The panel's own border. An absolute offset is measured from the padding edge, just inside it. */
  border: 1,
  /** `rounded-xl` on PANEL_SURFACE — the arc the base has to clear. */
  radius: 12,
  /** `left-4` on PANEL_ARROW. */
  left: 16,
  /** `-top-[7px]` on PANEL_ARROW. */
  top: -7,
  /** `sm:-left-[17px]` on ANCHORED_PANEL. */
  panelLeft: -17,
  /** The mark: the button's glyph centre, 6px into the wrapper STATUS_ROW_ACTION's ink trim leaves. */
  markCentre: 6,
} as const

// Width is per-panel and each panel applies EXACTLY ONE of these — never both. Tailwind resolves a
// same-property collision by CSS source order, not class order, so stacking two `sm:w-*` utilities on
// one element is a coin flip (the same trap lib/overlaySurface.ts documents for `z-*`).
//
// 23rem holds the popover's one sentence. The failure card is wider because its content is BUILD
// OUTPUT: at 23rem, ~45 mono characters fit per line, so each ~110-character snapshot path wrapped
// across three lines and a routine typecheck failure became 20 wrapped lines — which pushed the one
// `error TS…` line that says what actually broke below the scroll fold. At 34rem the same failure
// reads in about half that, so the actionable line is visible without scrolling.
const POPOVER_WIDTH = "sm:w-[min(23rem,calc(100vw-1.5rem))]"
const NOTICE_WIDTH = "sm:w-[min(34rem,calc(100vw-1.5rem))]"

// Both panels are OPAQUE. Anything anchored here hangs over the sidebar list and the dispatch
// composer, and a tinted-but-transparent fill let every one of those lines read straight through the
// text on top of it — the failure message became unreadable exactly when it mattered most
// (maintainer, 2026-08-01, on a wall of build log over the board: "these translucent error messages
// look insane"). Same contract as lib/overlaySurface.ts states for portal menus: opaque from the
// first painted frame.
const PANEL_SURFACE = "rounded-xl bg-elevated p-3.5 shadow-xl shadow-black/45"

export function UpdateRestartPopover({
  open,
  update,
  version,
  updateVersion,
}: {
  open: boolean
  update: boolean
  /** The running application-server version. Absent keeps legacy/monolithic versionless UI unchanged. */
  version?: string
  /** The newer application-server version, once the launcher has observed one. */
  updateVersion?: string
}) {
  if (!open) return null
  const action = update ? "Update Frizz" : "Restart Frizz"
  // Name the newer version only on the verb that installs it: in plain-restart mode the board is
  // confirmed current, so `updateVersion` is never present there anyway.
  const newer = update ? updateVersion : undefined
  return (
    <div
      id="update-restart-popover"
      role="tooltip"
      aria-label={action}
      // The arrow's apex tracks the button's glyph; PANEL_ARROW owns the geometry.
      className={`${ANCHORED_PANEL} ${POPOVER_WIDTH} ${PANEL_SURFACE} border border-border-strong`}
    >
      <span aria-hidden="true" className={`${PANEL_ARROW} border-border-strong`} />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/10 text-fg">
          <RefreshCw aria-hidden="true" size={14} strokeWidth={2.25} />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{action}</span>
          {version && (
            // Always mono, whatever the board font: version numbers are identifiers, not prose.
            <span className="font-mono text-[11px] leading-snug text-muted">{newer ? `${version} → ${newer}` : version}</span>
          )}
        </div>
      </div>
      <p className="relative mt-2.5 text-[12px] leading-relaxed text-muted">{update ? (newer ? newerVersionCopy : updateCopy) : restartCopy}</p>
    </div>
  )
}

const PREVIOUS_KEPT: RestartFailureOutcome = { kind: "previous-kept" }

/**
 * The failure panel, built on the SAME opaque card as the popover it replaces — an error is the one
 * message that has to stay readable, so it is the last thing that should be see-through.
 *
 * `outcome` decides the sentence under the title (finding 11, audit 2026-09-11). The default is the
 * old one — the previous version kept running — which is true for a request the supervisor rejected
 * and for a durable frizz-dev rollback, but NOT for a successor that came up and then failed to
 * start its board: by then the previous version is gone, and saying it kept running was a lie.
 *
 * The supervisor's `message` is raw build output: a `nub run typecheck` failure arrives as several
 * hundred characters of absolute snapshot paths wrapped around the one `error TS…` line that actually
 * says what broke. Dumped into a paragraph it filled a 23rem column with ~15 lines of prose-set path
 * fragments. It reads as what it is — a terminal excerpt — inside a scrolling mono block, and the card
 * keeps a fixed height whatever the supervisor hands it.
 */
export function RestartFailureNotice({
  update,
  message,
  outcome = PREVIOUS_KEPT,
  onDismiss,
}: {
  update: boolean
  message: string
  /** Judged from the failed status's version against the version at click — api/restart.ts. */
  outcome?: RestartFailureOutcome
  onDismiss: () => void
}) {
  return (
    <div role="alert" className={`${ANCHORED_PANEL} ${NOTICE_WIDTH} ${PANEL_SURFACE} border border-danger-fill/45`}>
      <span aria-hidden="true" className={`${PANEL_ARROW} border-danger-fill/45`} />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-danger-fill/15 text-danger-soft">
          <AlertTriangle aria-hidden="true" size={14} strokeWidth={2.25} />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{update ? "Update failed" : "Restart failed"}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <X aria-hidden="true" size={14} strokeWidth={2.25} />
        </button>
      </div>
      <p className="relative mt-2.5 text-[12px] leading-relaxed text-muted">{restartFailureCopy(outcome).detail}</p>
      {/* The cap comes from the CARD's ceiling, not from any one log: ~360px is as tall as a transient
          notice hanging off a status-row button should ever get, and the chrome above takes ~100px of
          that. Chrome reserves this block's scrollbar gutter but paints no thumb at rest, so a fold
          that lands mid-glyph reads as broken rather than as "scroll me" — at 256px an ordinary build
          failure lands inside the box entirely and only genuinely huge output ever meets the fold. */}
      <pre className="relative mt-2.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-panel px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg/70">{message}</pre>
    </div>
  )
}

export function RestartActionButton({
  update,
  busy,
  version,
  updateVersion,
  onFocus,
  onBlur,
  onClick,
}: {
  update: boolean
  busy: boolean
  /** The running registry version, used with updateVersion to decide whether this is a new release line. */
  version?: string
  /** A confirmed newer registry version. Patch updates stay actionable but do not earn the badge dot. */
  updateVersion?: string
  onFocus?: () => void
  onBlur?: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-describedby="update-restart-popover"
      aria-label={update ? "Update Frizz" : "Restart Frizz"}
      disabled={busy}
      aria-busy={busy || undefined}
      className={`relative ${STATUS_ROW_ACTION}`}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <RefreshCw size={STATUS_ROW_ICON} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
      {/* The popover only opens on hover, so the mark calls out a new RELEASE LINE, not routine patch
          churn. frizz-dev remains unbadged because it has no package versions to compare. */}
      {/* 4px at a 2px inset, both MEASURED (dsf-8 crop + geometry, 2026-08-24): RefreshCw's ink corner
          sits at 4.75px inset, so a 5px dot at 2.5px touched the top-right arrowhead tip; this circle's
          ink clears that tip by ~1.9px, and the 2px inset keeps the whole dot inside the focus ring's
          rounded-md corner arc (an inset under ~1.76px pokes through it at 45°). */}
      {update && !busy && isBadgeRelease(version, updateVersion) && (
        <span aria-hidden="true" className="absolute right-[2px] top-[2px] h-[4px] w-[4px] rounded-full bg-accent" />
      )}
    </button>
  )
}

/** Global recovery action. It stays mounted in App chrome even when the app child is unhealthy. */
export function RestartFrizzButton() {
  const snap = useSnapshot(store)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The dismissed message, not a boolean: the supervisor keeps reporting "failed" on every poll, so a
  // boolean would either re-open the panel one poll after the close or swallow the NEXT, different
  // failure. Keyed on the text, a repeat of the same reason stays closed and a new reason re-opens.
  const [dismissed, setDismissed] = useState<string | undefined>()
  // Set at click, with the version that was running THEN: a later "failed" is read against it to
  // tell "the old launcher gave up" from "the new version came up and failed" (finding 11).
  const requested = useRef<{ version?: string } | null>(null)
  const controlRef = useRef<HTMLDivElement>(null)

  // Read straight off the shared supervisor poll (api/supervisorStatus.ts) rather than a private probe
  // copied into local state on mount. Two things follow. This button no longer contributes one of the
  // three /_frizz/control/status requests a single navigation used to make (t+58/61/63ms, 2026-09-04).
  // And it now tracks a status that CHANGES: a registry launcher starts update-optimistic and
  // versionless, so the version pair that decides whether to light the badge dot normally lands after
  // the first answer, and the frozen mount snapshot could never show it.
  const status = useSupervisorStatus().data ?? null
  const updateAvailable = canUpdateRestart(status)
  const versions = { version: status?.version, updateVersion: status?.updateVersion }

  // Nothing to offer until a supervisor has affirmatively answered — an unreachable one and a poll that
  // has not landed yet read the same, which is the correct bias for a global recovery verb.
  if (!canRestart(status)) return null

  // A failure the SUPERVISOR reports (a build that won't compile, an artifact that won't promote)
  // never reaches the click handler's catch — the POST was accepted, and the overlay simply drops
  // when a poll observes "failed". Its only trace was a 7-second toast, which is why a broken update
  // read as "the modal flashed and nothing happened". Once this session has asked for an update,
  // keep the supervisor's own reason on screen. It clears itself when the state leaves "failed".
  const reported = requested.current !== null && snap.controlPlaneState === "failed"
  const reportedFailure = reported ? snap.controlPlaneMessage ?? "Frizz did not become ready" : undefined
  const failure = error ?? reportedFailure
  const shownError = failure && failure !== dismissed ? failure : undefined
  // A rejected POST (`error`) came from the server we clicked on, so the previous version is by
  // definition still running; only a failure the POLL reports can be the successor's.
  const outcome: RestartFailureOutcome = !error && reported && requested.current
    ? restartFailureOutcome(requested.current.version, { version: status?.version })
    : PREVIOUS_KEPT

  const updateAndRestart = async () => {
    if (busy) return
    requested.current = { version: status?.version }
    setOpen(false)
    setBusy(true)
    setError(undefined)
    setDismissed(undefined)
    const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (updateAvailable) {
      // Raise the blocking overlay the instant the click lands — the update-restart POST can round-trip
      // slowly while the supervisor spins up the candidate build, and the user must see the block now,
      // not a second later. The recorded attempt holds it across the pre-ack window and withholds the
      // reload destination until the supervisor has actually accepted the transition (armed below), so a
      // stray status poll can neither drop the overlay nor reload onto the still-live old child. Its
      // `ackedAt` stays null until then: with no ack instant, NO answer can speak for this attempt.
      store.controlPlaneState = "restarting"
      store.controlPlaneMessage = null
      store.controlPlaneRestartAttempt = { startedAt: Date.now(), ackedAt: null, build: frizzBuildIdentity(status) }
    }
    try {
      if (updateAvailable) await requestFrizzUpdateRestart()
      else await requestFrizzRestart()
      // Do not reload onto the same old child while an immutable candidate is still building. App's
      // supervisor monitor reloads this exact route only after the durable owner reports readiness.
      if (updateAvailable) {
        // Arm the reload destination now that the supervisor owns the transition, and ramp the poll.
        // The attempt is deliberately NOT cleared here: it must outlive the ack until a poll OBSERVES
        // the server-confirmed transition (a non-"ready" status), so a stale in-flight poll that
        // captured the pre-flip "ready" can't slip past the guard and reload onto the old child. What
        // IS recorded is the ack instant — and before the wake below, so the refetch it triggers is
        // stamped at or after it: from here on only an answer requested after this moment counts, and
        // a "failed" from a poll that was already in flight at the click (the retry-from-failed path,
        // pullfrog on #35) can no longer settle this attempt (nextControlPlane in api/restart.ts).
        sessionStorage.setItem(RELOAD_AFTER_UPDATE_RESTART, destination)
        if (requested.current.version) sessionStorage.setItem(UPDATE_RESTART_FROM_VERSION, requested.current.version)
        else sessionStorage.removeItem(UPDATE_RESTART_FROM_VERSION)
        const attempt = store.controlPlaneRestartAttempt
        if (attempt) store.controlPlaneRestartAttempt = { ...attempt, ackedAt: Date.now() }
        window.dispatchEvent(new Event(FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT))
        setBusy(false)
      } else {
        window.location.replace(destination)
      }
    } catch (caught) {
      if (updateAvailable) {
        store.controlPlaneRestartAttempt = null
        store.controlPlaneState = "ready"
        store.controlPlaneMessage = null
      }
      const message = (caught as Error).message.slice(0, 140)
      setBusy(false)
      setError(message)
      // The reason goes in the failure panel, not the toast — see the same call in App.tsx.
      showToast(`${updateAvailable ? "Update & Restart" : "Restart Frizz"} failed`)
    }
  }

  return (
    <div ref={controlRef} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <RestartActionButton
        update={updateAvailable}
        busy={busy}
        version={versions.version}
        updateVersion={versions.updateVersion}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => void updateAndRestart()}
      />
      {shownError && <RestartFailureNotice update={updateAvailable} message={shownError} outcome={outcome} onDismiss={() => setDismissed(shownError)} />}
      <UpdateRestartPopover open={open && !shownError} update={updateAvailable} version={versions.version} updateVersion={versions.updateVersion} />
    </div>
  )
}
