import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./TerminalPane.tsx", import.meta.url), "utf8")

test("terminal theme includes cursor contrast and every ANSI color", () => {
  assert.match(source, /cursorAccent: color\("--terminal-cursor-accent"\)/)
  for (const color of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    assert.match(source, new RegExp(`${color}: color\\("--terminal-${color}"\\)`))
    assert.match(source, new RegExp(`bright${color[0].toUpperCase()}${color.slice(1)}: color\\("--terminal-bright-${color}"\\)`))
  }
})

test("terminal updates colors only for resolved-theme changes without remounting", () => {
  assert.match(source, /let resolvedTheme = getThemeSnapshot\(\)\.resolved/)
  assert.match(source, /if \(nextResolved === resolvedTheme\) return/)
  assert.match(source, /term\.options\.theme = terminalTheme\(\)/)
  assert.match(source, /\}, \[slug\]\)/)
})
