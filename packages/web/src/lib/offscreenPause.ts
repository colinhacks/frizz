// A LIVE DOT OFF SCREEN STOPS ANIMATING. Every running sub-agent, shell and watch draws a pulsing dot
// (`.frizz-live-dot`, styles.css), and an infinite CSS animation costs the machine a frame every vsync for
// as long as it runs, whether anyone can see it or not: the renderer's compositor ticks it, the GPU process
// is handed the frame, and every iteration fires an `animationiteration` event that React's root listener
// wakes the page's main thread for. Chrome culls none of that for an element scrolled out of view: it
// keeps most such pulses OFF the GPU instead (trace `compositeFailed` 131072, "compositor property
// animations have no effect") and ticks them on the main thread.
//
// Measured 2026-11-09 on a copy of the real boards, the Console idle with its 16 dots all below the fold,
// whole-browser CPU over 60s after the page had settled: 7-8% of a core with the pulse, 0.8% with every
// animation off. A dot this ref marks is paused (`animation-play-state`, styles.css `[data-offscreen]`)
// while it is out of the viewport, which brings the page back to the floor, and resumes from the same
// phase when it scrolls in. On screen nothing changes.
//
// The rail's BoxSpinner wears the same ref (styles.css `[data-offscreen] .frizz-box-spinner-lap`). One
// observer serves every dot and spinner on the page. The attribute is written straight onto the element, so
// crossing the fold re-renders nothing.
let observer: IntersectionObserver | null = null

function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting)
  })
  return observer
}

/** A ref callback: pause the element's CSS animations while it is outside the viewport. */
export function pauseWhileOffscreen(el: Element | null): (() => void) | undefined {
  if (!el || typeof IntersectionObserver === "undefined") return undefined
  const io = sharedObserver()
  io.observe(el)
  return () => {
    io.unobserve(el)
    el.removeAttribute("data-offscreen")
  }
}
