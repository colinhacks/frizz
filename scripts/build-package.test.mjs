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
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { build } from "esbuild";

import { SERVER_BUILD_OPTIONS, SERVER_CHILD_ENTRY, SHELL_BUILD_OPTIONS, SHELL_ENTRIES, WORKSPACE } from "./lib/package-build.mjs";

const [[outName, entry]] = Object.entries(SHELL_ENTRIES);
const bundled = await build({
  ...SHELL_BUILD_OPTIONS,
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
  assert.doesNotMatch(script, /dev-child\.ts/);
});

// THE SERVER. What a user's machine installs for it is `frizz-server` and one package holding the file
// watcher's binary for that platform; everything the watcher's JavaScript needs is in the bundle, at
// the versions this workspace locked (scripts/lib/package-build.mjs has what it replaced).
const [[childName, childEntry]] = Object.entries(SERVER_CHILD_ENTRY);
const serverBundled = await build({
  ...SERVER_BUILD_OPTIONS,
  entryPoints: [childEntry],
  outfile: join(WORKSPACE, "packages", "server-release", "dist", childName),
  write: false,
  metafile: true,
});

test("the server's bundle carries the watcher's JavaScript and names no package a release would have to resolve", () => {
  const [output] = Object.values(serverBundled.metafile.outputs);
  // Every package the bundle still names. Vite is the source launcher's, behind an `import()` a
  // published server never takes. `ws`'s two accelerators and the watcher's locally built binary are
  // each required inside a `try`. A new line here is a package some install has to provide.
  assert.deepEqual(
    output.imports.filter((imported) => imported.external && !isBuiltin(imported.path)).map((imported) => `${imported.kind} ${imported.path}`).sort(),
    [
      "dynamic-import vite",
      "require-call ./build/Debug/watcher.node",
      "require-call ./build/Release/watcher.node",
      "require-call bufferutil",
      "require-call utf-8-validate",
    ],
  );
  const inputs = Object.keys(serverBundled.metafile.inputs);
  for (const carried of ["@parcel/watcher/index.js", "@parcel/watcher/wrapper.js", "picomatch/index.js", "is-glob/index.js", "is-extglob/index.js", "detect-libc/lib/detect-libc.js"])
    assert.ok(inputs.some((input) => input.endsWith(`node_modules/${carried}`)), `${carried} is not in the bundle`);
  // Needed to compile the binary, never to load it.
  assert.deepEqual(inputs.filter((input) => input.includes("node-addon-api")), []);
  // The one thing left to the machine: the loader asks for its platform's binary by name.
  assert.match(new TextDecoder().decode(serverBundled.outputFiles[0].contents), /`@parcel\/watcher-\$\{process\.platform\}-\$\{process\.arch\}`/);
});

test("a bundle built this way watches with nothing installed beside it but the platform's binary", async () => {
  // The server's own bundle cannot be started alone, so this is the same options over five lines that
  // do what the server does with the watcher: load it and subscribe.
  const probe = await build({
    ...SERVER_BUILD_OPTIONS,
    stdin: {
      contents: `import watcher from "@parcel/watcher"\nconst subscription = await watcher.subscribe(process.argv[2], () => {})\nawait subscription.unsubscribe()\nconsole.log("watching")\n`,
      resolveDir: join(WORKSPACE, "packages", "server", "src"),
      loader: "js",
    },
    outfile: join(WORKSPACE, "probe.js"),
    write: false,
  });
  // The binary's package as this checkout installed it, found the way the watcher finds it.
  const fromWatcher = createRequire(createRequire(join(WORKSPACE, "packages", "server", "package.json")).resolve("@parcel/watcher/package.json"));
  const platform = `@parcel/watcher-${process.platform}-${process.arch}`;
  const binaries = [platform, `${platform}-glibc`, `${platform}-musl`].flatMap((name) => {
    try { return [{ name, directory: dirname(fromWatcher.resolve(`${name}/package.json`)) }]; } catch { return []; }
  });
  assert.ok(binaries.length > 0, `this checkout has no ${platform} binary installed, so the test cannot say anything`);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-server-alone-")));
  assert.ok(!root.split(sep).includes("node_modules"));
  try {
    // The layout of an installed generation: <prefix>/node_modules/frizz-server/dist/<bundle>.
    const dist = join(root, "node_modules", "frizz-server", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "probe.js"), probe.outputFiles[0].contents);
    writeFileSync(join(root, "node_modules", "frizz-server", "package.json"), JSON.stringify({ name: "frizz-server", type: "module" }));
    const watched = join(root, "watched");
    mkdirSync(watched);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FRIZZ_") && !name.startsWith("NODE_")));
    const run = () => spawnSync(process.execPath, [join(dist, "probe.js"), watched], { cwd: root, env, encoding: "utf8", timeout: 60_000 });

    // With no binary there is nothing to load, and the watcher says so. That this fails is what shows
    // the passing run below found the copy in this directory and not one the checkout has.
    const without = run();
    assert.notEqual(without.status, 0);
    assert.match(without.stderr, /No prebuild or local build of @parcel\/watcher found/);

    for (const { name, directory } of binaries) cpSync(directory, join(root, "node_modules", name), { recursive: true, dereference: true });
    const withBinary = run();
    assert.equal(withBinary.status, 0, `the bundled watcher did not load: ${withBinary.stderr.slice(0, 800)}`);
    assert.equal(withBinary.stdout.trim(), "watching");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
