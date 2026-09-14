import assert from "node:assert/strict"
import test from "node:test"
import { isVisualizationThemeAck, visualizationThemeMessage } from "./visualizationThemeProtocol.ts"

test("visualization acknowledgement is correlated to the current palette request", () => {
  assert.deepEqual(visualizationThemeMessage(4, "light", { "--foreground": "#111" }), {
    type: "frizz-inline-vis-theme", requestId: 4, colorScheme: "light", vars: { "--foreground": "#111" },
  })
  assert.equal(isVisualizationThemeAck({ type: "frizz-inline-vis-applied", requestId: 4 }, 4), true)
  assert.equal(isVisualizationThemeAck({ type: "frizz-inline-vis-applied", requestId: 3 }, 4), false)
  assert.equal(isVisualizationThemeAck({ type: "frizz-inline-vis-ready" }, 4), false)
})
