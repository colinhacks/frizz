import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./useThreadComposerControls.tsx", import.meta.url), "utf8")

// Every hook in useThreadComposerControls runs BEFORE its early return. The hook renders inside every
// mounted composer, and a surface can outlive its thread's board row (the queue card did, by one fade):
// on the render where the row is gone, `thread` is undefined and the function returns early. A hook
// below that return is then skipped on exactly that render, and React tears down the tree with "change
// in the order of Hooks" — which is how a steered queue card took every other card with it in one frame
// (2026-09-19).
test("no hook is called after the early return for a thread without a runtime profile", () => {
  const body = source.slice(source.indexOf("export function useThreadComposerControls"))
  const earlyReturn = body.indexOf("if (!thread || thread.foreign || thread.kind !== \"session\") return")
  assert.ok(earlyReturn > 0, "the early return is still there")
  const after = body.slice(earlyReturn)
  const hooks = [...after.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m[0])
  assert.deepEqual(hooks, [], `hooks called after the early return: ${hooks.join(", ")}`)
  // The ACP catalogue query in particular, which is the one that had slipped below it.
  assert.ok(body.indexOf('useQuery({ queryKey: ["acpAgents"]') < earlyReturn)
})
