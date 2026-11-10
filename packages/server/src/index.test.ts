import assert from "node:assert/strict"
import { test } from "node:test"
import { describeBootTimings, describeServerStart, registeredTenantHealth, splitTenantRequest, unknownProjectPage } from "./index.ts"

// A project slug and one of Frizz's own route names occupy the same position, so `/_frizz/rpc/board`
// and `/_frizz/nub/rpc/board` are indistinguishable until you know which slugs exist. The registry
// settles it — and cannot be ambiguous, because it refuses to mint a slug that shadows a route name.
test("splitTenantRequest tells a project slug from one of Frizz's own routes", () => {
  const known = (s: string) => ["nub", "frizz", "pullfrog-app"].includes(s)

  assert.deepEqual(splitTenantRequest("/_frizz/nub/rpc/board", known), {
    slug: "nub",
    rest: "/_frizz/rpc/board",
  })
  assert.deepEqual(splitTenantRequest("/_frizz/pullfrog-app/events", known), {
    slug: "pullfrog-app",
    rest: "/_frizz/events",
  })
  // Query strings ride along on the rest, untouched.
  assert.deepEqual(splitTenantRequest("/_frizz/nub/local-image?path=%2Ftmp%2Fa.png", known), {
    slug: "nub",
    rest: "/_frizz/local-image?path=%2Ftmp%2Fa.png",
  })
  // A bare slug with nothing after it still addresses that tenant.
  assert.deepEqual(splitTenantRequest("/_frizz/nub", known), { slug: "nub", rest: "/_frizz/" })

  // An UNPREFIXED route is the launching project — a client that has not learned about slugs keeps working.
  assert.equal(splitTenantRequest("/_frizz/rpc/board", known), undefined)
  assert.equal(splitTenantRequest("/_frizz/events", known), undefined)
  assert.equal(splitTenantRequest("/_frizz/health", known), undefined)
  // An unknown first segment is a route name we have not met, never a project.
  assert.equal(splitTenantRequest("/_frizz/not-a-project/rpc/board", known), undefined)
  // Anything outside the reserved prefix is a project PAGE, handled by the SPA rather than here.
  assert.equal(splitTenantRequest("/nub", known), undefined)
  assert.equal(splitTenantRequest("/nub/thread/x", known), undefined)
  assert.equal(splitTenantRequest("/", known), undefined)
})

// THE POINT: a launcher asking "is the Frizz on this machine serving my project" must be answered out
// of the registry, never by opening the project. Routing that question through routeToTenant made it
// cost a tenant activation — 34.5s against a live server on 2026-08-12 — and the launcher, which gives
// up long before that, then started a SECOND Frizz for a project the first one was already serving.
test("registeredTenantHealth answers the join probe for a registered project without opening it", () => {
  const registry: Record<string, { id: string; path: string }> = {
    nub: { id: "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5", path: "/Users/x/projects/nub" },
    zod: { id: "b47f4055-4262-432a-af18-ded4cbfb3071", path: "/Users/x/projects/zod" },
  }
  // findProjectBySegment resolves a slug OR an id, so the fake has to answer both.
  const lookup = (segment: string) =>
    registry[segment] ?? Object.values(registry).find((entry) => entry.id === segment)
  const openNone = (_projectId: string) => false
  const health = (url: string, isOpen: (projectId: string) => boolean = openNone, method = "GET") =>
    registeredTenantHealth(method, url, "boot-1", lookup, isOpen)

  // A registered project nobody has opened: answered, with ITS identity, not the launching project's.
  assert.deepEqual(health("/_frizz/nub/health"), {
    ok: true,
    projectId: "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5",
    projectDir: "/Users/x/projects/nub",
    bootId: "boot-1",
  })
  // The id addresses a tenant as well as the slug, because a worker's frizz MCP holds the id.
  assert.equal(health("/_frizz/b47f4055-4262-432a-af18-ded4cbfb3071/health")?.projectDir, "/Users/x/projects/zod")
  // A query string still names /health.
  assert.equal(health("/_frizz/nub/health?x=1")?.projectId, registry.nub!.id)

  // An OPEN project falls through to its own app instead — that is what carries `ownerProof`, and
  // reaching it costs nothing once the tenant exists.
  assert.equal(health("/_frizz/nub/health", (id) => id === registry.nub!.id), undefined)

  // Everything else routes normally. This shortcut answers exactly one route, and only for GET.
  assert.equal(health("/_frizz/nub/rpc/board"), undefined)
  assert.equal(health("/_frizz/nub/health", openNone, "POST"), undefined)
  // Unprefixed /health is the launching project's, owner proof and all.
  assert.equal(health("/_frizz/health"), undefined)
  // A project this machine does not know is not ours to answer for — the launcher must NOT join here.
  assert.equal(health("/_frizz/not-a-project/health"), undefined)
})

// A page for a project nobody has is the one URL the CLIENT cannot resolve: it renders the app, every
// call it makes is answered 404 by the launching project, the board never lands, and it sits on
// "connecting…" retrying forever. The registry is the authority, so the server answers instead.
test("unknownProjectPage names the slug of a project page that does not exist", () => {
  const known = (s: string) => ["nub", "frizz", "pullfrog-app"].includes(s)

  assert.equal(unknownProjectPage("/project/deleted-last-week", known), "deleted-last-week")
  assert.equal(unknownProjectPage("/project/deleted-last-week/thread/fix-auth", known), "deleted-last-week")
  assert.equal(unknownProjectPage("/project/deleted-last-week/thread/x/full", known), "deleted-last-week")
  // A slug can be percent-encoded in the address bar and must be compared decoded, or every project
  // with a character worth encoding looks missing.
  assert.equal(unknownProjectPage("/project/pullfrog%2Dapp", known), undefined)

  // Everything that is NOT a missing project page is left alone.
  assert.equal(unknownProjectPage("/project/nub", known), undefined)
  assert.equal(unknownProjectPage("/project/nub/status/active", known), undefined)
  assert.equal(unknownProjectPage("/", known), undefined, "the grid")
  assert.equal(unknownProjectPage("/thread/fix-auth", known), undefined, "the launching project, unprefixed")
  assert.equal(unknownProjectPage("/project", known), undefined, "no slug to be missing")
  assert.equal(unknownProjectPage("/project/", known), undefined)
  assert.equal(unknownProjectPage("/assets/index-D2Pc7U9B.js", known), undefined, "a bundle, not a page")
})

// A run log belongs to the launcher, which outlives every server it starts, so the server names itself.
test("describeServerStart names the release the launcher started, and what it runs on", () => {
  const on = { pid: 4242, version: "v26.11.1", platform: "darwin", arch: "arm64" } as const
  assert.equal(
    describeServerStart({ FRIZZ_STABLE_ARTIFACT: "npm:frizz-server@0.15.48" }, false, on),
    "Frizz server frizz-server@0.15.48 starting: pid 4242, node v26.11.1, darwin arm64",
  )
  // A build from a checkout is named by its digest, which is all the launcher has for it.
  assert.match(describeServerStart({ FRIZZ_STABLE_ARTIFACT: "9f3c2a71d0" }, true, on), /^Frizz server 9f3c2a71d0 starting: /u)
  assert.match(describeServerStart({}, true, on), /^Frizz server from source starting: /u)
  assert.match(describeServerStart({}, false, on), /^Frizz server of an unnamed build starting: /u)
})

test("describeBootTimings is one line: the total, then each phase worth reading, slowest first", () => {
  assert.equal(
    describeBootTimings(1_384, [["launch ownership", 3.2], ["runtimes", 612.4], ["database", 31], ["tailer producer", 420], ["HTTP listen", 9.9], ["context", 1_204.6]]),
    "boot 1.38s: context 1.20s, runtimes 612ms, tailer producer 420ms, database 31ms",
  )
  assert.equal(describeBootTimings(42, [["launch ownership", 3], ["database", 4]]), "boot 42ms", "nothing worth listing")
})
