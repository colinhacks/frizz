import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closureProblem, installedPackages } from "./lib/installed-closure.mjs";

/** A `node_modules` holding `packages` (name → manifest), as npm's hoisted install lays them out. */
function installed(packages) {
  const nodeModules = join(mkdtempSync(join(tmpdir(), "frizz-closure-")), "node_modules");
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(nodeModules, name), { recursive: true });
    writeFileSync(join(nodeModules, name, "package.json"), JSON.stringify({ name, ...manifest }));
  }
  // npm's own bookkeeping sits beside the packages and is none of them.
  mkdirSync(join(nodeModules, ".bin"), { recursive: true });
  writeFileSync(join(nodeModules, ".package-lock.json"), "{}");
  return nodeModules;
}
const server = (extra = {}) => ({
  version: "9.9.9",
  optionalDependencies: { "@parcel/watcher-darwin-arm64": "2.5.6", "@parcel/watcher-linux-x64-glibc": "2.5.6", "@parcel/watcher-linux-x64-musl": "2.5.6" },
  ...extra,
});

test("the server and the binary for this machine is an exact install", (t) => {
  const nodeModules = installed({ "frizz-server": server(), "@parcel/watcher-darwin-arm64": { version: "2.5.6" } });
  t.after(() => rmSync(join(nodeModules, ".."), { recursive: true, force: true }));
  assert.deepEqual(installedPackages(nodeModules), ["@parcel/watcher-darwin-arm64", "frizz-server"]);
  assert.equal(closureProblem(nodeModules), null);
});

test("a package nothing names is reported by name", (t) => {
  const nodeModules = installed({ "frizz-server": server(), "@parcel/watcher-darwin-arm64": { version: "2.5.6" }, picomatch: { version: "4.0.7" }, "@parcel/watcher": { version: "2.5.6" } });
  t.after(() => rmSync(join(nodeModules, ".."), { recursive: true, force: true }));
  assert.equal(closureProblem(nodeModules), "installed but named by nothing: @parcel/watcher, picomatch");
});

test("a binary at another version, or no binary at all, is a problem too", (t) => {
  const drifted = installed({ "frizz-server": server(), "@parcel/watcher-darwin-arm64": { version: "2.5.7" } });
  const bare = installed({ "frizz-server": server() });
  t.after(() => { for (const dir of [drifted, bare]) rmSync(join(dir, ".."), { recursive: true, force: true }); });
  assert.equal(closureProblem(drifted), "@parcel/watcher-darwin-arm64 is 2.5.7, and the server names 2.5.6");
  assert.match(closureProblem(bare), /none of the watcher's binaries was installed/);
});

test("a server that still declares dependencies is not judged", (t) => {
  // Every published server before the closure was pinned: npm resolved its tree, and a verifier run
  // against one (`--public=<old version>`) must not fail on what that release never promised.
  const nodeModules = installed({ "frizz-server": { version: "0.15.48", dependencies: { "@parcel/watcher": "2.5.6" } }, "@parcel/watcher": { version: "2.5.6" }, picomatch: { version: "4.0.7" } });
  t.after(() => rmSync(join(nodeModules, ".."), { recursive: true, force: true }));
  assert.equal(closureProblem(nodeModules), null);
});

test("a directory with no server in it says so", (t) => {
  const nodeModules = installed({ picomatch: { version: "4.0.7" } });
  t.after(() => rmSync(join(nodeModules, ".."), { recursive: true, force: true }));
  assert.equal(closureProblem(nodeModules), "no frizz-server is installed here");
});
