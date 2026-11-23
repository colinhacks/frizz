// How two shell bundles are compared, on bundles written here. That a rebuild at a release's own commit
// matches what npm serves for it was checked against frizz 0.13.21, 0.13.22, 0.13.24 and 0.13.25 when
// this was written (plans/shell-release-cadence.md); the preflight runs the real comparison.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundleSections, comparable, describeShellChanges, fileInTarball, sectionName, shellSectionChanges } from "./shell-bundle-diff.mjs";

const bundle = (...sections) => sections.map(([source, code]) => `// ${source}\n${code}`).join("\n\n");

test("a package's files are named the same from any machine's store", () => {
  assert.equal(sectionName("node_modules/.pnpm/ws@8.21.0/node_modules/ws/lib/sender.js"), "node_modules/ws/lib/sender.js");
  assert.equal(sectionName("../../.cache/nub/pm/store/v1/ws@8.21.0-0b63ab59/node_modules/ws/lib/sender.js"), "node_modules/ws/lib/sender.js");
  assert.equal(sectionName("src/production.ts"), "src/production.ts");
  // The same holds for the path a CommonJS wrapper is keyed by, inside the code.
  assert.equal(
    comparable(`"node_modules/.pnpm/ws@8.21.0/node_modules/ws/lib/sender.js"(exports) {`),
    comparable(`"../../../.cache/nub/pm/store/v1/ws@8.21.0-0b63ab59/node_modules/ws/lib/sender.js"(exports) {`),
  );
});

test("an identifier esbuild renumbered is not a change, and anything else is", () => {
  const before = bundle(["src/a.ts", "var join = 1;\nuse(join);"], ["src/b.ts", "var join2 = 2;"]);
  const renamed = bundle(["src/a.ts", "var join2 = 1;\nuse(join2);"], ["src/b.ts", "var join3 = 2;"]);
  assert.deepEqual(shellSectionChanges(before, renamed), []);
  const edited = bundle(["src/a.ts", "var join = 1;\nuse(join);"], ["src/b.ts", "var join2 = 3;"]);
  assert.deepEqual(shellSectionChanges(before, edited), [{ name: "src/b.ts", change: "changed" }]);
});

test("a file the bundle starts or stops carrying is named as such", () => {
  const before = bundle(["src/a.ts", "a();"], ["node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js", "y();"]);
  const after = bundle(["src/a.ts", "a();"], ["packages/server/src/supervisor-pages.ts", "p();"]);
  const changes = shellSectionChanges(before, after);
  assert.deepEqual(changes, [
    { name: "node_modules/yaml/dist/index.js", change: "removed" },
    { name: "packages/server/src/supervisor-pages.ts", change: "added" },
  ]);
  assert.equal(describeShellChanges(changes), "packages/server/src/supervisor-pages.ts (added), package yaml (removed)");
  assert.equal(bundleSections(before).size, 3, "the preamble before the first file is a section too");
});

test("a long list is cut, and a package is named once however many of its files changed", () => {
  const changes = [
    ...["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name: `src/${name}.ts`, change: "changed" })),
    { name: "node_modules/ws/lib/sender.js", change: "changed" },
    { name: "node_modules/ws/lib/receiver.js", change: "changed" },
  ];
  assert.equal(describeShellChanges(changes), "src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts and 2 more");
  assert.equal(describeShellChanges(changes.slice(6)), "src/g.ts, package ws");
});

test("the shell is read out of a package tarball as npm serves it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-tarball-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "package", "dist"), { recursive: true });
  writeFileSync(join(dir, "package", "package.json"), "{}");
  writeFileSync(join(dir, "package", "dist", "frizz.js"), "// src/production.ts\nmain();\n".repeat(200));
  const made = spawnSync("tar", ["-czf", join(dir, "frizz.tgz"), "-C", dir, "package"]);
  assert.equal(made.status, 0, String(made.stderr));
  const tgz = readFileSync(join(dir, "frizz.tgz"));
  assert.equal(fileInTarball(tgz, "package/dist/frizz.js"), "// src/production.ts\nmain();\n".repeat(200));
  assert.throws(() => fileInTarball(tgz, "package/dist/missing.js"), /not in the tarball/);
});
