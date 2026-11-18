// The app's only way to reload this document or send it to another address. Every call goes through the
// gate index.html defines before any module runs (`frizzNavigate`), which counts the moves no click or
// keypress is behind and stops a page that keeps sending itself somewhere: past five in a minute or twelve
// in half an hour it offers a Reload button instead of going. navigation.guard.test.ts fails on a
// `location.reload`, `.replace`, `.assign` or `location.href =` anywhere else in the app.
//
// The gate exists because one did not: on 2026-11-18 a board on frizz.sh reloaded itself every two
// seconds for as long as it was open, through a path that reset its own backoff each time it booted.

type Gate = (to: string | null, options: { replace?: boolean; reason: string }) => boolean

export interface NavigateOptions {
  /** Replace this history entry rather than adding one. */
  replace?: boolean
  /** Why the page is moving, said in the console if the gate refuses. */
  reason: string
}

/**
 * Load `to`, or this page again when `to` is null. False when the gate refused: the page stays where it
 * is, under a panel that says so.
 */
export function navigate(to: string | null, options: NavigateOptions): boolean {
  const gate = typeof window === "undefined" ? undefined : (window as { frizzNavigate?: Gate }).frizzNavigate
  if (gate) return gate(to, options)
  // No index.html behind this module: a test's stand-in `location`, where nothing actually loads.
  if (typeof location === "undefined") return false
  if (to === null) location.reload()
  else if (options.replace) location.replace(to)
  else location.assign(to)
  return true
}
