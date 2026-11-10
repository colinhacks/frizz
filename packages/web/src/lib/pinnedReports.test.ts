import assert from "node:assert/strict"
import { test } from "node:test"
import { boardQueuedThread, type ThreadView } from "@frizz/shared"
import { consoleQueue, holdsCardOnConsole } from "./consoleBoard.ts"
import { nextThreadNeedingYou } from "./mobileTriage.ts"

// A PINNED THREAD QUEUES ONLY ITS ASKS (maintainer 2026-11-06). A report loses its card only where a
// pinned row shows it instead, so it is never in neither place. The server's half, which rest is a report,
// is board.derivePlainReport's; pinnedReports.e2e.test.ts drives the whole of it on a real stack.
const rest = (id: string, over: Partial<ThreadView> = {}): ThreadView =>
  ({ id, kind: "session", state: "open", runtime: "turn-idle", needsYou: true, ...over }) as ThreadView
const at = "2026-11-06T10:00:00.000Z"
const report = { plainReport: true }
const boardPin = { pinnedAt: at }
const consolePin = { consolePinnedAt: at }

test("a project's board draws no card for its pinned thread's plain report, and one for everything else", () => {
  assert.equal(boardQueuedThread(rest("pinned report", { ...report, ...boardPin })), false)
  assert.equal(boardQueuedThread(rest("pinned ask", boardPin)), true, "an ask or a failure is no plain report")
  assert.equal(boardQueuedThread(rest("unpinned report", report)), true)
  assert.equal(boardQueuedThread(rest("Console pin", { ...report, ...consolePin })), true, "the Console's pin is no part of a board")
  assert.equal(boardQueuedThread(rest("not queued", { ...report, ...boardPin, needsYou: false })), false)
})

test("By status reads the Console's pin alone, and By project lifts nothing, so a report is never in neither place", () => {
  const boardPinned = rest("board", { ...report, ...boardPin })
  const consolePinned = rest("console", { ...report, ...consolePin })
  const consolePinnedAsk = rest("console ask", consolePin)
  assert.equal(holdsCardOnConsole(boardPinned, "status"), true, "its row sits on no shelf on By status")
  assert.equal(holdsCardOnConsole(consolePinned, "status"), false, "its row is on By status's shelf")
  assert.equal(holdsCardOnConsole(consolePinnedAsk, "status"), true)
  assert.equal(holdsCardOnConsole(boardPinned, "project"), true, "By project has no shelf")
  assert.equal(holdsCardOnConsole(consolePinned, "project"), true, "By project has no shelf")
  assert.deepEqual(consoleQueue([boardPinned, consolePinned, consolePinnedAsk], "fifo", "status").map((t) => t.id).sort(), ["board", "console ask"])
})

test("the phone's Done loop passes over a pinned thread's report, and lands on its ask", () => {
  const threads = [
    rest("current"),
    rest("pinned report", { ...report, ...boardPin }),
    rest("pinned ask", { pinnedAt: "2026-11-06T11:00:00.000Z", pendingAsk: { questions: [{ question: "?", options: [] }] } }),
  ]
  assert.equal(nextThreadNeedingYou(threads, "current", "fifo", {})?.id, "pinned ask")
  assert.equal(nextThreadNeedingYou(threads.slice(0, 2), "current", "fifo", {}), undefined)
})
