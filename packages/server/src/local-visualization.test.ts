import assert from "node:assert/strict"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { resolveLocalVisualization } from "./local-visualization.ts"

test("resolves only the owning session's newest visualization and wraps it as a sandbox document", async () => {
  const root = await mkdtemp(join(tmpdir(), "frizz-inline-vis-"))
  try {
    const older = join(root, ".codex", "visualizations", "2026", "07", "21", "session-a")
    const newer = join(root, ".codex", "visualizations", "2026", "07", "22", "session-a")
    const other = join(root, ".codex", "visualizations", "2026", "07", "22", "session-b")
    mkdirSync(older, { recursive: true })
    mkdirSync(newer, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(older, "spend-chart.html"), "<p>older</p>")
    writeFileSync(join(newer, "spend-chart.html"), "<section>newer</section>")
    writeFileSync(join(other, "spend-chart.html"), "<p>wrong session</p>")

    const result = resolveLocalVisualization(root, "session-a", "spend-chart.html")
    assert.equal(result.status, 200)
    if (result.status !== 200) return
    assert.match(result.body, /<!doctype html>/)
    assert.match(result.body, /<section>newer<\/section>/)
    assert.doesNotMatch(result.body, /older|wrong session/)
    assert.match(result.body, /frizz-inline-vis-height/)
    assert.match(result.body, /event\.source !== parent/)
    assert.match(result.body, /Number\.isSafeInteger\(event\.data\.requestId\)/)
    assert.match(result.body, /new CustomEvent\("frizz-theme-change"/)
    assert.match(result.body, /frizz-inline-vis-applied", requestId: event\.data\.requestId/)
    assert.match(result.contentSecurityPolicy, /default-src 'none'/)
    assert.match(result.contentSecurityPolicy, /connect-src 'none'/)
    assert.match(result.contentSecurityPolicy, /sandbox allow-scripts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects traversal, non-contract names, oversized fragments, and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "frizz-inline-vis-gates-"))
  const outside = await mkdtemp(join(tmpdir(), "frizz-inline-vis-outside-"))
  try {
    const dir = join(root, ".codex", "visualizations", "2026", "07", "22", "session-a")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "large.html"), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    writeFileSync(join(outside, "escaped.html"), "<p>escaped</p>")
    symlinkSync(join(outside, "escaped.html"), join(dir, "escaped.html"))
    const otherSession = join(root, ".codex", "visualizations", "2026", "07", "22", "session-b")
    mkdirSync(otherSession, { recursive: true })
    writeFileSync(join(otherSession, "cross-session.html"), "<p>other session</p>")
    symlinkSync(join(otherSession, "cross-session.html"), join(dir, "cross-session.html"))

    assert.equal(resolveLocalVisualization(root, "session-a", "../escaped.html").status, 400)
    assert.equal(resolveLocalVisualization(root, "session-a", "Chart.html").status, 400)
    assert.equal(resolveLocalVisualization(root, "../session-a", "escaped.html").status, 400)
    assert.equal(resolveLocalVisualization(root, "session-a", "missing.html").status, 404)
    assert.equal(resolveLocalVisualization(root, "session-a", "large.html").status, 413)
    assert.equal(resolveLocalVisualization(root, "session-a", "escaped.html").status, 404)
    assert.equal(resolveLocalVisualization(root, "session-a", "cross-session.html").status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("rejects a visualization root symlinked outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "frizz-inline-vis-root-link-"))
  const outside = await mkdtemp(join(tmpdir(), "frizz-inline-vis-root-outside-"))
  try {
    const dir = join(outside, "2026", "07", "22", "session-a")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "chart.html"), "<p>outside</p>")
    mkdirSync(join(root, ".codex"), { recursive: true })
    symlinkSync(outside, join(root, ".codex", "visualizations"))
    assert.equal(resolveLocalVisualization(root, "session-a", "chart.html").status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
