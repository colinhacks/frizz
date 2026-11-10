#!/usr/bin/env node
// Is this commit ready to be released? Asked BEFORE anything is pushed.
//
//   nub scripts/release-preflight.mjs                   the commit `main` points at
//   nub scripts/release-preflight.mjs <commit>          the commit about to become `release`
//   nub scripts/release-preflight.mjs --only=lockfile   one or more of the checks below, by name
//
// IT READS, AND THAT IS ALL IT DOES. No push, no branch move, no dispatch, no approval, nothing on
// npm: git, the npm registry and GitHub are read, and the one thing it runs is the pinned pnpm, with
// `--lockfile-only`, in a temp directory holding a copy of the manifests. Every `gh` call is a read,
// so on the maintainer's Mac it needs no Touch ID.
//
// WHY IT EXISTS. Each rule of AGENTS.md § Cutting a release that a machine can check was prose the
// releaser had to remember, and each has broken a release at least once. Of 125 release runs, 14
// failed and 6 were cancelled; six of the failures were `Install workspace`, a lockfile the pinned
// pnpm refuses, found after the bump, the push and the approval. The workflow's own gates run INSIDE
// the run. These are the same questions asked first:
//
//   order       the commit is on `main`, and `release` fast-forwards to it
//   in flight   no release run is queued, running or waiting for an approval
//   versions    what this release would stage, and that each version directly follows the highest
//               one npm serves (the workflow's own script, .github/scripts/npm-refuse-overtake.sh)
//   manifests   the shell's server pin exists, its minimum is not above the pin, protocol and data
//               epoch agree across both packages, `engines.node` is the supported range
//   shell       launcher files changed since the last served shell, with its version unchanged
//   lockfile    the pnpm that release.yml pins accepts the lockfile as frozen
//   ci          the checks GitHub ran on this commit
//   pins        the bundled Claude Code and Codex are current (scripts/check-runtime-pins.mjs)
//   approvals   both release environments still require the maintainer and admit `release` only
//   notes       every version served since the rule has a GitHub release
//   ships       what is on this commit and not yet on `release`, by kind
//
// A line starts ✓ (holds), ✖ (does not: the exit code is 1), ! (worth reading, exit code unaffected)
// or – (could not be checked from here, with why). Not checked, because nothing outside npm can see
// it: whether a version is sitting in npm's staged queue. A release run still in flight is the proxy.
//
// Run it with nub, which is what lets it ask the launcher's own code about the manifests
// (src/server-release.ts, src/preflight.ts) instead of keeping a second copy of those rules.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ghCommand } from "./lib/gh-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/**
 * From when every release carries notes, server-only ones included: frizz-server 0.15.28, published
 * that evening, was the first. A registry timestamp, compared as text.
 */
export const NOTES_SINCE = "2026-10-16T20:00";
const REVIEWER = "colinhacks";
const ENVIRONMENTS = ["npm-publish", "release-approval"];

// ── The judgements, each on plain data so it can be tested without a network ───────────────────────

/** `owner/repo` from a git remote, SSH or HTTPS. */
export function repoSlug(remoteUrl) {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(remoteUrl ?? "")?.[1] ?? null;
}

/** Release runs that are not over. One of them means a version may still be in npm's review. */
export function runsInFlight(runs) {
  return runs.filter((run) => run.status !== "completed");
}

/**
 * The pnpm release.yml installs, so the lockfile is judged by the pnpm that will judge it: an exact
 * version today, a bare major (`10`) in the workflow's first months.
 */
export function pinnedPnpm(workflow) {
  return /pnpm\/action-setup@[^\n]*\n\s*with:\s*\n\s*version:\s*["']?(\d+(?:\.\d+){0,2})\b/.exec(workflow ?? "")?.[1] ?? null;
}

/** The manifests and lockfile a frozen install reads, out of every path in the tree. */
export function installInputs(paths) {
  return paths.filter(
    (file) =>
      !file.split("/").includes("node_modules") &&
      (/(^|\/)package\.json$/.test(file) || /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs)$/.test(file) || file.startsWith("patches/")),
  );
}

/**
 * What is wrong with one release environment. It must require the maintainer's approval and admit
 * deployments from `release` alone: either one missing lets a run stage without him.
 */
export function environmentProblems(environment, branchPolicies, { reviewer = REVIEWER, branch = "release" } = {}) {
  if (!environment) return ["it does not exist"];
  const problems = [];
  const reviewers = (environment.protection_rules ?? [])
    .filter((rule) => rule.type === "required_reviewers")
    .flatMap((rule) => (rule.reviewers ?? []).map((entry) => entry.reviewer?.login));
  if (!reviewers.includes(reviewer)) problems.push(`it does not require ${reviewer}'s approval`);
  if (environment.deployment_branch_policy?.custom_branch_policies !== true) problems.push("it does not restrict which branches may deploy");
  const admitted = (branchPolicies ?? []).map((policy) => policy.name);
  if (admitted.length !== 1 || admitted[0] !== branch) problems.push(`it admits ${admitted.length === 0 ? "no branch by name" : admitted.join(", ")} rather than ${branch} alone`);
  return problems;
}

const plain = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
const byVersion = (a, b) => {
  const [x, y] = [plain(a), plain(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The highest plain version a packument serves. */
export function highestServed(packument) {
  return Object.keys(packument?.versions ?? {}).filter(plain).sort(byVersion).at(-1) ?? null;
}

/** Served versions published on or after `since` that have no GitHub release under their tag. */
export function versionsWithoutNotes(packument, tags, tagOf, since = NOTES_SINCE) {
  const have = new Set(tags);
  return Object.keys(packument?.versions ?? {})
    .filter(plain)
    .filter((version) => (packument.time?.[version] ?? "") >= since)
    .filter((version) => !have.has(tagOf(version)))
    .sort(byVersion);
}

/** Files of the launcher itself: what a new shell version would carry and a server release does not. */
export function launcherFiles(paths) {
  return paths.filter((file) => file.startsWith("src/") && !/\.test\.[cm]?[jt]sx?$/.test(file) && !file.includes(".fixtures/"));
}

/** Commit subjects grouped by conventional type, most common first. */
export function byKind(subjects) {
  const groups = new Map();
  for (const subject of subjects) {
    const kind = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject)?.[1] ?? "other";
    groups.set(kind, [...(groups.get(kind) ?? []), subject]);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** How GitHub's checks on a commit stand. `null` when it ran none: the commit is not pushed. */
export function checksVerdict(checkRuns) {
  if (checkRuns.length === 0) return null;
  const failed = checkRuns.filter((run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(run.conclusion));
  const running = checkRuns.filter((run) => run.status !== "completed");
  return { failed: failed.map((run) => run.name), running: running.map((run) => run.name), total: checkRuns.length };
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  let failed = 0;
  const say = (mark, topic, line) => {
    if (mark === "✖") failed++;
    console.log(`${mark} ${topic.padEnd(10)} ${line}`);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const gitOk = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;
  const short = (sha) => sha.slice(0, 9);
  const gh = (reason, args) => {
    const [command, commandArgs] = ghCommand(reason, args);
    const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim().split("\n")[0]);
    return result.stdout;
  };
  const packument = async (name) => {
    const response = await fetch(`https://registry.npmjs.org/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${name}`);
    return response.json();
  };
  const only = new Set(argv.filter((arg) => arg.startsWith("--only=")).flatMap((arg) => arg.slice(7).split(",")));
  const attempt = async (topic, check) => {
    if (only.size > 0 && !only.has(topic)) return;
    try {
      await check();
    } catch (error) {
      say("–", topic, `could not be checked: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  };

  const wanted = argv.find((arg) => !arg.startsWith("--")) ?? "main";
  let sha;
  try {
    sha = git("rev-parse", "--verify", "--quiet", `${wanted}^{commit}`);
  } catch {
    console.error(`✖ ${wanted} is not a commit in this checkout`);
    return 1;
  }
  console.log(`Release preflight for ${short(sha)} ${git("log", "-1", "--format=%s", sha)}\n`);

  const repo = repoSlug(git("remote", "get-url", "origin"));
  const show = (file) => git("show", `${sha}:${file}`);
  // A commit from before the server had a package of its own has no second manifest; the checks that
  // read one say so, and the rest still run.
  const manifest = (file) => {
    try {
      return JSON.parse(show(file));
    } catch {
      return null;
    }
  };
  const shell = manifest("package.json");
  const server = manifest("packages/server-release/package.json");
  const bothManifests = () => {
    if (!shell || !server) throw new Error(`${short(sha)} does not carry both package manifests`);
  };

  // order ─ `release` is a fast-forward pointer into `main`, never a fork.
  let releaseSha = null;
  await attempt("order", async () => {
    if (gitOk("merge-base", "--is-ancestor", sha, "main")) say("✓", "order", `${short(sha)} is on main`);
    else say("✖", "order", `${short(sha)} is not on main: only a commit of main is released`);
    // Asked of GitHub over HTTPS rather than `git ls-remote`, which signs in over SSH and costs a Touch ID.
    releaseSha = gh("Read where the release branch points", ["api", `repos/${repo}/branches/release`, "--jq", ".commit.sha"]).trim();
    if (!gitOk("cat-file", "-e", `${releaseSha}^{commit}`)) return say("✖", "order", `origin's release is at ${short(releaseSha)}, which this checkout does not have: fetch before releasing`);
    if (releaseSha === sha) return say("!", "order", `release is already at ${short(sha)}: moving it there selects nothing new`);
    if (gitOk("merge-base", "--is-ancestor", releaseSha, sha)) say("✓", "order", `release (${short(releaseSha)}) fast-forwards to it`);
    else say("✖", "order", `release (${short(releaseSha)}) is not an ancestor of ${short(sha)}: moving it would not be a fast-forward. Stop and look`);
  });

  // in flight ─ never dispatch while an earlier version of the same package is still in review.
  await attempt("in flight", async () => {
    const runs = JSON.parse(gh("List recent release runs", ["run", "list", "--workflow=release.yml", "-R", repo, "--limit", "20", "--json", "databaseId,status,conclusion,createdAt,url"]));
    const open = runsInFlight(runs);
    if (open.length === 0) return say("✓", "in flight", `none of the last ${runs.length} release runs is still going`);
    for (const run of open) say("✖", "in flight", `release run ${run.databaseId} is ${run.status.replace("_", " ")} since ${run.createdAt}: wait for it, ${run.url}`);
  });

  // versions ─ what would be staged, and in the order npm will serve it.
  const packuments = {};
  const served = async () => {
    packuments.shell ??= await packument("frizz");
    packuments.server ??= await packument("frizz-server");
  };
  await attempt("versions", async () => {
    bothManifests();
    await served();
    const staged = [];
    for (const [manifest, registry] of [[server, packuments.server], [shell, packuments.shell]]) {
      if (registry.versions?.[manifest.version]) {
        say("✓", "versions", `${manifest.name}@${manifest.version} is already served: this release leaves it alone`);
        continue;
      }
      staged.push(manifest);
      // The workflow's own script, so this and the run cannot disagree about a gap.
      const order = spawnSync("bash", [path.join(root, ".github/scripts/npm-refuse-overtake.sh"), manifest.name, manifest.version], { cwd: root, encoding: "utf8", timeout: 60_000 });
      const line = `${order.stdout}${order.stderr}`.trim().split("\n").at(-1)?.replace(/^::error::/, "").replace(/^✓ /, "") ?? "";
      say(order.status === 0 ? "✓" : "✖", "versions", order.status === 0 ? `would stage ${line}` : line);
    }
    if (staged.length === 0) say("✖", "versions", `npm already serves both versions, so a run would stage nothing: bump the package that changed first`);
  });

  // manifests ─ the workflow's pin check, moved in front of the approval, and the launcher's own rules.
  await attempt("manifests", async () => {
    bothManifests();
    await served();
    const pin = shell.frizzServer?.version;
    if (pin === server.version) say("✓", "manifests", `the shell pins frizz-server@${pin}, this tree's own`);
    else if (packuments.server?.versions?.[pin]) say("✓", "manifests", `the shell pins frizz-server@${pin}, which npm serves`);
    else say("✖", "manifests", `the shell pins frizz-server@${pin}, which this tree does not carry and npm does not serve: a shell with no server behind it`);
    const { serverReleaseMinimum } = await import(pathToFileURL(path.join(root, "src/server-release.ts")).href);
    try {
      const minimum = serverReleaseMinimum(shell);
      say("✓", "manifests", minimum ? `its minimum server, ${minimum}, is not above the pin` : "it declares no minimum server");
    } catch (error) {
      say("✖", "manifests", `${error.message}: every launch below the minimum would stop`);
    }
    const [a, b] = [shell.frizzServer ?? {}, server.frizzServer ?? {}];
    if (a.protocol === b.protocol && a.dataEpoch === b.dataEpoch) say("✓", "manifests", `protocol ${a.protocol} and data epoch ${a.dataEpoch} agree across both packages`);
    else say("✖", "manifests", `the shell says protocol ${a.protocol}, data epoch ${a.dataEpoch} and the server says ${b.protocol}, ${b.dataEpoch}: they ship together or not at all`);
    const { supportedNodeRange } = await import(pathToFileURL(path.join(root, "src/preflight.ts")).href);
    const range = supportedNodeRange();
    const wrong = [shell, server].filter((manifest) => manifest.engines?.node !== range);
    if (wrong.length === 0) say("✓", "manifests", `engines.node is ${range} in both`);
    else for (const manifest of wrong) say("✖", "manifests", `${manifest.name} declares engines.node ${manifest.engines?.node}, and the launcher supports ${range}`);
  });

  // shell ─ a launcher change reaches nobody until the shell's own version moves.
  await attempt("shell", async () => {
    bothManifests();
    await served();
    const last = highestServed(packuments.shell);
    const head = packuments.shell?.versions?.[last]?.gitHead;
    if (!last || !head) throw new Error("npm records no gitHead for the last served shell");
    if (!gitOk("cat-file", "-e", `${head}^{commit}`)) throw new Error(`frizz@${last} was built from ${short(head)}, which this checkout does not have`);
    const changed = launcherFiles(git("diff", "--name-only", head, sha, "--", "src").split("\n").filter(Boolean));
    const bumped = shell.version !== last;
    const some = `${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ` and ${changed.length - 4} more` : ""}`;
    if (changed.length > 0 && !bumped) say("!", "shell", `${changed.length} launcher file${changed.length === 1 ? "" : "s"} changed since frizz@${last} and the shell is still ${last}, so they ship with no release until it is bumped: ${some}`);
    else if (changed.length === 0 && bumped) say("!", "shell", `the shell is bumped to ${shell.version} with no launcher file changed since frizz@${last}`);
    else if (bumped) say("✓", "shell", `frizz ${shell.version} carries ${changed.length} launcher file${changed.length === 1 ? "" : "s"} changed since ${last}`);
    else say("✓", "shell", `no launcher file changed since frizz@${last}`);
  });

  // lockfile ─ six release runs died at `Install workspace`. Judged by the pnpm the workflow installs:
  // a newer pnpm refuses this tree for a reason of its own, and an older one accepts what CI will not.
  await attempt("lockfile", async () => {
    const pnpm = pinnedPnpm(show(".github/workflows/release.yml"));
    if (!pnpm) throw new Error("release.yml no longer names a pnpm version where this looks for it");
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-release-preflight-"));
    try {
      for (const file of installInputs(git("ls-tree", "-r", "--name-only", sha).split("\n"))) {
        fs.mkdirSync(path.join(copy, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(copy, file), execFileSync("git", ["show", `${sha}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
      }
      const env = { ...process.env, CI: "true" };
      delete env.NODE_COMPAT;
      const install = spawnSync("nubx", ["-y", `pnpm@${pnpm}`, "install", "--frozen-lockfile", "--lockfile-only"], { cwd: copy, env, encoding: "utf8", timeout: 300_000 });
      if (install.status === 0) return say("✓", "lockfile", `pnpm ${pnpm}, the version release.yml installs, accepts the lockfile as frozen`);
      // pnpm's own first sentence, without the paragraph of advice that follows it.
      const why = `${install.stdout}${install.stderr}`.split("\n").map((line) => line.trim()).filter((line) => /ERR_PNPM|lockfile|specifiers|overrides/i.test(line)).slice(0, 2).join(" ").split(" Note that ")[0].replace(/\s+/g, " ");
      say("✖", "lockfile", `pnpm ${pnpm} refuses it, and so would the run's Install workspace step: ${why || `exit ${install.status ?? install.signal}`}`);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  // ci ─ a release must not be the first time GitHub has looked at the commit.
  await attempt("ci", async () => {
    let runs;
    try {
      runs = JSON.parse(gh("Read the checks on the commit", ["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, conclusion}]"]));
    } catch {
      runs = [];
    }
    const verdict = checksVerdict(runs);
    if (!verdict) return say("–", "ci", `GitHub has run nothing on ${short(sha)}: it is not pushed yet`);
    if (verdict.failed.length > 0) return say("✖", "ci", `failed on this commit: ${verdict.failed.join(", ")}`);
    if (verdict.running.length > 0) return say("!", "ci", `still running on this commit: ${verdict.running.join(", ")}`);
    say("✓", "ci", `all ${verdict.total} checks passed on this commit`);
  });

  // pins ─ "run it every day and before every release".
  await attempt("pins", async () => {
    const env = { ...process.env };
    delete env.NODE_COMPAT;
    const result = spawnSync("nub", [path.join(here, "check-runtime-pins.mjs"), "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    const report = JSON.parse(result.stdout);
    if (!report.ok) throw new Error(report.error);
    if (report.behind.length === 0) return say("✓", "pins", `${report.runtimes.map((line) => `${line.backend} ${line.pinned}`).join(" and ")} are the latest`);
    for (const line of report.runtimes.filter((entry) => entry.behind)) {
      const waiting = line.unpublishedPlatforms.length > 0;
      say(waiting ? "!" : "✖", "pins", `${line.backend} is pinned at ${line.pinned} and ${line.latest} is out${waiting ? `, not yet published for ${line.unpublishedPlatforms.join(", ")}` : ": bump it and land the bump first (plans/runtime-pin-bumps.md)"}`);
    }
  });

  // approvals ─ the two human gates are still where they were put (2026-10-12, 2026-11-05).
  await attempt("approvals", async () => {
    const environments = JSON.parse(gh("Read the release environments", ["api", `repos/${repo}/environments`, "--jq", ".environments"]));
    for (const name of ENVIRONMENTS) {
      const environment = environments.find((entry) => entry.name === name);
      const policies = environment ? JSON.parse(gh("Read which branches may deploy", ["api", `repos/${repo}/environments/${name}/deployment-branch-policies`, "--jq", ".branch_policies"])) : [];
      const problems = environmentProblems(environment, policies);
      if (problems.length === 0) say("✓", "approvals", `${name} requires ${REVIEWER} and admits release alone`);
      else for (const problem of problems) say("✖", "approvals", `${name}: ${problem}`);
    }
  });

  // notes ─ every release gets its notes, server-only ones included. A debt, not a reason to hold this one.
  await attempt("notes", async () => {
    await served();
    const tags = gh("List the GitHub releases", ["api", `repos/${repo}/releases`, "--paginate", "--jq", ".[].tag_name"]).split("\n").filter(Boolean);
    const missing = [
      ...versionsWithoutNotes(packuments.server, tags, (version) => `frizz-server-v${version}`).map((version) => `frizz-server@${version}`),
      ...versionsWithoutNotes(packuments.shell, tags, (version) => `v${version}`).map((version) => `frizz@${version}`),
    ];
    if (missing.length === 0) say("✓", "notes", `every version served since ${NOTES_SINCE.slice(0, 10)} has a GitHub release`);
    else say("!", "notes", `no GitHub release for ${missing.join(", ")}: scripts/release-notes.mjs, then scripts/tag-release.mjs`);
  });

  // ships ─ "look at what ships with you".
  await attempt("ships", async () => {
    releaseSha ??= gh("Read where the release branch points", ["api", `repos/${repo}/branches/release`, "--jq", ".commit.sha"]).trim();
    const subjects = git("log", "--format=%s", `${releaseSha}..${sha}`).split("\n").filter(Boolean);
    if (subjects.length === 0) return say("!", "ships", "nothing: this commit carries no commit that release does not have");
    const kinds = byKind(subjects);
    say("✓", "ships", `${subjects.length} commit${subjects.length === 1 ? "" : "s"} since release: ${kinds.map(([kind, list]) => `${list.length} ${kind}`).join(", ")}`);
    for (const [kind, list] of kinds) {
      console.log(`\n  ${kind}`);
      for (const subject of list.slice(0, 40)) console.log(`    ${subject}`);
      if (list.length > 40) console.log(`    … and ${list.length - 40} more`);
    }
  });

  console.log(failed === 0 ? "\nNothing here stops this release." : `\n${failed} thing${failed === 1 ? "" : "s"} to put right before this commit is released.`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
