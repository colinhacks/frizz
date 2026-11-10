import type { CSSProperties, MouseEvent } from "react"
import { Link, useLocation } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { useBoardLoaded, useQueueCards } from "../hooks.ts"
import { CONSOLE_PATH, isConsolePath } from "../lib/base-path.ts"
import { PROJECTS_HREF, type HomeView } from "../lib/homeView.ts"
import { BOARD_PAIR_CLASS, SIDEBAR_WIDTH_CLASS, WORKPANE_WIDTH_CLASS } from "../lib/boardColumns.ts"
import { RAIL_INSET_CLASS } from "./ProjectRail.tsx"
import { Z_CHROME } from "../lib/layers.ts"

// THE SWITCH BETWEEN THE TWO HOMES — the project grid (`/`) and the Console (`/console`).
//
// TWO PLACEMENTS, ONE PILL (HomeTabs). On the Console it stands at the top-left of the sidebar
// (HomeSwitcher, below: maintainer 2026-10-26, "Projects/Console needs to move to the top left at the top
// of the sidebar"), its left edge on the prompt box's border, CONSOLE_TOP_PX above the status row. On the
// grid it is the head of the page, centred over the project icons where the home screen's search field
// was mocked (ProjectGrid; maintainer 2026-11-03: "put the tab switcher for projects and console in the
// place where the search bar currently is"). From 2026-10-26 the grid drew it in the Console's corner too,
// so that a click never moved the pill out from under the pointer; the home screen gave that up for a
// page whose head is the choice between the two homes.
//
// WHERE THAT CORNER FALLS IS LAID OUT, NOT CALCULATED. The sidebar's left edge is wherever the centred
// pair of columns puts it, which depends on the window's width at every step (lib/boardColumns.ts). So
// the switcher stands in an EMPTY copy of that pair, built from the same classes, and lands where the
// Console's sidebar starts at every width — in the stacked narrow layout too, where that is the page's
// own left padding. The copy draws nothing and takes no pointer; only the pill does.
//
// On the Console it is FIXED to the window, so it stays where the operator left it however far the page
// scrolls. It FLOATS: the pill is the whole of it, translucent and blurred (maintainer 2026-10-20:
// "supposed to be FLOATING. not be in a black top bar"). Beside the Console's cards nothing passes under
// it, since the sidebar column holds still; the narrow Console's cards do, where the workpane is stacked
// under the sidebar, and there the cards' headers stick below it (lib/homeView.ts
// HOME_SWITCHER_CLEARANCE_PX, App.tsx). On the grid it sits in the page's flow and scrolls with it.
//
// The two tabs are one fixed width (HOME_TAB_PX), their words centred in them, so the pill does not grow
// and shift when the count gains a digit. It fits the sidebar at its narrowest, 272px.
//
// The Console tab carries the queue's size across every project, drawn as the rail's badge FACE (the
// rail's badge is this face plus a 1px cut-out in the rail's colour; nothing sits under it here, so the
// cut-out goes). Both the word and the digits are trimmed to their cap band, so the tab's `items-center`
// centres ink on ink rather than line box on line box.

/**
 * Each tab's width: two of them, the 2px between, 3px of padding and a 1px border a side make 234px. The
 * widest tab, "Console" with a three-digit count, needs 107px. It was 136px while the pill was centred,
 * a width chosen to keep the pill's edge off the Console cards' edge; at 282px the pill overran the
 * sidebar it now sits in at its narrowest.
 */
const HOME_TAB_PX = 112

/** The face's width per digit count — the rail's badgeWidth less its 1px cut-out each side. */
function faceWidth(count: number): number {
  return count < 10 ? 14 : count < 100 ? 20 : 26
}

const TRIM = { textBox: "trim-both cap alphabetic" } as CSSProperties

/**
 * Every project's queue, summed. On the Console it is counted off the merged board the sidebar is
 * drawing, so the tab and the Queue band beside it never disagree; on the grid it is the rail's poll.
 */
export function useQueueTotal(): number | undefined {
  const onConsole = isConsolePath()
  const board = useBoardLoaded()
  const cards = useQueueCards()
  const polled = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  if (onConsole && board) return cards.length
  if (!polled.data) return undefined
  return Object.values(polled.data).reduce((sum, counts) => sum + counts.queued, 0)
}

/** A click the router would take: the main button, no modifier. Anything else is the browser's (a new tab, a window). */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** What each home page is, in a line: a tab's tooltip. */
export const HOME_TAB_ABOUT: Record<HomeView, string> = {
  projects: "Every project on this machine",
  console: "Every project's queue on one page",
}

/** The pill itself: the two tabs, Projects and Console. Placed by HomeSwitcher on the Console and by the grid. */
export function HomeTabs({ className = "" }: { className?: string }) {
  // The tab that is lit is the page on screen. It read the KEPT home (lib/homeView.ts) until 2026-10-23,
  // which every tab shares: choosing Projects in one tab lit "Projects" over the Console in another.
  const view: HomeView = isConsolePath(useLocation().pathname) ? "console" : "projects"
  const total = useQueueTotal()
  const tab = (target: HomeView, label: string, about: string, count?: number) => {
    const selected = view === target
    // REAL LINKS, so hovering one shows its address and ⌘-click, middle-click and "Open link in new tab"
    // work. They were buttons until 2026-10-23. Neither tab needs to record the choice: each page records
    // it on arrival (routes.tsx ConsoleRoute, GridPage), and the Projects tab names the grid's own address
    // because `/` forwards to the Console while that is the kept home.
    return (
      <Link
        to={target === "console" ? CONSOLE_PATH : PROJECTS_HREF}
        role="tab"
        aria-selected={selected}
        data-home-tab={target}
        // What the page is, for whoever has not opened it: nothing else on a new install says what
        // "Console" means. The browser's own delayed tooltip, since the pill is crossed constantly.
        title={about}
        // The page you are on: a plain click stays put, as it did when the tabs were buttons, rather than
        // closing whatever thread the Console has open. A new tab still opens.
        onClick={(event) => { if (selected && isPlainClick(event)) event.preventDefault() }}
        className={`flex h-7 items-center justify-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
          selected ? "bg-hover-strong text-fg shadow-[inset_0_0_0_1px_var(--hover-strong)]" : "text-muted hover:text-fg"
        }`}
        style={{ width: HOME_TAB_PX }}
      >
        <span className="block" style={TRIM}>{label}</span>
        {count ? (
          <span
            aria-label={`${count} in the queue`}
            data-home-queue-count={count}
            className="ml-1.5 flex h-[14px] shrink-0 items-center justify-center rounded-full bg-accent-fill text-[10px] font-semibold leading-none proportional-nums text-on-accent"
            style={{ width: faceWidth(count) }}
          >
            <span style={TRIM}>{count}</span>
          </span>
        ) : null}
      </Link>
    )
  }
  return (
    <div
      role="tablist"
      aria-label="Home"
      data-home-switcher
      className={`flex w-fit gap-0.5 rounded-full border border-border-strong bg-elevated/80 p-[3px] shadow-lg shadow-shadow-ink/40 backdrop-blur-md ${className}`}
    >
      {tab("projects", "Projects", HOME_TAB_ABOUT.projects)}
      {tab("console", "Console", HOME_TAB_ABOUT.console, total)}
    </div>
  )
}

/** The Console's placement: fixed, in the corner where its sidebar starts. `sidebarInset` is for a layout
 *  whose sidebar is not the centred pair's: how far in from the window's left edge the pill stands, as a
 *  CSS length of the page (the one-thread pane). */
export function HomeSwitcher({ railVisible, sidebarInset }: { railVisible: boolean; sidebarInset?: string }) {
  return (
    // The empty copy of the board's two columns, inset by the rail as the page is (routes.tsx RootLayout),
    // with the pill in the sidebar's slot. It is the window's width and takes no pointer, so nothing under
    // it stops being clickable.
    <div data-home-switcher-frame className={`pointer-events-none fixed inset-x-0 top-[14px] ${Z_CHROME} ${railVisible ? RAIL_INSET_CLASS : ""}`}>
      {sidebarInset !== undefined ? (
        <div style={{ paddingLeft: sidebarInset }}>
          <HomeTabs className="pointer-events-auto ml-0.5" />
        </div>
      ) : (
      <div className={BOARD_PAIR_CLASS}>
        <div className={SIDEBAR_WIDTH_CLASS}>
          {/* `ml-0.5`: the sidebar's prompt box is inset 2px in its column (ConsoleSidebar's `px-0.5`), and the
              pill's border stands on the box's border. */}
          <HomeTabs className="pointer-events-auto ml-0.5" />
        </div>
        <div className={WORKPANE_WIDTH_CLASS} />
      </div>
      )}
    </div>
  )
}
