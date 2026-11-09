import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, innerPath, isConsolePath, outerPath, prefixedAppRoute, projectApiBase, projectHref, projectSlug } from "./base-path.ts"

// The launching project is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_frizz", path)
    assert.equal(projectSlug(path), undefined, path)
  }
})

test("a project page lives under /project, and its API stays flat", () => {
  assert.equal(basePath("/project/nub"), "/project/nub")
  assert.equal(basePath("/project/nub/thread/fix-auth"), "/project/nub")
  assert.equal(projectSlug("/project/pullfrog-app/status/active"), "pullfrog-app")
  assert.equal(projectHref("nub"), "/project/nub")
  // The API is already inside a reserved namespace, so it has no root to protect: `/project` would
  // buy nothing there, and the server's split stays a two-part one.
  assert.equal(apiBase("/project/nub/thread/fix-auth"), "/_frizz/nub")
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/project/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/project/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/project/nub/thread/other"), "/project/nub/thread/fix-auth")
  assert.equal(outerPath("/", "/project/nub/thread/other"), "/project/nub")
  // Unprefixed, outer is a no-op — which is what keeps the launching project's own URLs working.
  assert.equal(outerPath("/thread/fix-auth", "/thread/other"), "/thread/fix-auth")
  assert.equal(outerPath("/", "/"), "/")
})

// THE POINT of moving projects under a segment of their own: the root namespace stays Frizz's.
test("only /project/<slug> is a project, so the root is free for other pages", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project")
  assert.equal(basePath("/status/blocked"), "")
  // A future top-level page cannot be shadowed by a directory somebody happens to have.
  assert.equal(basePath("/settings"), "")
  assert.equal(basePath("/docs/getting-started"), "")
  assert.equal(projectSlug("/settings"), undefined)
  // …and `/project` with nothing after it is not a project either.
  assert.equal(basePath("/project"), "")
  assert.equal(projectSlug("/project"), undefined)
})

// A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project. Under
// a prefix that raw href addresses whichever project LAUNCHED the server, so every modified click
// (⌘, middle, "open in new tab") on an agent's own cross-reference landed on a stranger's board.
test("an agent's unprefixed in-app link is re-pointed at the project the page is showing", () => {
  const page = "/project/nub/thread/fix-auth"
  assert.equal(prefixedAppRoute("/thread/other", page), "/project/nub/thread/other")
  assert.equal(prefixedAppRoute("/status/active", page), "/project/nub/status/active")
  assert.equal(prefixedAppRoute("/thread/other/full", page), "/project/nub/thread/other/full")
  // Query and fragment ride along rather than being dropped or re-pointed at the base.
  assert.equal(prefixedAppRoute("/thread/other?x=1#y", page), "/project/nub/thread/other?x=1#y")

  // Everything that must be left exactly as written.
  assert.equal(prefixedAppRoute("/project/other/thread/x", page), null, "already names its project")
  assert.equal(prefixedAppRoute("/", page), null, "the all-projects grid is the same page everywhere")
  assert.equal(prefixedAppRoute("/Users/me/notes.md", page), null, "a filesystem path is not a route")
  assert.equal(prefixedAppRoute("//cdn.example/a", page), null, "protocol-relative is a web URL")
  assert.equal(prefixedAppRoute("docs/x", page), null)
  assert.equal(prefixedAppRoute(null, page), null)
  // On the launching project there is nothing to add, so the href is left alone rather than churned.
  assert.equal(prefixedAppRoute("/thread/other", "/thread/fix-auth"), null)
})

// The Console is a base of its own: the router's inner paths work under it, and it names no project.
test("the Console is a base that names no project", () => {
  assert.equal(isConsolePath("/console"), true)
  assert.equal(isConsolePath("/console/thread/nub~fix"), true)
  assert.equal(isConsolePath("/project/console"), false, "a project called console is a project")
  assert.equal(isConsolePath("/"), false)
  assert.equal(basePath("/console/thread/nub~fix"), "/console")
  assert.equal(projectSlug("/console/thread/nub~fix"), undefined)
  assert.equal(innerPath("/console/thread/nub~fix"), "/thread/nub~fix")
  assert.equal(innerPath("/console"), "/")
  assert.equal(outerPath("/thread/nub~fix", "/console"), "/console/thread/nub~fix")
  assert.equal(outerPath("/", "/console/thread/nub~fix"), "/console")
  assert.equal(projectApiBase("nub"), "/_frizz/nub")
})

// Review finding 9 (2026-10-11): on the Console a worker's `/thread/<slug>` was stamped `/console/thread/<slug>`,
// which names no project — a new-tab open (and any click the interceptor could not place) then resolved the
// bare slug across EVERY project, landing on whichever had it, or on the launching project's thread of that
// name. The prose's own project (its surface's ProjectScope) now goes into the link. Since 2026-11-07 the
// link is that project's page for the thread — its full-screen page; a plain click still opens it here.
test("on the Console a thread link names its thread's project, and only when the prose's project is known", () => {
  const page = "/console"
  assert.equal(prefixedAppRoute("/thread/fix-auth", page, "billing"), "/project/billing/thread/fix-auth")
  assert.equal(prefixedAppRoute("/thread/fix-auth/", "/console", "billing"), "/project/billing/thread/fix-auth/")
  assert.equal(prefixedAppRoute("/thread/fix-auth?x=1#y", page, "billing"), "/project/billing/thread/fix-auth?x=1#y")
  // An old `/full` link goes to the same project, where routes.tsx drops the suffix.
  assert.equal(prefixedAppRoute("/thread/fix-auth/full", page, "billing"), "/project/billing/thread/fix-auth/full")
  // No project to name: left exactly as written rather than turned into a bare Console link.
  assert.equal(prefixedAppRoute("/thread/fix-auth", page), null)
  assert.equal(prefixedAppRoute("/thread/fix-auth", page, undefined), null)
  // Already a key, already a project's, or not a thread: untouched by the project.
  assert.equal(prefixedAppRoute("/thread/acme~fix-auth", page, "billing"), null)
  assert.equal(prefixedAppRoute("/project/acme/thread/fix-auth", page, "billing"), null)
  assert.equal(prefixedAppRoute("/status/active", page, "billing"), "/console/status/active")
  // A project page ignores the argument: its own prefix is the project (and ProjectScope is never set there).
  assert.equal(prefixedAppRoute("/thread/other", "/project/nub", "billing"), "/project/nub/thread/other")
})
