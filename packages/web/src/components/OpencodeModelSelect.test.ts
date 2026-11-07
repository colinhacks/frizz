import assert from "node:assert/strict"
import test from "node:test"
import { opencodeModelGroups } from "./OpencodeModelSelect.tsx"
import { selectDisplayValue } from "../lib/selectLayout.ts"

const models = { available: true, models: [{ providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: [] }] }
const shown = (groups: ReturnType<typeof opencodeModelGroups>, value: string) => selectDisplayValue(value, undefined, groups, "Loading models…")

test("while OpenCode's models load, the trigger says so instead of claiming the default", () => {
  assert.deepEqual(shown(opencodeModelGroups(undefined, undefined, true), ""), { text: "Loading models…", placeholder: true })
  // A saved model is the thread's value whatever the list says, so it reads as itself meanwhile.
  assert.deepEqual(shown(opencodeModelGroups(undefined, "opencode:opencode/big-pickle", true), "opencode/big-pickle"), { text: "opencode/big-pickle", placeholder: false })
})

test("once the list is back, an unset model reads as OpenCode's default and a saved one by its name", () => {
  assert.deepEqual(shown(opencodeModelGroups(models as never, undefined), ""), { text: "Default", placeholder: false })
  assert.deepEqual(shown(opencodeModelGroups(models as never, "opencode:opencode/big-pickle"), "opencode/big-pickle"), { text: "Big Pickle", placeholder: false })
})
