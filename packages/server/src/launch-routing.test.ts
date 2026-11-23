import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import {
  classifyLaunch,
  LAUNCH_ROUTE_PROTOCOL,
  parseLaunchRoute,
  parseLaunchRouteRequest,
  routeLaunch,
} from "./launch-routing.ts"
import { resolveProject } from "./project.ts"
import { findByPath, listProjects, registerProject } from "./project-registry.ts"
import { ensureProjectIdFile } from "./project-root.ts"

/** A home of its own, with folders under it: the walk-up stops at home, as it does on a real machine. */
function machine(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-launch-routing-")))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so data lands under it
  const folder = (rel: string, ...files: string[]) => {
    const dir = join(home, rel)
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(dir, file), "{}\n")
    return dir
  }
  return { home, folder, open: (dir: string) => resolveProject(dir, home) }
}

test("a folder Frizz knows opens as itself, from anywhere inside it, and is registered by the answer", (t) => {
  const { home, folder, open } = machine(t)
  const app = folder("code/kirby")
  const deep = folder("code/kirby/packages/web/src")
  ensureProjectIdFile(app, home)

  assert.deepEqual(classifyLaunch(deep, home), { kind: "open", root: app })
  assert.deepEqual(listProjects(home), [], "classifying writes nothing")

  const route = routeLaunch(deep, open, home)
  assert.deepEqual(route, { path: "/project/kirby", project: { name: "kirby", dir: app } })
  assert.equal(findByPath(app, home)?.slug, "kirby")
  // Asked again, it is the same project at the same address.
  assert.deepEqual(routeLaunch(app, open, home), route)
  assert.equal(listProjects(home).length, 1)
})

test("a folder known only to the registry still opens, so an uncommitted id file never costs a board", (t) => {
  const { home, folder, open } = machine(t)
  const plain = folder("notes")
  registerProject({ dir: plain, id: "029a30af-f126-40e3-b04c-d80e74e3e090" }, home)
  assert.deepEqual(classifyLaunch(plain, home), { kind: "open", root: plain })
  assert.equal(routeLaunch(plain, open, home).path, "/project/notes")
})

test("a folder that looks like a project is offered, and nothing is registered until the operator says so", (t) => {
  const { home, folder, open } = machine(t)
  const fresh = folder("code/new thing", "package.json")
  assert.deepEqual(classifyLaunch(join(fresh), home), { kind: "offer", directory: fresh })
  assert.deepEqual(routeLaunch(fresh, open, home), { path: `/?add=${encodeURIComponent(fresh)}` })
  assert.deepEqual(listProjects(home), [])
})

test("anywhere else is the dashboard, and the home folder is never a project whatever it carries", (t) => {
  const { home, folder, open } = machine(t)
  assert.deepEqual(routeLaunch(folder("Downloads"), open, home), { path: "/" })
  writeFileSync(join(home, "package.json"), "{}\n")
  assert.deepEqual(classifyLaunch(home, home), { kind: "grid" })
  ensureProjectIdFile(home, home)
  assert.deepEqual(classifyLaunch(home, home), { kind: "grid" })
  assert.deepEqual(routeLaunch(home, open, home), { path: "/" })
  assert.deepEqual(listProjects(home), [])
})

test("a known folder that cannot be opened lands on the dashboard with the reason", (t) => {
  const { home, folder } = machine(t)
  const broken = folder("code/broken")
  ensureProjectIdFile(broken, home)
  const route = routeLaunch(broken, () => { throw new Error("unable to resolve Git repository root") }, home)
  assert.deepEqual(route, { path: "/", notice: `Could not open ${broken}: unable to resolve Git repository root` })
})

test("a folder that does not exist is not classified at all", (t) => {
  const { home, open } = machine(t)
  assert.throws(() => routeLaunch(join(home, "gone"), open, home), /ENOENT/)
})

test("a request names the protocol and an absolute folder, and nothing else is read", () => {
  const dir = join(tmpdir(), "somewhere")
  assert.deepEqual(parseLaunchRouteRequest({ protocol: LAUNCH_ROUTE_PROTOCOL, dir }), { protocol: 1, dir })
  assert.deepEqual(parseLaunchRouteRequest({ protocol: 1, dir, args: ["a"], extra: true }), { protocol: 1, dir, args: ["a"] })
  assert.deepEqual(parseLaunchRouteRequest({ protocol: 1, dir, sandbox: true }), { protocol: 1, dir, sandbox: true })
  assert.deepEqual(parseLaunchRouteRequest({ protocol: 1, dir, sandbox: false }), { protocol: 1, dir })
  for (const bad of [null, [], "x", { dir }, { protocol: 2, dir }, { protocol: 1 }, { protocol: 1, dir: "relative/path" }, { protocol: 1, dir: "" }, { protocol: 1, dir, args: "a" }, { protocol: 1, dir, args: [1] }, { protocol: 1, dir, sandbox: "yes" }])
    assert.ok("error" in parseLaunchRouteRequest(bad), JSON.stringify(bad))
})

test("a launcher follows only a plain same-origin path", () => {
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/project/app", project: { name: "app", dir: "/code/app" }, notice: "hello" }), {
    path: "/project/app", project: { name: "app", dir: "/code/app" }, notice: "hello",
  })
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/?add=%2Fcode%2Fnew" }), { path: "/?add=%2Fcode%2Fnew" })
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/", project: { name: 1 }, notice: "" }), { path: "/" })
  // The server's own lines: strings only, eight at most, each as long as a notice may be.
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/", notice: "first", notices: ["a", "", 3, "b"] }), { path: "/", notice: "first", notices: ["a", "b"] })
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/", notices: Array.from({ length: 12 }, (_, i) => `line ${i}`) })?.notices?.length, 8)
  assert.equal(parseLaunchRoute({ protocol: 1, path: "/", notices: ["x".repeat(900)] })?.notices?.[0]?.length, 500)
  assert.deepEqual(parseLaunchRoute({ protocol: 1, path: "/", notices: "not a list" }), { path: "/" })
  for (const bad of [
    undefined, "/", { path: "/" }, { protocol: 2, path: "/" }, { protocol: 1 },
    { protocol: 1, path: "//evil.example/" }, { protocol: 1, path: "https://evil.example/" }, { protocol: 1, path: "/\\evil.example" },
    { protocol: 1, path: "project/app" }, { protocol: 1, path: "/a\nb" }, { protocol: 1, path: "" },
  ])
    assert.equal(parseLaunchRoute(bad), undefined, JSON.stringify(bad))
})
