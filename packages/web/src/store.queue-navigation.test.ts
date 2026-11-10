import assert from "node:assert/strict"
import test from "node:test"
import { scrollToQueueCard, store } from "./store.ts"
import { takeScrollAfterUnlock } from "./lib/pageScrollLock.ts"

// How queueCardTargetY asks the document for the queue's FIRST card (the topmost slot not fading out).
// The mocks below answer it with a distinct predecessor where the card under test must NOT be first.
const FIRST_SLOT_SELECTOR = '[data-queue-card]:not([data-queue-leaving="true"])'

test("sidebar queue navigation lands immediately at the card reading line", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const scrolls: ScrollToOptions[] = []
  const flashes: string[] = []
  let top = 418

  try {
    // No `[data-queue-card-root]` child: this pins the FALLBACK, where the slot itself is the ring
    // target. Only fixtures render a rootless slot — every production card emits one (see test 3).
    const card = {
      getBoundingClientRect: () => ({ top }),
      querySelector: () => null,
      setAttribute: (name: string) => flashes.push(`+${name}`),
      removeAttribute: (name: string) => flashes.push(`-${name}`),
    }
    const predecessor = {}
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      // A predecessor heads the queue, so this card takes the standard landing (a FIRST card lands at
      // scrollY 0 instead — see the last test).
      querySelector: (selector: string) => {
        if (selector === FIRST_SLOT_SELECTOR) return predecessor
        assert.equal(selector, '[data-queue-card="queued-thread"]')
        return card
      },
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: (options: ScrollToOptions) => {
        scrolls.push(options)
        top -= options.top ?? 0
      },
      clearTimeout: () => {},
      setTimeout: (fn: () => void) => {
        fn()
        return 0
      },
    } as unknown as typeof window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(scrolls, [{ top: 378, left: 0, behavior: "auto" }])
    // The leading removal is the animation RESTART (see test 4), then the ring, then its teardown.
    assert.deepEqual(flashes, ["-data-queue-flash", "+data-queue-flash", "-data-queue-flash"])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

test("sidebar queue navigation uses an absolute reading-line target after a narrow-layout drawer close", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const scrolls: ScrollToOptions[] = []
  let top = -4680

  try {
    const card = {
      getBoundingClientRect: () => ({ top }),
      querySelector: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
    }
    const predecessor = {}
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: (selector: string) => (selector === FIRST_SLOT_SELECTOR ? predecessor : card),
    } as unknown as Document
    globals.window = {
      scrollY: 5941,
      scrollTo: (options: ScrollToOptions) => {
        scrolls.push(options)
        top = 40
      },
      clearTimeout: () => {},
      setTimeout: () => 0,
    } as unknown as typeof window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(scrolls, [{ top: 1221, left: 0, behavior: "auto" }])
    assert.equal(top, 40)
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// Clicking a queued row while a drawer is open must do BOTH halves (maintainer 2026-08-11: "clicking a
// queued item in the sidebar should both DISMISS the current drawer and autoscroll"). Neither half can
// be done here in the obvious way: the drawer keeps its stack slot for the ~210ms slide-out, so the page
// is still scroll-LOCKED — `window.scrollTo` would be clamped to a no-op, and App's unlock would then
// restore the pre-click offset over the top of it anyway. So the landing is PARKED for the unlock, and
// it is measured off the lock's own offset rather than a window.scrollY the lock has pinned at 0.
test("a queued row clicked under an open drawer dismisses every layer and parks its landing for the unlock", () => {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document; CSS?: typeof CSS }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const drawersBefore = [...store.drawers]

  try {
    const root = { getBoundingClientRect: () => ({ top: 400 }), setAttribute: () => {}, removeAttribute: () => {} }
    const slot = { getBoundingClientRect: () => ({ top: 400 }), querySelector: () => root, setAttribute: () => {}, removeAttribute: () => {} }
    const predecessor = {}
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      // The page as App leaves it while an overlay is up: pinned at the reader's 1740px offset.
      body: { style: { position: "fixed", top: "-1740px" } },
      querySelector: (selector: string) => (selector === FIRST_SLOT_SELECTOR ? predecessor : slot),
    } as unknown as Document
    globals.window = {
      scrollY: 0, // what a pinned body reports, whatever the reader's real offset
      scrollTo: () => assert.fail("a locked page cannot scroll — the landing belongs to the unlock"),
      clearTimeout: () => {},
      setTimeout: () => 0,
    } as unknown as typeof window

    store.drawers = [
      { id: 1, kind: "thread", slug: "some-thread" },
      { id: 2, kind: "subagent", slug: "some-thread", subId: "toolu_1" },
    ]
    takeScrollAfterUnlock() // start clean

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(store.drawers, [], "every open layer goes, not just the topmost")
    // 1740 (the lock's offset) + 400 (the card's box) - 40 (the landing). Off window.scrollY it
    // would have been 360 — short by exactly how far the reader had scrolled.
    assert.equal(takeScrollAfterUnlock(), 2100)
  } finally {
    store.drawers = drawersBefore
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// The arrival ring belongs to the BORDERED CARD ROOT, never the outer `[data-queue-card]` slot. The slot
// is the fade wrapper, not the bordered box — and while it still wrapped the inter-card hairline rule and
// its 40px margins (until 2026-08-25), ringing it drew the card AND ~80px of gutter plus the rule below it
// as one highlighted box (maintainer, 2026-07-21: "the ordered area also includes the horizontal rule
// beneath the card").
test("the queue arrival ring lands on the bordered card root, never the fade slot around it", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const rootRinged: boolean[] = []
  const slotRinged: boolean[] = []
  const removals: (() => void)[] = []

  try {
    const root = {
      getBoundingClientRect: () => ({ top: 300 }),
      setAttribute: () => rootRinged.push(true),
      removeAttribute: () => rootRinged.push(false),
    }
    const slot = {
      getBoundingClientRect: () => ({ top: 300 }),
      querySelector: (selector: string) => (selector === '[data-queue-card-root="queued-thread"]' ? root : null),
      setAttribute: () => slotRinged.push(true),
      removeAttribute: () => slotRinged.push(false),
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: () => slot,
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: () => {},
      clearTimeout: () => {},
      setTimeout: (fn: () => void) => { removals.push(fn); return 0 },
    } as unknown as typeof window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(rootRinged, [false, true], "restart-clear, then the ring")
    assert.deepEqual(slotRinged, [], "the slot must never carry the ring — it is the fade wrapper, not the bordered box")

    // …and the scheduled teardown clears the ring from the same element it was set on.
    for (const fn of removals) fn()
    assert.deepEqual(rootRinged, [false, true, false])
    assert.deepEqual(slotRinged, [])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// Clicking the SAME queued row twice inside the 1.1s window must replay the ring. Re-setting an already
// present attribute does not restart a CSS animation, and the card is already at the landing so no
// scroll happens and (by design) no drawer opens — without a restart the second click is a total no-op.
test("re-clicking a queued row inside the flash window replays the ring and reschedules one teardown", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const events: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  try {
    const root = {
      getBoundingClientRect: () => ({ top: 40 }),
      setAttribute: () => events.push("set"),
      removeAttribute: () => events.push("clear"),
    }
    const slot = {
      getBoundingClientRect: () => ({ top: 40 }),
      querySelector: () => root,
      setAttribute: () => assert.fail("the slot must never carry the ring"),
      removeAttribute: () => {},
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: () => slot,
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: () => assert.fail("an already-landed card must not be re-scrolled"),
      setTimeout: (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id },
      clearTimeout: (id: number) => { events.push(`cancel:${id}`); timers.delete(id) },
    } as unknown as typeof window

    assert.equal(scrollToQueueCard("re-clicked"), true)
    assert.equal(scrollToQueueCard("re-clicked"), true)
    // Second click: cancels the first teardown, then clears + re-sets to restart the animation.
    assert.deepEqual(events, ["clear", "set", "cancel:1", "clear", "set"])

    // Exactly ONE teardown survives, and firing it leaves no stale timer behind.
    assert.deepEqual([...timers.keys()], [2])
    timers.get(2)!()
    assert.equal(events.at(-1), "clear")

    // A later click after the window closed schedules cleanly — no stale id to cancel.
    events.length = 0
    assert.equal(scrollToQueueCard("re-clicked"), true)
    assert.deepEqual(events, ["clear", "set"])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// The FIRST card lands at the very top of the page, not at the standard 40px landing: its box rests 52px
// below the page top, so that landing is scrollY 12, which left the page scrollable by that sliver after
// clearing a card whose successor headed the queue (maintainer 2026-08-28: "it scrolls me like there's
// like 10 pixels that I could scroll up from where it scrolls me to, and it's very annoying"). A FADING
// predecessor still holds its row but does not count — it is already gone from the reader's point of
// view, and the dismissal landing runs once it has unmounted.
test("the first card in the queue lands at scrollY 0, and a fading predecessor does not displace it", () => {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document; CSS?: typeof CSS }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const scrolls: ScrollToOptions[] = []

  try {
    // Box top 52 at scrollY 0: the standard landing would be 12, leaving 12px of page above the fold.
    const card = {
      getBoundingClientRect: () => ({ top: 52 }),
      querySelector: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: (selector: string) => {
        // The `:not([data-queue-leaving="true"])` clause is what skips the fading predecessor; the
        // document answers it with this card, as a real DOM would.
        assert.equal(selector.includes(':not([data-queue-leaving="true"])') || selector === '[data-queue-card="first-thread"]', true, selector)
        return card
      },
    } as unknown as Document
    globals.window = {
      scrollY: 12,
      scrollTo: (options: ScrollToOptions) => scrolls.push(options),
      clearTimeout: () => {},
      setTimeout: () => 0,
    } as unknown as typeof window

    assert.equal(scrollToQueueCard("first-thread"), true)
    assert.deepEqual(scrolls, [{ top: 0, left: 0, behavior: "auto" }])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})
