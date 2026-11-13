import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BackgroundShellInfo } from "./tailer.ts"

// A Claude Code MONITOR through the background-shell drawer's two endpoints. It has no output file; the
// tailer hands over the events it delivered (tailer.ts collectMonitorEvents), and these answer them.
// The stub carries what `createRouter` resolves up front, the lookup, and `subAgent` for the stop gate.
function harness(shells: Record<string, BackgroundShellInfo>) {
  const ctx = {
    project: { dir: tmpdir(), stateDir: tmpdir() },
    storage: {},
    board: {},
    tailer: { backgroundShell: (_slug: string, id: string) => shells[id], subAgent: () => undefined },
  } as unknown as AppContext
  return createRouter(ctx)
}

const SLUG = "monitor-thread"
const MONITOR: BackgroundShellInfo = {
  command: "tail -F gates.log | grep --line-buffered -E 'pass|FAIL'",
  state: "done",
  monitor: { events: [{ text: "pass  lab-sqlite  1s", at: "2026-10-22T20:40:37.834Z" }, { text: "FAIL  mysql-server" }], dropped: 3 },
}

test("the drawer endpoint answers a Monitor's command and events, and an ended one still resolves", async () => {
  const router = harness({ mon: MONITOR })
  assert.deepEqual(await router.backgroundShellOutput.handler({ input: { slug: SLUG, id: "mon" } }), {
    command: MONITOR.command,
    output: "",
    truncated: false,
    events: [{ text: "pass  lab-sqlite  1s", at: "2026-10-22T20:40:37.834Z" }, { text: "FAIL  mysql-server", at: null }],
    eventsDropped: 3,
    state: "done",
    stoppable: false,
    stopNote: null,
  })
})

test("a background Bash answers events:null, which is how the drawer tells the two apart", async () => {
  const router = harness({ sh: { command: "gh run watch", state: "running" } })
  const answer = await router.backgroundShellOutput.handler({ input: { slug: SLUG, id: "sh" } })
  assert.equal(answer.events, null)
  assert.equal(answer.eventsDropped, 0)
  const gone = await router.backgroundShellOutput.handler({ input: { slug: SLUG, id: "nobody" } })
  assert.equal(gone.state, "gone")
  assert.equal(gone.events, null)
})

test("the activity counter counts a Monitor's events, the ones let go included", async () => {
  const router = harness({ mon: { ...MONITOR, state: "running" } })
  assert.deepEqual(await router.backgroundShellActivity.handler({ input: { slug: SLUG, ids: ["mon"] } }), {
    shells: [{ id: "mon", lines: 5, running: true }],
  })
})
