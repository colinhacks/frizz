import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { queueOpsCounts } from "./queueOpsCounts.ts"

// The drawer hands the counts the shells it reads off the transcript, which the board reports none of for
// a Codex thread — and reports AGAIN for a Claude one. The line has to count the first and must not count
// the second twice, or the drawer and the queue card disagree about one thread.
const thread = (bgShells: ThreadView["bgShells"]) => ({ id: "t", subAgents: [], watches: [], links: [], bgShells }) as unknown as ThreadView
const BOARD_SHELL = { id: "toolu_a", label: "Run the dev server", startedAt: "2026-10-09T10:00:00.000Z", state: "running" as const }

test("the counts take the drawer's transcript shells, once each", () => {
  const codex = { label: "Tail the build log", startedAt: "2026-10-09T10:01:00.000Z", state: "running" as const }
  const claudeCopy = { ...BOARD_SHELL, id: undefined, launchId: "toolu_a", startedAt: "2026-10-09T10:00:04.000Z" }
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL])).map(({ key, n }) => ({ key, n })), [{ key: "shell", n: 1 }])
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL]), [claudeCopy]).map(({ key, n }) => ({ key, n })), [{ key: "shell", n: 1 }], "the board's own shell is not counted twice")
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL]), [codex]).map(({ key, n }) => ({ key, n })), [{ key: "shell", n: 2 }])
  assert.deepEqual(queueOpsCounts(thread([]), [codex]).map(({ key, n }) => ({ key, n })), [{ key: "shell", n: 1 }], "a Codex shell the board never reports still counts")
})

// Every wait the thread has is counted, because the steps card lists none of them and points here: a
// kind with no count would be a wait shown nowhere on the queue card or in the drawer.
test("the counts name a command watch and a timer, each by its own kind", () => {
  const watch = (kind: string, target: string, state = "armed") => ({ id: `${kind}:${target}`, kind, target, state, createdAt: "2026-10-15T10:00:00.000Z" })
  const t = { id: "t", state: "rested", subAgents: [], links: [], bgShells: [], watches: [
    watch("command", "cmw_a"), watch("command", "cmw_b"), watch("timer", "tmr_a"), watch("timer", "tmr_b", "fired"),
  ] } as unknown as ThreadView
  assert.deepEqual(queueOpsCounts(t).map(({ key, n }) => ({ key, n })), [{ key: "command", n: 2 }, { key: "timer", n: 1 }])
})

// A persistent command watch had its own count until the two became one command (2026-11-06).
test("the counts hold both shapes of command watch as one", () => {
  const watch = (target: string, monitor: boolean) => ({
    id: `command:t:${target}`, kind: "command", target, state: "armed", createdAt: "2026-11-03T10:00:00.000Z",
    command: { command: "tail -F x.log", every: "0s", expiresAt: "2026-11-04T10:00:00.000Z", runs: 0, ...(monitor ? { monitor: { description: "Errors in x.log", events: 1 } } : {}) },
  })
  const t = (watches: unknown[]) => ({ id: "t", state: "rested", subAgents: [], links: [], bgShells: [], watches }) as unknown as ThreadView
  const read = (watches: unknown[]) => queueOpsCounts(t(watches)).map(({ key, n, one }) => ({ key, n, one }))
  assert.deepEqual(read([watch("cmw_m", true)]), [{ key: "command", n: 1, one: "command" }])
  assert.deepEqual(read([watch("cmw_m", true), watch("cmw_n", true), watch("cmw_c", false)]), [{ key: "command", n: 3, one: "command" }])
})
