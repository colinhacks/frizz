import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { ModalSurface } from "./components/ui/ModalSurface.tsx"
import { Z_MODAL } from "./lib/layers.ts"

// WHERE THE FOCUS GOES WHEN A FULL-SCREEN SURFACE CLOSES (lib/restoreFocus.ts), on the real
// ui/ModalSurface in a real browser. Two surfaces stand in for the app's: A is opened from a button on
// the page, as Settings and ⌘K are, and B is opened from inside A, either over it or in its place (⌘K's
// "Settings" closes the palette as Settings opens). Escape closes the top one, as the app's chain does.
function Fixture() {
  const [a, setA] = useState(false)
  const [b, setB] = useState(false)
  const [openerShown, setOpenerShown] = useState(true)
  const [went, setWent] = useState(0)
  // Reset as A OPENS, the way ⌘K resets its own: it is read after the surface has gone.
  const ranCommand = useRef(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (b) setB(false)
      else setA(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [b])
  const button = "rounded border border-border px-3 py-1.5 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
  return (
    <div className="flex min-h-screen flex-col items-start gap-3 bg-bg p-8 text-sm text-fg">
      <a href="#first" data-first-link className="underline">The first link on the page</a>
      {openerShown && (
        <button data-open-a className={button} onClick={() => { ranCommand.current = false; setA(true) }}>Open A</button>
      )}
      <button data-other className={button}>Somewhere else</button>
      {went > 0 && <TakesFocus key={went} />}
      {a && (
        <ModalSurface
          label="Surface A"
          data-surface-a
          returnsFocus={() => !ranCommand.current}
          className={`fixed inset-0 ${Z_MODAL} flex flex-col items-start gap-3 bg-panel p-8`}
        >
          <input data-autofocus data-a-input aria-label="A's field" className="rounded border border-border bg-transparent px-2 py-1" />
          <button data-close-a className={button} onClick={() => setA(false)}>Close A</button>
          <button data-b-over-a className={button} onClick={() => setB(true)}>Open B over A</button>
          <button data-b-instead className={button} onClick={() => { setB(true); setA(false) }}>Open B in A's place</button>
          {/* A close that is a NAVIGATION: what it opens takes the focus as it mounts, in the commit
              that removes the surface, the way a thread's drawer does when ⌘K picks a thread. (A
              `focus()` in this handler would prove nothing: the surface's focus trap is still up and
              pulls it straight back.) */}
          <button data-close-and-go className={button} onClick={() => { setA(false); setWent((n) => n + 1) }}>
            Close A and go somewhere else
          </button>
          {/* A close the surface says is not a dismissal (⌘K after running a command). */}
          <button data-run-command className={button} onClick={() => { ranCommand.current = true; setA(false) }}>
            Run a command and close A
          </button>
          {/* The opener leaves the page while the surface is open (a row archived under Settings). */}
          <button data-close-without-opener className={button} onClick={() => { setOpenerShown(false); setA(false) }}>
            Close A, its opener gone
          </button>
        </ModalSurface>
      )}
      {b && (
        <ModalSurface label="Surface B" data-surface-b className={`fixed inset-0 ${Z_MODAL} flex flex-col items-start gap-3 bg-panel-2 p-8`}>
          <input data-autofocus data-b-input aria-label="B's field" className="rounded border border-border bg-transparent px-2 py-1" />
          <button data-close-b className={button} onClick={() => setB(false)}>Close B</button>
        </ModalSurface>
      )}
    </div>
  )
}

/** Stands in for a layer that focuses itself when it mounts. */
function TakesFocus() {
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-other]")?.focus()
  }, [])
  return null
}

createRoot(document.getElementById("root")!).render(<Fixture />)
