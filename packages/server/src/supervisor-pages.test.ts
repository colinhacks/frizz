import assert from "node:assert/strict"
import { test } from "node:test"
import { recoveryPage, retryTarget, unauthorizedPage, unlistedHostPage } from "./supervisor-pages.ts"

// The property two HTTP-level tests in restart-supervisor.test.ts already assert, pinned here as well
// so it fails at the unit that owns it. A shared document shell is exactly the shape that leaks this
// by accident: the first draft of supervisor-pages.ts named the product in a CSS keyframe, in a CSS
// comment ("the board's own dot") and in the localStorage key the font script reads — none of them
// visible on the page, all three served to a visitor who had proved nothing.
test("the unauthorized page discloses nothing about the product, in every reason", () => {
  for (const reason of [undefined, "unknown", "expired", "already-used"] as const) {
    const page = unauthorizedPage(reason)
    assert.doesNotMatch(page, /frizz|board|agent/i, `the ${reason ?? "default"} 401 page named the product`)
    // The whole point of carrying a reason: "already used" and "expired" are different next actions.
    assert.match(page, /access link|Generate a fresh one/)
  }
  assert.match(unauthorizedPage("already-used"), /already been used/)
  assert.match(unauthorizedPage("expired"), /expired/)
})

test("a request target that is not a same-origin path can never become the retry link", () => {
  assert.equal(retryTarget("/thread/demo?tab=terminal"), "/thread/demo?tab=terminal")
  assert.equal(retryTarget("/"), "/")
  // Absolute-form and authority-form request targets are both legal on the wire, and neither is a
  // link back to this board. The protocol-relative spelling is the one that looks like a path.
  assert.equal(retryTarget("//evil.invalid/"), "/")
  assert.equal(retryTarget("http://evil.invalid/"), "/")
  assert.equal(retryTarget("javascript:alert(1)"), "/")
  assert.equal(retryTarget(""), "/")
})

test("the recovery page escapes its target into both the link and the script's data attribute", () => {
  const page = recoveryPage('/thread/"><img src=x onerror=alert(1)>?a=1&b=2')
  assert.doesNotMatch(page, /<img src=x/)
  assert.match(page, /href="\/thread\/&quot;&gt;&lt;img/)
  // The script reads its target from body[data-target] rather than from an interpolated JS literal,
  // so there is no script-string escaping to get wrong.
  assert.match(page, /<body data-target="\/thread\/&quot;/)
  assert.match(page, /&amp;b=2/)
  // A hostile target must not survive anywhere as a bare href.
  assert.doesNotMatch(recoveryPage("http://evil.invalid/"), /evil\.invalid/)
})

test("each recovery variant states its own cause, and both offer the same two ways out", () => {
  const starting = recoveryPage("/")
  const unreachable = recoveryPage("/", "unreachable")
  assert.match(starting, />Frizz is restarting</)
  assert.match(unreachable, />Frizz is not responding</)
  for (const page of [starting, unreachable]) {
    assert.match(page, /Try again/)
    assert.match(page, /Restart Frizz/)
    // Threads outlive a restart because each is its own detached process; an operator staring at this
    // page should not have to guess.
    assert.match(page, /Threads already running are not affected/)
    // A `</script>` anywhere inside the inline script would end it early and dump the rest as markup.
    assert.equal(page.split("</script>").length - 1, 3, "one theme script, one font script, one recovery script")
    assert.match(page, /localStorage\.getItem\("frizz-theme"\)/)
  }
})

test("the unlisted-host page escapes the name it echoes, in prose and in both flag spellings", () => {
  const page = unlistedHostPage('a"<b>&c')
  assert.doesNotMatch(page, /<b>/)
  assert.equal(page.split("a&quot;&lt;b&gt;&amp;c").length - 1, 3, "prose, --allowed-host and the env var")
  assert.match(page, /--allowed-host/)
  assert.match(page, /FRIZZ_ALLOWED_HOSTS/)
})
