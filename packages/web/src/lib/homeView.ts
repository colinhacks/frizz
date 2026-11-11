import { proxy, useSnapshot } from "valtio"

// WHICH HOME THE OPERATOR KEEPS — the project grid at `/`, or the Console at `/console`.
//
// Both are "home": the grid's Console link goes one way and a house goes back, the choice is remembered
// in this browser, and a bare `/` forwards to the Console while that is the one kept (routes.tsx
// GridRoute). The page records the choice on ARRIVAL: `/console` records the Console, and the grid records
// Projects when it is reached through PROJECTS_HREF, the address that says it was chosen.
//
// No switcher stands between them. A Projects | Console pill headed both pages from 2026-10-20 until
// 2026-11-10 (maintainer: "I kind of don't think that the console page should have the switcher. I think
// we just drop the entire tab switcher between console and the projects page").
//
// THE HOUSE IS NOT A WAY TO THE KEPT HOME. Every house — the rail's, a project's status row, the
// Console's — always goes to the grid, through PROJECTS_HREF (maintainer 2026-10-27: "Clicking the home
// button … should always bring you to the root / not /console"). They followed the kept home until then,
// so with the Console kept the house sent the operator to the page they were already on, or back to it
// from a project.

export type HomeView = "projects" | "console"

const CHOSEN_PARAM = "home"

/**
 * The grid, as an address that says the operator chose it: `/?home=projects`. Every house links here
 * rather than to `/`, which forwards to the Console while that is the kept home, so a link opened in a new
 * tab (or followed from a copied link) would have landed back on the Console. The grid records the choice
 * and strips the marker (routes.tsx GridPage).
 */
export const PROJECTS_HREF = `/?${CHOSEN_PARAM}=projects`

/** Did this arrival at the grid come through PROJECTS_HREF? */
export function choseProjects(search: string): boolean {
  return new URLSearchParams(search).get(CHOSEN_PARAM) === "projects"
}

/** `search` with the PROJECTS_HREF marker taken out, ready for the address bar. */
export function withoutProjectsChoice(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(CHOSEN_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

const KEY = "frizz:home-view"

function read(): HomeView {
  try {
    return localStorage.getItem(KEY) === "console" ? "console" : "projects"
  } catch {
    return "projects"
  }
}

const home = proxy({ view: typeof window === "undefined" ? ("projects" as HomeView) : read() })

// Guarded for the unit tests, which import the store (and so this) under a stubbed `window`.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Another tab chose: follow it, so a bare `/` opened here goes where the operator last went anywhere.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) home.view = read()
  })
}

export function homeView(): HomeView {
  return home.view
}

export function setHomeView(view: HomeView): void {
  if (home.view !== view) home.view = view
  try {
    localStorage.setItem(KEY, view)
  } catch {
    // Storage refused (a private window): the choice holds for this page and is not remembered.
  }
}

export function useHomeView(): HomeView {
  return useSnapshot(home).view
}
