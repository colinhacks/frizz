import { useEffect, useState, type Ref } from "react"
import { AlertTriangle, Check } from "lucide-react"
import type { BootView, BootViewStep } from "@frizz/shared"
import { LiveDot } from "./LiveDot.tsx"

// WHAT A RESTART OR AN UPDATE IS DOING, ON THE BOARD (2026-11-15). The launcher derives the view
// (server/src/boot-view.ts) and the recovery page draws it in its own inline script
// (server/src/supervisor-pages.ts); this is the same checklist for the board's restart overlay and its
// update button. Every word and number comes from the view, so the three agree: this file only lays
// them out, in the recovery page's rhythm (a 14px mark column, the label with a mono version, a short
// reading at the right, and under a download a bar and a line of bytes, speed and time left).
//
// ON A TOUCH SCREEN the card takes the phone shell's sizes, as the recovery page does (its
// `@media(pointer:coarse)` rules carry the same numbers, and the reason for each): 15px prose under a 17px
// title, the readings a step up, and "Open Frizz now" a thumb's height where it was 28px.

/** The recovery page's sentence under its heading (supervisor-pages.ts RECOVERY_PROGRESS_DETAIL). */
export const BOOT_PROGRESS_DETAIL = "Running threads keep working. The board opens when it is ready."

/** House grammar, two units at most: `24s`, `3m 12s`, `1h 05m` (boot-view.ts formatElapsed). */
export function formatBootElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * The view's elapsed reading, ticked locally between polls: the launcher measured `elapsedMs` when it
 * answered, and the clock carries on from there rather than jumping once a second per poll.
 */
export function useTickingElapsed(view: BootView | undefined): string | undefined {
  const [anchor, setAnchor] = useState<{ base: number; at: number } | null>(null)
  const [, setTick] = useState(0)
  const base = view?.elapsedMs
  useEffect(() => {
    setAnchor(base === undefined ? null : { base, at: Date.now() })
  }, [base])
  useEffect(() => {
    if (base === undefined) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [base === undefined])
  if (base === undefined) return undefined
  return formatBootElapsed(anchor ? anchor.base + Date.now() - anchor.at : base)
}

/** The mark column's three marks and a hollow ring for what has not started. */
function StepMark({ state }: { state: BootViewStep["state"] }) {
  if (state === "done") return <Check aria-hidden="true" size={12} strokeWidth={3} className="block text-success" />
  if (state === "stalled") return <AlertTriangle aria-hidden="true" size={13} strokeWidth={2.25} className="block text-accent" />
  if (state === "live") return <span aria-hidden="true" className="block h-[11px] w-[11px] animate-spin rounded-full border-[1.5px] border-accent/25 border-t-accent" />
  return <span aria-hidden="true" className="block h-[7px] w-[7px] rounded-full border-[1.5px] border-muted/55" />
}

const STEP_STATE_WORD: Record<BootViewStep["state"], string> = { done: "done", live: "in progress", stalled: "stalled", todo: "not started" }

/** The checklist, one row per step, keyed so a spinner does not restart on every poll. */
export function BootSteps({ steps, className = "" }: { steps: BootViewStep[]; className?: string }) {
  if (steps.length === 0) return null
  return (
    <ol className={`flex list-none flex-col gap-2 ${className}`}>
      {steps.map((step) => (
        <li key={step.key} data-step={step.key} data-state={step.state} className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2.5">
          <span className="flex h-[1.55em] items-center justify-center"><StepMark state={step.state} /></span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <span className={`min-w-0 ${step.state === "done" ? "text-muted" : step.state === "todo" ? "text-muted/70" : "text-fg"}`}>
                {step.label}
                {step.version ? <> <span className="font-mono text-[11.5px] pointer-coarse:text-[13.5px]">{step.version}</span></> : null}
                <span className="sr-only">, {STEP_STATE_WORD[step.state]}</span>
              </span>
              {step.note ? <span className="ml-auto whitespace-nowrap font-mono text-[11px] tabular-nums text-muted pointer-coarse:text-[12.5px]">{step.note}</span> : null}
            </div>
            {typeof step.fraction === "number" ? (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-fg/[0.09]">
                <b
                  className={`block h-full rounded-full transition-[width] duration-[400ms] ${step.state === "stalled" ? "bg-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-muted))]" : "bg-accent"}`}
                  style={{ width: `${(Math.max(0, Math.min(1, step.fraction)) * 100).toFixed(1)}%` }}
                />
              </div>
            ) : null}
            {step.meta ? (
              <div className={`mt-[5px] font-mono text-[11px] tabular-nums pointer-coarse:text-[12px] ${step.state === "stalled" ? "text-[color-mix(in_srgb,var(--color-accent)_80%,var(--color-muted))]" : "text-muted"}`}>{step.meta}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The restart overlay's card while the launcher reports progress: the title with a live dot and the
 * elapsed clock, the checklist, and — when a download is slow or stalled — the callout that offers to
 * open the board without it.
 */
export function BootProgressCard({
  view,
  cardRef,
  onOpenNow,
  openNowError,
  openNowSent = false,
}: {
  view: BootView
  cardRef?: Ref<HTMLDivElement>
  onOpenNow: () => void
  /** The launcher refused the request, in its words. */
  openNowError?: string
  /** The request is on its way; the next poll reports `opening`. */
  openNowSent?: boolean
}) {
  const elapsed = useTickingElapsed(view)
  const stalled = view.steps.some((step) => step.state === "stalled")
  const opening = view.opening === true || (openNowSent && !openNowError)
  const callout = view.callout
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-boot-progress={view.kind}
      // 28rem, two over the plain restart card: the sentence under the title fits one line, and a
      // download's line of bytes, speed and time left fits beside nothing.
      className="w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border-strong bg-elevated p-5 text-left text-[12.5px] leading-[1.55] text-fg shadow-2xl shadow-shadow-ink/60 outline-none pointer-coarse:text-[15px]"
    >
      <h2 className="flex items-baseline gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-fg pointer-coarse:text-[17px]">
        {/* A baseline-aligned item with no text of its own contributes its border-box BOTTOM as its
            baseline, so the 6px dot's ink centre sits 3px above the baseline; `0.5cap` is half the
            resolved font's cap height, which puts it on the cap band's centre at any size (the
            recovery page's .dot carries the same correction). */}
        {stalled ? (
          <span aria-hidden="true" className="block h-1.5 w-1.5 shrink-0 translate-y-[calc(3px_-_0.5cap)] rounded-full bg-accent" />
        ) : (
          <LiveDot hue="agent" aria-hidden="true" style={{ transform: "translateY(calc(3px - 0.5cap))" }} />
        )}
        <span className="min-w-0">{view.title}</span>
        {elapsed ? <span className="ml-auto whitespace-nowrap pl-2.5 font-mono text-[11px] font-normal tracking-normal tabular-nums text-muted pointer-coarse:text-[12.5px]">{elapsed}</span> : null}
      </h2>
      <p className="mt-1.5 text-muted">{BOOT_PROGRESS_DETAIL}</p>
      <BootSteps steps={view.steps} className="mt-3 border-t border-border pt-[11px]" />
      {callout || openNowError ? (
        <div data-boot-callout className="mt-3.5 rounded-[9px] border border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-panel px-3 pb-3 pt-[11px]">
          <p aria-live="polite" className="text-[12px] leading-[1.55] text-muted pointer-coarse:text-[14px]">
            {openNowError ?? (
              <>
                {callout?.lead ? <b className="font-semibold text-fg">{callout.lead} </b> : null}
                {callout?.text}
              </>
            )}
          </p>
          {view.openNow || opening ? (
            <div className="mt-2.5 flex">
              <button
                type="button"
                data-open-now
                disabled={opening}
                onClick={onOpenNow}
                className="button-outline inline-flex items-center rounded-md bg-accent-fill px-2.5 py-[5px] text-[11.5px] font-semibold leading-[1.4] text-on-accent outline-none transition-[filter,opacity] hover:brightness-110 disabled:opacity-60 pointer-coarse:min-h-[42px] pointer-coarse:rounded-[9px] pointer-coarse:px-4 pointer-coarse:py-0 pointer-coarse:text-[15px]"
              >
                {opening ? "Opening" : "Open Frizz now"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The part of a download the update button's ring shows: the live step's bar, or none while it has no total. */
export function bootViewFraction(view: BootView): number | undefined {
  const live = view.steps.find((step) => step.state === "live" || step.state === "stalled")
  return live?.fraction
}
