import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  describeGenerationSweep, GENERATION_MIN_AGE_MS, npmServerPackageInstaller, resolveNpmCli, runningCommands, serverGenerationLaunch,
  serverReleaseMinimum, serverReleaseSpec, ServerReleaseStore,
  validateServerGeneration, type ServerCompatibility, type ServerGeneration, type ServerPackageInstaller, type ServerReleaseSpec,
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

// --- sweeping old generations ---------------------------------------------------------------

const DAY = GENERATION_MIN_AGE_MS;
/** Give a generation (or anything in the store's directory) an install time `ago` before now. */
function installed(path: string, ago: number): void {
  const at = new Date(Date.now() - ago);
  utimesSync(path, at, at);
}
/** `count` generations, 1.0.0 upwards, each a day older than the next, the newest five days old. */
async function generations(store: ServerReleaseStore, count: number): Promise<ServerGeneration[]> {
  const made: ServerGeneration[] = [];
  for (let index = 0; index < count; index += 1) {
    const generation = await store.prepare(`1.${index}.0`);
    installed(join(store.generations, generation.id), (count - index + 4) * DAY);
    made.push(generation);
  }
  return made;
}
const nothingRunning = async (): Promise<string[]> => ["node /somewhere/else/server.js", "/sbin/launchd"];
const versionsIn = (store: ServerReleaseStore): string[] => readdirSync(store.generations)
  .map((id) => JSON.parse(readFileSync(join(store.generations, id, "node_modules", baseline.package, "package.json"), "utf8")).version as string)
  .sort();

test("a sweep removes old generations and keeps the selected one, the newest two others and any a process still runs from", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 7);
  // The selection is the OLDEST: what is selected is kept for being selected, not for its age.
  store.commit(made[0]!);
  const running = made[2]!;
  const sweep = await store.sweep({
    commands: async () => ["/sbin/launchd", `node ${running.root}/dist/claude-agent-broker.js`],
  });
  assert.deepEqual(sweep.removed.sort(), ["1.1.0", "1.3.0", "1.4.0"]);
  assert.deepEqual(versionsIn(store), ["1.0.0", "1.2.0", "1.5.0", "1.6.0"]);
  assert.deepEqual(sweep.kept.sort((a, b) => a.version.localeCompare(b.version)), [
    { version: "1.0.0", why: "held" },
    { version: "1.2.0", why: "running" },
    { version: "1.5.0", why: "recent" },
    { version: "1.6.0", why: "recent" },
  ]);
  assert.equal(sweep.unfinished, 0);
  // What was kept still loads, and nothing was reinstalled to make that so.
  assert.equal((await store.load()).id, made[0]!.id);
  assert.equal(existsSync(running.entry), true);
});

test("a generation the caller holds is kept, however old and however many are newer", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 6);
  store.commit(made[5]!);
  const sweep = await store.sweep({ keep: [made[0]!.id], commands: nothingRunning });
  assert.deepEqual(sweep.removed.sort(), ["1.1.0", "1.2.0"]);
  assert.deepEqual(versionsIn(store), ["1.0.0", "1.3.0", "1.4.0", "1.5.0"]);
});

test("nothing installed within the day is removed, and the process list is not even read", async (t) => {
  const { store } = setup(t);
  const made: ServerGeneration[] = [];
  for (let index = 0; index < 6; index += 1) {
    made.push(await store.prepare(`1.${index}.0`));
    installed(join(store.generations, made[index]!.id), DAY - (6 - index) * 60_000);
  }
  store.commit(made[5]!);
  let asked = 0;
  const sweep = await store.sweep({ commands: async () => { asked += 1; return []; } });
  assert.deepEqual(sweep.removed, []);
  assert.equal(versionsIn(store).length, 6);
  assert.equal(asked, 0);
  // The two installed last are kept for being the newest; the other three for being under a day old.
  assert.deepEqual(sweep.kept.filter((entry) => entry.why === "young").map((entry) => entry.version).sort(), ["1.2.0", "1.3.0", "1.4.0"]);
  assert.equal(describeGenerationSweep(sweep), undefined);
});

test("when this machine's processes cannot be listed, no generation is removed", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 5);
  store.commit(made[4]!);
  const sweep = await store.sweep({ commands: async () => undefined });
  assert.deepEqual(sweep.removed, []);
  assert.equal(versionsIn(store).length, 5);
  assert.deepEqual(sweep.kept.filter((entry) => entry.why === "unlisted").map((entry) => entry.version).sort(), ["1.0.0", "1.1.0"]);
  assert.equal(describeGenerationSweep(sweep), "old Frizz server releases: kept 1.1.0 and 1.0.0, because the running processes could not be listed");
});

test("what a killed install left behind goes once it is a day old, and nothing else in the directory is touched", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 1);
  store.commit(made[0]!);
  const stale = join(store.generations, `${randomUUID()}.staging`);
  const fresh = join(store.generations, `${randomUUID()}.staging`);
  const foreign = join(store.generations, "notes");
  const lookalike = join(store.generations, "not-a-generation.staging");
  for (const path of [stale, fresh, foreign, lookalike]) {
    mkdirSync(join(path, "node_modules"), { recursive: true });
    writeFileSync(join(path, "package.json"), "{}");
  }
  for (const path of [stale, foreign, lookalike]) installed(path, 3 * DAY);
  installed(fresh, DAY - 60_000);
  // No process list at all: a leftover install is judged by its age alone.
  const sweep = await store.sweep({ commands: async () => undefined });
  assert.equal(sweep.unfinished, 1);
  assert.deepEqual([stale, fresh, foreign, lookalike].map((path) => existsSync(path)), [false, true, true, true]);
  assert.equal(describeGenerationSweep(sweep), "old Frizz server releases: removed 1 unfinished install");
});

test("a selection that cannot be read removes nothing", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 5);
  await assert.rejects(store.sweep({ commands: nothingRunning }), "nothing is selected yet");
  store.commit(made[4]!);
  for (const broken of ["not json", JSON.stringify({ package: baseline.package, id: "../../elsewhere" })]) {
    writeFileSync(store.selection, broken);
    await assert.rejects(store.sweep({ commands: nothingRunning }));
    assert.equal(versionsIn(store).length, 5);
  }
});

test("a generation that could not be removed is reported, and the others still go", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 6);
  store.commit(made[5]!);
  const stuck = join(store.generations, made[1]!.id);
  const sweep = await store.sweep({
    commands: nothingRunning,
    remove: async (path) => {
      if (path === stuck) throw new Error("EBUSY");
      rmSync(path, { recursive: true });
    },
  });
  assert.deepEqual(sweep.removed.sort(), ["1.0.0", "1.2.0"]);
  assert.deepEqual(sweep.kept.filter((entry) => entry.why === "failed"), [{ version: "1.1.0", why: "failed" }]);
  assert.equal(existsSync(stuck), true);
  assert.match(describeGenerationSweep(sweep) ?? "", /^old Frizz server releases: removed 1\.\d\.0 and 1\.\d\.0; could not remove 1\.1\.0$/u);
});

test("two sweeps asked for at once are one sweep", async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 5);
  store.commit(made[4]!);
  let asked = 0;
  const commands = async (): Promise<string[]> => { asked += 1; return []; };
  const [first, second] = await Promise.all([store.sweep({ commands }), store.sweep({ commands })]);
  assert.equal(first, second);
  assert.equal(asked, 1);
  assert.deepEqual(first.removed.sort(), ["1.0.0", "1.1.0"]);
});

test("the sweep's log line names what went and what a process still holds", () => {
  assert.equal(
    describeGenerationSweep({
      removed: ["0.15.18", "0.15.21", "0.15.30"], unfinished: 2,
      kept: [{ version: "0.15.48", why: "held" }, { version: "0.15.41", why: "running" }, { version: "0.15.47", why: "recent" }],
    }),
    "old Frizz server releases: removed 0.15.18, 0.15.21 and 0.15.30; removed 2 unfinished installs; kept 0.15.41, still used by a running process",
  );
  assert.equal(describeGenerationSweep({ removed: [], unfinished: 0, kept: [{ version: "0.15.48", why: "held" }, { version: "0.15.47", why: "young" }] }), undefined);
});

// The real process table and a real process, because the whole rule rests on one fact: whatever
// was started from a generation has that generation's id in its command line, in full.
test("a generation a real process was started from is kept while it runs and removed once it has ended", { skip: process.platform === "win32" }, async (t) => {
  const { store } = setup(t);
  const made = await generations(store, 5);
  store.commit(made[4]!);
  const daemon = join(made[0]!.root, "dist", "claude-agent-broker.js");
  writeFileSync(daemon, "setInterval(() => {}, 1000);\n");
  // A long argument BEFORE the path: a listing that cut its lines short would lose the id.
  const child = spawn(process.execPath, [`--conditions=${"c".repeat(5000)}`, daemon, "x".repeat(6000)], { stdio: "ignore", detached: true });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* It has already ended. */ } });
  await once(child, "spawn");
  const deadline = Date.now() + 30_000;
  let listed: string | undefined;
  while (Date.now() < deadline && !listed) {
    listed = (await runningCommands())?.find((line) => line.includes(made[0]!.id));
    if (!listed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(listed, "the process table names the generation the child was started from");
  assert.ok(listed.endsWith("x".repeat(6000)), "and its command line is whole");

  const during = await store.sweep();
  assert.deepEqual(during.removed, ["1.1.0"]);
  assert.deepEqual(during.kept.filter((entry) => entry.why === "running"), [{ version: "1.0.0", why: "running" }]);
  assert.equal(existsSync(daemon), true);

  child.kill("SIGKILL");
  await once(child, "exit");
  while (Date.now() < deadline && (await runningCommands())?.some((line) => line.includes(made[0]!.id)))
    await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await store.sweep();
  assert.deepEqual(after.removed, ["1.0.0"]);
  assert.equal(existsSync(join(store.generations, made[0]!.id)), false);
  assert.deepEqual(versionsIn(store), ["1.2.0", "1.3.0", "1.4.0"]);
});

test("Windows, whose processes this cannot list, is told so rather than given an empty list", async () => {
  assert.equal(await runningCommands("win32"), undefined);
});
