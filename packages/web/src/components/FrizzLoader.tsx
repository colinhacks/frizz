import { FRIZZ_MARK_PATH, FRIZZ_MARK_STROKE, FRIZZ_MARK_VIEWBOX } from "./frizzMarkPath.ts"

// THE PAGE LOADER: the fff mark WRITING ITSELF, for the wait before a board's first snapshot (App.tsx).
// It replaced a 20px grey ring on 2026-11-02 (maintainer: "make it more prominent/interesting"). The mark is
// one continuous stroke (assets/logo-concepts/build-fff.mjs), so a single dash travelling its length
// writes it the way it was drawn: in from the left, a held beat on the finished mark, then the pen lifts
// off the same way and starts again. A faint copy underneath keeps the shape legible mid-stroke.
// The motion lives in styles.css § The page loader, with its reduced-motion form.
export function FrizzLoader({ label, size = 96 }: { label: string; size?: number }) {
  return (
    <div role="status" aria-label={label} className="frizz-loader" style={{ width: size, height: size }}>
      <svg viewBox={FRIZZ_MARK_VIEWBOX} width={size} height={size} overflow="visible" aria-hidden className="block">
        <path className="frizz-loader-track" d={FRIZZ_MARK_PATH} strokeWidth={FRIZZ_MARK_STROKE} />
        {/* pathLength 1 makes the dash pattern a fraction of the stroke, whatever its real length. */}
        <path className="frizz-loader-pen" d={FRIZZ_MARK_PATH} strokeWidth={FRIZZ_MARK_STROKE} pathLength={1} />
      </svg>
    </div>
  )
}
