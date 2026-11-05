import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCliArgs } from "./launcher.ts";
import {
  PRODUCTION_PRINT_LAUNCHER_FLAG,
  PRODUCTION_REEXEC_FLAG,
  awaitRegistrySuccessor,
  canReexecInPlace,
  compareReleaseVersions,
  createNpmRegistryReleaseAdapter,
  handoffToRegistrySuccessor,
  isGlobalInstall,
  keepUpdateHint,
  planRegistryUpdate,
  readLauncherStatus,
  reexecIntoRegistrySuccessor,
  resolveNpmInvocation,
  resolveRegistrySuccessor,
  reexecArgv,
  successorArgs,
  type RegistryReleaseAdapter,
  type RegistrySuccessor,
} from "./production-update.ts";

const execFileP = promisify(execFile);

const plan = { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" };
// A file that exists, standing in for the successor's launcher bundle.
const thisFile = fileURLToPath(import.meta.url);

test("release ordering follows numeric prerelease identifiers rather than lexical order", () => {
  const ascending = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0", "1.0.1"];
  for (let index = 1; index < ascending.length; index++) {
    assert.equal(compareReleaseVersions(ascending[index - 1]!, ascending[index]!), -1);
    assert.equal(compareReleaseVersions(ascending[index]!, ascending[index - 1]!), 1);
  }
  assert.equal(compareReleaseVersions("1.2.3+build.1", "1.2.3+build.2"), 0);
  assert.equal(compareReleaseVersions("1.0.0-01", "1.0.0"), null);
});

function fakeChild(pid: number | null = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null; unrefCalls: number; killCalls: number; unref(): void; kill(): boolean;
  };
  child.pid = pid ?? undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.unrefCalls = 0;
  child.killCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  child.kill = () => { child.killCalls++; return true; };
  return child;
}

/** A successor watch on a fake clock: `answers` is what the status route says on each poll, in order. */
function fakeWatch(answers: Array<{ version?: string } | undefined>) {
  let now = 0;
  const polls: number[] = [];
  return {
    polls,
    watch: {
      status: async () => { polls.push(now); return answers.length > 1 ? answers.shift() : answers[0]; },
      deadlineMs: 60_000,
      intervalMs: 250,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
    },
  };
}

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

// The 2026-09-10 failure, pinned at the seam that produced it: the successor was started with the
// project directory as a positional argument, which parseCliArgs has refused since the singleton
// launch — so every registry update started a successor that died on its first line, unseen.
test("the successor's argv is one parseCliArgs accepts: the re-exec flag, the port, and no repository path", () => {
  const args = successorArgs(4917);
  assert.deepEqual(args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  const parsed = parseCliArgs(args.filter((arg) => arg !== PRODUCTION_REEXEC_FLAG));
  assert.equal(parsed.port, 4917);
});

// The other half of that failure, seen from the SUCCESSOR: the launcher that starts it is the previous
// release, and every release from 0.7.0 to 0.12.10 still appends the project directory. A successor that
// refuses it is one no install in the field can update into (measured 2026-09-11: 0.12.10 -> 0.12.11
// printed "taking over", then ECONNREFUSED for good). The directory is dropped; the port survives.
test("a re-exec'd launcher drops the project directory an older launcher appends, and keeps its port", () => {
  const legacy = [PRODUCTION_REEXEC_FLAG, "--port", "4917", "/Users/someone/code/app"];
  assert.deepEqual(reexecArgv(legacy), ["--port", "4917"]);
  assert.equal(parseCliArgs(reexecArgv(legacy)).port, 4917);
  // A Windows launcher appends the directory with backslashes; the same pass drops it.
  assert.deepEqual(reexecArgv([PRODUCTION_REEXEC_FLAG, "--port", "4917", "C:\\Users\\someone\\repo"]), ["--port", "4917"]);
  // The current successor argv is unchanged by the same pass.
  assert.deepEqual(reexecArgv(successorArgs(4917)), ["--port", "4917"]);
  // Flags survive in place, and a directory before the flags is dropped too.
  assert.deepEqual(reexecArgv(["/repo", PRODUCTION_REEXEC_FLAG, "--no-app", "--port=4918"]), ["--no-app", "--port=4918"]);
});

test("resolving the successor installs it through npm exec and reads its launcher entry off stdout", async () => {
  let captured: Parameters<RegistryReleaseAdapter["npmExec"]>[0] | undefined;
  const successor = await resolveRegistrySuccessor(plan, { cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, {
    npmExec: async (request) => {
      captured = request;
      // npm may print its own lines first (a funding notice, a config warning); the entry is the last one.
      return { code: 0, signal: null, stdout: `npm warn Unknown project config "node-linker"\n${thisFile}\n`, stderr: "" };
    },
  });
  assert.equal(successor.entry, thisFile);
  assert.equal(successor.plan, plan);
  assert.equal(captured?.packageSpec, "frizz@1.3.0");
  // The invoked bin tracks the package name so a renamed release can't invoke a stale bin.
  assert.equal(captured?.bin, "frizz");
  assert.deepEqual(captured?.args, [PRODUCTION_PRINT_LAUNCHER_FLAG]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
});

test("a successor that npm cannot install or start fails the update BEFORE anything is drained, quoting stderr", async () => {
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 1, signal: null, stdout: "", stderr: "npm error 404 Not Found\nnpm error frizz@1.3.0 is not in this registry\n" }),
    }),
    /npm exec frizz@1\.3\.0 failed \(exit 1\): npm error 404 Not Found\nnpm error frizz@1\.3\.0 is not in this registry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "dist/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "/definitely/not/here/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
});

test("the in-place handoff execve's node onto the resolved entry with the lease and the release in the environment", () => {
  const successor: RegistrySuccessor = { plan, entry: thisFile };
  let captured: { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  assert.throws(() =>
    reexecIntoRegistrySuccessor(successor, { port: 4917, env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, (file, args, env) => {
      captured = { file, args, env };
      throw new Error("execve stand-in");
    }),
  /execve stand-in/);
  assert.equal(captured?.file, process.execPath);
  assert.deepEqual(captured?.args, [process.execPath, thisFile, PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_PACKAGE, "frizz");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
});

test("the detached fallback starts the resolved entry, not another npm exec, lets go of it, and hands it back", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnDetached"]>[0] | undefined;
  const returned = handoffToRegistrySuccessor(
    { plan, entry: thisFile },
    { port: 4917, cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnDetached: (request) => { captured = request; return child as never; } },
  );
  assert.equal(returned, child as never);
  assert.equal(captured?.entry, thisFile);
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});

// A spawn that fails outright has no pid synchronously and reports ENOENT a tick later. Before the
// audit of 2026-09-11 (finding 1) the caller had already printed "taking over" and exited by then.
test("a detached successor with no pid is refused on the spot, and its late error does not throw", () => {
  const child = fakeChild(null);
  assert.throws(
    () => handoffToRegistrySuccessor({ plan, entry: thisFile }, { port: 4917, cwd: "/repo", env: {} }, { spawnDetached: () => child as never }),
    /could not start Frizz 1\.3\.0 from /,
  );
  assert.equal(child.unrefCalls, 0);
  // The ENOENT arrives after the throw; an unhandled 'error' on a ChildProcess would take the old owner down.
  assert.doesNotThrow(() => child.emit("error", new Error("spawn ENOENT")));
});

test("the old owner waits until the detached successor answers with its version", async () => {
  const child = fakeChild();
  const { watch, polls } = fakeWatch([undefined, undefined, { version: "1.2.3" }, { version: "1.3.0" }]);
  await awaitRegistrySuccessor(child, { version: "1.3.0", port: 4917 }, watch);
  // Two silent polls, one answer from a stranger (the old version), then the successor.
  assert.deepEqual(polls, [0, 250, 500, 750]);
  assert.equal(child.killCalls, 0);
  assert.equal(child.listenerCount("exit"), 0, "the exit listener is removed once the wait settles");
});

test("a successor that never answers fails the handoff at the deadline, naming its log, and is killed first", async () => {
  const child = fakeChild();
  const { watch, polls } = fakeWatch([undefined]);
  await assert.rejects(
    () => awaitRegistrySuccessor(child, { version: "1.3.0", port: 4917, logFile: "/logs/frizz-run.log" }, watch),
    /Frizz 1\.3\.0 did not answer on port 4917 within 60s; its log is \/logs\/frizz-run\.log/,
  );
  assert.equal(polls.at(-1), 60_000);
  assert.equal(child.killCalls, 1, "a successor still starting must not bind the port under the restored board");
  assert.equal(child.listenerCount("exit"), 0);
});

test("a successor that exits before answering fails the handoff with its exit and its log", async () => {
  const child = fakeChild();
  const { watch } = fakeWatch([undefined]);
  const pending = awaitRegistrySuccessor(child, { version: "1.3.0", port: 4917, logFile: "/logs/frizz-run.log" }, watch);
  child.emit("exit", 1, null);
  await assert.rejects(pending, /Frizz 1\.3\.0 exited \(exit 1\) before it answered on port 4917; its log is \/logs\/frizz-run\.log/);
  assert.equal(child.killCalls, 0, "nothing to kill: it is already gone");
  // A child that was already dead when the wait began is reported the same way, without a poll.
  const dead = fakeChild();
  dead.exitCode = null;
  dead.signalCode = "SIGKILL";
  await assert.rejects(
    () => awaitRegistrySuccessor(dead, { version: "1.3.0", port: 4917 }, fakeWatch([{ version: "1.3.0" }]).watch),
    /exited \(signal SIGKILL\) before it answered on port 4917$/,
  );
});

test("the status read used by the wait yields the version, and undefined for anything that is not a launcher answering", async () => {
  // The route is same-origin gated and refuses a bare Node fetch with 403; the read must say who is
  // asking or it never sees a version (measured on Windows 2026-09-11).
  const answering = (async (_url: unknown, init?: RequestInit) => {
    const origin = new Headers(init?.headers).get("origin");
    if (origin !== "http://127.0.0.1:4917") return new Response("Forbidden", { status: 403 });
    return new Response(JSON.stringify({ protocol: 1, state: "starting", version: "1.3.0" }));
  }) as typeof fetch;
  assert.deepEqual(await readLauncherStatus(4917, answering), { version: "1.3.0", state: "starting" });
  const refused = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  assert.equal(await readLauncherStatus(4917, refused), undefined);
  const notOk = (async () => new Response("nope", { status: 503 })) as typeof fetch;
  assert.equal(await readLauncherStatus(4917, notOk), undefined);
  const noVersion = (async () => new Response(JSON.stringify({ protocol: 1, state: "ready" }))) as typeof fetch;
  assert.deepEqual(await readLauncherStatus(4917, noVersion), { state: "ready" });
});

// npm 12 answers `view <spec> version --json` with a one-element array; npm 11 answered the bare string.
test("npm view's answer reads the same from npm 11 and npm 12", async () => {
  const printing = (stdout: string) => () => ({ command: process.execPath, prefixArgs: ["-e", `console.log(${JSON.stringify(stdout)})`] });
  assert.equal(await createNpmRegistryReleaseAdapter({ npm: printing('"1.3.0"') }).latestVersion("frizz"), "1.3.0");
  assert.equal(await createNpmRegistryReleaseAdapter({ npm: printing('[\n  "1.3.0"\n]') }).latestVersion("frizz"), "1.3.0");
});

// A stalled registry held the probe for npm's own fetch timeout times its retries, and a source
// build of a native dependency held every tab behind the overlay for as long as it took (audit
// 2026-09-11, finding 6). The stand-in for npm is node itself, sleeping past the limit.
test("npm view and npm exec are bounded, and the failure names the timeout", async () => {
  const sleeper = () => ({ command: process.execPath, prefixArgs: ["-e", "setTimeout(() => {}, 30000)"] });
  const adapter = createNpmRegistryReleaseAdapter({ viewTimeoutMs: 300, execTimeoutMs: 300, npm: sleeper });
  await assert.rejects(() => adapter.latestVersion("frizz"), /could not check npm for frizz: npm view did not answer within 1s/);
  const result = await adapter.npmExec({ packageSpec: "frizz@1.3.0", bin: "frizz", args: [], cwd: process.cwd(), env: process.env });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /npm exec frizz@1\.3\.0 did not finish within 1s and was stopped/);
  // The whole failure the operator reads, through the same path a real install failure takes.
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: process.cwd(), env: process.env }, adapter),
    /npm exec frizz@1\.3\.0 failed \((signal SIGTERM|exit \d+)\): npm exec frizz@1\.3\.0 did not finish within 1s and was stopped/,
  );
});

// `npm view` names the newest release whatever a user's `min-release-age` says, so the exec of that
// exact version has to lift the window for itself or it fails `notarget` until the release ages.
test("npm exec of the planned release lifts a user's release-age window for that command only", async () => {
  const echo = () => ({ command: process.execPath, prefixArgs: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))"] });
  const result = await createNpmRegistryReleaseAdapter({ npm: echo }).npmExec({ packageSpec: "frizz@1.3.0", bin: "frizz", args: ["--version"], cwd: process.cwd(), env: process.env });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["exec", "--yes", "--min-release-age=0", "--package=frizz@1.3.0", "--", "frizz", "--version"]);
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

test("npm runs as node + npm-cli.js — the bare `npm` name is only a `.cmd` shim on Windows", () => {
  const node = join("/", "opt", "node", "bin", "node");
  const cli = join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const exists = (path: string) => path === cli;
  const rows: Array<{ name: string; env: NodeJS.ProcessEnv; execPath: string; exists: (path: string) => boolean; expected: ReturnType<typeof resolveNpmInvocation> }> = [
    { name: "npm_execpath names npm-cli.js", env: { npm_execpath: cli }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "an npx-cli.js hint resolves to the sibling npm-cli.js", env: { npm_execpath: join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npx-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a pnpm hint has no npm-cli.js beside it", env: { npm_execpath: join("/", "opt", "pnpm", "bin", "pnpm.cjs") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "no hint: the npm that ships with node (POSIX layout)", env: {}, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a stale hint that points nowhere is skipped", env: { npm_execpath: join("/", "gone", "npm-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
  ];
  const windowsNode = join("C:", "Program Files", "nodejs", "node.exe");
  const windowsCli = join("C:", "Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  rows.push({ name: "no hint: the npm beside node.exe (Windows layout)", env: {}, execPath: windowsNode, exists: (path) => path === windowsCli, expected: { command: windowsNode, prefixArgs: [windowsCli] } });
  for (const row of rows) assert.deepEqual(resolveNpmInvocation(row.env, row.execPath, row.exists, "linux"), row.expected, row.name);
  // No script at all: POSIX keeps the bare command, Windows refuses (the bare name is a dead spawn there).
  assert.deepEqual(resolveNpmInvocation({}, node, () => false, "linux"), { command: "npm", prefixArgs: [] });
  assert.throws(() => resolveNpmInvocation({}, windowsNode, () => false, "win32"), /npm-cli\.js not found beside/);
});

test("the resolved npm invocation actually starts on this platform", async () => {
  // Pins the spawn, not the registry: before this, Windows failed with `spawn npm ENOENT` because the
  // bare name only reaches a `.cmd` shim there. `--version` is the cheapest thing npm answers offline.
  const npm = resolveNpmInvocation();
  const { stdout } = await execFileP(npm.command, [...npm.prefixArgs, "--version"], { encoding: "utf8" });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/u);
});

// Node 24 on Windows exports process.execve and throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM when it is
// called, so the presence of the function chose the in-place branch there and every Windows update
// failed after tearing down the pane host and tunnel (measured 2026-09-11).
test("in-place re-exec is a platform decision, not a typeof check", () => {
  const fn = () => {};
  assert.equal(canReexecInPlace("win32", fn), false);
  assert.equal(canReexecInPlace("linux", fn), true);
  assert.equal(canReexecInPlace("darwin", fn), true);
  // `null`, not `undefined`: an explicit undefined would select the default (this process).
  assert.equal(canReexecInPlace("linux", null), false);
});
