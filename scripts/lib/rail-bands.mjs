/**
 * Opens the rail's Running band, which every page load starts collapsed (2026-11-11). A verifier that
 * watches a row reach, sit in or leave Running needs that band's rows drawn. It flips the app's own store,
 * the module the page already imported, so it needs a Frizz that serves its web source (an adhoc stack or
 * a fixture vite), the same as every other verifier that reaches into `/src/store.ts`.
 */
export async function openRunningBand(page) {
  await page.evaluate(async () => {
    const { store } = await import("/src/store.ts")
    store.sidebarCollapsed.running = false
  })
}
