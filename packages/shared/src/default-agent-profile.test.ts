import { test } from "node:test"
import { strict as assert } from "node:assert"
import { defaultAgentProfile, opencodeAgentProfile } from "./default-agent-profile.ts"
import { acpModelSlug } from "./index.ts"

const out = "signed-out" as const

test("signed out of both with OpenCode installed starts on OpenCode", () => {
  assert.deepEqual(defaultAgentProfile({ claude: out, codex: out, opencodeInstalled: true }), { backend: "acp", model: acpModelSlug("opencode") })
})

test("every other machine keeps the shipped default", () => {
  for (const input of [
    { claude: out, codex: out, opencodeInstalled: false },
    { claude: "authed", codex: out, opencodeInstalled: true },
    { claude: out, codex: "authed", opencodeInstalled: true },
    // An unsettled or unreadable answer is not a positive signed-out: a slow read must not move anyone.
    { claude: "unknown", codex: out, opencodeInstalled: true },
    { claude: out, codex: "unknown", opencodeInstalled: true },
    { claude: undefined, codex: undefined, opencodeInstalled: true },
  ] as const) {
    assert.equal(defaultAgentProfile(input), undefined, JSON.stringify(input))
  }
})

test("an OpenCode new enough for the native backend starts on it; an older one stays on ACP", () => {
  assert.deepEqual(defaultAgentProfile({ claude: out, codex: out, opencodeInstalled: true, opencodeNative: true }), { backend: "opencode", model: "opencode:" })
  assert.deepEqual(defaultAgentProfile({ claude: out, codex: out, opencodeInstalled: true, opencodeNative: false }), { backend: "acp", model: acpModelSlug("opencode") })
  assert.equal(defaultAgentProfile({ claude: "authed", codex: out, opencodeInstalled: true, opencodeNative: true }), undefined)
  assert.deepEqual(opencodeAgentProfile(true), { backend: "opencode", model: "opencode:" })
  assert.deepEqual(opencodeAgentProfile(undefined), { backend: "acp", model: acpModelSlug("opencode") })
})
