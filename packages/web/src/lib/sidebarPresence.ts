import type { BoardSnapshot } from "@frizz/shared"

export type SidebarPresence = {
  projectDir: string | null
  hasBeenVisible: boolean
}

// A board keyframe is a point-in-time transport snapshot, not a declaration that the workspace lost
// its navigation. In particular, a reconnect/rebuild can briefly report no Frizz-owned rows while a
// live delta or the next keyframe repopulates them. Keep the desktop rail mounted after this project
// has had something to navigate; only a genuinely fresh project retains the centered first-task view.
export function nextSidebarPresence(
  previous: SidebarPresence,
  // How many threads, not the threads: App reads this off useBoardIsEmpty rather than walk the tracked
  // board's threads array, which costs proxy-compare a pass over every slot each time a delta replaces it.
  board: (Pick<BoardSnapshot, "projectDir"> & { threadCount: number }) | null,
): SidebarPresence {
  if (!board) return previous
  const projectChanged = previous.projectDir !== board.projectDir
  // FOREIGN SESSIONS COUNT (2026-08-19, reversing the earlier rule that they did not). They used to be
  // discounted because nothing rendered them, so a board holding only terminal sessions was blank in
  // every meaningful sense. Now they have their own rail band — and the project where that band matters
  // MOST is exactly the one this predicate used to call fresh: a repo you have worked in from the
  // terminal and never dispatched a frizz thread in. Discounting them there hid the only surface that
  // could show them. A truly empty board — no threads of any origin — still gets the centered
  // first-task view.
  const hasWorkspaceContent = board.threadCount > 0
  return {
    projectDir: board.projectDir,
    hasBeenVisible: projectChanged ? hasWorkspaceContent : previous.hasBeenVisible || hasWorkspaceContent,
  }
}

/**
 * The last answer per project, so a reload can RESERVE the sidebar's column before the board arrives.
 *
 * `hasBeenVisible` is derived from the board, and the board is a socket push that lands a beat after
 * React's first render. Until then App painted the workpane centered ALONE, then mounted the sidebar
 * and shoved the workpane 269px right on every reload of a populated project (measured 2026-08-25,
 * 1440px viewport: workpane left 360 → 629). Same cure as the font and the project rail: remember the
 * server's last answer in this browser, and let the first frame use it. Keyed by the project the
 * page names (`projectSlug()`, "" for the unprefixed launching project — the same scope
 * lib/queryKeyScope.ts uses), because it is a per-PROJECT fact on a one-origin app. A project never
 * loaded in this browser gets the fresh-workspace shell, which is what it would have got anyway.
 */
const MIRROR_PREFIX = "frizz-sidebar-seen:"

/** The Console's key in the mirror. No project's slug can be it: a slug has no `@`. */
export const CONSOLE_MIRROR = "@console"

export function readSidebarMirror(slug: string | undefined): boolean {
  try {
    return localStorage.getItem(MIRROR_PREFIX + (slug ?? "")) === "1"
  } catch {
    return false
  }
}

export function writeSidebarMirror(slug: string | undefined, seen: boolean): void {
  try {
    localStorage.setItem(MIRROR_PREFIX + (slug ?? ""), seen ? "1" : "0")
  } catch {
    // storage unavailable — the next load starts from the fresh-workspace shell, as before
  }
}
