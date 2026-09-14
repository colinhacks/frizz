// VERIFICATION FIXTURE for the shipped hover timestamp — not a mockup, and not a hand-rebuilt copy.
//
// It imports the REAL `MessageRow` from `components/MessageTimestamp.tsx` and the REAL `messageStamp`
// from `lib/activityTime.ts`, on the REAL stylesheet, so what renders here is the code that ships.
//
// It also reproduces the one thing a plain fixture would miss: the transcript's rows are
// `absolute … transform: translateY()` (ChatView's virtualizer), which makes EVERY ROW ITS OWN
// STACKING CONTEXT. That is why the reveal — drawn past its row's bottom edge, into the gap the next
// row owns as its top padding — needs a `hover:z-[1]` lift on the row wrapper to avoid being painted
// underneath. The rows below are stacked exactly that way, at the two gaps that actually occur
// (STEP 14px and META_CARD_STEP 6px), so the failure this guards against is reproduced, not imagined.
//
//   nub exec vite build   then open the inlined bundle
//   (a dev server needs listen(), which this sandbox refuses — hence the static build)
//   ?hover=<n>     paints row n as if hovered, because a camera cannot hold a pointer
//                  (?hover=1 is the tight case — a reading lands in the NEXT row's gap, and row 2's is 6px)
//   ?hover=band    the same for the pinned current-ask band, which is not a [data-verify-row]
import { createRoot } from "react-dom/client"
import { MessageRow, MessageStamp } from "./components/MessageTimestamp.tsx"
import { messageStamp } from "./lib/activityTime.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
// `?hover=band` targets the pinned band, `?hover=<n>` an ordinary row. The band needs its own value
// because it is not a `[data-verify-row]` — it is hoisted out of the absolute layer, which is the whole
// point of it — and while it went unphotographable its reading sat 6px lower than every other row's
// without anyone noticing (2026-08-28).
const HOVER = params.get("hover")
const FORCED = HOVER !== null && HOVER !== "band" ? Number(HOVER) : -1
// The reveal is opacity-driven off a real `:hover`, and a camera cannot hold a pointer. Force the ONE
// element under test from OUTSIDE the component — a stylesheet override on its row — rather than adding
// a prop to `MessageRow` that exists only for photography. What renders is still the shipped element,
// at the shipped opacity, in the shipped position.
const forcedSelector = HOVER === "band" ? "[data-verify-band]" : FORCED >= 0 ? `[data-verify-row="${FORCED}"]` : null
if (forcedSelector) {
  const style = document.createElement("style")
  style.textContent = `${forcedSelector} time { opacity: 1 !important; }`
  document.head.appendChild(style)
}

const iso = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

// A day apart at nearly the same clock time — the case the unconditional date exists for, and the one
// a bare "10:31 AM" could not tell apart.
const ROWS = [
  { at: iso(1, 17, 42), gap: 14, kind: "user", h: 47, text: "Check whether auto-merge actually armed on #3778 — the queue said false again." },
  // ROW 1 IS THE TIGHT CASE — `?hover=1`, not `?hover=2`. A row carries its OWN top gap, but its
  // reading is drawn past its BOTTOM edge, into the gap the NEXT row owns. So the reveal that has to
  // survive META_CARD_STEP (6px, well under the 16px reading) is this row's, because row 2 below it
  // is the 6px one. Row 2's own reading lands in row 3's ordinary 14px step.
  { at: iso(0, 9, 14), gap: 14, kind: "agent", h: 30, text: "CI green (85 checks) and mergeState=CLEAN, but auto-merge shows false again. Let me re-arm it." },
  { at: iso(0, 9, 27), gap: 6, kind: "meta", h: 20, text: "Ran 5 tool calls" },
  { at: iso(0, 10, 31), gap: 14, kind: "agent", h: 52, text: "Already queued — auto=false is just how the queue reports it once it takes the PR. CI is fully green and the state is CLEAN, so it's waiting its turn." },
]

function Body({ kind, text }: { kind: string; text: string }) {
  if (kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-bg">{text}</div>
      </div>
    )
  }
  if (kind === "meta") return <div className="text-[14px] leading-5 text-muted">{text}</div>
  return <div className="text-[13px] leading-6 text-fg">{text}</div>
}

function Sheet() {
  let top = 0
  const placed = ROWS.map((r) => {
    const y = top
    top += r.gap + r.h
    return { ...r, y }
  })
  return (
    <div className="mx-auto w-[min(900px,calc(100%-48px))] py-10">
      <h1 className="mb-1 text-[15px] font-semibold text-fg">Trailing reveal — the shipped component</h1>
      <p className="mb-8 max-w-[92ch] text-[12px] leading-5 text-muted-80">
        Real <code className="text-muted-60">MessageRow</code> and real <code className="text-muted-60">messageStamp</code>, on the real
        stylesheet, in transform-positioned rows that reproduce the transcript's virtualizer — so the stacking the reveal depends on is
        genuinely exercised. Hover row 1 (<code className="text-muted-60">?hover=1</code>) for the tight case: its reading is
        drawn into row 2's 6px <code className="text-muted-60">META_CARD_STEP</code> gap, which is where it overflows furthest into
        its neighbour and where the stacking lift has to hold.
      </p>
      {/* A SCROLL PANE with a pinned band, because the row lift has a second job beyond clearing its
          neighbour: it must not clear the pinned current-ask. ChatView hoists that row into normal flow
          as `pointer-events-none … sticky top-0 z-[9]` with a `pointer-events-auto` bubble, so a
          pointer in its transparent strip falls through to the row behind — and a row that lifts ABOVE
          9 then covers the bubble and swallows its hover-to-expand. Reproduced here so the value on the
          rows is exercised against the band rather than asserted. */}
      <div className="relative overflow-y-auto rounded-lg border border-border/60 bg-bg" style={{ height: 260 }}>
        <div className="group/ts pointer-events-none [&>*]:pointer-events-auto sticky top-0 z-[9] flex w-full flex-col pt-3 pb-1.5" data-verify-band>
          {/* The inner wrapper is not decoration — it is the reading's containing block, and it must
              mirror ChatView exactly (`px-6` down here, not on the band) or this fixture measures a
              shape that does not ship. `top-full` and `right-6` both resolve against the PADDING
              box: with the band as the containing block the reading hung a further `pb-1.5` (6px)
              down and read as the NEXT row's, and with `px-6` left on the band it sat 48px from the
              edge instead of 24px. */}
          <div className="!pointer-events-none relative flex w-full flex-col px-6 [&>*]:pointer-events-auto">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-bg" data-verify-bubble>
                The pinned current ask — it must keep its own hover while a row below is hovered.
              </div>
            </div>
            <MessageStamp at={ROWS[0].at} host="bubble" />
          </div>
        </div>
        <div className="relative w-full" style={{ height: top + 56 }}>
        {placed.map((r, i) => (
          <div
            key={i}
            className={`absolute left-0 top-0 w-full hover:z-[1] ${i === FORCED ? "z-[1]" : ""}`}
            style={{ transform: `translateY(${r.y}px)` }}
            data-verify-row={i}
          >
            <MessageRow at={r.at} host={r.kind === "user" ? "bubble" : "prose"} gap={r.gap}>
              <Body kind={r.kind} text={r.text} />
            </MessageRow>
          </div>
        ))}
        </div>
      </div>
      <p className="mt-6 text-[12px] leading-5 text-muted-80">
        Readings this build produces: {ROWS.map((r) => messageStamp(r.at)).join("   ·   ")}
      </p>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
