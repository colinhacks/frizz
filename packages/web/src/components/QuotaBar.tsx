import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { AccountBackend, AuthSnapshot, ProviderAuth, ProviderQuota, QuotaWindow } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { CLAUDE_MODELS } from "../lib/options.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { GAUGE, HEALTHY_MIN, gaugeAngle, gaugeArc, gaugeNeedle, gaugeWindow, modelFamily, remainingPercent } from "../lib/quotaGauge.ts"

// THE FUEL GAUGE — the quota readout in the StatusRow above the prompt box: ONE gauge for the model the
// prompt box has selected, its needle and lit arc standing at the quota that model has left. Pointing
// at it opens the full per-window breakdown at once; clicking it rechecks.
//
// It was two chips until 2026-10-26, a provider mark and a 9px percentage for each of Claude and Codex
// side by side, whichever model you were about to use (maintainer: "the usage should look like a fuel
// gauge and it should actually change to reflect the remaining usage. it should show usage for the model
// that's currently selected in the prompt box"). Which window it reads — the 5h one, until a longer cap
// binding the model runs low — and why, is lib/quotaGauge.ts gaugeWindow.
//
// The gauge renders ONLY when it has a reading to show (see hasReading): the first fetch, a signed-out
// account, an unreachable usage endpoint and an ACP agent — which reports no quota at all — draw nothing.
// The sign-in door is the composer's dispatch gate (submitting a thread on a signed-out backend opens the
// sign-in modal) and the `/login` alias.
//
// Quota is ACCOUNT-global — it was never a property of the composer it sits over — which is why it
// rides the GLOBAL status row rather than being composer decoration. What it follows is the composer's
// SELECTION, read off the same durable new-thread profile the selector writes (useDispatchProfile):
// that write updates the cache before it reaches the server, so the gauge swings in the same frame the
// selection changes.
//
// Quota is polled (rpc.quota) rather than pushed on the board: it is ACCOUNT-global, not per-thread.
// The server keeps Claude's reading warm on its own heartbeat (refreshClaudeQuotaInBackground) and
// holds Codex's for a minute (readCodexQuota), so this poll reads those caches — a cheap local RPC
// that starts a provider round-trip only when one of them has expired — and a 30s cadence keeps the
// gauge tracking them within half a minute instead of drifting minutes stale during a fast burn. An
// UNAVAILABLE read re-polls at 15s (a blip should self-heal in seconds) — but only for a provider that
// is signed in: a signed-out one has no reading to recover, and counting it as a blip put every
// one-provider account on the fast cadence for good. CLICKING the gauge forces a fresh read of that
// provider's quota, and of auth — the click is the recheck. Hovering it does not: see QuotaGauge.

// Every quota/auth request carries an abort deadline. Without one, a single response the server never
// finishes (a dev-server restart severing an in-flight request) leaves the fetch pending FOREVER:
// react-query stays "fetching" and never retries, the recheck latch never clears, and the readout
// freezes with a dead click target — the exact reported failure. The deadline turns that into an
// ordinary error the next poll recovers from, while `data` keeps the last good reading.
const POLL_TIMEOUT_MS = 30_000
// A forced recheck legitimately runs Claude Code's `/usage` CLI behind a cross-process lock (~27s
// worst case), so it gets a longer leash.
const RECHECK_TIMEOUT_MS = 45_000
// How long the breakdown survives the pointer leaving the gauge: long enough to cross the panel's 6px
// offset into it (the account address in it is selectable) and back, the same grace ContextMeter's
// hover panel gives.
const HOVER_CLOSE_DELAY_MS = 150

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

/**
 * Is there a percentage to show for this provider? Anything else — the first fetch, a signed-out
 * account, an unreachable usage endpoint — is NO DATA, and a readout with no data renders nothing at all
 * (maintainer 2026-08-19: "if there's no data available for a given agent, then it should just be
 * entirely hidden instead of showing an em dash"). An em dash occupied a readout's worth of space to
 * say a readout was missing, which is the noisiest way to say nothing.
 *
 * A signed-out provider counts as no data: a signed-out account HAS no quota.
 */
function hasReading(quota: ProviderQuota | undefined, auth: ProviderAuth | undefined, loading: boolean): boolean {
  if (auth === "signed-out") return false
  if (!quota && loading) return false
  return !!quota && quota.status === "ok" && quota.windows.length > 0
}

/**
 * The provider and model the prompt box will start its next thread on: the durable new-thread profile,
 * under the SAME query key useDispatchProfile reads and optimistically rewrites, so one fetch serves
 * both and a new selection reaches the gauge at once. An unset Claude model is the dispatch default,
 * Opus (lib/dispatchPreferences.ts); an unset Codex model needs no answer, since no Codex window is
 * scoped to a model.
 */
function useSelectedModel(): { backend: AccountBackend; model: string | undefined } | undefined {
  const preferences = useQuery({ queryKey: ["dispatchPreferencesGet"], queryFn: () => rpc.dispatchPreferencesGet() })
  const data = preferences.data
  if (!data || data.backend === "acp") return undefined
  return { backend: data.backend, model: data[data.backend]?.model ?? (data.backend === "claude" ? "opus" : undefined) }
}

/** The selected model in words for the tooltip: "Opus" for a Claude alias, the slug for a Codex model. */
function modelWords(backend: AccountBackend, model: string | undefined): string {
  if (!model) return PROVIDER_LABEL[backend]
  if (backend === "claude") return CLAUDE_MODELS.find((option) => option.value === model)?.label ?? model
  return model
}

export function QuotaGauge() {
  const queryClient = useQueryClient()
  const recheckInFlight = useRef<Promise<void> | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // Keep the last value through refetches so the gauge never flickers away. The query never rejects
  // meaningfully (the server degrades each provider to "unavailable").
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: (query) => {
      const d = query.state.data
      const signedIn = queryClient.getQueryData<AuthSnapshot>(["authStatus"])
      const degraded = !d || (["claude", "codex"] as const).some((b) => d[b].status !== "ok" && signedIn?.[b] !== "signed-out")
      return degraded ? 15_000 : 30_000
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
  // The credential surface. Same cache key as the dispatch gate, so a sign-in from either place
  // updates both. Polled slowly; the popover-open refetch is the responsive path.
  const auth = useQuery({
    queryKey: ["authStatus"],
    queryFn: ({ signal }) => rpc.authStatus(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: 120_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  const selected = useSelectedModel()
  // The breakdown is a HOVER PANEL (maintainer 2026-10-26: "we need an immediate popover to show on the
  // usage gauge when hovered"). Until then it opened on a click alone, and the hover had only a native
  // `title`, which the browser shows after about a second and draws as a one-line system label.
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  const recheck = (backend: AccountBackend) => {
    if (recheckInFlight.current) return
    setRechecking(true)
    const request = Promise.all([
      rpc.quota({ force: backend }, { signal: deadline(RECHECK_TIMEOUT_MS) })
        .then((snapshot) => queryClient.setQueryData(["quota"], snapshot)),
      queryClient.refetchQueries({ queryKey: ["authStatus"] }),
    ]).then(() => {}).catch(() => {})
      .finally(() => {
        recheckInFlight.current = null
        setRechecking(false)
      })
    recheckInFlight.current = request
  }

  if (!selected) return null
  const { backend, model } = selected
  const reading = quota.data?.[backend]
  if (!hasReading(reading, auth.data?.[backend], quota.isLoading)) return null
  const window = gaugeWindow(reading!.windows, modelFamily(backend, model))!
  const remaining = remainingPercent(window)
  const words = modelWords(backend, model)
  const providerLabel = PROVIDER_LABEL[backend]

  const openNow = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }
  // A press on the gauge is the gauge's own gesture. Without this, Radix reads its pointerdown (and the
  // focus it moves) as an interaction OUTSIDE the panel and shuts the panel the hover just opened.
  const keepGaugeInteractions = (event: { detail: { originalEvent: Event }; preventDefault: () => void }) => {
    if (button.current?.contains(event.detail.originalEvent.target as Node)) event.preventDefault()
  }

  return (
    // ANCHOR + a plain button, NOT PopoverTrigger: a Trigger toggles, so the click that follows a hover
    // would shut the panel the hover opened. Owning the state keeps one meaning per gesture — pointing
    // opens, clicking opens and rechecks, leaving (or Escape, or a click elsewhere) shuts.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {/* The row's icon square (STATUS_ROW_ACTION), so it hovers, trims and spaces like the settings
            and reload buttons it stands beside — and stays lit while its panel is open, as the crumb's
            pill does with its menu. No `title`: the panel is the hover's answer, and a native tooltip
            would arrive a second later on top of it. */}
        <button
          ref={button}
          type="button"
          data-quota-gauge={backend}
          data-quota-window={window.key}
          data-remaining={remaining}
          aria-label={`${providerLabel} quota for ${words}: ${remaining}% remaining in the ${window.label} window`}
          aria-haspopup="dialog"
          aria-expanded={open}
          // POINTER-typed, as RecurringPromptControl's preview is: a touch tap goes straight to the
          // click, which opens the panel and rechecks, instead of painting a hover under the finger.
          onPointerEnter={(event) => { if (event.pointerType !== "touch") openNow() }}
          onPointerLeave={(event) => { if (event.pointerType !== "touch") closeSoon() }}
          // Keyboard reaches the same panel the pointer does: tab to the gauge and the breakdown shows.
          onFocus={openNow}
          onClick={() => {
            openNow()
            // The CLICK is the recheck — a true server-side cache bypass, not a replay of the last cached
            // failure with a decorative spinner. The hover is not: it shows the reading the 30s poll
            // already holds, because a forced Claude read spends the usage endpoint's per-token budget
            // (about one request in five minutes, shared with every Claude Code session on the machine)
            // and a forced Codex read starts a `codex app-server`. Passing the pointer over the gauge
            // must not cost either.
            recheck(backend)
          }}
          // A VARIANT, not a class added while open: a bare `text-fg` would tie STATUS_ROW_ACTION's
          // `text-fg/75` and win or lose on stylesheet order.
          className={`${STATUS_ROW_ACTION} aria-expanded:bg-elevated aria-expanded:text-fg`}
        >
          <FuelGauge remaining={remaining} />
        </button>
      </PopoverAnchor>
      {/* Drops DOWN from the row, which sits at the top of the sidebar column, and hangs off the
          gauge's right edge — the gauge is near the column's right end, so a left-aligned panel would
          run out past it. */}
      <PopoverContent
        side="bottom"
        align="end"
        data-quota-panel={backend}
        aria-label={`${providerLabel} quota`}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onInteractOutside={keepGaugeInteractions}
        // Hover opened it, so focus stays where the operator left it: pulling focus into the panel would
        // steal the caret from the prompt box the pointer merely passed over on its way up.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-[min(15rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg"
      >
        <QuotaBreakdown backend={backend} quota={reading!} email={auth.data?.emails?.[backend]} reading={window} fetching={quota.isFetching || rechecking} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The dial. The lit arc and the needle carry the reading; the track behind them stays faint so an
 * empty tank still reads as a gauge rather than as a stray tick. Colour is spent only where the old
 * chip spent it — amber in the warn zone, the danger colour when nearly empty — and a healthy tank takes
 * the row's own icon tone from the button around it, so it hovers to full fg like its neighbours.
 */
export function FuelGauge({ remaining, size = STATUS_ROW_ICON }: { remaining: number; size?: number }) {
  const level = gaugeAngle(remaining)
  const tone = remaining <= 8 ? "text-danger" : remaining <= HEALTHY_MIN ? "text-accent" : undefined
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      data-fuel-gauge=""
      className={tone}
    >
      <path data-gauge-track="" d={gaugeArc(GAUGE.start, GAUGE.start + GAUGE.sweep)} opacity={0.35} />
      {remaining > 0 && <path data-gauge-level="" d={gaugeArc(GAUGE.start, level)} />}
      <path data-gauge-needle="" d={gaugeNeedle(remaining)} />
      <circle data-gauge-hub="" cx={GAUGE.cx} cy={GAUGE.cy} r={GAUGE.hub} fill="currentColor" stroke="none" />
    </svg>
  )
}

// The breakdown behind the gauge: the provider's plan and account, then every window it reports, the
// one the gauge is reading in full fg and the rest in the muted label tone.
function QuotaBreakdown({
  backend,
  quota,
  email,
  reading,
  fetching,
}: {
  backend: AccountBackend
  quota: ProviderQuota
  email: string | undefined
  reading: QuotaWindow
  fetching: boolean
}) {
  return (
    <>
      {/* The IDENTITY block: who this provider is, which plan, and which account — one unit, held
          together by its own tight internal leading and separated from the numbers below by mb-2.
          Measured cap-band gaps: 10.9px inside the block vs 18.9px to the first window row, so the
          email reads as part of the header rather than as a homeless row between two blocks. */}
      <div className="mb-2">
        <div className="flex items-center gap-1.5 font-medium">
          <ProviderMark backend={backend} />
          <span>{PROVIDER_LABEL[backend]}</span>
          {quota.planType && <span className="text-muted-70">· {cap(quota.planType)} plan</span>}
          {fetching && <Loader2 size={11} className="animate-spin text-muted-60" aria-label="Rechecking" />}
        </div>
        {/* WHICH account this is. Sits above the window breakdown because it is an AUTH fact, not a
            quota one — "am I on the right account?" is asked while reading the numbers, not after.
            Selectable and title-carrying, so a long address stays copyable past the 15rem truncation. */}
        {email && (
          <div data-quota-account className="truncate text-muted-70 select-text" title={email}>
            {email}
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {quota.windows.map((w) => {
          const left = clampPct(100 - w.usedPercent)
          const reset = resetText(w)
          return (
            <li key={w.key} data-quota-window-row={w.key} className="flex items-center justify-between gap-3">
              <span className={w.key === reading.key ? "text-fg" : "text-muted-80"}>{w.label}</span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className={toneText(left)}>{left}% left</span>
                {reset && <span className="text-muted-55">resets {reset}</span>}
              </span>
            </li>
          )
        })}
        {quota.detail && <li className="pt-1 text-muted-55">{quota.detail}</li>}
      </ul>
    </>
  )
}

/**
 * THE PHONE'S QUOTA READING — every window of every provider that has one, as a labelled meter.
 *
 * The phone has no status row to hang the gauge on, and no hover to open its popover, so its Settings
 * page leads with the whole breakdown instead (phone design 2026-09-30, § 6): one row per backend
 * window, a bar and a number. The number is REMAINING quota, like the desktop breakdown's — a phone
 * that read 38% where the desktop reads 62% for the same window would be two answers to one question —
 * and the bar fills with what is left. Same query keys and the same no-reading rule as the gauge, so it
 * renders nothing for a provider the gauge would hide, and one fetch serves both.
 *
 * The tone spends colour only where the gauge does, minus the amber: on a phone screen the accent is the
 * ask colour and nothing else, so a low window reads in the foreground and only a nearly empty one in
 * the danger colour.
 */
export function QuotaMeters() {
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
  const auth = useQuery({
    queryKey: ["authStatus"],
    queryFn: ({ signal }) => rpc.authStatus(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    staleTime: 30_000,
  })
  const rows = (["claude", "codex"] as const).flatMap((backend) => {
    const q = quota.data?.[backend]
    if (!hasReading(q, auth.data?.[backend], quota.isLoading)) return []
    return q!.windows.map((w) => ({ key: `${backend}-${w.key}`, label: `${PROVIDER_LABEL[backend]} · ${w.label}`, left: clampPct(100 - w.usedPercent) }))
  })
  if (rows.length === 0) return null
  return (
    <ul data-quota-meters className="m-0 flex list-none flex-col gap-[9px] p-0">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-2.5 text-[13.5px] leading-[19px]">
          <span className="w-[108px] shrink-0 truncate text-muted">{row.label}</span>
          <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <span className={`block h-full rounded-full ${row.left <= 8 ? "bg-danger" : "bg-fg/75"}`} style={{ width: `${row.left}%` }} />
          </span>
          <span className={`w-[64px] shrink-0 text-right tabular-nums ${row.left <= 8 ? "text-danger" : "text-fg"}`}>{row.left}% left</span>
        </li>
      ))}
    </ul>
  )
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// Severity by REMAINING: healthy (neutral light gray — no alarm), low (amber), critical (red). Color is
// spent only on states that want attention; a healthy quota is just information, so it reads as a calm
// neutral light gray rather than any hue (green, in any shade, fought the muted dark palette).
function toneText(remaining: number): string {
  if (remaining <= 8) return "text-danger"
  if (remaining <= HEALTHY_MIN) return "text-accent"
  return "text-fg/70"
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

// A short reset label from a unix-seconds instant: "3:40pm" if within a day, else a weekday ("Thu").
// A reset in the PAST (stale data past its rollover) is suppressed rather than shown as a misleading
// already-elapsed clock time.
function resetText(w: QuotaWindow): string | null {
  if (!w.resetsAt) return null
  const ms = w.resetsAt * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const delta = ms - Date.now()
  if (delta <= 0) return null
  const withinDay = delta < 24 * 3600_000
  if (withinDay) {
    let h = d.getHours()
    const m = d.getMinutes()
    const ap = h >= 12 ? "pm" : "am"
    h = h % 12 || 12
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`
  }
  return d.toLocaleDateString(undefined, { weekday: "short" })
}
