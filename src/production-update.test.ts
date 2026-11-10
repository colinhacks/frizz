import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "./launcher.ts";
import {
  PRODUCTION_REEXEC_FLAG,
  compareReleaseVersions,
  isGlobalInstall,
  keepUpdateHint,
  planRegistryUpdate,
  reexecArgv,
} from "./production-update.ts";

const plan = { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" };

test("release ordering follows numeric prerelease identifiers rather than lexical order", () => {
  const ascending = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0", "1.0.1"];
  for (let index = 1; index < ascending.length; index++) {
    assert.equal(compareReleaseVersions(ascending[index - 1]!, ascending[index]!), -1);
    assert.equal(compareReleaseVersions(ascending[index]!, ascending[index - 1]!), 1);
  }
  assert.equal(compareReleaseVersions("1.2.3+build.1", "1.2.3+build.2"), 0);
  assert.equal(compareReleaseVersions("1.0.0-01", "1.0.0"), null);
});

test("registry update does nothing when the installed version is current", async () => {
  assert.equal(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.2.3" }), null);
});

test("registry update selects an immutable newer package spec", async () => {
  assert.deepEqual(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.3.0" }), plan);
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

// Semver §11.4. The raw-string comparison this replaced judged `rc.9` newer than `rc.10` (audit
// 2026-09-11, finding 10), so a `latest` tag on the tenth release candidate read as a downgrade.
test("prerelease identifiers compare per field, numerically where numeric, shorter list lower", () => {
  const rows: Array<[string, string, number | null]> = [
    ["0.13.0-rc.9", "0.13.0-rc.10", -1],
    ["0.13.0-rc.10", "0.13.0-rc.9", 1],
    ["0.13.0-rc.10", "0.13.0-rc.10", 0],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    // The release itself still outranks every prerelease of it, and the downgrade guard stays.
    ["1.0.0-rc.1", "1.0.0", -1],
    ["0.13.0", "0.13.0-rc.2", 1],
    ["0.12.10", "0.12.9", 1],
    ["next", "0.12.9", null],
  ];
  for (const [a, b, expected] of rows) assert.equal(compareReleaseVersions(a, b), expected, `${a} vs ${b}`);
});

// A launcher before 0.13.0 updates by starting THIS release with an argv it chose, and every release
// from 0.7.0 to 0.12.10 appends the project directory, which parseCliArgs has refused since the
// singleton launch. A successor that refuses it is one no install in the field can update into
// (measured 2026-09-11: 0.12.10 -> 0.12.11 printed "taking over", then ECONNREFUSED for good). The
// directory is dropped; the port survives.
test("a re-exec'd launcher drops the project directory an older launcher appends, and keeps its port", () => {
  const legacy = [PRODUCTION_REEXEC_FLAG, "--port", "4917", "/Users/someone/code/app"];
  assert.deepEqual(reexecArgv(legacy), ["--port", "4917"]);
  assert.equal(parseCliArgs(reexecArgv(legacy)).port, 4917);
  // A Windows launcher appends the directory with backslashes; the same pass drops it.
  assert.deepEqual(reexecArgv([PRODUCTION_REEXEC_FLAG, "--port", "4917", "C:\\Users\\someone\\repo"]), ["--port", "4917"]);
  // 0.12.11 through 0.12.13 pass no directory; the same pass leaves that argv as it is.
  assert.deepEqual(reexecArgv([PRODUCTION_REEXEC_FLAG, "--port", "4917"]), ["--port", "4917"]);
  // Flags survive in place, and a directory before the flags is dropped too.
  assert.deepEqual(reexecArgv(["/repo", PRODUCTION_REEXEC_FLAG, "--no-app", "--port=4918"]), ["--no-app", "--port=4918"]);
});

// npm sets `npm_execpath` for every bin it runs (npx, npm exec, and the package managers set it to
// their own entry), so its absence plus a real `node_modules` path is a global bin — the one shape
// whose self-update does not survive the next launch (audit 2026-09-11, finding 9).
test("a global install is told apart from npx, the execution cache and a source checkout", () => {
  const rows: Array<[string, NodeJS.ProcessEnv, boolean]> = [
    ["/Users/ada/.nvm/versions/node/v24.0.0/lib/node_modules/frizz/dist", {}, true],
    ["/opt/homebrew/lib/node_modules/frizz/dist", {}, true],
    ["C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\frizz\\dist", {}, true],
    // npx: the same layout under npm's execution cache, with npm's own hint in the environment.
    ["/Users/ada/.npm/_npx/0123abcd/node_modules/frizz/dist", { npm_execpath: "/opt/node/lib/node_modules/npm/bin/npx-cli.js" }, false],
    // The cache without the hint — a successor started by an older launcher inherits a scrubbed env.
    ["/Users/ada/.npm/_npx/0123abcd/node_modules/frizz/dist", {}, false],
    ["C:\\Users\\ada\\AppData\\Local\\npm-cache\\_npx\\0123abcd\\node_modules\\frizz\\dist", {}, false],
    // A global bin run THROUGH npm (`npm exec frizz` against the global tree) is npm's to re-resolve.
    ["/opt/homebrew/lib/node_modules/frizz/dist", { npm_execpath: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js" }, false],
    ["/Users/ada/projects/frizz/dist", {}, false],
  ];
  for (const [dir, env, expected] of rows) assert.equal(isGlobalInstall(dir, env), expected, dir);
  assert.equal(keepUpdateHint("frizz", "1.3.0"), "this session only — run npm i -g frizz@1.3.0 to keep it");
});
