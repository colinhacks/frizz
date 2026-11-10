// The stable shell, bundled exactly as a release bundles it and then started with nothing installed
// beside it. `npx frizz` installs the shell's dependencies and nothing else, so whatever the bundle
// imports when it loads has to be Node's own.
//
// Until 2026-11-10 it was not. The bundle opened with `import watcher from "@parcel/watcher"`, pulled
// in from the supervisor's default file watcher, which the registry launcher never starts. The
// package therefore declared the watcher as its one dependency (eight packages and a native addon for
// every `npx frizz`), and the bundle copied to a directory with no `node_modules` above it died on
// `--help` with ERR_MODULE_NOT_FOUND. That directory is a machine installed with `omit=optional`, or
// an architecture the addon publishes no binary for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { build } from "esbuild";

import { PACKAGE_BUILD_OPTIONS, SHELL_ENTRIES, WORKSPACE } from "./lib/package-build.mjs";

const [[outName, entry]] = Object.entries(SHELL_ENTRIES);
const bundled = await build({
  ...PACKAGE_BUILD_OPTIONS,
  entryPoints: [entry],
  outfile: join(WORKSPACE, "dist", outName),
  write: false,
  metafile: true,
});

test("the shell bundle imports nothing at load but Node's own modules", () => {
  const [output] = Object.values(bundled.metafile.outputs);
  const external = output.imports.filter((imported) => imported.external);
  assert.ok(external.length > 0, "the metafile lists no import at all, so this test would pass on anything");
  // An `import` statement is resolved before any of the file runs: one that names a package ends the
  // launch, whatever the code around it would have done.
  const atLoad = external.filter((imported) => imported.kind === "import-statement" && !isBuiltin(imported.path));
  assert.deepEqual(
    atLoad.map((imported) => imported.path),
    [],
    "the shell declares no dependency, so a package it imports at load is one no install provides",
  );
  // Everything else that names a package, listed so that a new one is a decision. The watcher is an
  // `import()` on a path the registry launcher does not take. The other two are `ws`'s optional
  // accelerators, each required inside a `try` that falls back to JavaScript; the next test is what
  // shows the bundle starts without any of the three.
  assert.deepEqual(
    external.filter((imported) => !isBuiltin(imported.path)).map((imported) => `${imported.kind} ${imported.path}`).sort(),
    ["dynamic-import @parcel/watcher", "require-call bufferutil", "require-call utf-8-validate"],
  );
});

test("the shell answers --help with nothing installed beside it", () => {
  // No `node_modules` on the way up from here, or Node could find a package this test says is absent.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-shell-alone-")));
  assert.ok(!root.split(sep).includes("node_modules"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", outName), bundled.outputFiles[0].contents);
    // The launcher reads its version from the manifest it ships inside.
    copyFileSync(join(WORKSPACE, "package.json"), join(root, "package.json"));
    // Neither run reads the home directory or the folder it is started in; both are pointed at the
    // empty directory anyway, and no variable of a Frizz this test runs under is passed on.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FRIZZ_") && !name.startsWith("NODE_")));
    const run = (flag) => spawnSync(process.execPath, [join(root, "dist", outName), flag], { cwd: root, env: { ...env, HOME: root }, encoding: "utf8", timeout: 60_000 });

    const help = run("--help");
    assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr.slice(0, 600)}`);
    assert.match(help.stdout, /-h, --help\s+show this help/);
    // A flag it does not know is refused by the launcher's own parser, which is the bundle running too.
    const unknown = run("--no-such-flag");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^frizz: unknown option: --no-such-flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build script bundles with the options this file tests", async () => {
  // The script cannot be imported (it writes `dist/` when it loads), so it is read: a second copy of
  // the options there would be what ships, and this file would be testing something else.
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(join(dirname(import.meta.filename), "build-package.mjs"), "utf8");
  assert.match(script, /from "\.\/lib\/package-build\.mjs"/);
  assert.doesNotMatch(script, /external:/);
  assert.doesNotMatch(script, /src\/production\.ts/);
});
