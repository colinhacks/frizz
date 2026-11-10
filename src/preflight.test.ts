import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
  MINIMUM_NODE,
  NODE_API_AVAILABILITY,
  providerReadiness,
  SUPPORTED_NODE_LINES,
  supportedNodeRange,
} from "./preflight.ts";

test("core launch preflight accepts a supported Node host with git", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "22.13.0", command: () => true })
  );
});

test("core launch preflight accepts newer Node majors", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "26.0.0", command: () => true })
  );
});

test("core launch preflight rejects a Node host below the dependency floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "18.20.0", command: () => true }),
    /Node\.js \^22\.13\.0 \|\| >=23\.4\.0 is required \(found 18\.20\.0\)/
  );
});

test("core launch preflight rejects Node 20, which predates node:sqlite entirely", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true }),
    /Node\.js \^22\.13\.0 \|\| >=23\.4\.0 is required \(found 20\.19\.0\)/
  );
});

test("core launch preflight rejects an old 22.x minor below the floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "22.11.0", command: () => true }),
    /Node\.js \^22\.13\.0 \|\| >=23\.4\.0 is required \(found 22\.11\.0\)/
  );
});

// Git USED to be the one required executable, because a project was defined as a Git repository.
// A project is now a directory (project-root.ts), so a machine with no git launches fine.
test("a missing git no longer blocks a launch", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "22.13.0", command: (name) => name !== "git" })
  );
});

// The launchers probe for these BEFORE resolving a workspace, which is what makes the diagnosis
// eager: resolving one execs `git`, which used
// to report the absence in its own unrelated vocabulary.
test("the eager probe requires nothing now, git included", () => {
  assert.doesNotThrow(() => assertRequiredExecutables((name) => name !== "git"));
  assert.doesNotThrow(() => assertRequiredExecutables(() => false));
  assert.doesNotThrow(() => assertRequiredExecutables(() => true));
});

// Node's floor is deliberately NOT part of the eager probe: `--stop`/`--status`/`promote` stay
// reachable for repair on a host whose Node is too old, and only a real launch enforces it.
test("the eager executable probe leaves the Node floor to the full prerequisite check", () => {
  assert.doesNotThrow(() => assertRequiredExecutables(() => true));
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true }),
    /Node\.js \^22\.13\.0 \|\| >=23\.4\.0 is required/
  );
});

// The floor users are TOLD about and the floor Frizz enforces must be the same. They have drifted
// twice, in opposite directions: `>=26` against an enforced 22.12 (EBADENGINE about a floor nothing
// checked), then `>=22.12.0` against a runtime that segfaults there.
test("the published engines floor is exactly the floor the launcher enforces", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
  ) as { engines?: { node?: string } };
  assert.equal(
    manifest.engines?.node,
    supportedNodeRange(),
    "package.json engines.node must mirror SUPPORTED_NODE_LINES"
  );
});

// Measured, not derived. `node:sqlite` was unflagged in 22.13 and 23.4; below that the import fails
// outright with "No such built-in module". Confirmed by running the driver's own suite (sqlite.test.ts)
// on 22.12, 22.13, 22.14, 23.4, 23.6, 24 and 26 — every release from 22.13 up passes it whole, and
// 22.12 is the only one that fails, at import. A floor written as plain `>=22.13` would wrongly
// advertise 23.0-23.3, where the module does not exist either, hence a floor per release line.
test("the Node floor tracks the releases node:sqlite actually ships in", () => {
  for (const version of ["22.13.0", "22.14.0", "22.23.1", "23.4.0", "23.6.0", "23.11.0", "24.17.0", "25.9.0", "26.5.0"]) {
    assert.doesNotThrow(
      () => assertLaunchPrerequisites({ nodeVersion: version, command: () => true }),
      `${version} ships node:sqlite and was measured to run the driver suite`
    );
  }
  for (const version of ["20.11.0", "21.7.0", "22.0.0", "22.11.0", "22.12.0", "23.0.0", "23.3.0"]) {
    assert.throws(
      () => assertLaunchPrerequisites({ nodeVersion: version, command: () => true }),
      /is required/,
      `${version} has no node:sqlite and must be refused`
    );
  }
  assert.equal(supportedNodeRange(), "^22.13.0 || >=23.4.0");
  // MINIMUM_NODE stays the lowest supported release, for callers that want a single number.
  assert.deepEqual({ ...MINIMUM_NODE }, { major: 22, minor: 13 });
});

// The floor has drifted TWICE, and both times a hand-maintained number went stale against a native
// dependency. better-sqlite3 is gone now — the database is `node:sqlite`, which has no prebuild to go
// stale — but @parcel/watcher is still an addon, so the guard stays and is now general:
// it re-derives the requirement from what EVERY runtime dependency actually builds against.
//
// The failure it exists to prevent is not a clean error. better-sqlite3 built with NAPI_VERSION=10
// while declaring `engines: ">=22"`, and on Node 22.12 the addon did not fail to load — Node
// SEGFAULTED registering it (EXC_BAD_ACCESS in napi_module_register_by_symbol during DLOpen).
test("the Node floor covers the Node-API version every native dependency builds against", () => {
  // What a user's machine installs is the shell's dependencies and the published server's. The shell
  // has had none since 2026-11-10, so the addons are the server's, resolved from where its source
  // installs them. Reading only the shell's manifest would leave this loop with nothing to read.
  const repo = join(import.meta.dirname, "..");
  const dependenciesOf = (...path: string[]) =>
    Object.keys((JSON.parse(readFileSync(join(repo, ...path, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
  const installed = [
    ...dependenciesOf().map((name) => ({ name, require: createRequire(import.meta.url) })),
    ...dependenciesOf("packages", "server-release").map((name) => ({ name, require: createRequire(join(repo, "packages", "server", "package.json")) })),
  ];
  assert.ok(
    !installed.some(({ name }) => name === "better-sqlite3"),
    "better-sqlite3 is back as a dependency; it segfaults below its NAPI floor — see sqlite.ts"
  );

  let highest = 8; // Node-API 8 is the default when a binding.gyp says nothing.
  const addons: string[] = [];
  for (const { name, require } of installed) {
    let gyp: string;
    try {
      gyp = readFileSync(join(dirname(require.resolve(`${name}/package.json`)), "binding.gyp"), "utf8");
    } catch {
      continue; // Not a native addon, or it ships no binding.gyp — nothing to derive.
    }
    addons.push(name);
    const declared = Number(/NAPI_VERSION=(\d+)/.exec(gyp)?.[1]);
    if (Number.isSafeInteger(declared)) highest = Math.max(highest, declared);
  }
  // The guard read something: with no addon found it would pass whatever the floor is.
  assert.deepEqual(addons, ["@parcel/watcher"], "the set of native addons a user installs has changed; re-measure the Node floor");

  const lines = NODE_API_AVAILABILITY[highest];
  assert.ok(
    lines,
    `a dependency now needs Node-API ${highest}, which NODE_API_AVAILABILITY does not describe. ` +
      `Add it from https://nodejs.org/api/n-api.html and re-measure SUPPORTED_NODE_LINES.`
  );
  for (const line of lines!) {
    const ours = SUPPORTED_NODE_LINES.find((entry) => entry.major === line.major);
    if (!ours) continue; // We advertise no release on that line at all, so nothing can load there.
    assert.ok(
      ours.minor >= line.minor,
      `Frizz advertises Node ${ours.major}.${ours.minor}, below the ${line.major}.${line.minor} that ` +
        `Node-API ${highest} requires — a native dependency would crash there, not fail cleanly`
    );
  }
});

test("provider readiness disables only the unavailable backend and never requires gh", () => {
  const seen: string[] = [];
  const readiness = providerReadiness((name) => {
    seen.push(name);
    return name === "codex";
  });
  assert.deepEqual(readiness, { claude: false, codex: true });
  assert.deepEqual(seen, ["claude", "codex"]);
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({
      nodeVersion: "22.13.0",
      command: (name) => name === "git",
    })
  );
});
