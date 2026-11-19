import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { MOBILE_QUERY } from "./mobile.ts"

// "Is this a phone?" has ONE answer, spelled three times: `MOBILE_QUERY` (lib/mobile.ts), which picks the
// shell, the `phone:` variant in styles.css, which every phone-only class uses, and the rule beside it
// that makes a sheet the whole screen. Until 2026-11-19 the CSS half was `max-[700px]:` at each call
// site, so the answer was a width, and a phone held sideways (844 to 956px wide) got the desktop shell
// with none of the phone's rules. If a scan below fails on your change, spell the class `phone:` or move
// the query in all three places, rather than widening the scan.

const src = fileURLToPath(new URL("..", import.meta.url))
const styles = readFileSync(`${src}/styles.css`, "utf8")

test("the stylesheet's phone variant and its full-screen sheet rule are the shell's own query", () => {
  const uses = styles.split(`@media ${MOBILE_QUERY} {`).length - 1
  assert.equal(uses, 2, `styles.css must open exactly two blocks with \`@media ${MOBILE_QUERY}\`: the \`phone:\` variant and the sheet rule`)
  assert.match(styles, /@custom-variant phone \{\s*@media [^{]+\{\s*@slot;\s*\}\s*\}/, "the `phone:` variant is one media query around @slot")
  // The query is the one spelling: a second `max-width: 700px` in the sheet would be a rule the sideways
  // phone misses.
  assert.equal(styles.split("max-width: 700px").length - 1, 2, "no other rule in styles.css asks for the phone's width alone")
})

test("no class spells the phone's width: a phone-only class is `phone:`", () => {
  const offenders: string[] = []
  for (const file of globSync("**/*.{ts,tsx}", { cwd: src })) {
    if (file.endsWith("mobile.guard.test.ts")) continue
    const lines = readFileSync(`${src}/${file}`, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (/\bmax-\[70[01]px\]:|\bmin-\[70[01]px\]:/.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], "these classes key on the phone's width, which a phone on its side does not have; use `phone:` (or `not-phone:`)")
})
