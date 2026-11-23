import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeSkillsProbe } from "./claude-skills-probe.ts"
import type { ClaudeQueryFactory, ClaudeQueryHandle, ClaudeQueryStartOptions } from "./claude-agent-sdk.ts"
import type { ClaudeSkillInfo } from "./claude-agent-sdk-protocol.ts"

// A CLI session that never runs a turn: it answers skill listings from `listing` and ends when closed.
function fakeFactory(listing: (session: number, call: number) => ClaudeSkillInfo[] | Error) {
  const started: Array<{ options: ClaudeQueryStartOptions; closed: () => boolean }> = []
  const factory: ClaudeQueryFactory = {
    start(options) {
      const session = started.length
      let closed = false
      let end: (() => void) | undefined
      let calls = 0
      const handle = {
        async reloadSkills() {
          const answer = listing(session, calls++)
          if (answer instanceof Error) throw answer
          return answer
        },
        async close() { closed = true; end?.() },
        async *[Symbol.asyncIterator]() { if (!closed) await new Promise<void>((resolve) => { end = resolve }) },
      }
      started.push({ options, closed: () => closed })
      return handle as unknown as ClaudeQueryHandle
    },
  }
  return { factory, started }
}

const REVIEW: ClaudeSkillInfo = { name: "review", description: "Review changes", source: "project" }

test("the probe is one session started the way a worker is, asked afresh for every listing", async () => {
  const { factory, started } = fakeFactory((_session, call) => call === 0 ? [REVIEW] : [REVIEW, { name: "fresh", description: "Added later" }])
  const probe = createClaudeSkillsProbe({
    projectDir: "/repo",
    executablePath: "claude",
    env: { HOME: "/home/x", FRIZZ_THREAD: "some-thread" },
    pluginDir: "/frizz/cc-worker",
    factory,
  })
  try {
    assert.deepEqual(await probe.skills(), [REVIEW])
    // The second listing is the same session's re-read, so a skill written in between is in it.
    assert.deepEqual((await probe.skills()).map((skill) => skill.name), ["review", "fresh"])
    assert.equal(started.length, 1)
    const options = started[0]!.options
    assert.equal(options.cwd, "/repo")
    assert.equal(options.pluginDir, "/frizz/cc-worker", "the frizz:* skills come from the worker plugin")
    // Every setting scope, as a worker: the factory's default, which an explicit list would override.
    assert.equal(options.settingSources, undefined)
    assert.equal(options.persistSession, false)
    assert.equal(options.strictMcpConfig, true)
    assert.equal(options.mcpServers, undefined, "no MCP server is mounted")
    // The CLI runs SessionStart hooks even without a turn; the worker plugin's must not take it for a worker.
    assert.deepEqual(options.env, { HOME: "/home/x", FRIZZ_SCRATCHPAD_HOOK: "off" })
  } finally {
    await probe.close()
  }
  assert.equal(started[0]!.closed(), true)
})

test("a listing that fails retires its session, and the next listing starts a new one", async () => {
  const { factory, started } = fakeFactory((session) => session === 0 ? new Error("CLI went away") : [REVIEW])
  const probe = createClaudeSkillsProbe({ projectDir: "/repo", executablePath: "claude", env: {}, factory })
  try {
    await assert.rejects(probe.skills(), /CLI went away/)
    assert.equal(started[0]!.closed(), true)
    assert.deepEqual(await probe.skills(), [REVIEW])
    assert.equal(started.length, 2)
  } finally {
    await probe.close()
  }
})

test("an idle probe closes its session", async () => {
  const { factory, started } = fakeFactory(() => [REVIEW])
  const probe = createClaudeSkillsProbe({ projectDir: "/repo", executablePath: "claude", env: {}, factory, idleMs: 20 })
  try {
    await probe.skills()
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(started[0]!.closed(), true)
    await probe.skills()
    assert.equal(started.length, 2, "a listing after the idle close starts a new session")
  } finally {
    await probe.close()
  }
})
