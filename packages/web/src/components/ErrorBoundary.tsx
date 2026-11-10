import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { store } from "../store.ts"

// THE WINDOW MUST NEVER GO BLANK.
//
// React unmounts the ENTIRE root when a render throws and nothing catches it, so until this file
// existed one bad component took the whole app down to an empty page — no message, no way back,
// nothing left on screen to report it with. That is not hypothetical: a promoted artifact captured
// ChatView.tsx between two edits (its unqueue hooks called, their `import` line not yet written),
// the bundler emitted the calls as free identifiers because a free identifier is legal JS, and
// opening a thread drawer threw `ReferenceError: useUnqueueSupported is not defined` — board,
// sidebar, drawer, all gone at once. Frizz builds its own artifacts from a working tree several
// agents are editing at the same time, so a torn build is a permanent hazard here, not an accident
// that got fixed once.
//
// So the blast radius of a render error is now the SURFACE that failed, never the window. The
// sidebar, the pane's thread, the full-screen page's thread and every drawer layer catch their own; the
// root catches whatever is left. A broken thread leaves the sidebar, so another thread is one click
// away; a broken drawer leaves the board usable and closable. Each fallback carries the error text,
// because the operator reading it is the person who will fix it.
//
// "THE ROOT" IS TWO PLACES. react-router catches a throw under a route itself, before the boundary
// around the router in main.tsx can see it, and a route with no `errorElement` draws the library's own
// page for developers ("Unexpected Application Error! … Hey developer"). That page is what a throw in
// the pane's thread drew from 2026-11-09, when the one-thread pane replaced the queue and its boundary
// went with it, until 2026-11-10. Every top-level route names `RouteError` (routes.tsx), which draws
// the same page as RootErrorBoundary; the boundary in main.tsx is left for a throw outside any route.

type Props = {
  children: ReactNode
  /** Names the failed surface in the fallback copy and the console line — "the queue", "this drawer". */
  label: string
  /** Rendered instead of the default panel. Gets the error and a retry that re-mounts the children. */
  fallback?: (error: Error, retry: () => void) => ReactNode
  /**
   * Re-mount the children when any of these change. Opening a DIFFERENT thread is a genuinely new
   * render, and a boundary that stayed latched would show the previous thread's error over it
   * forever — the surface would look permanently broken when only one payload ever was.
   */
  resetKeys?: readonly unknown[]
}

type State = { error: Error | null }

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Frizz is a developer tool run against its own source, so the stack IS the deliverable. Keep it
    // in the console verbatim rather than losing it inside the fallback's one-line summary.
    console.error(`[frizz] render error in ${this.props.label}:`, error, info.componentStack)
  }

  override componentDidUpdate(previous: Props): void {
    if (!this.state.error || sameKeys(previous.resetKeys, this.props.resetKeys)) return
    this.setState({ error: null })
  }

  private retry = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.retry)
    return <ErrorPanel label={this.props.label} error={error} onRetry={this.retry} />
  }
}

// A thrown non-Error (a string, a rejected value) still has to read as something. Keep it short —
// the full object and its component stack are already in the console.
function errorLine(error: Error): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const ACTION_CLASS =
  "shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel"

/** The default fallback: a quiet bordered card that states what broke, why, and the two ways out. */
export function ErrorPanel({
  label,
  error,
  onRetry,
  onClose,
}: {
  label: string
  error: Error
  onRetry: () => void
  onClose?: () => void
}): ReactElement {
  return (
    <div data-error-panel className="m-4 rounded-md border border-border-strong bg-panel-2 px-3.5 py-3 text-[12.5px]">
      <p className="text-fg/90">Something went wrong rendering {label}.</p>
      <p className="font-mono-keep mt-1.5 break-words text-[11.5px] text-muted">{errorLine(error)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={ACTION_CLASS} onClick={onRetry}>
          Try again
        </button>
        {onClose && (
          <button type="button" className={ACTION_CLASS} onClick={onClose}>
            Close
          </button>
        )}
        <button type="button" className={ACTION_CLASS} onClick={() => window.location.reload()}>
          Reload Frizz
        </button>
      </div>
    </div>
  )
}

/**
 * The LAST-RESORT boundary around the whole app. Its fallback owns the viewport because by
 * definition there is no app chrome left to sit inside — but it is still a readable page with the
 * error on it, which is the entire difference between this and the blank screen.
 */
export function RootErrorBoundary({ children }: { children: ReactNode }): ReactElement {
  return (
    <ErrorBoundary label="Frizz" fallback={(error, retry) => <RootErrorPage error={error} onRetry={retry} />}>
      {children}
    </ErrorBoundary>
  )
}

/** The page the last resort draws: RootErrorBoundary's fallback, and a route's `errorElement`. */
export function RootErrorPage({ error, onRetry }: { error: Error; onRetry: () => void }): ReactElement {
  return (
    <div data-root-error className="flex min-h-screen items-center justify-center bg-bg p-6 text-fg">
      <div className="w-full max-w-lg">
        <ErrorPanel label="Frizz" error={error} onRetry={onRetry} />
      </div>
    </div>
  )
}

/**
 * The fallback for ONE drawer layer. It re-mounts the shared Sheet at the same geometry, so a drawer
 * whose body threw still slides in as a normal drawer with a working close button and an Esc
 * binding — the operator dismisses it and the board underneath is untouched. Closing removes the
 * stack entry outright rather than going through the animated closer: the layer that registered
 * that closer is exactly the one that just failed to render.
 */
export function DrawerErrorSheet({
  id,
  depth,
  widthDepth,
  error,
  onRetry,
}: {
  id: number
  depth: number
  widthDepth: number
  error: Error
  onRetry: () => void
}): ReactElement {
  const drop = () => {
    store.drawers = store.drawers.filter((drawer) => drawer.id !== id)
  }
  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader title="This drawer could not be rendered" onClose={() => { close(); drop() }} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ErrorPanel label="this drawer" error={error} onRetry={onRetry} onClose={drop} />
          </div>
        </>
      )}
    </Sheet>
  )
}
