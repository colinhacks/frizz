import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  npmServerPackageInstaller, resolveNpmCli, serverGenerationLaunch, serverReleaseMinimum, serverReleaseSpec, ServerReleaseStore,
  validateServerGeneration, type ServerCompatibility, type ServerPackageInstaller, type ServerReleaseSpec,
} from "./server-release.ts";

const baseline: ServerReleaseSpec = { package: "frizz-server", version: "1.0.0", protocol: 1, dataEpoch: 1 };
const epochTwo: ServerReleaseSpec = { ...baseline, version: "2.0.0", dataEpoch: 2 };
const epochTwoCompatibility: ServerCompatibility = { protocol: 1, dataEpoch: 2 };
const files = ["dist/dev-child.js", "dist/codex-app-server-daemon.js", "dist/claude-agent-broker.js", "web-dist/index.html", "runtime/board/index.mjs", "runtime/cc-worker/.claude-plugin/plugin.json"];
function fixture(prefix: string, spec: ServerReleaseSpec): string {
  const root = join(prefix, "node_modules", spec.package);
  for (const name of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), name);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: spec.package, version: spec.version, frizzServer: { protocol: spec.protocol, dataEpoch: spec.dataEpoch } }));
  return root;
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "frizz-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installs: string[] = [];
  const installer: ServerPackageInstaller = {
    async install(prefix, spec) { installs.push(spec.version); fixture(prefix, spec); },
    async latestVersion() { return "1.1.0"; },
  };
  const roots = { cache: join(root, "cache"), state: join(root, "state"), data: join(root, "data"), legacy: false };
  return { root, roots, installs, installer, store: new ServerReleaseStore(baseline, installer, roots) };
}

test("boot metadata rejects unknown protocol, data epoch and non-exact package versions", () => {
  assert.deepEqual(serverReleaseSpec({ frizzServer: baseline }), baseline);
  for (const patch of [{ protocol: 2 }, { dataEpoch: 2 }, { version: "latest" }, { package: "file:../../repo" }])
    assert.throws(() => serverReleaseSpec({ frizzServer: { ...baseline, ...patch } }));
});

test("a server that can boot but cannot dispatch either provider is rejected before selection", async (t) => {
  const { store } = setup(t);
  for (const file of ["dist/codex-app-server-daemon.js", "dist/claude-agent-broker.js"]) {
    const generation = await store.prepare("1.1.0");
    rmSync(join(generation.root, file));
    assert.throws(() => store.commit(generation), /ENOENT/);
    assert.equal(existsSync(store.selection), false);
  }
});

test("preparation is immutable and does not commit until the server is ready", async (t) => {
  const { store, installs, installer, roots } = setup(t);
  const first = await store.load();
  assert.equal(existsSync(store.selection), false);
  store.commit(first);
  const saved = readFileSync(store.selection, "utf8");
  const candidate = await store.prepare("1.1.0");
  assert.equal(readFileSync(store.selection, "utf8"), saved);
  assert.notEqual(first.root, candidate.root);
  assert.equal((await new ServerReleaseStore(baseline, installer, roots).load()).id, first.id);
  store.commit(candidate);
  assert.equal((await store.load()).id, candidate.id);
  assert.deepEqual(installs, ["1.0.0", "1.1.0"]);
  assert.equal(existsSync(first.entry), true, "old worker runtime must be retained");
  const launch = serverGenerationLaunch(candidate);
  assert.equal(launch.entry, candidate.entry);
  assert.equal(launch.environment.FRIZZ_STABLE_ARTIFACT, "npm:frizz-server@1.1.0");
  assert.equal(launch.environment.FRIZZ_WORKER_PLUGIN_DIR, join(candidate.root, "runtime/cc-worker"));
});

test("an interrupted or failed install leaves the active release and no partially selectable generation", async (t) => {
  const { store, installer } = setup(t);
  const first = await store.load();
  store.commit(first);
  installer.install = async (prefix, spec) => { fixture(prefix, spec); throw new Error("registry interrupted"); };
  await assert.rejects(store.prepare("1.1.0"), /registry interrupted/);
  assert.equal((await store.load()).id, first.id);
  assert.deepEqual(readdirSync(store.generations), [first.id]);
});

test("cache eviction reinstalls exactly the committed version, never the launcher's older default", async (t) => {
  const { store, installs } = setup(t);
  const current = await store.prepare("1.2.0");
  store.commit(current);
  rmSync(join(store.generations, current.id), { recursive: true });
  const restored = await store.load();
  assert.equal(restored.version, "1.2.0");
  assert.deepEqual(installs, ["1.2.0", "1.2.0"]);
  assert.notEqual(restored.id, current.id);
});

test("a shell starts a machine whose server is older than it works with on its pinned release", async (t) => {
  const { installer, roots, installs, store: old } = setup(t);
  old.commit(await old.load());

  const pinned = { ...baseline, version: "1.3.0" };
  const newer = new ServerReleaseStore(pinned, installer, roots, undefined, "1.2.0");
  assert.deepEqual(newer.belowMinimum(), { selected: "1.0.0", minimum: "1.2.0", pinned: "1.3.0" });
  const raised = await newer.load();
  assert.equal(raised.version, "1.3.0");
  // Not selected until it is up: a pinned release that cannot boot leaves the old one on disk.
  assert.equal(JSON.parse(readFileSync(newer.selection, "utf8")).version, "1.0.0");
  newer.commit(raised);
  assert.equal(newer.belowMinimum(), undefined);
  assert.equal((await newer.load()).id, raised.id);
  assert.deepEqual(installs, ["1.0.0", "1.3.0"]);
});

test("the minimum never moves a server that is new enough, and a shell without one never moves any", async (t) => {
  const { installer, roots, installs, store } = setup(t);
  const selected = await store.prepare("1.2.0");
  store.commit(selected);
  const pinned = { ...baseline, version: "1.5.0" };
  // At the minimum exactly, above it, and above the pin itself — Update is what moves those.
  for (const minimum of ["1.2.0", "1.1.9", undefined]) {
    const shell = new ServerReleaseStore(pinned, installer, roots, undefined, minimum);
    assert.equal(shell.belowMinimum(), undefined, String(minimum));
    assert.equal((await shell.load()).id, selected.id, String(minimum));
  }
  const ahead = await store.prepare("1.9.0");
  store.commit(ahead);
  assert.equal((await new ServerReleaseStore(pinned, installer, roots, undefined, "1.4.0").load()).id, ahead.id);
  // A machine with no server starts on the pin whatever the minimum says.
  assert.equal(new ServerReleaseStore(pinned, installer, { ...roots, state: join(roots.state, "fresh") }, undefined, "1.4.0").belowMinimum(), undefined);
  assert.deepEqual(installs, ["1.2.0", "1.9.0"]);
});

test("a shell's minimum must be an exact version its own pinned server satisfies", () => {
  const manifest = (minimum: unknown) => ({ frizzServer: { ...baseline, version: "1.3.0", minimum } });
  assert.equal(serverReleaseMinimum({ frizzServer: baseline }), undefined);
  assert.equal(serverReleaseMinimum(manifest("1.3.0")), "1.3.0");
  assert.equal(serverReleaseMinimum(manifest("1.2.9")), "1.2.9");
  for (const bad of ["1.3.1", "2.0.0", "latest", "^1.2.0", 1, null]) assert.throws(() => serverReleaseMinimum(manifest(bad)), String(bad));
});

test("a newer shell stages its exact epoch generation before making its data boundary durable", async (t) => {
  const { installer, roots, installs, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);

  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  const candidate = await newer.load();
  assert.equal(candidate.version, "2.0.0");

  // This is the crash window: no child has become ready and the old selection remains on disk, but
  // the candidate could have migrated data as soon as it is launched. The global marker must win.
  assert.deepEqual(JSON.parse(readFileSync(newer.compatibilityMarker, "utf8")), epochTwoCompatibility);
  await assert.rejects(() => old.load(), /newer launcher or a data migration/);
  assert.deepEqual(installs, ["1.0.0", "2.0.0"]);
});

test("failed epoch preparation never advances the marker and leaves the old shell bootable", async (t) => {
  const { installer, roots, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);
  installer.install = async (prefix, spec) => {
    fixture(prefix, spec);
    throw new Error("epoch-two registry interruption");
  };

  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  await assert.rejects(() => newer.load(), /epoch-two registry interruption/);
  assert.deepEqual(JSON.parse(readFileSync(newer.compatibilityMarker, "utf8")), { protocol: 1, dataEpoch: 1 });
  assert.equal((await old.load()).id, oldGeneration.id);
});

test("an epoch-two committed selection reinstalls its exact version and never permits an epoch-one fallback", async (t) => {
  const { installer, roots, installs, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);
  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  const selected = await newer.load();
  newer.commit(selected);
  rmSync(join(newer.generations, selected.id), { recursive: true });

  const restored = await new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility).load();
  assert.equal(restored.version, "2.0.0");
  assert.notEqual(restored.id, selected.id);
  await assert.rejects(() => old.load(), /newer launcher or a data migration/);
  assert.deepEqual(installs, ["1.0.0", "2.0.0", "2.0.0"]);
});

test("a malformed global compatibility marker fails closed for every package selection", async (t) => {
  const { store, roots } = setup(t);
  mkdirSync(dirname(store.compatibilityMarker), { recursive: true });
  writeFileSync(store.compatibilityMarker, "{");
  await assert.rejects(() => store.load(), /data compatibility marker/);

  const override = new ServerReleaseStore({ ...baseline, package: "frizz-server-preview" }, {
    async install(prefix, spec) { fixture(prefix, spec); },
    async latestVersion() { return "1.0.0"; },
  }, roots);
  await assert.rejects(() => override.load(), /data compatibility marker/);
});

test("corrupt, escaping and incompatible saved selections fail closed", async (t) => {
  const { store, installs } = setup(t);
  mkdirSync(dirname(store.selection), { recursive: true });
  for (const selected of ["{", JSON.stringify({ ...baseline, id: "../../outside" }), JSON.stringify({ ...baseline, id: randomUUID(), dataEpoch: 2 })]) {
    writeFileSync(store.selection, selected);
    await assert.rejects(store.load());
  }
  assert.deepEqual(installs, []);
});

test("incompatible candidate manifests are refused while the previous selection stays intact", async (t) => {
  const { store, installer } = setup(t);
  const first = await store.load();
  store.commit(first);
  installer.install = async (prefix, spec) => { fixture(prefix, { ...spec, dataEpoch: 2 }); };
  await assert.rejects(store.prepare("1.1.0"), /protocol\/data epoch is incompatible/);
  assert.equal((await store.load()).id, first.id);
});

test("missing or symlink-escaped runtime assets cannot become a generation", async (t) => {
  const { root } = setup(t);
  const packageRoot = fixture(root, baseline);
  rmSync(join(packageRoot, "web-dist/index.html"));
  assert.throws(() => validateServerGeneration(packageRoot, baseline, randomUUID()));
  const outside = join(root, "outside.html");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(packageRoot, "web-dist/index.html"));
  assert.throws(() => validateServerGeneration(packageRoot, baseline, randomUUID()), /escapes its package/);
});

test("concurrent preparations cannot overwrite each other's package files", async (t) => {
  const { store } = setup(t);
  const [a, b] = await Promise.all([store.prepare("1.1.0"), store.prepare("1.1.0")]);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.root, b.root);
  assert.equal(existsSync(a.entry) && existsSync(b.entry), true);
  assert.equal(existsSync(store.selection), false);
});

test("commit rejects generations owned by a different store", async (t) => {
  const a = setup(t);
  const b = setup(t);
  const generation = await a.store.load();
  assert.throws(() => b.store.commit(generation));
  assert.equal(existsSync(b.store.selection), false);
});

test("a failed pointer replacement preserves the previous committed selection", async (t) => {
  const { store } = setup(t);
  const first = await store.load();
  store.commit(first);
  const candidate = await store.prepare("1.1.0");
  // A broken destination is an actual filesystem failure, not a fake successful persistence call.
  const saved = readFileSync(store.selection, "utf8");
  rmSync(store.selection);
  mkdirSync(store.selection);
  assert.throws(() => store.commit(candidate));
  assert.equal(readdirSync(dirname(store.selection)).some((path) => path.endsWith(".tmp")), false);
  rmSync(store.selection, { recursive: true });
  writeFileSync(store.selection, saved);
  assert.equal((await store.load()).id, first.id);
});

test("npm is resolved beside Node including paths with spaces, without launching npm.cmd", async (t) => {
  const { root } = setup(t);
  const nodeDir = join(root, "Node with spaces");
  const cli = join(nodeDir, "node_modules/npm/bin/npm-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "console.log('stub')");
  writeFileSync(join(nodeDir, "npm.cmd"), "exit /b 99");
  assert.equal(resolveNpmCli({ PATH: nodeDir }, join(nodeDir, "node.exe")), cli);
  assert.throws(() => resolveNpmCli({ PATH: "" }, join(root, "missing/node")), /npm was not found/);
});

test("the npm adapter executes a real JS child with isolated prefix and scripts disabled", async (t) => {
  const { root } = setup(t);
  const cli = join(root, "npm-cli.js");
  const captured = join(root, "captured.json");
  writeFileSync(cli, `require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})); console.log('"1.1.0"')`);
  const installer = npmServerPackageInstaller({ ...process.env, npm_execpath: cli, CAPTURE: captured });
  const prefix = join(root, "prefix with spaces & literal");
  mkdirSync(prefix);
  await installer.install(prefix, baseline);
  const { argv, cwd } = JSON.parse(readFileSync(captured, "utf8"));
  assert.equal(cwd, realpathSync(prefix));
  assert.deepEqual(argv.slice(0, 4), ["install", "--prefix", prefix, "--global=false"]);
  assert.equal(argv.includes("--ignore-scripts"), true);
  // The version npm view names must install under a user's min-release-age window.
  assert.equal(argv.includes("--min-release-age=0"), true);
  assert.equal(argv.at(-1), "frizz-server@1.0.0");
  assert.equal(await installer.latestVersion("frizz-server"), "1.1.0");
});

// The launcher's cwd is the folder it was started from. Once that is deleted, a child that inherits
// it throws `uv_cwd ENOENT` on its first `process.cwd()`, which npm calls before anything else
// (2026-10-11: every Update click on such a board failed with that stack).
test("the latest-version probe answers after the folder the launcher was started from is deleted", async (t) => {
  const { root } = setup(t);
  const cli = join(root, "npm-cli.js");
  writeFileSync(cli, `process.cwd(); console.log('"1.1.0"')`);
  const installer = npmServerPackageInstaller({ ...process.env, npm_execpath: cli });
  const launchFolder = mkdtempSync(join(tmpdir(), "frizz-launch-folder-"));
  const original = process.cwd();
  process.chdir(launchFolder);
  try {
    rmSync(launchFolder, { recursive: true });
    assert.throws(() => process.cwd(), /uv_cwd/, "this process now has the deleted cwd a child would inherit");
    assert.equal(await installer.latestVersion("frizz-server"), "1.1.0");
  } finally {
    process.chdir(original);
  }
});

// A child that dies before npm starts ends in a stack and a property dump, so the last eight lines
// of stderr never held the line naming the fault (2026-10-11: an Update failed with
// `at Module._compile (node:internal/modules/cjs/loader:1968:14)` and nothing else an operator could read).
test("a failed npm operation reports the error that caused it, not only the end of its stack", async (t) => {
  const { root } = setup(t);
  const failing = (name: string, stderr: string[]) => {
    const cli = join(root, name, "npm-cli.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `process.stderr.write(${JSON.stringify(stderr.join("\n"))}); process.exit(7)`);
    return npmServerPackageInstaller({ ...process.env, npm_execpath: cli });
  };
  const crash = [
    "node:internal/bootstrap/switches/does_own_process_state:142", "    cachedCwd = rawMethods.cwd();", "                           ^", "",
    "Error: ENOENT: process.cwd failed with error no such file or directory, uv_cwd",
    ...Array.from({ length: 9 }, (_, frame) => `    at frame${frame} (node:internal/modules/cjs/loader:${frame}:1)`),
    "  errno: -2,", "  code: 'ENOENT',", "  syscall: 'uv_cwd'", "}", "", "Node.js v26.11.1",
  ];
  await assert.rejects(() => failing("crash", crash).latestVersion("frizz-server"), (error: Error) => {
    assert.match(error.message, /^Frizz server npm operation failed: Error: ENOENT: process\.cwd failed/);
    assert.match(error.message, /Node\.js v26\.11\.1$/, "the tail is still there under the cause");
    return true;
  });
  // npm's own failures already end in their summary; nothing is added or repeated.
  const npmError = ["npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/frizz-server - Not found"];
  await assert.rejects(() => failing("e404", npmError).latestVersion("frizz-server"), (error: Error) => {
    assert.equal(error.message, `Frizz server npm operation failed: ${npmError.join("\n")}`);
    return true;
  });
});

test("an npm operation that never finishes is stopped and says how long it was given", async (t) => {
  const { root } = setup(t);
  const cli = join(root, "npm-cli.js");
  writeFileSync(cli, "setInterval(() => {}, 1000)");
  const installer = npmServerPackageInstaller({ ...process.env, npm_execpath: cli }, { timeoutMs: 300 });
  await assert.rejects(() => installer.latestVersion("frizz-server"), /npm view did not finish within 1s and was stopped/);
});

// npm 12 answers `view <spec> version --json` with a one-element array; npm 11 answered the bare
// string. Reading only the string left every launcher on npm 12 reporting "no update" (2026-09-25).
test("the latest-version probe reads npm 12's one-element array and still refuses anything wider", async (t) => {
  const { root } = setup(t);
  const answering = (name: string, stdout: string) => {
    // resolveNpmCli honours npm_execpath only when it names an `npm-cli.js`; anything else silently
    // falls through to the real npm beside Node.
    const cli = join(root, name, "npm-cli.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `console.log(${JSON.stringify(stdout)})`);
    return npmServerPackageInstaller({ ...process.env, npm_execpath: cli });
  };
  assert.equal(await answering("npm11", '"1.1.0"').latestVersion("frizz-server"), "1.1.0");
  assert.equal(await answering("npm12", '[\n  "1.1.0"\n]').latestVersion("frizz-server"), "1.1.0");
  await assert.rejects(() => answering("two", '["1.1.0", "1.2.0"]').latestVersion("frizz-server"), /npm returned an invalid Frizz server version/);
  await assert.rejects(() => answering("empty", "[]").latestVersion("frizz-server"), /npm returned an invalid Frizz server version/);
});
