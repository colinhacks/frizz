import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { markDrawerClosing, openThread, pushDrawer, resolveRoutedThread, store } from "../store.ts"
import { appPushedCurrentEntry, boardThreadHref, primeRoute, queueDestination, startRouter, threadParam, withThreadParam } from "./router.ts"
import { paneProto, setPaneFolded, setPaneRailShown } from "./threadPane.ts"

// A stubbed address bar for a URL the router wrote: its path and its query, as the browser splits them.
function at(url: string): Location {
  const query = url.indexOf("?")
  return (query === -1 ? { pathname: url, search: "" } : { pathname: url.slice(0, query), search: url.slice(query) }) as unknown as Location
}

function resetStore(): void {
  store.drawers = []
  store.paneSlug = null
  store.view = "todos"
  store.routeThreadSlug = null
  store.board = null
  paneProto.folded = false
  paneProto.artifacts = "default"
}

// A board carrying exactly the fields the routing decision reads.
function boardWith(threads: Array<{ id: string; needsYou?: boolean }>): void {
  store.board = { threads: threads.map((t) => ({ ...t, needsYou: t.needsYou ?? false })) } as unknown as BoardSnapshot
}

// A stubbed page for the router to run in. With `phone` the viewport is a phone's, where a thread is a
// drawer: with an address bar to read, a desktop board shows threads in its one-thread pane instead
// (store.ts paneEnabled).
function mountPage({ phone = false, width }: { phone?: boolean; width?: number } = {}): () => void {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document; CSS?: typeof CSS }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  globals.CSS = { escape: (value: string) => value } as typeof CSS
  globals.document = {
    querySelector: () => null,
  } as unknown as Document
  globals.window = {
    scrollY: 0,
    scrollTo: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0,
    ...(phone ? { matchMedia: () => ({ matches: true, addEventListener: () => {} }) } : null),
    // A desktop window this wide: a `min-width` query matches up to it, and nothing else does.
    ...(width !== undefined
      ? { matchMedia: (query: string) => ({ matches: Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) <= width, addEventListener: () => {} }) }
      : null),
  } as unknown as typeof window
  return () => Object.assign(globals, previous)
}

test("primeRoute parks a direct thread route until the board can settle it", () => {
  resetStore()
  primeRoute("/", "?thread=cold-load")
  // No board yet, so no drawer — deciding blind is what stacked a second panel over a queued
  // thread's card. The slug is held instead, and the address bar stays on it.
  assert.equal(store.routeThreadSlug, "cold-load")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.view, "todos")
})

test("a parked route opens the chat drawer once the board says the thread is not queued", () => {
  resetStore()
  primeRoute("/", "?thread=cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountPage()
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.deepEqual(
    store.drawers.map(({ kind, slug, routed }) => ({ kind, slug, routed })),
    [{ kind: "thread", slug: "cold-load", routed: true }],
  )
  assert.equal(store.routeThreadSlug, null)
})

test("a queued thread opens in the drawer too where there is no pane", () => {
  resetStore()
  primeRoute("/", "?thread=queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  const restore = mountPage()
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.slug, "queued-thread")
})

test("resolveRoutedThread is inert without a board or a parked slug", () => {
  resetStore()
  resolveRoutedThread()
  assert.equal(store.drawers.length, 0)

  primeRoute("/", "?thread=no-board")
  resolveRoutedThread()
  assert.equal(store.routeThreadSlug, "no-board", "a board-less resolve must not consume the parked slug")
  assert.equal(store.drawers.length, 0)
})

test("primeRoute is idempotent for the current direct thread and decodes its slug", () => {
  resetStore()
  primeRoute("/", "?thread=a%20thread")
  primeRoute("/", "?thread=a%20thread")
  assert.equal(store.routeThreadSlug, "a thread")
  assert.equal(store.drawers.length, 0)
})

test("priming the queue unwinds a routed drawer without leaving a phantom", () => {
  resetStore()
  primeRoute("/", "?thread=cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountPage()
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)

  primeRoute("/")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
  assert.equal(store.view, "todos")
})

test("a direct route reopens the closing layer instead of appending a duplicate", () => {
  resetStore()
  boardWith([{ id: "rapid-forward" }])
  const restore = mountPage()
  try {
    primeRoute("/", "?thread=rapid-forward")
    resolveRoutedThread()
    const closingId = store.drawers[0]?.id
    assert.ok(closingId)
    markDrawerClosing(closingId)

    primeRoute("/", "?thread=rapid-forward")
    resolveRoutedThread()
  } finally {
    restore()
  }

  assert.equal(store.drawers.length, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.drawers[0] ?? {}).filter(([key]) => ["kind", "slug", "routed", "closing"].includes(key))),
    { kind: "thread", slug: "rapid-forward", routed: true },
  )
})

test("landing on a thread already in the stack unwinds above it and parks nothing", () => {
  resetStore()
  boardWith([{ id: "below" }, { id: "above" }])
  const restore = mountPage()
  try {
    primeRoute("/", "?thread=below")
    resolveRoutedThread()
    primeRoute("/", "?thread=above")
    resolveRoutedThread()
  } finally {
    restore()
  }
  // The one-drawer policy replaced `below`, so re-landing on it is a fresh park, not an unwind.
  primeRoute("/", "?thread=above")
  assert.equal(store.routeThreadSlug, null, "the surface it asks for is already up")
  assert.equal(store.drawers.filter((d) => !d.closing).length, 1)
})

test("malformed percent escapes fall back to Queue instead of throwing before mount", () => {
  resetStore()
  primeRoute("/", "?thread=existing")
  // The query decodes leniently: a stray `%` is part of the slug, which then resolves like any other
  // slug the board does not have.
  assert.doesNotThrow(() => primeRoute("/", "?thread=%"))
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, "%")
  assert.equal(store.view, "todos")

  assert.doesNotThrow(() => primeRoute("/status/%"))
  assert.equal(store.view, "todos")
  assert.equal(store.routeThreadSlug, null)
})

// `/` is the ALL-PROJECTS GRID since the singleton landed, so the queue could not keep using it as a
// URL: closing the last drawer on the launching project navigated to the project picker.
test("the queue's URL is a board, never the all-projects grid", () => {
  assert.equal(queueDestination("/", "fray"), "/project/fray", "the launching project has a board URL too")
  assert.equal(queueDestination("/", undefined), "/", "no slug yet (pre-restart server / cold boot) — old behaviour")
  // A status list is already a board on either shape and must pass through untouched.
  assert.equal(queueDestination("/status/active", "fray"), "/status/active")
})

// The drawer is the board's URL with `?thread=<slug>` (maintainer 2026-11-07); the thread's own path is
// its full-screen page.
test("a drawer is named by the board URL's thread parameter, and only that parameter changes", () => {
  assert.equal(threadParam("?thread=fix-auth"), "fix-auth")
  assert.equal(threadParam("?scan&thread=a%20thread"), "a thread")
  assert.equal(threadParam("?thread="), null, "an empty value names nothing")
  assert.equal(threadParam(""), null)

  assert.equal(withThreadParam("", "fix-auth"), "?thread=fix-auth")
  assert.equal(withThreadParam("?thread=old", "new"), "?thread=new")
  assert.equal(withThreadParam("?scan=1&thread=old", null), "?scan=1", "another parameter survives a close")
  assert.equal(withThreadParam("?scan=1", "fix-auth"), "?thread=fix-auth&scan=1")
  assert.equal(withThreadParam("", "billing~retry-webhooks"), "?thread=billing~retry-webhooks", "a Console key reads as written")
  assert.equal(withThreadParam("", null), "")

  resetStore()
  store.board = { projectSlug: "reylo", threads: [] } as unknown as BoardSnapshot
  assert.equal(boardThreadHref("brainstorm"), "/project/reylo?thread=brainstorm")
  assert.equal(boardThreadHref("retry-webhooks", "billing"), "/project/billing?thread=retry-webhooks")
  resetStore()
})

test("a drawer over a status list keeps the list's path under it", () => {
  resetStore()
  primeRoute("/status/active", "?thread=cold-load")
  assert.equal(store.view, "status:active")
  assert.equal(store.routeThreadSlug, "cold-load")
  // And closing it leaves the list where it was.
  primeRoute("/status/active", "")
  assert.equal(store.view, "status:active")
  assert.equal(store.routeThreadSlug, null)
  resetStore()
})

// A deep link to a slug THIS project does not have. Since one server started serving every project
// that is usually a thread ANOTHER project has — every pre-singleton bookmark and every agent-written
// thread link names a slug alone — so it must not open an empty sheet over the board.
test("a routed slug this board does not have hands off to the full-screen page's recovery", () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const replaced: string[] = []
  globals.location = { pathname: "/", search: "", replace: (url: string) => replaced.push(url) } as unknown as Location
  try {
    boardWith([{ id: "present" }])
    primeRoute("/", "?thread=lives-elsewhere")
    resolveRoutedThread()
    assert.deepEqual(replaced, ["/thread/lives-elsewhere"], "<MissingThread> + threadLocate relocate from there")
    assert.equal(store.drawers.length, 0, "no empty drawer is opened over the board")

    // A thread this board DOES have is unaffected: it still opens in place, with no navigation.
    replaced.length = 0
    primeRoute("/", "?thread=present")
    resolveRoutedThread()
    assert.deepEqual(replaced, [])
    assert.equal(store.drawers.length, 1)
    assert.equal(store.drawers[0].slug, "present")
  } finally {
    globals.location = previous
  }
})

// On a phone the fullscreen door clears the drawer stack and navigates to `/thread/<slug>` in one tick;
// valtio delivers the store notification a microtask later, when the address bar already names the
// fullscreen page. The board's store→URL sync must leave that URL alone — it pulled the page straight
// back to the board before the guard (live, 2026-08-28). A desktop's thread path is the board's own.
test("the store→URL sync never writes over a phone's fullscreen page", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const restore = mountPage({ phone: true })
  try {
    globals.location = { pathname: "/thread/focus", search: "" } as unknown as Location
    const stop = startRouter((path) => navigated.push(path))
    store.drawers = [{ id: 1, kind: "thread", slug: "focus" } as never]
    await settle()
    store.drawers = []
    await settle()
    stop()
    assert.deepEqual(navigated, [] as string[], "no write while the address bar names a full-screen page")

    // CONTROL — the same writes on the board DO drive the URL, so the guard is the only difference.
    globals.location = { pathname: "/", search: "" } as unknown as Location
    const stopBoard = startRouter((path) => navigated.push(path))
    store.drawers = [{ id: 2, kind: "thread", slug: "focus" } as never]
    await settle()
    stopBoard()
    assert.deepEqual(navigated, ["/?thread=focus"])
  } finally {
    restore()
    globals.location = previous
    resetStore()
  }
})

// THE PANE'S LAYOUT IS IN THE ADDRESS (maintainer 2026-11-11). On a desktop the thread's own path is that
// thread full screen in the pane — every full-screen link from before keeps opening the view people read
// threads in — and `artifacts=` records a choice about the rail that differs from the window's own.
test("a desktop reads a thread's own path as the pane full screen, and the query's rail choice", () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  globals.location = at("/project/demo/thread/focus/full?artifacts=hidden")
  const restore = mountPage({ width: 1440 })
  try {
    primeRoute("/project/demo/thread/focus/full", "?artifacts=hidden")
    assert.equal(store.routeThreadSlug, "focus", "parked for the board, as a query's thread is")
    assert.equal(paneProto.folded, true, "the sidebar put away")
    assert.equal(paneProto.artifacts, "hidden")
    boardWith([{ id: "focus" }])
    resolveRoutedThread()
    assert.equal(store.paneSlug, "focus", "in the pane, not a drawer")
    assert.equal(store.drawers.length, 0)

    primeRoute("/project/demo", "?thread=focus")
    assert.equal(paneProto.folded, false, "the query is the thread beside the sidebar")
    assert.equal(paneProto.artifacts, "default", "and no parameter is the window's own choice")

    // With no thread named there is nothing to lay out, so the choices wait for the next thread.
    paneProto.folded = true
    primeRoute("/project/demo", "")
    assert.equal(paneProto.folded, true)
  } finally {
    restore()
    globals.location = previous
    resetStore()
  }
})

test("putting the sidebar or the rail away moves the address and replaces the entry", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: Array<{ path: string; replace: boolean }> = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = at("/project/demo?thread=focus")
  const restore = mountPage({ width: 1440 })
  const stop = startRouter((path, { replace }) => {
    writes.push({ path, replace })
    globals.location = at(path)
  })
  try {
    store.paneSlug = "focus"
    await settle()
    assert.deepEqual(writes, [], "the address already says it")

    setPaneFolded(true)
    await settle()
    setPaneRailShown(false)
    await settle()
    setPaneFolded(false)
    await settle()
    setPaneRailShown(true)
    await settle()
    assert.deepEqual(writes, [
      { path: "/project/demo/thread/focus", replace: true },
      { path: "/project/demo/thread/focus?artifacts=hidden", replace: true },
      { path: "/project/demo?thread=focus&artifacts=hidden", replace: true },
      { path: "/project/demo?thread=focus", replace: true },
    ])

    // Another thread full screen is a thread opening: pushed, at its own path.
    writes.length = 0
    setPaneFolded(true)
    await settle()
    store.paneSlug = "other"
    await settle()
    assert.deepEqual(writes, [
      { path: "/project/demo/thread/focus", replace: true },
      { path: "/project/demo/thread/other", replace: false },
    ])
  } finally {
    stop()
    restore()
    globals.location = previous
    resetStore()
  }
})

// "the artifact sidebar should be visible on the screens that can support it by default. On the others, it
// should not be. When somebody clicks the button to show the artifact sidebar, it should also hide the
// regular sidebar if the screen is not big enough to include both" (maintainer 2026-11-11).
test("on a window too narrow for both, showing the rail puts the sidebar away and bringing it back puts the rail away", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = at("/project/demo?thread=focus")
  const restore = mountPage({ width: 1280 })
  const stop = startRouter((path) => {
    writes.push(path)
    globals.location = at(path)
  })
  try {
    store.paneSlug = "focus"
    setPaneRailShown(true)
    await settle()
    assert.deepEqual({ folded: paneProto.folded, artifacts: paneProto.artifacts }, { folded: true, artifacts: "shown" })
    setPaneFolded(false)
    await settle()
    assert.deepEqual({ folded: paneProto.folded, artifacts: paneProto.artifacts }, { folded: false, artifacts: "default" })
    assert.deepEqual(writes, ["/project/demo/thread/focus?artifacts=shown", "/project/demo?thread=focus"])

    // Full screen, the rail put away again is this window's own choice, and leaves the sidebar where it is.
    setPaneFolded(true)
    setPaneRailShown(true)
    setPaneRailShown(false)
    await settle()
    assert.deepEqual({ folded: paneProto.folded, artifacts: paneProto.artifacts }, { folded: true, artifacts: "default" })
  } finally {
    stop()
    restore()
    globals.location = previous
    resetStore()
  }
})

test("a thread this board does not have, at its own path, stays there for the pane to go looking", () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const replaced: string[] = []
  globals.location = { pathname: "/project/demo/thread/lives-elsewhere", search: "", replace: (url: string) => replaced.push(url) } as unknown as Location
  const restore = mountPage({ width: 1440 })
  try {
    boardWith([{ id: "present" }])
    primeRoute()
    resolveRoutedThread()
    assert.deepEqual(replaced, [], "sent to its own address again, the page would reload forever")
    assert.equal(store.paneSlug, "lives-elsewhere", "the pane draws MissingThread, which asks threadLocate")
  } finally {
    restore()
    globals.location = previous
    resetStore()
  }
})

// The launching project's unprefixed drawer, `/?thread=<slug>`, takes its `/project/<slug>` prefix once
// the board names the slug. That is the same thread at its canonical address, not a thread opening, so
// it must not leave the unprefixed entry behind for Back to land on.
test("the unprefixed drawer address takes its project prefix without a history entry", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: Array<{ path: string; replace: boolean }> = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = at("/?thread=cold-load")
  const stop = startRouter((path, { replace }) => {
    writes.push({ path, replace })
    globals.location = at(path)
  })
  const restore = mountPage()
  try {
    store.board = { projectSlug: "fray", threads: [{ id: "cold-load", needsYou: false }] } as unknown as BoardSnapshot
    resolveRoutedThread()
    await settle()
    assert.deepEqual(writes, [{ path: "/project/fray?thread=cold-load", replace: true }])
    // CONTROL — another thread from there IS an opening, and pushes.
    writes.length = 0
    pushDrawer("thread", "other")
    await settle()
    assert.deepEqual(writes, [{ path: "/project/fray?thread=other", replace: false }])
  } finally {
    stop()
    restore()
    globals.location = previous
    resetStore()
  }
})

// Back after a LATERAL move — thread A, then a transcript link or a sidebar row to thread B. The
// one-drawer policy replaced A with B, so Back lands on A's entry with A gone and B still on top. The
// router used to park A and leave B up, and the store→URL sync then pushed B's URL over A's (and
// settling A pushed A's over that): every Back press grew the history by two and flipped between the
// threads, on the phone and the desktop alike. Back must be a pure pop: no write, and A on top. (The
// desktop board's pane has the same rule, in the test below this one.)
test("Back onto a thread a lateral move replaced pops without writing history", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: Array<{ path: string; replace: boolean }> = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = { pathname: "/", search: "" } as unknown as Location
  const stop = startRouter((path, { replace }) => {
    writes.push({ path, replace })
    globals.location = at(path)
  })
  const restore = mountPage({ phone: true })
  try {
    boardWith([{ id: "thread-a" }, { id: "thread-b" }])
    pushDrawer("thread", "thread-a")
    await settle()
    pushDrawer("thread", "thread-b")
    await settle()
    assert.deepEqual(writes, [{ path: "/?thread=thread-a", replace: false }, { path: "/?thread=thread-b", replace: false }])
    assert.deepEqual(store.drawers.map((d) => d.slug), ["thread-b"], "the lateral move replaced A")

    // Back: the browser is already on A's entry; the route tree applies it (routes.tsx useRouteToStore),
    // then App settles the parked slug once the board is there (resolveRoutedThread).
    writes.length = 0
    globals.location = { pathname: "/", search: "?thread=thread-a" } as unknown as Location
    primeRoute("/", "?thread=thread-a")
    await settle()
    resolveRoutedThread()
    await settle()
    assert.deepEqual(writes, [], "Back pushes nothing — it was a pop")
    assert.deepEqual(store.drawers.filter((d) => !d.closing).map((d) => d.slug), ["thread-a"])

    // And the next Back reaches the board, again without a write.
    globals.location = { pathname: "/", search: "" } as unknown as Location
    primeRoute("/")
    await settle()
    assert.deepEqual(writes, [])
    assert.equal(store.drawers.filter((d) => !d.closing).length, 0)
  } finally {
    stop()
    restore()
    globals.location = previous
    resetStore()
  }
})

// THE ONE-THREAD PANE keeps the same rule on a desktop board: each thread a row or a link brings up is a
// history entry, and Back is a pure pop onto the thread before it, then onto the board.
test("in the board's pane, Back onto the thread before pops without writing history", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: Array<{ path: string; replace: boolean }> = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = { pathname: "/", search: "" } as unknown as Location
  const stop = startRouter((path, { replace }) => {
    writes.push({ path, replace })
    globals.location = at(path)
  })
  const restore = mountPage()
  try {
    boardWith([{ id: "thread-a" }, { id: "queued-b", needsYou: true }])
    pushDrawer("thread", "thread-a")
    await settle()
    openThread("queued-b")
    await settle()
    assert.equal(store.drawers.length, 0, "the pane, not a drawer")
    assert.equal(store.paneSlug, "queued-b")
    assert.deepEqual(writes, [{ path: "/?thread=thread-a", replace: false }, { path: "/?thread=queued-b", replace: false }])

    writes.length = 0
    globals.location = { pathname: "/", search: "?thread=thread-a" } as unknown as Location
    primeRoute("/", "?thread=thread-a")
    await settle()
    resolveRoutedThread()
    await settle()
    assert.deepEqual(writes, [], "Back pushes nothing — it was a pop")
    assert.equal(store.paneSlug, "thread-a")

    globals.location = { pathname: "/", search: "" } as unknown as Location
    primeRoute("/")
    await settle()
    assert.deepEqual(writes, [])
    assert.equal(store.paneSlug, null, "the board, with the pane offering the first item")
  } finally {
    stop()
    restore()
    globals.location = previous
    resetStore()
  }
})

// The phone thread header's ← pops history only when the entry under the thread is ours. react-router
// numbers its entries from 0 at document load, so 0 (or no router state at all) is a cold link.
test("appPushedCurrentEntry: only an entry the router pushed above the document's first counts", () => {
  assert.equal(appPushedCurrentEntry({ usr: null, key: "a", idx: 1 }), true)
  assert.equal(appPushedCurrentEntry({ usr: null, key: "b", idx: 4, frizzLayer: 9 }), true)
  assert.equal(appPushedCurrentEntry({ idx: 0 }), false)
  assert.equal(appPushedCurrentEntry({ usr: null, key: "c" }), false)
  assert.equal(appPushedCurrentEntry(null), false)
  assert.equal(appPushedCurrentEntry("not-an-object"), false)
})
