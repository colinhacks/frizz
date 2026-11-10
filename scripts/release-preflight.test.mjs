// The judgements of scripts/release-preflight.mjs, on plain data. What the script READS (git, the npm
// registry, GitHub) is exercised by running it: its header has the command, and it changes nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  byKind,
  checksVerdict,
  environmentProblems,
  highestServed,
  installInputs,
  launcherFiles,
  NOTES_SINCE,
  pinnedPnpm,
  repoSlug,
  runsInFlight,
  versionsWithoutNotes,
} from "./release-preflight.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the repository is read from either spelling of the remote", () => {
  assert.equal(repoSlug("git@github.com:colinhacks/frizz.git"), "colinhacks/frizz");
  assert.equal(repoSlug("https://github.com/colinhacks/frizz"), "colinhacks/frizz");
  assert.equal(repoSlug("https://github.com/colinhacks/frizz.git\n"), "colinhacks/frizz");
  assert.equal(repoSlug("/some/local/path"), null);
});

test("a release run is in flight until it has completed, whatever it is waiting for", () => {
  const runs = [
    { databaseId: 1, status: "completed", conclusion: "success" },
    { databaseId: 2, status: "waiting" }, // held on an approval, with no runner
    { databaseId: 3, status: "in_progress" },
    { databaseId: 4, status: "queued" },
    { databaseId: 5, status: "completed", conclusion: "failure" },
  ];
  assert.deepEqual(runsInFlight(runs).map((run) => run.databaseId), [2, 3, 4]);
});

test("the pnpm that judges the lockfile is the one THIS repository's release.yml installs", () => {
  // Read from the real workflow, so a restructured step fails here and not as a skipped check.
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(pinnedPnpm(workflow) ?? "", /^\d+\.\d+\.\d+$/, "release.yml pins an exact pnpm, and the preflight finds it");
  assert.equal(pinnedPnpm("      - uses: pnpm/action-setup@v4\n        with:\n          version: 10\n"), "10", "the bare major the workflow used until 2026-09");
  assert.equal(pinnedPnpm("      - uses: pnpm/action-setup@abc123 # v4.4.0\n        with:\n          version: \"10.34.9\"\n"), "10.34.9");
  assert.equal(pinnedPnpm("      - run: npm i -g pnpm\n"), null);
});

test("a frozen install is given the manifests and the lockfile, and nothing else of the tree", () => {
  assert.deepEqual(
    installInputs([
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "patches/some-dep@1.0.0.patch",
      "packages/web/package.json",
      "packages/web/src/App.tsx",
      "packages/web/node_modules/x/package.json",
      "src/index.ts",
      "docs/package.json.md",
    ]),
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/some-dep@1.0.0.patch", "packages/web/package.json"],
  );
});

const environment = (overrides = {}) => ({
  name: "npm-publish",
  protection_rules: [{ type: "branch_policy" }, { type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "colinhacks" } }] }],
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  ...overrides,
});

test("a release environment must require the maintainer and admit `release` alone", () => {
  assert.deepEqual(environmentProblems(environment(), [{ name: "release", type: "branch" }]), []);
  assert.deepEqual(environmentProblems(undefined, []), ["it does not exist"]);
  assert.deepEqual(environmentProblems(environment({ protection_rules: [{ type: "branch_policy" }] }), [{ name: "release" }]), ["it does not require colinhacks's approval"]);
  assert.deepEqual(
    environmentProblems(environment({ protection_rules: [{ type: "required_reviewers", reviewers: [{ reviewer: { login: "someone-else" } }] }] }), [{ name: "release" }]),
    ["it does not require colinhacks's approval"],
  );
  assert.deepEqual(environmentProblems(environment(), [{ name: "release" }, { name: "main" }]), ["it admits release, main rather than release alone"]);
  assert.deepEqual(environmentProblems(environment(), []), ["it admits no branch by name rather than release alone"]);
  assert.deepEqual(
    environmentProblems(environment({ deployment_branch_policy: null }), [{ name: "release" }]),
    ["it does not restrict which branches may deploy"],
  );
});

test("the highest served version is by number, and a prerelease is not one", () => {
  assert.equal(highestServed({ versions: { "0.15.9": {}, "0.15.10": {}, "0.15.11-beta.1": {}, "0.9.99": {} } }), "0.15.10");
  assert.equal(highestServed({ versions: {} }), null);
  assert.equal(highestServed(undefined), null);
});

test("a version served since the rule with no GitHub release is named, and earlier ones are not", () => {
  const packument = {
    versions: { "0.15.27": {}, "0.15.28": {}, "0.15.29": {}, "0.15.30": {} },
    time: { "0.15.27": "2026-10-16T19:15:52.103Z", "0.15.28": "2026-10-16T20:38:15.370Z", "0.15.29": "2026-10-18T03:04:37.046Z", "0.15.30": "2026-10-19T03:00:00.000Z" },
  };
  const tag = (version) => `frizz-server-v${version}`;
  assert.deepEqual(versionsWithoutNotes(packument, ["frizz-server-v0.15.28", "frizz-server-v0.15.30"], tag), ["0.15.29"]);
  assert.deepEqual(versionsWithoutNotes(packument, ["frizz-server-v0.15.28", "frizz-server-v0.15.29", "frizz-server-v0.15.30"], tag), []);
  // 0.15.27 went out an hour before the rule and has no release to this day: it is not a debt.
  assert.ok(packument.time["0.15.27"] < NOTES_SINCE && packument.time["0.15.28"] >= NOTES_SINCE);
  // The shell's tags are a bare `v`, which a server tag must not satisfy.
  assert.deepEqual(versionsWithoutNotes(packument, ["frizz-server-v0.15.28", "frizz-server-v0.15.29", "frizz-server-v0.15.30"], (version) => `v${version}`), ["0.15.28", "0.15.29", "0.15.30"]);
});

test("the launcher's files are its sources, not its tests or their fixtures", () => {
  assert.deepEqual(
    launcherFiles(["src/index.ts", "src/launcher.test.ts", "src/production.ts", "src/artifacts.fixtures/x.mjs", "packages/server/src/index.ts", "scripts/prepare-package.mjs"]),
    ["src/index.ts", "src/production.ts"],
  );
});

test("commits are grouped by their conventional type, most common first", () => {
  const kinds = byKind([
    "fix(web): a",
    "feat: b",
    "fix: c",
    "Merge branch 'main' into x",
    "fix(server)!: d",
    "chore(release): frizz-server 0.15.50",
    'Revert "feat(web): e"',
  ]);
  assert.deepEqual(kinds.map(([kind, list]) => [kind, list.length]), [["fix", 3], ["other", 2], ["chore", 1], ["feat", 1]]);
});

test("GitHub's checks on a commit: none run, some failed, some still running, all passed", () => {
  assert.equal(checksVerdict([]), null, "nothing ran: the commit is not pushed");
  assert.deepEqual(checksVerdict([{ name: "check", status: "completed", conclusion: "success" }, { name: "docs", status: "completed", conclusion: "skipped" }]), { failed: [], running: [], total: 2 });
  assert.deepEqual(checksVerdict([{ name: "check", status: "completed", conclusion: "failure" }, { name: "test", status: "in_progress", conclusion: null }]), { failed: ["check"], running: ["test"], total: 2 });
  assert.deepEqual(checksVerdict([{ name: "check", status: "completed", conclusion: "cancelled" }]).failed, ["check"]);
});
