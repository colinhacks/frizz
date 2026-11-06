import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { listAcpAgents, resolveAcpAgent } from "./acp-agents.ts"

/** A PATH holding one executable per name, so the answer never depends on what this machine has installed. */
function withPath<T>(names: readonly string[], run: (env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "acp-agents-"))
  try {
    for (const name of names) {
      writeFileSync(join(dir, name), "#!/bin/sh\n")
      chmodSync(join(dir, name), 0o755)
    }
    return run({ PATH: dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a goose on PATH is not offered as an agent: Homebrew's goose is a database migration tool", () => {
  withPath(["goose", "opencode"], (env) => {
    const found = listAcpAgents(undefined, env).filter((agent) => agent.bin).map((agent) => agent.id)
    assert.deepEqual(found, ["opencode"])
    assert.equal(resolveAcpAgent("goose", undefined, env), undefined)
  })
})

test("Block's goose agent is one settings entry away", () => {
  const custom = [{ id: "goose", label: "goose", command: "goose", args: ["acp"] }]
  withPath(["goose"], (env) => {
    const agent = resolveAcpAgent("goose", custom, env)
    assert.equal(agent?.bin, join(env.PATH!, "goose"))
    assert.deepEqual(agent?.args, ["acp"])
    assert.ok(listAcpAgents(custom, env).some((listed) => listed.id === "goose" && listed.bin))
  })
})
