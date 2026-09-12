import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

test("inline visualizations require the current source and request acknowledgement before showing", () => {
  assert.match(source, /const requestId = useRef\(0\)/)
  assert.match(source, /loadedSrc\.current !== src/)
  assert.match(source, /isVisualizationThemeAck\(event\.data, requestId\.current\)/)
  assert.match(source, /setAppliedSrc\(src\)/)
  assert.match(source, /visibility: appliedSrc === src \? "visible" : "hidden"/)
})

test("inline visualizations retry a complete palette on readiness and resolved theme changes", () => {
  assert.match(source, /frizz-inline-vis-ready[\s\S]{0,80}sendTheme\(\)/)
  assert.match(source, /useEffect\(\(\) => \{\s*sendTheme\(\)\s*\}, \[resolved, sendTheme\]\)/)
  assert.match(source, /visualizationThemeMessage\(requestId, root\.colorScheme === "light" \? "light" : "dark", vars\)/)
  assert.match(source, /window\.setTimeout\(\(\) => setAvailable\(false\), 5000\)/)
  assert.match(source, /sandbox="allow-scripts"/)
})
