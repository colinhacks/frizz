// THE BAND AT THE BOTTOM OF THE SCREEN THAT THE QUEUE'S DOCKED PROMPT BOXES COVER, published as
// `--queue-dock-inset` on <html> so everything else that lives at the viewport bottom stands clear of it:
//
// - the page's `scroll-padding-bottom` (styles.css), so a control focused by Tab under a dock is
//   scrolled out from beneath it rather than left hidden behind the box that covers it;
// - the toaster (Toaster.tsx), which sat on top of the dock's send button and Goal.
//
// The /full thread page publishes its prompt box's footer the same way while it is one column
// (StandaloneThreadPage): below the split, the window's bottom-right corner is that box's Send.
//
// Every queue card docks its own box; they are all the same shape, so the tallest one is the inset. A
// textarea grows to its 220px cap while the operator types, which is why this observes rather than
// reading the height once. No card, no dock: the inset is 0.
//
// The phone never renders a queue card, but its board's floating "New thread" button holds the same
// corner (MobileBoard, trackBottomFloat below). A toast there covered 59-69% of the button, and an Undo
// toast's pill took a tap meant for it (2026-11-01).
const heights = new Map<string, number>()

function publish(): void {
  const inset = heights.size === 0 ? 0 : Math.max(...heights.values())
  if (inset > 0) document.documentElement.style.setProperty("--queue-dock-inset", `${inset}px`)
  else document.documentElement.style.removeProperty("--queue-dock-inset")
}

export function trackQueueDock(slug: string, dock: HTMLElement): () => void {
  const observer = new ResizeObserver(() => {
    heights.set(slug, dock.getBoundingClientRect().height)
    publish()
  })
  observer.observe(dock)
  return () => {
    observer.disconnect()
    heights.delete(slug)
    publish()
  }
}

// A control that FLOATS above the window's bottom edge rather than docking on it: its band runs from its
// top down to the edge, gap included. It is `fixed`, so only its own size and the window's move it.
export function trackBottomFloat(key: string, el: HTMLElement): () => void {
  const measure = () => {
    heights.set(key, Math.max(0, document.documentElement.clientHeight - el.getBoundingClientRect().top))
    publish()
  }
  const observer = new ResizeObserver(measure)
  observer.observe(el)
  window.addEventListener("resize", measure)
  return () => {
    observer.disconnect()
    window.removeEventListener("resize", measure)
    heights.delete(key)
    publish()
  }
}
