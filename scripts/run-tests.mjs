#!/usr/bin/env node
// The project test suite — `nub run test`. Runs node's test runner exactly as before, then proves
// the run was COMPLETE before it lets the run be green.
//
// The problem it exists for: `--test-force-exit` makes each per-file child process.exit() the moment
// its tests finish, and that discards whatever is still queued on the async pipe carrying its
// verdicts to the parent. The parent counts only what arrived and still prints `fail 0` /
// `cancelled 0` and exits 0. Measured 2026-08-16: one run in four dropped the last 31 of
// delivery-ledger.test.ts's 70 tests, with nothing on screen to say so. Upstream: nodejs/node#64833.
//
// Dropping the flag is not the fix — packages/server/src/backend/claude-agent-broker.test.ts leaks a
// handle and hangs forever without it (measured: still running after 90s, `cancelled 1`). So the
// flag stays, scripts/test-guard-preload.mjs stops the truncation at its source, and this script
// reconciles what each child EMITTED against what the parent RECEIVED. Any shortfall is a hard
// failure with the offending files named.
//
//   nub run test                       the whole suite
//   nub run test packages/x/y.test.ts  just these files, same guard

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reconcile } from "./lib/test-guard-reconcile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

const GLOBS = [
  "board/*.test.mjs",
  "scripts/**/*.test.mjs",
  "src/**/*.test.ts",
  "packages/shared/src/**/*.test.ts",
  "packages/server/src/**/*.test.ts",
  "packages/registrar/src/**/*.test.ts",
  "packages/relay/src/**/*.test.ts",
  "packages/web/src/**/*.test.ts",
];

const forwarded = process.argv.slice(2);
const usingDefaults = !forwarded.some((arg) => !arg.startsWith("-"));
const targets = usingDefaults ? [...forwarded, ...GLOBS] : forwarded;

// node's runner ignores a glob that matches nothing and still exits 0, so a renamed directory would
// quietly drop a whole tree from a green run — the same "green does not prove it ran" defect this
// script exists for, arriving by a different route. Every configured glob must match something.
if (usingDefaults) {
  const empty = GLOBS.filter((glob) => fs.globSync(glob, { cwd: root }).length === 0);
  if (empty.length > 0) {
    console.error("✖ these test globs in scripts/run-tests.mjs match no files, so a whole tree would go unrun:");
    for (const glob of empty) console.error(`  ${glob}`);
    process.exit(1);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-test-guard-"));
const ledgerPath = path.join(scratch, "emitted.jsonl");
const receivedPath = path.join(scratch, "received.json");
fs.writeFileSync(ledgerPath, "");

const runner = spawn(
  "nub",
  [
    "--import",
    pathToFileURL(path.join(here, "test-guard-preload.mjs")).href,
    "--test",
    "--test-force-exit",
    // Pinned explicitly because naming any reporter drops node's defaults. `spec` is what node
    // already chose here, to a terminal and through a pipe alike, so the output is unchanged.
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${pathToFileURL(path.join(here, "test-guard-reporter.mjs")).href}`,
    `--test-reporter-destination=${receivedPath}`,
    ...targets,
  ],
  {
    cwd: root,
    stdio: "inherit",
    // A suite must never provision a runtime: that is half a gigabyte per pin into whatever HOME the
    // test sandboxed. Every server a test boots runs the machine's PATH `claude`/`codex` unless the
    // test names a stand-in, exactly as before 2026-09-04; runtimes.test.ts covers the provisioner
    // itself against a local registry. Set FRIZZ_RUNTIMES yourself to override.
    env: { FRIZZ_RUNTIMES: "path", ...process.env, FRIZZ_TEST_LEDGER: ledgerPath },
  },
);

runner.on("error", (err) => {
  console.error(`test runner failed to start: ${err.message}`);
  process.exit(1);
});

runner.on("exit", (code, signal) => {
  let problems;
  try {
    problems = checkRun(code === 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error("");
    console.error("✖ INCOMPLETE TEST RUN — results were lost, so this run proves nothing.");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("");
    console.error("  Each test file tallies the verdicts it emits and writes that tally");
    console.error("  synchronously at exit; the reporter counts what the parent received. A");
    console.error("  shortfall means --test-force-exit truncated a child's report pipe");
    console.error("  (nodejs/node#64833). Re-run; if it persists, see scripts/test-guard-preload.mjs.");
    process.exit(1);
  }

  if (signal) {
    console.error(`test runner terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

// Reads both tallies off disk and hands them to the shared checker.
function checkRun(runnerSaidGreen) {
  const problems = [];

  const emitted = [];
  for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      emitted.push({ ...entry, file: canonical(entry.file) });
    } catch {
      problems.push(`unreadable ledger line: ${line.slice(0, 120)}`);
    }
  }

  let received;
  try {
    const parsed = JSON.parse(fs.readFileSync(receivedPath, "utf8"));
    received = Object.entries(parsed.perFile).map(([file, count]) => [canonical(file), count]);
  } catch (err) {
    if (runnerSaidGreen) problems.push(`could not read the reporter's counts, so nothing about this run is verified: ${err.message}`);
    return problems;
  }

  return [...problems, ...reconcile({ emitted, received, runnerSaidGreen, describe: rel })];
}

// The child names its file as node resolved it while the reporter names it as the runner found it,
// and on macOS those spellings differ either side of a symlink (/tmp vs /private/tmp). Compare the
// resolved paths so the same file is never mistaken for two.
function canonical(file) {
  if (!file) return "<unknown file>";
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function rel(file) {
  return file === "<unknown file>" ? file : path.relative(root, file);
}
