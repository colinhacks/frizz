// frizz.sh's appearance. Dark unless this browser chose light with the footer's theme button, whatever the OS
// prefers (maintainer 2026-11-22). Loaded without defer or async in every page's <head>, so html[data-theme]
// is set before the first paint and a light page never flashes dark.
;(() => {
  const KEY = "frizz-theme"
  const root = document.documentElement
  const apply = (theme) => {
    root.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#fbfbfb" : "#09090b")
    for (const button of document.querySelectorAll("[data-theme-toggle]")) button.textContent = theme === "light" ? "Dark theme" : "Light theme"
  }
  let theme = "dark"
  try { if (localStorage.getItem(KEY) === "light") theme = "light" } catch {}
  apply(theme)
  // The button is below this script, so its label is set once the page has parsed.
  addEventListener("DOMContentLoaded", () => apply(root.dataset.theme))
  addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-theme-toggle]")) return
    const next = root.dataset.theme === "light" ? "dark" : "light"
    try { next === "light" ? localStorage.setItem(KEY, "light") : localStorage.removeItem(KEY) } catch {}
    apply(next)
  })
})()
