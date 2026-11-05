import assert from "node:assert/strict"
import test from "node:test"
import { splitToolPath, toolRailNode } from "./toolRow.ts"

test("a path splits so the filename survives whichever separator it uses", () => {
  assert.deepEqual(splitToolPath("packages/web/src/ChatView.tsx"), { dir: "packages/web/src/", base: "ChatView.tsx" })
  assert.deepEqual(splitToolPath("C:\\repo\\src\\app.ts"), { dir: "C:\\repo\\src\\", base: "app.ts" })
  assert.deepEqual(splitToolPath("README.md"), { dir: "", base: "README.md" })
})

test("only a bad outcome changes a call's node, and a running or finished call keeps the plain one", () => {
  assert.equal(toolRailNode("failed"), "failed")
  assert.equal(toolRailNode("cancelled"), "cancelled")
  assert.equal(toolRailNode("completed"), undefined)
  assert.equal(toolRailNode("pending"), undefined)
  assert.equal(toolRailNode(undefined), undefined)
})
