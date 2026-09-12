import assert from "node:assert/strict"
import test from "node:test"
import { githubLabelColors } from "./githubLabelColors.ts"

test("GitHub label colors preserve valid external hues through semantic CSS treatments", () => {
  for (const color of ["fef2c0", "ffffff", "000001", "D73A4A"]) {
    const treatment = githubLabelColors(color)
    assert.match(treatment.foreground, /var\(--color-fg\)/)
    assert.match(treatment.background, /var\(--gh-label-bg-base\)/)
    assert.match(treatment.border, /var\(--gh-label-border-base\)/)
    assert.match(`${treatment.foreground}${treatment.background}${treatment.border}`, new RegExp(`#${color.toLowerCase()}`, "i"))
  }
})

test("malformed external label colors use semantic neutral treatments", () => {
  for (const color of ["", "white", "#fff", "#ffffff00", "url(javascript:alert(1))"]) {
    assert.deepEqual(githubLabelColors(color), {
      foreground: "color-mix(in srgb, var(--color-fg) var(--gh-label-fg-mix), var(--color-muted))",
      background: "color-mix(in srgb, var(--color-muted) var(--gh-label-bg-mix), var(--gh-label-bg-base))",
      border: "color-mix(in srgb, var(--color-muted) var(--gh-label-border-mix), var(--gh-label-border-base))",
    })
  }
})
