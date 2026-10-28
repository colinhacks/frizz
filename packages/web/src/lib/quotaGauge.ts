import type { QuotaWindow } from "@frizz/shared"

// THE FUEL GAUGE's arithmetic (components/QuotaBar.tsx QuotaGauge): which of a provider's quota windows
// it reads for the model the prompt box has selected, and where on its dial that reading lands. Pure, so
// both halves are pinned by a test rather than by eye.

/**
 * The Claude model FAMILY a quota window can be scoped to: `opus`, `sonnet`, `fable`, `haiku`.
 *
 * Claude reports a weekly cap per model beside the general one (`weekly-opus`, `weekly-sonnet`, and
 * from the modern `limits[]` body a slug of the model's display name, so `weekly-fable` or
 * `weekly-fable-5-1` — server backend/claude-quota.ts). The prompt box's model is an alias, and its
 * leading letters are the family those keys carry. Codex reports no per-model windows, so a Codex model
 * has no family and only its account-wide windows apply.
 */
export function modelFamily(backend: string, model: string | undefined): string | undefined {
  if (backend !== "claude" || !model) return undefined
  return /^[a-z]+/.exec(model.toLowerCase())?.[0]
}

// The remaining % at/below which a window is no longer "a good amount of quota": it enters the warn zone,
// where the gauge's tone drops the calm neutral for the amber alarm — and where a longer cap than the 5h
// window starts to earn the gauge (gaugeWindow).
export const HEALTHY_MIN = 25

/**
 * The window the gauge reads: the 5h window, unless a longer cap binding the selected model is in the
 * warn zone (HEALTHY_MIN or less left) with less left than the 5h window — then the tightest such cap.
 *
 * A window binds the model unless it is a weekly cap scoped to a DIFFERENT model: the 5h session and the
 * general weekly bind every model, an unfamiliar future cap might bind any of them, and `weekly-opus`
 * binds Opus alone. So choosing Sonnet over Opus changes the reading exactly when Opus's own weekly cap
 * is the one running out (maintainer 2026-10-26: "it should show usage for the model that's currently
 * selected in the prompt box").
 *
 * It read the tightest PERCENTAGE among those windows until 2026-10-28, and that put the weekly on the
 * gauge for most of the week (maintainer: "The fuel gauge icon often is just showing me my weekly limit
 * when 5 hours would be far more relevant"). Percentages are not comparable across windows: 40% of a
 * week's allowance is several 5h windows' worth, so a weekly with less left than the 5h window is usually
 * still not the wall the next turn meets. A longer cap takes the gauge only once it is low enough to be
 * a warning, and since that is the threshold the gauge turns amber at, the colour announces the switch.
 * The breakdown behind the gauge lists every window either way, the one it reads in full fg.
 *
 * With no 5h window to default to (a provider that reports only longer caps), the tightest binding cap
 * is the reading. Equal readings keep the earlier window.
 */
export function gaugeWindow(windows: readonly QuotaWindow[], family: string | undefined): QuotaWindow | undefined {
  const scopedElsewhere = (key: string) =>
    key.startsWith("weekly-") && !(family && (key === `weekly-${family}` || key.startsWith(`weekly-${family}-`)))
  const binding = windows.filter((w) => !scopedElsewhere(w.key))
  const pool = binding.length > 0 ? binding : windows
  if (pool.length === 0) return undefined
  const tightest = pool.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
  const session = pool.find((w) => w.key === "5h")
  return session && remainingPercent(tightest) > HEALTHY_MIN ? session : tightest
}

/** Percent REMAINING in a window, clamped to a whole 0–100. */
export function remainingPercent(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))
}

// THE DIAL, in a lucide-style 24-unit box. The arc is lucide's own `gauge` — radius 10, 240° from the lower
// left, over the top, to the lower right — so the glyph reads as a gauge at a glance and paints as much
// of its box as the row's gear and reload glyphs do. Angles are screen degrees: clockwise from +x, with
// y pointing down.
//
// E is the lower-left end and F the lower-right, as on a car's fuel gauge: the needle and the lit arc
// climb from E toward F as quota remains. The centre sits half a unit low because the sweep leaves the
// bottom 120° open: its ink then spans y 3.5–20.5, centred in the box. The needle swings from a filled
// hub, without which a 14px needle read as a loose dash floating inside the arc.
export const GAUGE = { cx: 12, cy: 14.5, r: 10, start: 150, sweep: 240, needle: 6.5, hub: 2 } as const

function polar(angle: number, r: number): [number, number] {
  const rad = (angle * Math.PI) / 180
  // Rounded to a hundredth of a unit: the path strings stay short and stable across renders.
  const round = (n: number) => Math.round(n * 100) / 100
  return [round(GAUGE.cx + r * Math.cos(rad)), round(GAUGE.cy + r * Math.sin(rad))]
}

/** The dial angle a remaining percentage points at: `start` at 0%, `start + sweep` at 100%. */
export function gaugeAngle(remaining: number): number {
  return GAUGE.start + (GAUGE.sweep * Math.max(0, Math.min(100, remaining))) / 100
}

/** An SVG arc along the dial from one angle to another, clockwise. Empty when they coincide. */
export function gaugeArc(from: number, to: number): string {
  if (to - from <= 0) return ""
  const [x1, y1] = polar(from, GAUGE.r)
  const [x2, y2] = polar(to, GAUGE.r)
  const large = to - from > 180 ? 1 : 0
  return `M${x1} ${y1}A${GAUGE.r} ${GAUGE.r} 0 ${large} 1 ${x2} ${y2}`
}

/** The needle: from the hub toward the dial at the reading's angle, stopping short of the arc. */
export function gaugeNeedle(remaining: number): string {
  const [x, y] = polar(gaugeAngle(remaining), GAUGE.needle)
  return `M${GAUGE.cx} ${GAUGE.cy}L${x} ${y}`
}
