#!/usr/bin/env node
// THE BROWSER E2E SUITE — `nub run test:e2e`. Boots a vite over `packages/web`, points every
// `*.e2e.test.ts` at it, runs them ONE AT A TIME, and tears the server back down.
//
// It exists because the suite had rotted in place with nothing on screen to say so. Each of these
// files gates itself on its OWN env var (`skip: !process.env.FRIZZ_<SOMETHING>_E2E_URL`), and NOTHING
// in the repo has ever set one — not `run-tests.mjs`, not CI. The files match the `packages/web/src/**
// /*.test.ts` glob, so they were IN the default run the whole time, reporting `skipped` and counting
// as green. Twenty-eight browser tests can go stale for months that way, and two of them had
// (2026-08-24). A skip nobody chose is a test nobody has.
//
// The env var is still per-file and still the gate. That is deliberate — it is what lets you run one
// file by hand against a vite you already have open, which is how these are actually debugged, and the
// header of each file documents its own variable. This script just sets all of them at once.
//
// ONE BROWSER AT A TIME, which is the other half of the reason this exists. Node's runner defaults to
// `os.availableParallelism() - 1` files in flight, so an unpinned run over this glob launches ~9 real
// Chromes at once. That is not a hypothetical: on 2026-08-19 two concurrent runs of a single file
// wedged the machine badly enough that `browser.close()` took 40s-2min to return, every test blew its
// timeout, and the suite read as uniformly broken when nothing was wrong with it. Each of these files
// owns a real browser and several are geometry assertions; they are I/O-bound on a shared GPU and a
// shared window server, not on cores. `--test-concurrency=1` costs wall-clock and buys a run whose
// failures mean something.
//
//   nub run test:e2e                     the whole browser suite
//   nub run test:e2e -- --url=http://…   against a vite you already have running
//   nub run test:e2e -- <file> <file>    just these, still serial, still against a fresh vite
//
// NOT EVERY e2e FILE IS HERE. `lib/projectSwitch.e2e.test.ts` needs a real multi-project Frizz rather
// than a plain vite over the fixtures — see its own header for the `adhoc-stack.mjs` invocation. It is
// excluded by name below rather than silently missing, so the exclusion is a decision you can find.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

// NOT EVERY e2e FILE BELONGS HERE. Several drive the REAL APP at `/` — a running Frizz with a
// board, a project and a seeded thread behind it — rather than a fixture page, and a plain vite serves
// them an app with no server to talk to. Each documents its own `adhoc-stack.mjs` invocation in its
// header; two also want a thread slug this script has no way to invent.
//
// Listed by name, and then CROSS-CHECKED against the structural tell below, because either half alone
// rots: a bare list silently stops matching when a file is renamed, and a bare heuristic silently
// reclassifies a file when someone adds an unrelated fixture URL to it. Disagreement is an error, not
// a guess — this script exists because a silently-not-run test is indistinguishable from a passing one.
const NEEDS_REAL_STACK = [
  "packages/web/src/components/consoleProjectChip.e2e.test.ts",
  "packages/web/src/components/registeredQuestionNavigation.e2e.test.ts",
  "packages/web/src/components/questionLetterStacking.e2e.test.ts",
  "packages/web/src/components/promptDraftTabs.e2e.test.ts",
  "packages/web/src/components/filePanelStack.e2e.test.ts",
  "packages/web/src/lib/projectSwitch.e2e.test.ts",
  "packages/web/src/lib/projectRail.e2e.test.ts",
  "packages/web/src/App.firstPaint.e2e.test.ts",
  "packages/web/src/components/overlayAccessibility.e2e.test.ts",
  "packages/web/src/components/ui/Menu.e2e.test.ts",
  "packages/web/src/components/fullscreenEscape.e2e.test.ts",
  "packages/web/src/components/fullscreenOpsInRail.e2e.test.ts",
  "packages/web/src/components/mobileThreadBack.e2e.test.ts",
  "packages/web/src/components/mobileUpdate.e2e.test.ts",
  "packages/web/src/components/threadSurfaceFileDrop.e2e.test.ts",
  "packages/web/src/components/pageFrame.e2e.test.ts",
  "packages/web/src/components/pinnedBandReorder.e2e.test.ts",
  "packages/web/src/components/consolePinnedBand.e2e.test.ts",
  "packages/web/src/components/queueOneAtATime.e2e.test.ts",
  "packages/web/src/components/homeSwitcher.e2e.test.ts",
  "packages/web/src/components/stackingOrder.e2e.test.ts",
  "packages/web/src/components/updatePopoverStacking.e2e.test.ts",
];

const args = process.argv.slice(2);
const urlFlag = args.find((a) => a.startsWith("--url="))?.slice("--url=".length);
const files = args.filter((a) => !a.startsWith("--"));

// Every e2e file, and the env var each one gates itself on. Read out of the SOURCE rather than kept in
// a list here: a list would drift the moment someone renames a variable, and the failure mode of that
// drift is a file that silently skips — the exact thing this script exists to end.
const GATE = /process\.env\.(FRIZZ_[A-Z0-9_]*_E2E_URL)/;
// The structural tell: a fixture-driven file names at least one `*-fixture.html`. One that names none
// is navigating to the app itself, which is what a plain vite cannot serve meaningfully.
const DRIVES_REAL_APP = (source) => !/-fixture\.html/.test(source);

function discover() {
  const all = fs
    .globSync("packages/web/src/**/*.e2e.test.ts", { cwd: root })
    .map((file) => file.split(path.sep).join("/"))
    .map((file) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      return { file, gate: GATE.exec(source)?.[1], realApp: DRIVES_REAL_APP(source) };
    });

  const declared = new Set(NEEDS_REAL_STACK);
  const disagree = all.filter((f) => f.realApp !== declared.has(f.file));
  if (disagree.length > 0) {
    console.error("✖ NEEDS_REAL_STACK in scripts/e2e-web.mjs no longer matches the files:");
    for (const f of disagree) {
      console.error(f.realApp
        ? `  ${f.file} drives the app at / but is not listed — it would run against a vite with no server behind it`
        : `  ${f.file} is listed but names a fixture page — it can run here, and is being skipped for nothing`);
    }
    process.exit(1);
  }

  const found = all.filter((f) => !f.realApp);
  const ungated = found.filter((f) => !f.gate);
  if (ungated.length > 0) {
    // A file with no recognizable gate would run with no server behind it and fail confusingly, or —
    // worse — pass because it asserts nothing. Name it and stop.
    console.error("✖ these e2e files declare no FRIZZ_*_E2E_URL gate, so this script cannot point them anywhere:");
    for (const f of ungated) console.error(`  ${f.file}`);
    process.exit(1);
  }
  return found;
}

const discovered = discover();
const selected = files.length > 0
  ? discovered.filter((f) => files.some((want) => f.file.endsWith(want) || want.endsWith(f.file)))
  : discovered;
if (selected.length === 0) {
  console.error(`✖ no e2e files matched ${files.join(" ")}`);
  process.exit(1);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    // Host-pinned to match what we hand the tests: a server listening only on ::1 is not reachable at
    // the 127.0.0.1 the URL would otherwise claim, which reads as every test failing to connect.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode} before it served anything`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite never answered on ${url}`);
}

let vite;
let url = urlFlag;
// THE WHOLE GROUP, NOT THE PID WE HOLD. `nubx vite` is a launcher: it forks the real `node vite.js` as
// its own child and waits on it, so the pid `spawn` returns is nubx's. A SIGKILL to that pid killed
// nubx alone and left vite serving with launchd as its parent — one orphaned vite per run, measured
// 2026-10-05 (pid 77213, ppid 1, still listening on the run's port after the suite had exited). So vite
// starts in its own process group (`detached`) and teardown signals the group. Windows has no groups to
// signal and does not run this suite; it keeps the plain kill.
const killVite = () => {
  if (!vite) return;
  try {
    if (process.platform === "win32") vite.kill("SIGKILL");
    else process.kill(-vite.pid, "SIGKILL");
  } catch {
    // the group is already gone
  }
};
if (!url) {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  vite = spawn("nubx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.join(root, "packages", "web"),
    stdio: ["ignore", "pipe", "pipe"],
    // No watcher, no HMR (see vite.config.ts): a concurrent agent editing the tree mid-run must not
    // reload a fixture page in the middle of a test.
    env: { ...process.env, FRIZZ_E2E_STATIC_VITE: "1" },
    detached: process.platform !== "win32",
  });
  const viteLog = [];
  vite.stdout.on("data", (d) => viteLog.push(String(d)));
  vite.stderr.on("data", (d) => viteLog.push(String(d)));
  try {
    await waitForServer(`${url}/index.html`, vite);
  } catch (err) {
    killVite();
    console.error(`✖ ${err.message}`);
    console.error(viteLog.join(""));
    process.exit(1);
  }
  console.error(`vite serving the fixtures on ${url}`);
}

// Every gate points at the one server. Setting them all rather than one per child is what lets the
// whole suite run in a single node process, which is where the completeness guard lives.
const env = { ...process.env };
for (const { gate } of discovered) env[gate] = url;

// Through run-tests.mjs rather than around it: that script reconciles what each child EMITTED against
// what the parent RECEIVED, and a browser suite is exactly where a truncated report pipe would go
// unnoticed. `--test-concurrency=1` is forwarded straight through to node's runner.
const runner = spawn(
  "node",
  [path.join(here, "run-tests.mjs"), "--test-concurrency=1", ...selected.map((f) => f.file)],
  { cwd: root, stdio: "inherit", env },
);

// Not gated on nubx's own exit code: the launcher can be gone while the vite it forked still serves.
const shutdown = killVite;
process.on("SIGINT", () => { shutdown(); process.exit(130); });
process.on("SIGTERM", () => { shutdown(); process.exit(143); });

runner.on("error", (err) => {
  shutdown();
  console.error(`could not start the test runner: ${err.message}`);
  process.exit(1);
});
runner.on("exit", (code, signal) => {
  shutdown();
  if (signal) {
    console.error(`the browser suite was terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
