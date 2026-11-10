// A MODULE LOADED ON FIRST USE, WHOSE FAILED LOAD IS NOT KEPT.
//
// The obvious cache, `held ??= import("x")`, keeps a rejected promise as faithfully as a resolved one:
// one failed chunk request and every later caller is handed that failure until the page reloads. The
// app's chunks reach a phone through the relay, where a request can fail and the next one succeed.
//
// So a load that fails is tried once more after a pause, for the callers already waiting, and if that
// fails too the failure is handed to them and forgotten: the next caller starts a new load.
//
// What a second `import()` of the same module does is the browser's, and they differ. Measured
// 2026-11-10 with a module whose first request is answered 503 and every later one 200:
//
//     Chrome 150      never asks again; the second and third import() fail with no request made
//     WebKit 27.2     asks again, and the second import() succeeds
//     Firefox 157     asks again, and the second import() succeeds
//
// A phone is WebKit or Chrome on Android. In Chrome nothing short of a reload brings the module back,
// and this file does not pretend otherwise: the retry there fails at once, with the same error.

export type LazyModuleOptions = {
  /** The pause before the one retry. */
  retryAfterMs?: number
  /** The pause itself; a test passes its own. */
  wait?: (ms: number) => Promise<void>
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `load` run on the first call and its result kept; a load that fails twice is forgotten. */
export function lazyModule<T>(load: () => Promise<T>, { retryAfterMs = 800, wait = pause }: LazyModuleOptions = {}): () => Promise<T> {
  let held: Promise<T> | undefined
  return () => {
    held ??= load()
      .catch(() => wait(retryAfterMs).then(load))
      .catch((error: unknown) => {
        held = undefined
        throw error
      })
    return held
  }
}
