import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared";

export const PRODUCTION_REEXEC_FLAG = "--_frizz-production-reexec";

/**
 * Whether this runtime can replace its own image with the successor. `typeof process.execve ===
 * "function"` is NOT that test: Node 24 on Windows exports the function and throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM when it is called, so the in-place branch was taken there,
 * the pane host and tunnel were torn down, and every update on Windows ended "durable supervisor
 * handoff failed: The feature process.execve is unavailable on the current platform" with the old
 * board restored (measured on Windows Server 2022, 2026-09-11). Windows takes the detached path.
 */
export function canReexecInPlace(
  platform: NodeJS.Platform = process.platform,
  execve: unknown = (process as { execve?: unknown }).execve
): boolean {
  return platform !== "win32" && typeof execve === "function";
}
/**
 * Print the absolute path of the launcher bundle that is running and exit 0. Internal: this is how
 * an OLDER launcher finds the entry of the release it resolved through npm, so it can execve into it
 * (keeping this pid and this terminal) instead of guessing where npm put the execution cache.
 */
export const PRODUCTION_PRINT_LAUNCHER_FLAG = "--_frizz-print-launcher";

export interface NpmInvocation {
  command: string;
  /** Arguments that go BEFORE the npm subcommand (the npm-cli.js script when node runs npm directly). */
  prefixArgs: string[];
}

/**
 * How to start npm from this process. `execFile("npm", …)` is not enough on Windows. There npm is only
 * a `npm.cmd` shim. A shell-less spawn cannot find the shim (`spawn npm ENOENT`), and Node refuses to
 * run a `.cmd` file without a shell. The reliable form is the one every shim ends in: this node binary
 * running `npm-cli.js`. Three places can hold that script, in this order:
 *
 *   1. beside `npm_execpath`, which npm sets for a bin it runs itself (`npx frizz`, `npm exec`);
 *   2. beside node.exe (the Windows installer layout);
 *   3. under `../lib/node_modules` (the POSIX installer layout).
 *
 * A global bin started from a shell has no `npm_execpath`, so it gets the npm that ships with node.
 * On POSIX the bare `npm` command is the fallback, which is the behaviour before this helper existed.
 * On Windows there is no working fallback: the bare name only reaches the shim, and a swallowed spawn
 * error would end the board with a success message. So Windows throws instead. (8r4x, #32.)
 */
export function resolveNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): NpmInvocation {
  const nodeDir = dirname(execPath);
  const candidates = [
    // pnpm, yarn and bun set `npm_execpath` too, to their own entry file. Their directories hold no
    // `npm-cli.js`, so the existence check below skips them.
    env.npm_execpath ? join(dirname(env.npm_execpath), "npm-cli.js") : undefined,
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const script = candidates.find((candidate) => exists(candidate));
  if (script) return { command: execPath, prefixArgs: [script] };
  if (platform === "win32") {
    throw new Error(`npm-cli.js not found beside ${execPath} (searched: ${candidates.join(", ")})`);
  }
  return { command: "npm", prefixArgs: [] };
}

export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
  /**
   * Run one command through `npm exec --package=<spec>` TO COMPLETION and hand back what it wrote.
   * The explicit package spec makes npm resolve and install the release into its own execution
   * cache first, so this is also the install step — and the one place an install failure can be read.
   */
  npmExec(request: {
    packageSpec: string;
    /** Bin to invoke from the resolved package. Defaults to the package name (frizz). */
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  /** Start a resolved successor entry as a detached process. The fallback where execve does not exist. */
  spawnDetached(request: { entry: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
}

export interface RegistryUpdatePlan {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  packageSpec: string;
}

/** A release npm has installed into an immutable execution cache, located by its own launcher bundle. */
export interface RegistrySuccessor {
  plan: RegistryUpdatePlan;
  /** Absolute path of the successor's launcher bundle (the file its `frizz` bin resolves to). */
  entry: string;
}

/**
 * Compare normal npm versions without bringing a runtime semver dependency into the launcher.
 * Unknown/non-semver versions deliberately never self-update: an operator can still run npx with
 * an explicit tag, but the browser button must fail closed rather than downgrade or guess.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split(".");
    if (prerelease?.some((part) => /^0\d+$/u.test(part))) return null;
    return { numeric: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < left.numeric.length; index++) {
    const delta = left.numeric[index]! - right.numeric[index]!;
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export async function planRegistryUpdate(
  packageName: string,
  currentVersion: string,
  adapter: Pick<RegistryReleaseAdapter, "latestVersion">
): Promise<RegistryUpdatePlan | null> {
  const latestVersion = (await adapter.latestVersion(packageName)).trim();
  const comparison = compareReleaseVersions(currentVersion, latestVersion);
  if (comparison === null)
    throw new Error(`cannot safely compare installed Frizz version ${currentVersion} with registry version ${latestVersion}`);
  if (comparison >= 0) return null;
  return { packageName, currentVersion, latestVersion, packageSpec: `${packageName}@${latestVersion}` };
}

/**
 * The argv a successor is started with, after its entry. NO repository path: an internal launch
 * reads its pinned project out of the environment (`projectLaunchTargetFromEnvironment`), and
 * `parseCliArgs` REFUSES a positional path since the singleton (bc037f17) — "Frizz takes no
 * repository path". The handoff kept passing one anyway, so from that day every registry Update &
 * Restart started a successor that died on its first line, exit 1, into `stdio: "ignore"`, after the
 * launcher had already printed "taking over" and quit. Measured 2026-09-10 22:35: the npm debug log
 * for `npm exec --package=frizz@0.12.10` ends `verbose exit 1` four seconds in, no Frizz log was ever
 * created, and the operator found a dead board with a note saying it had updated.
 */
export function successorArgs(port: number): string[] {
  return [PRODUCTION_REEXEC_FLAG, "--port", String(port)];
}

/**
 * The argv a re-exec'd launcher hands to parseCliArgs: its own raw argv with the re-exec flag removed,
 * and with the project directory an OLDER launcher still appends dropped rather than refused.
 *
 * The launcher that starts a successor is the PREVIOUS release, so the argv arriving here was chosen
 * by code that already shipped. Every registry launcher from 0.7.0 — bc037f17, the commit that made
 * parseCliArgs refuse a positional — through 0.12.10 hands its successor
 * `--_frizz-production-reexec --port <n> <projectDir>`, and by the time the successor reads it the old
 * launcher has drained its board and quit. A successor that refuses the path is therefore one no
 * install in the field can update INTO: measured 2026-09-11 against the published 0.12.10 updating to
 * 0.12.11 — "Frizz 0.12.11 is taking over on port 47110", ECONNREFUSED one second later, never back.
 * That is the failure users report as "the update button kills Frizz and I have to run npx again".
 *
 * The directory carries nothing the successor needs: a re-exec'd launch reads its pinned project out
 * of the environment (projectLaunchTargetFromEnvironment), which every one of those releases sets the
 * same way. So it is dropped here, never honoured — the refusal in parseCliArgs still guards a human's
 * `frizz /some/repo`. Flags and the value after `--port` pass through untouched.
 */
export function reexecArgv(rawArgs: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]!;
    if (arg === PRODUCTION_REEXEC_FLAG) continue;
    if (arg === "--port" || arg === "--sign-out") {
      kept.push(arg);
      if (index + 1 < rawArgs.length) kept.push(rawArgs[++index]!);
      continue;
    }
    if (arg.startsWith("-")) kept.push(arg);
  }
  return kept;
}

/**
 * Ask npm for a separate, immutable execution cache holding the planned release, and locate its
 * launcher bundle. This never edits the package directory npx is currently executing, which might be
 * shared or deleted by npm while the durable supervisor is still live.
 *
 * Runs BEFORE the running board is drained: everything that can go wrong with the install — a
 * registry that is down, a native module that fails to build, a bin that will not start — surfaces
 * here as a failed update with the board still up, instead of after the old owner has already exited.
 */
export async function resolveRegistrySuccessor(
  plan: RegistryUpdatePlan,
  request: { cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "npmExec">
): Promise<RegistrySuccessor> {
  const result = await adapter.npmExec({
    packageSpec: plan.packageSpec,
    // The published bin name tracks the package name (frizz). Never hardcode a stale bin here or
    // a renamed release would resolve the new package but invoke a bin that no longer exists.
    bin: plan.packageName,
    args: [PRODUCTION_PRINT_LAUNCHER_FLAG],
    cwd: request.cwd,
    env: request.env,
  });
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    const tail = result.stderr.trim().split("\n").slice(-6).join("\n").trim();
    throw new Error(`npm exec ${plan.packageSpec} failed (${how})${tail ? `: ${tail}` : ""}`);
  }
  // The last non-empty line: npm itself may print above it (a funding notice, a config warning).
  const entry = result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (!isAbsolute(entry) || !existsSync(entry))
    throw new Error(`${plan.packageSpec} did not report its launcher entry (got ${JSON.stringify(entry)})`);
  return { plan, entry };
}

/**
 * Replace this process with the successor: same pid, same terminal, same stdio, so ctrl-c still
 * stops the board and the readout keeps going. The environment must already carry the tokenized
 * project owner (`projectLaunchEnvironment`); the successor adopts that exact lease.
 */
export function reexecIntoRegistrySuccessor(
  successor: RegistrySuccessor,
  request: { port: number; env: NodeJS.ProcessEnv },
  execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => never = process.execve!.bind(process)
): never {
  return execve(process.execPath, [process.execPath, successor.entry, ...successorArgs(request.port)], {
    ...request.env,
    FRIZZ_REGISTRY_PACKAGE: successor.plan.packageName,
    FRIZZ_REGISTRY_VERSION: successor.plan.latestVersion,
  });
}

/**
 * Start the successor detached — the fallback for a runtime without `process.execve` (Windows).
 * This terminal is not handed to it: the launcher ends, and the board serves from a pid this
 * window can no longer signal. The caller has to say so — and has to WAIT for it first
 * (`awaitRegistrySuccessor`), which is why the child is handed back rather than dropped.
 *
 * A spawn that fails outright (the entry unreadable, node itself missing) has no pid synchronously
 * and reports ENOENT on the next tick. Before the audit of 2026-09-11 that tick never came: the
 * caller printed "taking over" and called `process.exit(0)` in the same turn, so the failure was
 * swallowed and the board was dead with a note saying it had updated. Refusing here, synchronously,
 * keeps the old owner alive to report it.
 */
export function handoffToRegistrySuccessor(
  successor: RegistrySuccessor,
  request: { port: number; cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "spawnDetached">
): ChildProcess {
  const child = adapter.spawnDetached({
    entry: successor.entry,
    args: successorArgs(request.port),
    cwd: request.cwd,
    env: {
      ...request.env,
      FRIZZ_REGISTRY_PACKAGE: successor.plan.packageName,
      FRIZZ_REGISTRY_VERSION: successor.plan.latestVersion,
    },
  });
  // The error still arrives on the next tick; without a listener it would throw and take this
  // process down before the caller could restore the board.
  child.once("error", () => {});
  if (child.pid === undefined) throw new Error(`could not start Frizz ${successor.plan.latestVersion} from ${successor.entry}`);
  child.unref();
  return child;
}

/** How long a detached successor gets to answer its status route before the handoff is judged failed. */
export const SUCCESSOR_READY_TIMEOUT_MS = 60_000;

/** The slice of a ChildProcess the wait needs; structural so a test can stand one in. */
export interface SuccessorProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean;
}

export interface SuccessorWatch {
  /** The successor's `/_frizz/control/status` answer, or undefined while nothing (or something else) answers. */
  status: () => Promise<{ version?: string } | undefined>;
  deadlineMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Hold the old owner alive until the detached successor is OBSERVED serving the port, so a
 * successor that never comes up is a failed update with the old board restored, not a dead board
 * with a farewell above it (audit 2026-09-11, finding 1).
 *
 * "Up" means the status route answers with the successor's version. Only the successor can say that
 * version: the old proxy closed before the spawn, so anything else on the port is a stranger. The
 * successor's proxy listens before its first child boots, so this settles in the seconds the bundle
 * takes to load, not the time the board takes to become ready — a child that fails AFTER that is
 * the new version's failure, reported through its own status file.
 *
 * Two ways to lose. The child EXITS early (its Node floor, a lease it could not adopt, a port taken
 * in the gap): its stdio is ignored, so the only trace is its run log, and the error names it. Or
 * the deadline passes with no answer: the child is then killed before the caller restores the old
 * proxy on the same port, so a slow successor cannot bind it a second later under the restored board.
 */
export async function awaitRegistrySuccessor(
  child: SuccessorProcess,
  expected: { version: string; port: number; logFile?: string },
  watch: SuccessorWatch
): Promise<void> {
  const deadlineMs = watch.deadlineMs ?? SUCCESSOR_READY_TIMEOUT_MS;
  const intervalMs = watch.intervalMs ?? 250;
  const now = watch.now ?? Date.now;
  const sleep = watch.sleep ?? ((ms: number) => delay(ms));
  const where = expected.logFile ? `; its log is ${expected.logFile}` : "";
  let exited: string | undefined = child.exitCode !== null || child.signalCode !== null
    ? describeExit(child.exitCode, child.signalCode)
    : undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => { exited = describeExit(code, signal); };
  child.once("exit", onExit);
  try {
    const started = now();
    for (;;) {
      if (exited) throw new Error(`Frizz ${expected.version} exited (${exited}) before it answered on port ${expected.port}${where}`);
      const status = await watch.status();
      if (status?.version === expected.version) return;
      if (now() - started >= deadlineMs) {
        // Best effort: a successor still starting after the deadline must not bind the port under
        // the board the caller is about to restore.
        try { child.kill(); } catch { /* already gone */ }
        throw new Error(
          `Frizz ${expected.version} did not answer on port ${expected.port} within ${Math.round(deadlineMs / 1000)}s${where}`
        );
      }
      await sleep(intervalMs);
    }
  } finally {
    child.off("exit", onExit);
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
}

/** One read of a launcher's status route, for the successor watch: undefined when nothing answers. */
/** The headers a launcher-side read of the supervisor's control routes needs to be answered at all. */
export function launcherControlHeaders(port: number): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, "cache-control": "no-store" };
}

export async function readLauncherStatus(
  port: number,
  fetcher: typeof fetch = fetch
): Promise<{ version?: string; state?: string } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  timeout.unref?.();
  try {
    // The status route is same-origin gated: a request carrying neither Origin nor fetch metadata is
    // refused, and Node's fetch sends neither, so every read answered 403 and the successor wait ran
    // to its deadline on Windows (measured 2026-09-11). Say who is asking, the way a tab would.
    const response = await fetcher(`http://127.0.0.1:${port}${FRIZZ_ROUTE_PREFIX}/control/status`, {
      signal: controller.signal,
      headers: launcherControlHeaders(port),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown; state?: unknown };
    return {
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.state === "string" ? { state: body.state } : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Whether this bundle runs from a GLOBAL install (`npm i -g frizz`), the one shape a self-update
 * does not persist: the release goes into npm's `_npx` execution cache, the global bin still points
 * at the old package, and the next `frizz` from a shell is the old version again with nothing said
 * (audit 2026-09-11, finding 9). `npx frizz` re-resolves `latest` on every run, so it self-heals.
 *
 * Deliberately a cheap heuristic and never fatal: npm sets `npm_execpath` for every bin it runs
 * itself (`npx`, `npm exec`; pnpm, yarn and bun set it to their own entry), so its ABSENCE says a
 * shell started this bin directly — and a path through `node_modules` that is not npm's `_npx`
 * cache is where a global bin's real file lives on every layout (nvm, Homebrew, the Windows
 * installer). The one false positive, `node <project>/node_modules/frizz/dist/frizz.js` by hand,
 * gets a hint it does not need.
 */
export function isGlobalInstall(bundleDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.npm_execpath) return false;
  const segments = bundleDir.split(/[\\/]/u);
  return segments.includes("node_modules") && !segments.includes("_npx");
}

/** The environment flag that carries `isGlobalInstall` to a successor, whose own path is always the `_npx` cache. */
export const GLOBAL_INSTALL_ENV = "FRIZZ_REGISTRY_GLOBAL_INSTALL";

/** The tail of a ready notice for a global install: the update lives in this process only. */
export function keepUpdateHint(packageName: string, version: string): string {
  return `this session only — run npm i -g ${packageName}@${version} to keep it`;
}

/**
 * How long the registry probe (`npm view`) and the install (`npm exec`) may run. Neither had a limit
 * before the audit of 2026-09-11 (finding 6): a registry that accepts the connection and stalls held
 * the probe for npm's own fetch timeout times its retries, and the install — which can compile a
 * native dependency from source when no prebuilt matches — held every open tab behind the restart overlay for
 * as long as it took. Thirty seconds answers "is there a newer version" on any working network; ten
 * minutes covers a source build of a native dependency on a slow box and no more.
 */
export const NPM_VIEW_TIMEOUT_MS = 30_000;
export const NPM_EXEC_TIMEOUT_MS = 10 * 60_000;
const NPM_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";

function formatTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.ceil(ms / 1000)}s`;
}

export interface NpmAdapterOptions {
  viewTimeoutMs?: number;
  execTimeoutMs?: number;
  /** How npm is started; injectable so a test can stand in a command that never finishes. */
  npm?: () => NpmInvocation;
}

export function createNpmRegistryReleaseAdapter(options: NpmAdapterOptions = {}): RegistryReleaseAdapter {
  const viewTimeoutMs = options.viewTimeoutMs ?? NPM_VIEW_TIMEOUT_MS;
  const execTimeoutMs = options.execTimeoutMs ?? NPM_EXEC_TIMEOUT_MS;
  const npmInvocation = options.npm ?? (() => resolveNpmInvocation());
  return {
    latestVersion(packageName) {
      return new Promise((resolveVersion, reject) => {
        let npm: NpmInvocation;
        try { npm = npmInvocation(); } catch (error) { return reject(error); }
        execFile(
          npm.command,
          [...npm.prefixArgs, "view", `${packageName}@latest`, "version", "--json"],
          { encoding: "utf8", windowsHide: true, timeout: viewTimeoutMs, killSignal: NPM_KILL_SIGNAL },
          (error, stdout) => {
            if (error) {
              // execFile reports its own kill as `killed` with the signal it sent; say what that was.
              const why = error.killed && error.signal === NPM_KILL_SIGNAL
                ? `npm view did not answer within ${formatTimeout(viewTimeoutMs)}`
                : error.message;
              return reject(new Error(`could not check npm for ${packageName}: ${why}`));
            }
            try {
              // npm 12 answers a one-element array where npm 11 answered the bare string (see the
              // server installer's latestVersion). String() of that array happened to read right;
              // unwrap it on purpose instead.
              const answer = JSON.parse(stdout) as unknown;
              const parsed = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer;
              resolveVersion(typeof parsed === "string" ? parsed : String(parsed));
            } catch {
              resolveVersion(stdout.trim().replaceAll('"', ""));
            }
          },
        );
      });
    },
    npmExec({ packageSpec, bin, args, cwd, env }) {
      return new Promise((settle) => {
        let npm: NpmInvocation;
        try { npm = npmInvocation(); } catch (error) {
          return settle({ code: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
        }
        // The explicit package spec forces npm to resolve/install a new cache entry before running it.
        // Runs to completion with its output captured, so on Windows the console window `cmd.exe` would
        // open for the bin shim is hidden and nothing of it is left behind.
        //
        // `--min-release-age=0`: the version came from `npm view`, which ignores a user's
        // `min-release-age` window, so under one the exact release just published fails `notarget`
        // and every update in the window would too. `npm exec` ignores `min-release-age-exclude`, so the
        // user cannot exempt Frizz from their own .npmrc; a flag on this one command is the only way.
        // npm does not export the setting to the child, so the successor's own npm calls keep the window.
        const started = Date.now();
        const child = spawn(npm.command, [...npm.prefixArgs, "exec", "--yes", "--min-release-age=0", `--package=${packageSpec}`, "--", bin, ...args], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: execTimeoutMs,
          killSignal: NPM_KILL_SIGNAL,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", (error) => settle({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
        child.once("close", (code, signal) => {
          // spawn's timeout kills silently; the stderr tail is what the failed update quotes, so the
          // reason has to be written there or the operator reads a bare "signal SIGTERM".
          const timedOut = signal === NPM_KILL_SIGNAL && Date.now() - started >= execTimeoutMs;
          settle({
            code,
            signal,
            stdout,
            stderr: timedOut ? `${stderr}\nnpm exec ${packageSpec} did not finish within ${formatTimeout(execTimeoutMs)} and was stopped` : stderr,
          });
        });
      });
    },
    spawnDetached({ entry, args, cwd, env }) {
      // `detached` gives the successor no console of its own, and `windowsHide` keeps the children it
      // starts from opening one. Measured on Windows Server 2022 (8r4x, #32): without `windowsHide` a
      // forked child of a console-less parent gets a visible console window, and closing that window
      // sends CTRL_CLOSE_EVENT, which Node maps to SIGHUP — the board stops. With it, nothing opens.
      return spawn(process.execPath, [entry, ...args], { cwd, env, detached: true, stdio: "ignore", windowsHide: true });
    },
  };
}

export const npmRegistryReleaseAdapter: RegistryReleaseAdapter = createNpmRegistryReleaseAdapter();
