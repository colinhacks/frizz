/**
 * Opens the rail's Running band. It opens by default (2026-11-14), but the fold is remembered per project
 * in localStorage, so a verifier that watches a row reach, sit in or leave Running opens it explicitly
 * rather than trusting whatever the profile holds. It calls the app's own fold store, the module the page
 * already imported, so it needs a Frizz that serves its web source (an adhoc stack or a fixture vite), the
 * same as every other verifier that reaches into `/src/…`.
 */
export async function openRunningBand(page) {
  await page.evaluate(async () => {
    const { setBandFolded } = await import("/src/lib/sidebarBands.ts")
    setBandFolded("running", false)
  })
}
