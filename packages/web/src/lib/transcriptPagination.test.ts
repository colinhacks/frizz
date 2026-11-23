import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage, TranscriptPage } from "@frizz/shared"
import {
  prependEarlierPage,
  previousUserBoundary,
  reconcileLatestPage,
  reconcileLiveMessages,
} from "./transcriptPagination.ts"

const message = (role: "user" | "assistant", sourceId: string): TranscriptMessage => ({
  sourceId,
  role,
  text: sourceId,
  tools: [],
  parts: [],
})

const page = (ids: Array<["user" | "assistant", string]>, overrides: Partial<TranscriptPage> = {}): TranscriptPage => ({
  messages: ids.map(([role, id]) => message(role, id)),
  beforeCursor: null,
  hasEarlier: false,
  reachedTurnBoundary: true,
  transcriptKey: "transcript-A",
  ...overrides,
})

test("client boundary selection handles first-visible assistant, user, consecutive users, and no prior user", () => {
  const messages = [message("user", "u0"), message("assistant", "a0"), message("user", "u1"), message("user", "u2"), message("assistant", "a2")]
  assert.equal(previousUserBoundary(messages, 4), 3, "assistant-visible start steps to preceding user")
  assert.equal(previousUserBoundary(messages, 3), 2, "user-visible start steps to user immediately before it")
  assert.equal(previousUserBoundary(messages, 2), 0)
  assert.equal(previousUserBoundary([message("assistant", "event")], 1), 0, "no user reveals the remaining prefix")
  assert.equal(previousUserBoundary(messages, 0), null)
})

// Minutes and seconds past 10:00, so each test reads as a timeline.
const timed = (role: "user" | "assistant", sourceId: string, mmss: string): TranscriptMessage => ({
  ...message(role, sourceId),
  at: `2026-11-23T10:${mmss}.000Z`,
})

test("a burst of user messages less than a minute apart opens in one click", () => {
  const messages = [
    timed("user", "ask", "00:00"),
    timed("assistant", "work", "05:00"),
    timed("user", "h1", "20:00"),
    timed("user", "h2", "20:20"),
    timed("user", "h3", "20:40"),
    timed("assistant", "long-turn", "45:00"),
    timed("user", "steer", "59:00"),
  ]
  // The three quick messages start a 25-minute turn, so the click stops at the first of them.
  assert.equal(previousUserBoundary(messages, 6), 2)
  // A gap of a minute or more is not a burst: the next click is the step before, on its own.
  assert.equal(previousUserBoundary(messages, 2), 0)
})

test("a step that all arrived within a minute keeps reaching back", () => {
  const messages = [
    timed("user", "ask", "00:00"),
    timed("assistant", "work", "10:00"),
    timed("user", "reminder-1", "30:01"),
    timed("assistant", "reply-1", "30:10"),
    timed("user", "reminder-2", "31:30"),
    timed("assistant", "reply-2", "31:40"),
    timed("user", "steer", "59:00"),
  ]
  // reminder-2 and its reply span 10s, and reminder-1 is 89s before it: no burst, but each step is quick,
  // so the click reaches past both to the ask and the 10 minutes of work it started.
  assert.equal(previousUserBoundary(messages, 6), 0)
  // The same quick steps at the head of the loaded window reveal the whole prefix.
  assert.equal(previousUserBoundary(messages.slice(2), 4), 0)
})

test("a window that opens inside a burst reveals the rest of it and the step before", () => {
  const messages = [
    timed("user", "ask", "00:00"),
    timed("assistant", "work", "20:00"),
    timed("user", "h1", "30:00"),
    timed("user", "h2", "30:15"),
    timed("user", "h3", "30:30"),
    timed("assistant", "reply", "40:00"),
  ]
  assert.equal(previousUserBoundary(messages, 4), 0)
})

test("a step that spans a minute or more stops where it is", () => {
  const messages = [
    timed("user", "ask", "00:00"),
    timed("assistant", "work", "10:00"),
    timed("user", "reminder", "30:00"),
    timed("assistant", "reply", "31:00"),
    timed("user", "steer", "59:00"),
  ]
  assert.equal(previousUserBoundary(messages, 4), 2)
})

test("a message without a time never joins a burst", () => {
  const messages = [
    timed("user", "ask", "00:00"),
    timed("assistant", "work", "10:00"),
    message("user", "untimed"),
    timed("user", "h2", "30:10"),
    timed("assistant", "reply", "45:00"),
    timed("user", "steer", "59:00"),
  ]
  assert.equal(previousUserBoundary(messages, 5), 3)
  assert.equal(previousUserBoundary(messages, 3), 2)
})

test("client prepend is gap-free/idempotent across a repeated response", () => {
  const current = { ...page([["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-2", hasEarlier: true }) }
  const earlier = page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true })
  const once = prependEarlierPage(current, earlier)
  const twice = prependEarlierPage(once, earlier)
  assert.deepEqual(twice.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2"])
  assert.equal(twice.beforeCursor, "cursor-1")
})

test("loading the canonical launch replaces its synthetic pinned background-shell card", () => {
  const canonical = {
    ...message("assistant", "old-shell-launch"),
    tools: [{ name: "exec_command", detail: "sleep 999", status: "pending" as const, backgroundState: "background" as const }],
  }
  const pinned = {
    ...canonical,
    sourceId: "pinned-bg:old-shell-launch",
    pinnedFromSourceId: canonical.sourceId,
  }
  const current = {
    ...page([["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-2", hasEarlier: true }),
    messages: [message("user", "u2"), message("assistant", "a2"), pinned],
  }
  const earlier = {
    ...page([["user", "u1"]], { beforeCursor: "cursor-1", hasEarlier: true }),
    messages: [message("user", "u1"), canonical],
  }
  const loaded = prependEarlierPage(current, earlier)
  assert.deepEqual(
    loaded.messages.map((item) => item.sourceId),
    ["u1", "old-shell-launch", "u2", "a2"],
    "the same lifecycle card never renders twice after history reaches its launch",
  )
})

test("client latest reconciliation retains loaded history across concurrent append and refreshes overlap", () => {
  const loaded = prependEarlierPage(
    page([["user", "u2"], ["assistant", "a2-old"]], { beforeCursor: "cursor-2", hasEarlier: true }),
    page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true }),
  )
  const incoming = page([["user", "u2"], ["assistant", "a2-old"], ["user", "u3"], ["assistant", "a3"]], { beforeCursor: "new-window", hasEarlier: true })
  const reconciled = reconcileLatestPage(loaded, incoming)
  assert.deepEqual(reconciled.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2-old", "u3", "a3"])
  assert.equal(reconciled.beforeCursor, "cursor-1")
})

test("client transcript replacement discards loaded history instead of mixing sessions", () => {
  const loaded = { ...page([["user", "old-u"], ["assistant", "old-a"]]), historyLoaded: true }
  const replacement = page([["user", "new-u"], ["assistant", "new-a"]], { transcriptKey: "transcript-B" })
  assert.deepEqual(reconcileLatestPage(loaded, replacement).messages.map((m) => m.sourceId), ["new-u", "new-a"])
})

// A push carries messages only, so the envelope can only survive by being carried over. On a thread past
// the server's MAX_MESSAGES cap the window SLIDES on every new message, which used to take the
// envelope-dropping branch and silently cost the reader `hasEarlier`/`beforeCursor`/`transcriptKey` — i.e.
// the "Load earlier messages" affordance and the only route back to the history the slide just trimmed.
test("a live push against a SLID window keeps the page envelope", () => {
  const held = {
    ...page([["user", "u1"], ["assistant", "a1"], ["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-1", hasEarlier: true }),
    historyLoaded: false,
  }
  // The window moved on by two: u1/a1 fell off the head, u3/a3 arrived at the tail.
  const pushed = [message("user", "u2"), message("assistant", "a2"), message("user", "u3"), message("assistant", "a3")]
  const next = reconcileLiveMessages(held, pushed) as typeof held
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["u2", "a2", "u3", "a3"])
  assert.equal(next.hasEarlier, true, "a slid window has MORE earlier history, not less")
  assert.equal(next.beforeCursor, "cursor-1")
  assert.equal(next.transcriptKey, "transcript-A")
})

test("a live push with no overlap at all is a session replacement and discards the window", () => {
  const held = { ...page([["user", "old-u"], ["assistant", "old-a"]], { hasEarlier: true }), historyLoaded: false }
  const next = reconcileLiveMessages(held, [message("user", "new-u")])
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["new-u"])
  assert.equal((next as { hasEarlier?: boolean }).hasEarlier, undefined, "nothing of the old world is carried over")
})

test("a live push against a slid window still splices in explicitly loaded history", () => {
  const loaded = {
    ...page([["user", "u1"], ["assistant", "a1"], ["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-1", hasEarlier: true }),
    historyLoaded: true,
  }
  const pushed = [message("user", "u2"), message("assistant", "a2"), message("user", "u3")]
  const next = reconcileLiveMessages(loaded, pushed) as typeof loaded
  assert.deepEqual(next.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2", "u3"])
  assert.equal(next.beforeCursor, "cursor-1")
})
