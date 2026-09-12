import { useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { Backend, ProviderAuth, ProviderQuota, QuotaWindow } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"

// THE QUOTA CHIPS — the readouts at the left of the StatusRow above the prompt box, one compact chip
// per backend showing REMAINING subscription quota. Click a chip for the full per-window breakdown.
//
// A chip renders ONLY when it has a percentage to show (see hasReading). It used to be the provider
// AUTH surface too — a signed-out account drew an em dash whose popover offered Sign in — and that is
// gone with the dash: the sign-in door is the composer's dispatch gate (submitting a thread on a
// signed-out backend opens the same modal) and the `/login` alias.
//
// These are back above the sidebar's dispatch box, where they briefly floated on their own before a
// spell in a fixed corner bar. Quota is ACCOUNT-global — it was never a property of the composer it
// sits over — which is why it rides a GLOBAL status row rather than being composer decoration.
// The chips carry no wrapper padding or justification of their own: StatusRow owns the layout, and a
// chip that brought its own box would break the single-line rhythm.
//
// The live connection state is NOT repeated here: it is the dot at the far right of the same row,
// pinned to the project name.
//
// Quota is polled (rpc.quota) rather than pushed on the board: it is ACCOUNT-global, not per-thread.
// The server keeps the reading warm on its own 1-minute heartbeat (refreshClaudeQuotaInBackground), so
// this poll just reads that warm cache — a cheap local RPC, no provider round-trip — and a 30s cadence
// keeps the chip tracking the cache within half a minute instead of drifting minutes stale during a
// fast burn. An UNAVAILABLE read re-polls at 15s (a blip should self-heal in seconds), and opening a
// chip's popover forces a fresh read of both quota and auth — the popover is the recheck.

// Every quota/auth request carries an abort deadline. Without one, a single response the server never
// finishes (a dev-server restart severing an in-flight request) leaves the fetch pending FOREVER:
// react-query stays "fetching" and never retries, the recheck latch never clears, and the chip freezes
// into an em dash with a dead click target — the exact reported failure. The deadline turns that into
// an ordinary error the next poll recovers from, while `data` keeps the last good reading.
const POLL_TIMEOUT_MS = 30_000
// A forced recheck legitimately runs Claude Code's `/usage` CLI behind a cross-process lock (~27s
// worst case), so it gets a longer leash.
const RECHECK_TIMEOUT_MS = 45_000

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

// THE READING IS SMALL ON PURPOSE (maintainer 2026-08-19: "I wish we'd make the percentages a lot
// smaller. The actual text of the percentage numbers should be small"). 9px, down from 11px, against
// the row's 12px identity — the smallest type anywhere in this app, deliberately. The chips are
// ambient background information, not something to read on every glance, and at 11px two of them
// carried nearly the same weight as the project name they sit opposite. It stops at 9 because tabular
// digits below that stop being legible at a glance, which would trade one problem for another.
//
// It applies to the WRAPPER, so every branch inherits it: the percentage, the em dash a signed-out or
// unavailable provider shows, and the "··" first-fetch placeholder. Those three occupy the same slot
// and a size that only reached one of them would make the chip resize as its state changed.
//
// The PROVIDER MARKS do not shrink with it. They are fixed px in PROVIDER_MARK_GEOMETRY (11px Claude,
// 10px Codex — optically matched to each other, not to any font size), so the mark stays put and only
// the number drops. That is the intended reading: the mark identifies the provider, the small number
// is its current level.
const QUOTA_READING = "text-[9px]"

// THE PROVIDER MARK IS AN ICON IN THIS ROW, and carries an icon's size and weight (maintainer
// 2026-08-19: "logos should be the same brightness and size as the other icons. The text should just
// be small"). `text-fg/75` is exactly STATUS_ROW_ACTION's tone, so the two marks sit at the same
// brightness as the home, settings and reload glyphs beside them rather than reading as dimmer
// metadata.
//
// SIZE IS OPTICAL, NOT NOMINAL — and it is two numbers, not one, because these two marks do not fill
// their viewBoxes alike. PROVIDER_MARK_GEOMETRY's 11px/10px pairing already encodes that (the OpenAI
// knot is denser than the Claude asterisk), and the job here is to keep that relationship while
// landing both on the ~12px of ink a 14px lucide glyph paints. Measured with scripts/ink-gaps.mjs at
// --dsf=4 --pad=0 against the settings gear, and re-measure rather than re-guess if either changes.
//
// `!` on both because ProviderMark composes its own `text-muted-65` and `size-*` ahead of this
// className, and Tailwind resolves a same-property collision by CSS SOURCE order, not class order —
// without it these silently lose to the defaults.
const PROVIDER_MARK_AS_ICON: Record<Backend, string> = {
  claude: "text-fg/75! size-[14px]! translate-y-0!",
  codex: "text-fg/75! size-[12.75px]! translate-y-0!",
}

/**
 * Whether the chips have ANYTHING to draw. StatusRow owns the divider that separates the actions from
 * these readouts, so it has to know whether the group behind that divider is empty — otherwise a board
 * with neither provider reporting draws a hairline with nothing after it.
 *
 * Same query keys as QuotaChips, so react-query serves both from ONE fetch rather than doubling the
 * poll. (Mirrors useGithubTriggerVisible, which gates the composer's picker the same way.)
 */
export function useQuotaChipsVisible(): boolean {
  const quota = useQuery({ queryKey: ["quota"], queryFn: () => rpc.quota(), staleTime: 10_000 })
  const auth = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  return (["claude", "codex"] as const).some((backend) =>
    hasReading(quota.data?.[backend], auth.data?.[backend], quota.isLoading),
  )
}

/**
 * Is there a percentage to show for this provider? Anything else — the first fetch, a signed-out
 * account, an unreachable usage endpoint — is NO DATA, and a chip with no data renders nothing at all
 * (maintainer 2026-08-19: "if there's no data available for a given agent, then it should just be
 * entirely hidden instead of showing an em dash"). An em dash occupied a readout's worth of space to
 * say a readout was missing, which is the noisiest way to say nothing.
 *
 * A signed-out provider counts as no data: a signed-out account HAS no quota. That does remove the
 * chip's Sign in popover, which is why the composer's dispatch gate and the `/login` alias remain the
 * ways in — submitting a thread on a signed-out backend still opens the same modal.
 */
function hasReading(quota: ProviderQuota | undefined, auth: ProviderAuth | undefined, loading: boolean): boolean {
  if (auth === "signed-out") return false
  if (!quota && loading) return false
  return !!quota && quota.status === "ok" && quota.windows.length > 0
}

export function QuotaChips() {
  const queryClient = useQueryClient()
  const recheckInFlight = useRef<Promise<void> | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // Keep the last value through refetches so the bar never flickers to empty. The query never
  // rejects meaningfully (the server degrades each provider to "unavailable").
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: (query) => {
      const d = query.state.data
      const degraded = !d || d.claude.status !== "ok" || d.codex.status !== "ok"
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

  const recheck = (backend: Backend) => {
    if (recheckInFlight.current) return
    setRechecking(true)
    const request = Promise.all([
      rpc.quota({ force: backend === "claude" }, { signal: deadline(RECHECK_TIMEOUT_MS) })
        .then((snapshot) => queryClient.setQueryData(["quota"], snapshot)),
      queryClient.refetchQueries({ queryKey: ["authStatus"] }),
    ]).then(() => {}).catch(() => {})
      .finally(() => {
        recheckInFlight.current = null
        setRechecking(false)
      })
    recheckInFlight.current = request
  }

  return (
    // `gap-3` is the STATUS ROW's one optical distance, not a value of this component's own: these two
    // chips sit in that row, and a chip-to-chip gap that differs from the row's is exactly the
    // inconsistency the trims in lib/statusRow.ts were cut to remove. Both provider marks reach their
    // own box edge, so this gap needs no trim to mean 12px of ink (measured 12.25). The 6px INSIDE a
    // chip (mark → percentage) is deliberately half of it — that is what keeps each mark reading as
    // one pill rather than four loose glyphs.
    <div data-quota-bar className={`flex shrink-0 items-center gap-3 ${QUOTA_READING}`}>
      <QuotaChip backend="claude" quota={quota.data?.claude} auth={auth.data?.claude} email={auth.data?.emails?.claude} loading={quota.isLoading} fetching={quota.isFetching || rechecking} onRecheck={() => recheck("claude")} />
      <QuotaChip backend="codex" quota={quota.data?.codex} auth={auth.data?.codex} email={auth.data?.emails?.codex} loading={quota.isLoading} fetching={quota.isFetching || rechecking} onRecheck={() => recheck("codex")} />
    </div>
  )
}

// One provider's chip: the provider mark + the 5-HOUR window's remaining quota, as a percentage. Clicking
// opens a Popover with the full per-window breakdown (both windows + reset times + plan), the account the
// credential belongs to — and forces a fresh quota+auth read, so the chip doubles as the recheck control.
//
// NO READING, NO CHIP — see hasReading. The first fetch, a signed-out account and an unreachable usage
// endpoint all render nothing rather than the em dash and the "··" placeholder they used to. The
// popover's own branches for signed-out and unavailable are therefore unreachable from this row and
// have been removed with them; the sign-in door is the composer's dispatch gate and `/login`.
function QuotaChip({
  backend,
  quota,
  auth,
  email,
  loading,
  fetching,
  onRecheck,
}: {
  backend: Backend
  quota: ProviderQuota | undefined
  auth: ProviderAuth | undefined
  email: string | undefined
  loading: boolean
  fetching: boolean
  onRecheck: () => void
}) {
  const providerLabel = PROVIDER_LABEL[backend]

  // A positive signed-out outranks any quota reading: a signed-out account HAS no usable quota, and
  // "Usage endpoint unreachable" would be a misdiagnosis. Fails open — unknown/loading render quota.
  if (!hasReading(quota, auth, loading)) return null

  // The headline is ALWAYS the 5-hour window — "how much can I do right now" is the number that matters
  // day-to-day, and it is the only reading the chip ever shows. The weekly / Opus wall is one click away
  // in the popover. Falls back to the tightest window only when there is no 5h window at all.
  const headline = pickHeadline(quota!.windows)
  const remaining = clampPct(100 - headline.usedPercent)

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          // Opening the chip IS the recheck. This is a true server-side cache bypass, not a replay of
          // the last cached failure with a decorative spinner.
          if (open) onRecheck()
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${providerLabel} quota: ${remaining}% remaining`}
            className="flex items-center gap-1.5 min-w-0 rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            {/* The mark carries an ICON's size and weight; only the number is small. */}
            <ProviderMark backend={backend} className={PROVIDER_MARK_AS_ICON[backend]} />
            <span className={`tabular-nums ${toneText(remaining)}`}>{remaining}%</span>
          </button>
        </PopoverTrigger>
        {/* Drops DOWN from the row, which sits at the top of the sidebar column. */}
        <PopoverContent side="bottom" align="start" className="w-[min(15rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg">
          {/* The IDENTITY block: who this provider is, which plan, and which account — one unit, held
              together by its own tight internal leading and separated from the numbers below by mb-2.
              Measured cap-band gaps: 10.9px inside the block vs 18.9px to the first window row, so the
              email reads as part of the header rather than as a homeless row between two blocks. At the
              original mt-0.5/mb-1.5 those gaps were 12.9 and 16.9 — too close to call either way. */}
          <div className="mb-2">
            <div className="flex items-center gap-1.5 font-medium">
              <ProviderMark backend={backend} />
              <span>{providerLabel}</span>
              {quota?.planType && <span className="text-muted-70">· {cap(quota.planType)} plan</span>}
              {fetching && <Loader2 size={11} className="animate-spin text-muted-60" aria-label="Rechecking" />}
            </div>
            {/* WHICH account this is. Sits above the window breakdown because it is an AUTH fact, not a
                quota one — "am I on the right account?" is asked while reading the numbers, not after.
                Tone matches the
                plan label beside it (both are identity metadata, so the block reads as one). Selectable
                and title-carrying, so a long address stays copyable past the 15rem truncation. */}
            {email && (
              <div data-quota-account className="truncate text-muted-70 select-text" title={email}>
                {email}
              </div>
            )}
          </div>
          {/* No signed-out or unavailable branch: this popover only exists on a chip that HAS a
              reading, and a chip without one no longer renders. */}
          <ul className="flex flex-col gap-1">
            {quota!.windows.map((w) => {
              const left = clampPct(100 - w.usedPercent)
              const reset = resetText(w)
              return (
                <li key={w.key} className="flex items-center justify-between gap-3">
                  <span className="text-muted-80">{w.label}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className={toneText(left)}>{left}% left</span>
                    {reset && <span className="text-muted-55">resets {reset}</span>}
                  </span>
                </li>
              )
            })}
            {quota!.detail && <li className="pt-1 text-muted-55">{quota!.detail}</li>}
          </ul>
        </PopoverContent>
      </Popover>
    </>
  )
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// The remaining % at/below which a window is no longer "a good amount of quota" — it enters the warn
// zone, where the tone drops the calm neutral for the amber alarm.
const HEALTHY_MIN = 25

// Which window's number leads the chip: ALWAYS the 5-hour one — the immediate runway, the number that
// matters day-to-day. The chip is a FIXED-MEANING readout, not a "whichever limit is tightest" indicator:
// it used to swap to the weekly / Opus wall once anything dropped into the warn zone, which made the same
// glyph mean different things at different times — you had to open the popover just to learn which window
// the number described. The other windows are still in that popover, one click away. The tightest-window
// fallback survives only for a provider that reports no 5h window at all.
function pickHeadline(windows: QuotaWindow[]): QuotaWindow {
  return windows.find((w) => w.key === "5h") ?? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
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
