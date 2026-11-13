import { test } from "node:test"
import assert from "node:assert/strict"
import type { McpReloadResult } from "@frizz/shared"
import { reloadSummary } from "./McpPlug.tsx"

const base: McpReloadResult = { backend: "claude", agent: "Claude Code", supported: true, servers: [] }
const change = { added: [], removed: [], changed: [], unchanged: 2, errors: {}, unapproved: [] }

test("the Reload note says what changed in the thread, and how many other running threads it reached", () => {
  assert.equal(reloadSummary({ ...base, thread: change, others: { reloaded: 0, stale: 0, failed: 0 } }), "Nothing changed.")
  assert.equal(
    reloadSummary({
      ...base,
      thread: { ...change, added: ["docs"], removed: ["old"], errors: { broken: "x" }, unapproved: ["unsure"] },
      others: { reloaded: 2, stale: 0, failed: 0 },
    }),
    "Added docs. Removed old. broken failed to connect. unsure isn’t approved in .claude settings. Reloaded 2 other running threads.",
  )
  // The new-thread box has no thread of its own.
  assert.equal(reloadSummary({ ...base, others: { reloaded: 1, stale: 0, failed: 0 } }), "Reloaded 1 running thread.")
  assert.match(reloadSummary({ ...base, others: { reloaded: 0, stale: 0, failed: 0 } }), /^No running threads to reload/)
  assert.equal(reloadSummary({ ...base, note: "This thread’s Claude session isn’t running." }), "This thread’s Claude session isn’t running.")
  assert.equal(reloadSummary({ ...base, backend: "codex", agent: "Codex" }), "Reloaded every Codex thread of this project.")
})
