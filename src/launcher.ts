import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireGlobalLaunchLock,
  pidIsAlive,
  resolveGitProjectIdentity,
  tryReservePort,
  type GitProjectIdentityScope,
} from "@frizz/server/project-identity";
import {
  defaultProcessPlatformAdapter,
  processGenerationIsStale,
  projectLaunchRecordHasGeneration,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
  type ProjectLaunchOwnerRecord,
  type ProjectLaunchTarget,
  type ProcessPlatformAdapter,
} from "@frizz/server/project-launch";
import {
  ALL_INTERFACES_BIND_HOST,
  bindHostIsExposed,
  LOOPBACK_BIND_HOST,
  machineHostNames,
  normalizeAllowedHosts,
  normalizeBindHost,
  normalizePublicOrigin,
} from "@frizz/server/local-origin";
import { BOOT_HARD_TIMEOUT_MS, BOOT_STALL_TIMEOUT_MS, readBootProgress } from "@frizz/server/boot-progress";
import { frizzPaths, launchHostDir, projectStateDir } from "@frizz/server/frizz-paths";
import { claimIdentityPath } from "./identity.ts";
import {
  discoverProjectRoot,
  ensureProjectIdFile,
  isNotAGitWorktree,
  writeProjectIdFile,
} from "@frizz/server/project-root";
import {
  classifyLaunch,
  LAUNCH_ROUTE_PATH,
  LAUNCH_ROUTE_PROTOCOL,
  LAUNCH_TOKEN_HEADER,
  parseLaunchRoute,
  type LaunchRoute,
} from "@frizz/server/launch-routing";
import { defaultLogRoot, latestLogPath } from "@frizz/server/logging";
import { DEFAULT_PORT, fallbackPort, FRIZZ_ROUTE_PREFIX } from "@frizz/shared";

export { acquireGlobalLaunchLock, pidIsAlive };

/**
 * Run project-local launch preparation before entering the machine-global port/start critical
 * section. Keeping this sequencing here makes it testable without starting a real supervisor.
 */
export async function prepareBeforeGlobalLaunchLock<T>(
  prepare: () => T | Promise<T>,
  acquire: () => Promise<() => void> = () => acquireGlobalLaunchLock()
): Promise<{ prepared: T; release: () => void }> {
  const prepared = await prepare();
  return { prepared, release: await acquire() };
}

export interface CliOptions {
  noApp: boolean;
  appMode: boolean;
  foreground: boolean;
  stop: boolean;
  status: boolean;
  help: boolean;
  /** Deliberately unsafe source/HMR control plane, never selected implicitly. */
  dev: boolean;
  /** Stream the full event feed to the terminal instead of the compact readout. */
  debug: boolean;
  port?: number;
  /** `--sandbox`: a disposable Frizz — throwaway home and project, own port, deleted on exit. */
  sandbox: boolean;
  /** `--link`: ask the ALREADY-RUNNING board for a fresh single-use access link, then exit. */
  link: boolean;
  /** `--sessions`: list the devices holding a session on the already-running board, then exit. */
  sessions: boolean;
  /** `--sign-out <id|all>`: revoke one device's session, or every one of them. */
  signOut?: string;

}

export interface Workspace {
  root: string;
  id: string;
  stateDir: string;
  name: string;
  identityScope: GitProjectIdentityScope;
}

export interface LauncherStatus {
  pid: number;
  port: number;
  processStart?: string;
  publisherToken?: string;
  ownerToken?: string;
  state?: string;
  message?: string;
  childPid?: number;
  projectId?: string;
  projectDir?: string;
  artifactDigest?: string;
}

export interface FrizzHealth {
  ok: true;
  projectId: string;
  projectDir: string;
  bootId: string;
  ownerProof?: string;
}

export interface ExpectedFrizzHealth {
  projectId: string;
  projectDir: string;
  ownerProof?: string;
  /**
   * Ask a SPECIFIC project's health on a shared server: `/_frizz/nub/health`.
   *
   * One Frizz serves N projects, so "is Frizz on this port" and "is Frizz serving MY project on this
   * port" stopped being the same question. Probing the slug answers the second one.
   *
   * Asking does NOT open the project. The server answers this route out of its registry for a project
   * it has not activated (`registeredTenantHealth`), because a launcher deciding whether to join must
   * not have to wait out a cold tenant activation — when it did, the probe timed out and the launcher
   * started a rival server instead. Activation stays where it belongs: on the first real request.
   */
  slug?: string;
}

export const PORT_SCAN_COUNT = 100;
export const LAUNCH_TIMEOUT_MS = BOOT_STALL_TIMEOUT_MS;
/**
 * Hard ceiling on a progress-tracked wait. Only reached by a boot that keeps reporting progress but
 * never becomes healthy — a pathological board, or a bug. Without it a wedged-but-chatty child would
 * hold the launcher forever.
 */
export const LAUNCH_HARD_TIMEOUT_MS = BOOT_HARD_TIMEOUT_MS;
/** A first immutable artifact build can legitimately outlast the ordinary server-ready timeout. */
export const FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS = 120_000;

/**
 * The argv the durable launcher re-execs itself with on Update & Restart.
 *
 * Update & Restart replaces this launcher in place with the newly promoted artifact, and it rebuilds
 * the command line from scratch — so anything not named here is SILENTLY LOST across an update. That
 * bit a live board: it was launched with `up`, an update re-execed it as a plain `--port` launch, and
 * the board came back with its origin gate disarmed and no tunnel. The public hostname answered
 * "Forbidden", then "Cloudflare error 1033" once cloudflared went too, and nothing in the readout said
 * why — the successor genuinely did not know it was ever meant to be public.
 *
 * How the board is reached travels in the saved setup (`cloud.json` in the data root), which the successor
 * reads for itself — so nothing about it needs to survive in argv any more.
 */
export function durableReexecArgs(options: { entry: string; port: number }): string[] {
  // No workspace argument: an internal launch reads its pinned project out of the environment
  // (`projectLaunchTargetFromEnvironment`), and never consults a path at all.
  return [
    options.entry,
    "--port",
    String(options.port),
  ];
}

/** Flags that decided how a board was reached. Retired 2026-08-25 for the R pane; see retiredFlagMessage. */
const RETIRED_NETWORK_FLAGS = ["--host", "--allowed-host", "--public-origin", "--cloud"];

function retiredFlagMessage(flag: string): string {
  return `${flag} was retired — how a board is reached is set up from the running board now: press R in its terminal to pick a private frizz.sh name, a Cloudflare Tunnel, Tailscale or a proxy of your own. The choice is remembered, so a plain launch serves it.`;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const args = new Set(argv);
  let rawPort: string | undefined;
  let rawSignOut: string | undefined;
  const consumed = new Set<number>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (consumed.has(index)) continue;
    // The network flags are gone: how a board is reached is set up from the running board (press R)
    // and remembered, so a saved command never has to carry it. Name the replacement rather than
    // failing as an unknown option — these lived in scripts and shell history.
    const retired = arg === "up" ? "up" : RETIRED_NETWORK_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (retired) throw new Error(retiredFlagMessage(retired));
    if (arg === "--port") {
      rawPort = argv[++index];
      if (rawPort === undefined || rawPort.startsWith("-"))
        throw new Error("--port requires a value");
      consumed.add(index);
      continue;
    }
    if (arg.startsWith("--port=")) {
      rawPort = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--sign-out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-"))
        throw new Error("--sign-out requires a device id, or `all` to sign out every device");
      index++;
      consumed.add(index);
      rawSignOut = value;
      continue;
    }
    if (arg.startsWith("--sign-out=")) {
      rawSignOut = arg.slice("--sign-out=".length);
      if (!rawSignOut) throw new Error("--sign-out requires a device id, or `all` to sign out every device");
      continue;
    }
    if (arg.startsWith("-")) continue;
    // ONE SERVER SERVES EVERY PROJECT, so "which repository" is not a question a launch has. The
    // positional was a leftover from one-server-per-repo and it kept the wrong mental model alive:
    // `frizz /some/repo` reads as "serve that repo", when the server it starts serves all of them.
    // Refuse rather than ignore — someone with this in a script deserves to be told where it went.
    throw new Error(
      `unexpected argument: ${arg} — Frizz takes no repository path, because one server serves every project on this machine. cd into the directory you want and run it with no arguments.`
    );
  }
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid --port value: ${rawPort}`);
  }
  const known = new Set([
    "--app",
    "--no-app",
    "--foreground",
    "--detach",
    "--stop",
    "--status",
    "--link",
    "--sandbox",
    "--sessions",
    "--sign-out",
    "--help",
    "-h",
    "--dev",
    "--prod",
    "--port",
    "--debug",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (consumed.has(index)) continue;
    if (arg === "--port") {
      index++;
      continue;
    }
    if (arg === "--sign-out") {
      index++;
      continue;
    }
    if (arg.startsWith("--port=") || arg.startsWith("--sign-out=")) continue;
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  if (args.has("--detach"))
    throw new Error("--detach is no longer available; frizz-dev always runs in the foreground");
  if (args.has("--app") && args.has("--no-app"))
    throw new Error("choose either --app or --no-app");
  // A sandbox is a FRESH board by definition, so the flags that query the running one have nothing
  // to ask. Refusing beats querying a board that cannot exist and reporting it missing.
  if (args.has("--sandbox")) {
    for (const query of ["--stop", "--status", "--link", "--sessions", "--sign-out"]) {
      if (args.has(query) || argv.some((arg) => arg.startsWith(`${query}=`)))
        throw new Error(`${query} asks the running board, and --sandbox starts a fresh disposable one — run ${query} without --sandbox`);
    }
  }
  return {
    noApp: args.has("--no-app"),
    appMode: args.has("--app"),
    // Retain the option in the parsed shape for callers, but normal frizz-dev is always attached.
    foreground: true,
    stop: args.has("--stop"),
    link: args.has("--link"),
    sandbox: args.has("--sandbox"),
    sessions: args.has("--sessions"),
    ...(rawSignOut !== undefined ? { signOut: rawSignOut } : {}),
    status: args.has("--status"),
    help: args.has("--help") || args.has("-h"),
    dev: args.has("--dev"),
    debug: args.has("--debug"),
    port,
  };
}

/**
 * The board address as it should READ in the terminal.
 *
 * A bare origin gets its trailing slash, because `http://127.0.0.1:9494` alone looks truncated. The
 * two cases that slash is wrong for are the ones a launch outside a project produces: the grid is
 * already `/` and would print `//`, and an `?add=<dir>` offer would grow a slash INSIDE the query,
 * changing the directory the page is being asked about.
 */
export function boardAddress(url: string): string {
  return url.includes("?") || url.endsWith("/") ? url : `${url}/`;
}

/** The XDG roots frizz-paths.ts honors, and therefore the ones a throwaway home must not inherit. */
export const SANDBOX_DROPPED_XDG_ROOTS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

/**
 * Everything a sandbox launch needs, made before anything reads the home directory: a throwaway HOME
 * (so the registry, the lock, the session key and the saved remote setup are all disposable copies), a
 * throwaway repository to be the project, and the cwd moved into it. The caller deletes the home on
 * exit; the state root, logs and the minted project id all live under it.
 */
export function prepareSandbox(env: NodeJS.ProcessEnv = process.env, realHome: string = homedir()): { home: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), "frizz-sandbox-"));
  // The operator's environment as it was, because one path below is still theirs to resolve: the
  // machine's claim identity lives wherever THEIR roots put it, XDG included.
  const inherited: NodeJS.ProcessEnv = { ...env };
  // POSIX homedir() reads $HOME and Windows reads USERPROFILE, both at call time — this is the whole lever.
  env.HOME = home;
  env.USERPROFILE = home;
  // A SET XDG variable outranks the home in frizz-paths.ts, by design: a developer who configured XDG
  // asked for it. Inherited into a sandbox it defeats the whole point — `registryPath(home)`,
  // `claimIdentityPath(home)`, `cloudConfigPath(home)` all resolve straight back into the operator's
  // real `$XDG_DATA_HOME/frizz`, and the cleanup on exit only removes the throwaway home (raised on
  // PR #43, 2026-09-23). A sandbox is a home that has never run Frizz, so it gets the platform defaults.
  for (const name of SANDBOX_DROPPED_XDG_ROOTS) delete env[name];
  // AFTER the scrub, so the sandbox end of every link is resolved the way the sandbox itself will
  // resolve it later. Sharing first and scrubbing second put the identity link at the XDG-resolved
  // path and then made the sandbox look under its own home: a link nothing read, and a throwaway key
  // minted on the first claim (second review on PR #43).
  shareCredentials(realHome, home, inherited, env);
  const project = join(home, "sandbox");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# frizz sandbox\n\nA throwaway project; everything here is deleted when the sandbox exits.\n");
  try {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  } catch {
    throw new Error("--sandbox mints a throwaway git repository and git is not available — install git, or play in a repo of your own with a temp HOME");
  }
  // Only a folder Frizz already knows opens its own board (resolveLaunchIntent); a fresh repository
  // lands on the dashboard. A sandbox is a board to try things in, so its project is made one here.
  writeProjectIdFile(project, randomUUID());
  process.chdir(project);
  return { home, project };
}

/**
 * What a sandbox SHARES with the real home: credentials, never state.
 *
 * The board reads credentials out of $HOME too — Frizz's own GitHub credential (for the GitHub cards
 * and watchers; a frizz.sh claim never reads it), cloudflared its cert and tunnel credentials, the agents
 * their sessions — and a sandbox with none of them would say "not signed in" on every screen. So those are linked in. The one that MATTERS is the claim identity key:
 * the registrar knows a name's holder by that key alone, so a name claimed with a throwaway key would
 * be "taken" against the real board for the length of a lease. Linking the real key makes a sandbox
 * claim the machine's claim, which the real board then renews as its own.
 *
 * cloudflared's files are linked one by one into a real directory, not as the directory itself: Frizz
 * writes frizz.yml there, and that write must land in the sandbox, not over the real one. Everything
 * here is best-effort — a missing file is simply not linked, and a platform that refuses symlinks gets
 * a sandbox without shared credentials rather than no sandbox.
 */
function shareCredentials(realHome: string, home: string, realEnv: NodeJS.ProcessEnv, sandboxEnv: NodeJS.ProcessEnv): void {
  const link = (from: string, to: string) => {
    try {
      symlinkSync(from, to);
    } catch {
      // Best-effort, see above.
    }
  };
  // The claim identity: through a link even before it exists, so a first claim from the sandbox mints
  // the REAL machine key rather than a throwaway one. Both ends are wherever identity.ts puts the key
  // for that home — never a literal `~/.frizz`, which this used to create on the real home and which
  // frizz-paths.ts reads as "legacy install, route everything here" (found by the Linux suite run of
  // 2026-08-28: one sandbox launch on a fresh machine moved every later launch off the XDG roots).
  // Each end under ITS environment: the real key sits under the operator's XDG roots if they set any,
  // the sandbox's under the throwaway home, since those roots are gone from the sandbox's env.
  const realKey = claimIdentityPath(realHome, realEnv);
  const sandboxKey = claimIdentityPath(home, sandboxEnv);
  mkdirSync(dirname(realKey), { recursive: true });
  mkdirSync(dirname(sandboxKey), { recursive: true });
  link(realKey, sandboxKey);
  // Frizz's own GitHub credential (github-credential.ts), for the GitHub cards and watchers — never the
  // operator's `gh` sign-in, which the server no longer reads. The DIRECTORY is linked, not the file:
  // an App token is renewed by writing a sibling and renaming it over the file, and a rename over a
  // linked file would land in the sandbox and leave the real board holding a spent refresh token.
  const realGithub = join(frizzPaths({ home: realHome, env: realEnv }).data, "github");
  if (existsSync(realGithub)) {
    const sandboxGithub = join(frizzPaths({ home, env: sandboxEnv }).data, "github");
    mkdirSync(dirname(sandboxGithub), { recursive: true });
    link(realGithub, sandboxGithub);
    // The credential is encrypted with a key in the real login keychain, which a sandbox HOME can't find
    // on its own. Named by path, so nothing ever looks for a keychain under the sandbox HOME.
    const keychain = join(realHome, "Library", "Keychains", "login.keychain-db");
    if (process.platform === "darwin" && existsSync(keychain)) sandboxEnv.FRIZZ_GITHUB_KEYCHAIN = keychain;
  }
  const cloudflared = join(realHome, ".cloudflared");
  if (existsSync(cloudflared)) {
    mkdirSync(join(home, ".cloudflared"), { recursive: true });
    for (const entry of readdirSync(cloudflared)) {
      if (entry === "cert.pem" || entry.endsWith(".json")) link(join(cloudflared, entry), join(home, ".cloudflared", entry));
    }
  }
  // The agent CLIs, so a sandbox can dispatch a real worker — the same sharing scripts/adhoc-stack.mjs
  // does with --creds.
  for (const entry of [".claude", ".claude.json", ".codex"]) {
    if (existsSync(join(realHome, entry))) link(join(realHome, entry), join(home, entry));
  }
  // macOS keeps the login keychain UNDER the home directory, and that is where gh and Claude keep their
  // tokens — so a redirected HOME hides every credential above even with the config dirs linked.
  // Measured: gh answers 401 through a linked ~/.config/gh alone, and the login through this link.
  // Only the keychain: ~/Library/Application Support/Frizz is state and must stay throwaway.
  if (process.platform === "darwin" && existsSync(join(realHome, "Library", "Keychains"))) {
    mkdirSync(join(home, "Library"), { recursive: true });
    link(join(realHome, "Library", "Keychains"), join(home, "Library", "Keychains"));
  }
}

/** Best-effort: a sandbox that fails to delete leaves only a temp dir the OS will reap. */
export function cleanupSandbox(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Shutdown path; the temp dir is the OS's problem now.
  }
}

export function helpText(command = "frizz-dev"): string {
  return `Frizz source launcher

Usage: ${command} [options]

Run it anywhere. One server serves EVERY project on this machine, each at its own
/project/<name> URL, so a second run joins the one already going. In a folder that is already a
project it opens that project's board; anywhere else it opens the dashboard, where projects are
added. Frizz serves a verified immutable artifact, selecting or safely building one on first
launch, then opens it in your default browser; source edits never restart the shared board.

Options:
  --no-app               print the URL without opening a browser
  --foreground           accepted for compatibility; ${command} always runs in the foreground
  --dev                  explicitly use the unsafe source watcher and Vite/HMR, not an artifact
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Frizz to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials (Frizz's
                         GitHub sign-in, cloudflared, Claude, Codex, the machine's frizz.sh
                         key) are shared
  --link                 print a fresh single-use access link for the already-running board
  --sessions             list the devices holding a session on the already-running board
  --sign-out <id|all>    revoke one device's session, or every one of them
  --debug                stream the full event feed to the terminal instead of the compact readout
  --status               report this workspace's stable server and artifact
  --stop                 stop this workspace's UI supervisor (agents keep running)
  -h, --help             show this help


Commands:
  build                  build a new immutable candidate from the configured Frizz source checkout
  promote <digest>       explicitly select a verified candidate for this workspace
  restart                restart the currently promoted artifact without building

To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a private frizz.sh name (no account needed), a Cloudflare
Tunnel, Tailscale, or a proxy of your own, and
remembers the choice, so a plain launch serves it from then on. The board stays on loopback and
shows a single-use sign-in link as a QR; press L for a fresh one, or run --link from another shell.

An immutable artifact is the default. --dev is the only explicit unsafe source watcher/HMR mode.
`;
}

/**
 * What a `frizz` in THIS directory should actually do.
 *
 * A FOLDER FRIZZ ALREADY KNOWS OPENS ITS BOARD. ANYTHING ELSE OPENS THE DASHBOARD. One server serves
 * every project on the machine, so the command starts Frizz; it does not pick a project, and it never
 * makes one. Projects are added on the dashboard (maintainer 2026-10-10: "If the folder that you run
 * it in is not a pre-existing Frizz project, it should just bring you to the root of the dashboard").
 *
 * It was the other way round twice. Running the command ADOPTED the directory until 2026-08-06, which
 * minted a project in $HOME, inside Frizz's own `~/.frizz` state root. Then a repository was adopted
 * on sight and everything else refused or offered (2026-08-11) — so a new user's first `npx frizz`,
 * typed in a fresh terminal or in `~/Documents`, ended in "cd into a repository and run frizz
 * there". Both came from the days of one server per project, when where the command ran had to mean
 * something.
 *
 *  - `open`  — a directory Frizz knows, from `.frizz/.id` or from the registry: its own board.
 *  - `offer` — a repository or a manifest root Frizz has not seen: the dashboard, asking whether to
 *               add it. Nothing is written until the operator says yes there.
 *  - `grid`  — every other directory: the dashboard, and nothing else. `~/Downloads` is a command
 *               in the wrong terminal. $HOME is never offered because the dashboard's own add
 *               refuses it (isHomeDirectory).
 *
 * The last two still need a project to LAUNCH with, because a server is a process that serves a
 * board. That host is a folder of Frizz's own (hostWorkspace), never one of the operator's projects.
 *
 * It was the most recently opened project until 2026-10-11, and that tied a running board to a
 * folder nobody had launched it from: `npx frizz` typed in $HOME was hosted on `~/Documents/scratch`,
 * the folder was deleted a day later, and the board could no longer update or restart — the server
 * refuses to boot without its host folder (maintainer: "Why can't we just start it from wherever
 * they run the fucking command?").
 */
export type LaunchIntent =
  | { kind: "open"; workspace: Workspace }
  | { kind: "offer"; workspace: Workspace; directory: string }
  | { kind: "grid"; workspace: Workspace }

export function resolveLaunchIntent(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): LaunchIntent {
  // The rule itself lives with the server (launch-routing.ts classifyLaunch), which answers it for a
  // launcher that asks. This is the copy a launcher falls back on, and the one frizz-dev still uses.
  const launch = classifyLaunch(cwd, home)
  if (launch.kind === "open") return { kind: "open", workspace: resolveWorkspace(cwd, home, env) }

  const host = hostWorkspace(home)
  return launch.kind === "offer"
    ? { kind: "offer", workspace: host, directory: launch.directory }
    : { kind: "grid", workspace: host }
}

/**
 * Ask the running server where a launch typed in `dir` lands (launch-routing.ts, app.ts).
 *
 * Undefined means "decide it here", and every reason for it is ordinary: a server that predates the
 * route answers 403 or 404, a server that is restarting answers 503 until it is back, and a launcher
 * must never hang on a question whose fallback is the rule it carried anyway. The 503 is waited out
 * briefly, because the public listener is published before the server behind it is ready.
 */
export async function askLaunchRoute(
  port: number,
  ownerToken: string,
  dir: string,
  options: { fetcher?: typeof fetch; args?: readonly string[]; patienceMs?: number; timeoutMs?: number } = {},
): Promise<LaunchRoute | undefined> {
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.patienceMs ?? 6_000)
  for (;;) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
    timeout.unref?.()
    try {
      const response = await fetcher(`http://127.0.0.1:${port}${FRIZZ_ROUTE_PREFIX}${LAUNCH_ROUTE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [LAUNCH_TOKEN_HEADER]: ownerToken },
        body: JSON.stringify({ protocol: LAUNCH_ROUTE_PROTOCOL, dir, ...(options.args?.length ? { args: options.args } : {}) }),
        signal: controller.signal,
      })
      if (response.status === 200) return parseLaunchRoute(await response.json())
      if (response.status !== 503 || Date.now() >= deadline) return undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
    }
    await delay(250)
  }
}

/**
 * The server's host for a launch outside a project: a folder of Frizz's own, never registered.
 *
 * The server builds a whole board around the project it is launched with — its state dir holds the
 * launch record and the `server.lock` every worker reads the port from — so "no project" is not a
 * state it has. This is the smallest thing that stands in: a real, empty project the registry never
 * hears about, so the dashboard lists only the operator's own projects, and on a new machine says
 * "Welcome to Frizz". Every project there is an ordinary tenant.
 */
export function hostWorkspace(home = homedir()): Workspace {
  const dir = launchHostDir(home)
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(dir)
  const id = ensureProjectIdFile(root, home)
  const stateDir = projectStateDir(id, home)
  mkdirSync(stateDir, { recursive: true })
  return { root, id, stateDir, name: basename(root), identityScope: "repository" }
}

/** Is this workspace that stand-in? Its folder must never be registered, named or offered as a project. */
export function isHostWorkspace(workspace: Pick<Workspace, "root">, home = homedir()): boolean {
  try {
    return workspace.root === realpathSync(launchHostDir(home))
  } catch {
    return false
  }
}

export function resolveWorkspace(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  // A repository still gets its root from Git — that is what makes `frizz` in a sub-directory open the
  // repo's board. Outside one (including a non-colocated jj checkout, which has no `.git` at all, and
  // a machine with no `git` installed) the root comes from marker walk-up instead of the launch dying.
  let gitRoot: string | undefined;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      // stderr is CAPTURED, not ignored: it is the only thing that distinguishes "no worktree here"
      // from "this repository is broken", and those two must not be handled the same way.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // A broken REAL repository still fails closed — inventing a namespace for it would strand its
    // board. Only "there is no worktree here" falls through to marker discovery.
    if (!isNotAGitWorktree(error)) throw new Error("unable to resolve Git repository root");
    gitRoot = undefined;
  }
  const root0 = realpathSync(gitRoot ?? discoverProjectRoot(cwd, home));
  const identity = gitRoot ? resolveGitProjectIdentity(root0, home) : undefined;
  const root = identity?.root ?? root0;
  // The id lives at `.frizz/.id`; a repository's existing `git config frizz.id` seeds it, so an
  // established board keeps its exact id and nothing is ever removed from the old store.
  const id = ensureProjectIdFile(root, home, identity?.id);
  const stateDir = projectStateDir(id, home);
  mkdirSync(stateDir, { recursive: true });
  const target = {
    projectId: id,
    projectDir: root,
    stateDir,
    ...(identity?.scope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
  return {
    root,
    id,
    stateDir,
    name: basename(root),
    identityScope: identity?.scope ?? "repository",
  };
}

export function workspaceLaunchTarget(
  workspace: Workspace
): ProjectLaunchTarget {
  return {
    projectId: workspace.id,
    projectDir: workspace.root,
    stateDir: workspace.stateDir,
    ...(workspace.identityScope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
}

export function workspaceFromLaunchTarget(
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  let root: string;
  try {
    root = realpathSync(target.projectDir);
  } catch {
    throw new Error("pinned Frizz workspace is no longer available");
  }
  if (root !== target.projectDir)
    throw new Error("pinned Frizz workspace path is not canonical");
  return {
    root,
    id: target.projectId,
    stateDir: target.stateDir,
    name: basename(root),
    identityScope:
      target.identityScope === "worktree" ? "worktree" : "repository",
  };
}

function parseStatusFile(
  path: string,
  authoritative?: ProjectLaunchOwnerRecord | null,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<LauncherStatus>;
    if (
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      !Number.isInteger(value.port) ||
      value.port! < 1 ||
      value.port! > 65_535
    )
      return null;
    if (authoritative) {
      const generation = { pid: value.pid!, processStart: value.processStart! };
      if (
        typeof value.processStart !== "string" ||
        value.ownerToken !== authoritative.token ||
        value.projectId !== authoritative.projectId ||
        value.projectDir !== authoritative.projectDir ||
        (expected &&
          (value.projectId !== expected.projectId ||
            value.projectDir !== expected.projectDir)) ||
        !projectLaunchRecordHasGeneration(authoritative, generation) ||
        processGenerationIsStale(generation, adapter)
      )
        return null;
    } else if (typeof value.processStart === "string") {
      if (
        processGenerationIsStale(
          { pid: value.pid!, processStart: value.processStart },
          adapter
        )
      )
        return null;
    } else if (!pidIsAlive(value.pid)) return null; // read-only compatibility with pre-owner status
    return value as LauncherStatus;
  } catch {
    return null;
  }
}

export function liveWorkspaceOwner(
  stateDir: string,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  const authoritative = readProjectLaunchOwner(stateDir);
  if (
    authoritative &&
    expected &&
    (authoritative.projectId !== expected.projectId ||
      authoritative.projectDir !== expected.projectDir)
  )
    return null;
  if (authoritative?.state === "draining") return null;
  if (authoritative && processGenerationIsStale(authoritative, adapter))
    return null;
  // The supervisor is the durable owner; server.lock belongs to its disposable child.
  return (
    parseStatusFile(
      join(stateDir, "dev-supervisor.lock"),
      authoritative,
      expected,
      adapter
    ) ??
    parseStatusFile(
      join(stateDir, "server.lock"),
      authoritative,
      expected,
      adapter
    )
  );
}

// A config validation failure deliberately leaves the prior healthy child serving while the durable
// watcher waits for a corrective edit. Health alone therefore cannot make `frizz-dev --status` green: the
// supervisor lock is the authoritative signal that the newest generation needs attention.
export function supervisorNeedsAttention(
  owner: LauncherStatus | null
): boolean {
  return owner?.state === "failed" || owner?.state === "degraded";
}

export function readPreferredPort(stateDir: string): number | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(stateDir, "launcher.json"), "utf8")
    ) as { port?: unknown };
    return Number.isInteger(value.port) &&
      (value.port as number) > 0 &&
      (value.port as number) <= 65535
      ? (value.port as number)
      : undefined;
  } catch {
    return undefined;
  }
}

export function persistLauncher(
  workspace: Workspace,
  port: number,
  sourceDir: string
): void {
  writeFileSync(
    join(workspace.stateDir, "launcher.json"),
    JSON.stringify(
      {
        projectId: workspace.id,
        projectDir: workspace.root,
        port,
        sourceDir: realpathSync(sourceDir),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

export const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * How long the JOIN probe waits, versus the second it takes to ask a server about itself.
 *
 * These are different questions and only one of them is cheap. "Is the server I started healthy yet"
 * is answered by a process with nothing else to do. "Is the Frizz already running on this machine
 * serving my project" is answered by a process that may be mid-prime for some other board, and its
 * event loop is genuinely busy for seconds at a time.
 *
 * Timing out the second question does not degrade — it starts a RIVAL SERVER, which is worse than any
 * wait: two Frizzes on one machine means two schedulers, and a board whose timers and recurring
 * prompts fire twice. A dead port fails instantly with ECONNREFUSED, so this patience is only ever
 * spent when something really is listening, which is exactly when we want to wait rather than race.
 */
export const JOIN_PROBE_TIMEOUT_MS = 15_000;

export async function probeFrizz(
  port: number,
  expected: ExpectedFrizzHealth,
  fetcher: typeof fetch = fetch,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS
): Promise<FrizzHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const scope = expected.slug ? `${FRIZZ_ROUTE_PREFIX}/${expected.slug}` : FRIZZ_ROUTE_PREFIX;
    const response = await fetcher(`http://127.0.0.1:${port}${scope}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const health = (await response.json()) as Partial<FrizzHealth>;
    if (
      health.ok !== true ||
      typeof health.projectId !== "string" ||
      typeof health.projectDir !== "string" ||
      typeof health.bootId !== "string"
    )
      return null;
    if (
      health.projectId !== expected.projectId ||
      health.projectDir !== expected.projectDir
    )
      return null;
    if (
      expected.ownerProof !== undefined &&
      health.ownerProof !== expected.ownerProof
    )
      return null;
    return health as FrizzHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The unscoped health of whatever Frizz answers on a port, with no expectation to match against:
 * the singleton names the project it was LAUNCHED from, which is what a client in another project
 * needs to learn before it can find that launch's owner record.
 */
export async function readFrizzHealth(port: number, fetcher: typeof fetch = fetch, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<FrizzHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}${FRIZZ_ROUTE_PREFIX}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const health = (await response.json()) as Partial<FrizzHealth>;
    if (health.ok !== true || typeof health.projectId !== "string" || typeof health.projectDir !== "string" || typeof health.bootId !== "string") return null;
    return health as FrizzHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface LaunchControlTarget {
  target: ProjectLaunchTarget;
  stateDir: string;
  /** False when the board serving this project was launched from ANOTHER project, named by `target`. */
  host: boolean;
}

/**
 * Which launch `--stop` and `--status` are about. ONE server serves every project, and it publishes
 * its owner record under the project it was launched from — so `frizz --stop` in project B, served
 * by a board launched in A, found no record in B and answered "not running" (pullfrog on #35,
 * 2026-09-11). When this project holds no record, the singleton's ports are asked who they are; a
 * board that names another project with a live record is the one to control, with that project's
 * token. A board that names nobody, or this project, leaves the answer as it was.
 */
export async function resolveLaunchControlTarget(options: {
  stateDir: string;
  target: ProjectLaunchTarget;
  fetcher?: typeof fetch;
  ports?: readonly number[];
  stateDirFor?: (projectId: string) => string;
}): Promise<LaunchControlTarget> {
  const own = { target: options.target, stateDir: options.stateDir, host: true };
  if (readProjectLaunchOwner(options.stateDir)) return own;
  const fetcher = options.fetcher ?? fetch;
  const stateDirFor = options.stateDirFor ?? ((projectId: string) => projectStateDir(projectId));
  for (const port of new Set(options.ports ?? [DEFAULT_PORT, fallbackPort(DEFAULT_PORT)])) {
    const health = await readFrizzHealth(port, fetcher);
    if (!health || health.projectId === options.target.projectId) continue;
    const stateDir = stateDirFor(health.projectId);
    if (!readProjectLaunchOwner(stateDir)) continue;
    return { target: { projectId: health.projectId, projectDir: health.projectDir, stateDir }, stateDir, host: false };
  }
  return own;
}

export async function requestFrizzStop(
  port: number,
  expected: ExpectedFrizzHealth,
  ownerToken: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!(await probeFrizz(port, expected, fetcher))) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}${FRIZZ_ROUTE_PREFIX}/control/stop`, {
      method: "POST",
      headers: { "x-frizz-launch-token": ownerToken },
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function expectedOwnerHealth(
  target: ProjectLaunchTarget,
  owner: ProjectLaunchOwnerRecord | null
): ExpectedFrizzHealth {
  return {
    projectId: target.projectId,
    projectDir: target.projectDir,
    ...(owner
      ? { ownerProof: projectLaunchTokenProof(target, owner.token) }
      : {}),
  };
}

/**
 * Probe on the SAME address the supervisor will bind. A port free on loopback can still be taken on
 * another interface, so probing 127.0.0.1 and then binding 0.0.0.0 hands the launcher a port that
 * fails at listen() time — after it has already reserved it machine-wide.
 */
export async function probeBindPort(
  port: number,
  host: string = LOOPBACK_BIND_HOST
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolveBind) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolveBind(error.code ?? "EADDRINUSE")
    );
    server.listen(port, host, () => server.close(() => resolveBind(undefined)));
  });
}

export async function canBindPort(
  port: number,
  host: string = LOOPBACK_BIND_HOST
): Promise<boolean> {
  return (await probeBindPort(port, host)) === undefined;
}

/**
 * The two bind failures need different advice, and a boolean cannot tell them apart.
 *
 * EADDRINUSE means something is LISTENING and the user can go find it. EACCES means an invisible
 * reservation — on Windows `netstat` shows the port free and bind() still fails, and SO_REUSEADDR
 * does not rescue you — so "already in use" sends people hunting a process that does not exist.
 */
export function portUnavailableMessage(port: number, code?: string): string {
  if (code === "EACCES" || code === "EPERM")
    return `port ${port} is reserved by the system, not held by a process (bind returned ${code}); on Windows list the reservations with: netsh int ipv4 show excludedportrange protocol=tcp`;
  return `port ${port} is already in use`;
}

export async function choosePort(
  explicit: number | undefined,
  preferred: number | undefined,
  available = canBindPort,
  base = DEFAULT_PORT
): Promise<number> {
  if (explicit !== undefined) {
    if (!(await available(explicit)))
      throw new Error(
        portUnavailableMessage(explicit, await probeBindPort(explicit))
      );
    return explicit;
  }
  for (const port of portCandidates(preferred, base)) {
    if (await available(port)) return port;
  }
  throw new Error(noFreePortMessage(base));
}

/**
 * The well-known port, then a JUMP, then a scan from where it landed.
 *
 * A `+1` scan does not work. Windows reservations come in contiguous 100-port blocks and the
 * reported unions contain unbroken runs of 2,400 ports, so scanning PORT_SCAN_COUNT candidates up
 * from the primary burns every one of them INSIDE THE SAME RESERVATION and then reports "no free
 * port" while tens of thousands are free. Jumping first puts the scan in a band the reservations do
 * not reach.
 *
 * Degrade, do not refuse: Vite and Jupyter both move to another port, Docker fails hard, and a local
 * tool that will not start because something unrelated holds a port is the worse of the two.
 *
 * THE WELL-KNOWN PORT COMES FIRST, ahead of the port this project last bound. A remembered port was
 * the right first choice when every project ran its own server — it kept that board's URL stable. One
 * server for the machine inverts it: the remembered port is a per-project answer to a machine-level
 * question, so whichever project you happened to launch from would decide the address, and every
 * pre-singleton `launcher.json` on this machine would keep dragging the singleton back to a port from
 * the era of many servers. It stays the SECOND candidate, so an old bookmark still resolves when the
 * well-known port is taken.
 */
function portCandidates(
  preferred: number | undefined,
  base = DEFAULT_PORT
): number[] {
  const fallback = fallbackPort(base);
  return [
    base,
    preferred,
    ...Array.from({ length: PORT_SCAN_COUNT }, (_, index) => fallback + index),
  ].filter((port): port is number => !!port && port <= 65535);
}

function noFreePortMessage(base = DEFAULT_PORT): string {
  const fallback = fallbackPort(base);
  return `no free Frizz port: ${base} is taken, and so is every port in ${fallback}-${
    fallback + PORT_SCAN_COUNT - 1
  }`;
}

export interface PortAllocation {
  port: number;
  /** Drops the machine-wide reservation. Idempotent. */
  release: () => void;
}

/**
 * Choose a port AND hold it machine-wide until the control plane is really listening on it.
 *
 * The reservation is taken BEFORE the bind probe, never after: the probe proves a port is free by
 * binding and CLOSING it, so two launchers scanning concurrently would otherwise both see the same
 * port free and both start on it. Reserving first makes the winner unambiguous — which is what lets a
 * caller release the machine-global launch lock as soon as allocation is done, instead of holding it
 * across the child's entire boot and serializing every other repository on this machine behind it.
 */
export async function allocatePort(
  explicit: number | undefined,
  preferred: number | undefined,
  options: {
    available?: (port: number) => Promise<boolean>;
    reserve?: (port: number) => (() => void) | undefined;
    /** Address the caller will actually bind; the probe has to match it. */
    host?: string;
    /** The well-known port to try first. `frizz-dev` has its own so it never fights the singleton. */
    base?: number;
  } = {}
): Promise<PortAllocation> {
  const host = options.host ?? LOOPBACK_BIND_HOST;
  const available = options.available ?? ((port: number) => canBindPort(port, host));
  const reserve = options.reserve ?? ((port: number) => tryReservePort(port));
  const claim = async (port: number): Promise<PortAllocation | undefined> => {
    const release = reserve(port);
    if (!release) return undefined;
    if (await available(port)) return { port, release };
    release();
    return undefined;
  };
  if (explicit !== undefined) {
    const allocated = await claim(explicit);
    if (!allocated)
      throw new Error(
        portUnavailableMessage(explicit, await probeBindPort(explicit, host))
      );
    return allocated;
  }
  for (const port of portCandidates(preferred, options.base)) {
    const allocated = await claim(port);
    if (allocated) return allocated;
  }
  throw new Error(noFreePortMessage(options.base));
}

export interface WaitForWorkspaceOptions {
  /**
   * The project state dir. When given, the wait tracks the control plane's published boot progress
   * (boot-progress.ts) and the flat `timeoutMs` becomes a STALL window rather than a total budget:
   * a boot that keeps reporting progress keeps its patience, up to `hardTimeoutMs`. Omit it to keep
   * the historical flat deadline exactly.
   */
  stateDir?: string;
  hardTimeoutMs?: number;
}

/**
 * Wait for the control plane on `port` to answer /_frizz/health as the expected owner.
 *
 * WHY THIS IS NOT A FLAT DEADLINE. A launcher spawns the control plane detached and cannot see inside
 * it, so a flat 30s budget silently conflates "something is wrong" with "this board is big and this
 * machine is busy" — and the maintainer's own board hit that every time, printing "Frizz did not become
 * healthy" while a perfectly healthy child kept booting behind it. Elapsed time is not evidence of
 * failure; a boot that has STOPPED MAKING PROGRESS is. So when the state dir is known, `timeoutMs` is
 * spent from the last observed progress step rather than from the start, and the failure message names
 * the phase the boot reached instead of only how long the launcher waited.
 */
export async function waitForWorkspace(
  port: number,
  expected: ExpectedFrizzHealth,
  timeoutMs = LAUNCH_TIMEOUT_MS,
  options: WaitForWorkspaceOptions = {}
): Promise<FrizzHealth> {
  const started = Date.now();
  const hardDeadline = started + (options.hardTimeoutMs ?? LAUNCH_HARD_TIMEOUT_MS);
  let stallDeadline = started + timeoutMs;
  let lastStep = -1;
  let lastPhase: string | undefined;
  for (;;) {
    const health = await probeFrizz(port, expected);
    if (health) return health;
    if (options.stateDir) {
      const progress = readBootProgress(options.stateDir);
      // Only a live publisher's ADVANCING counter buys patience. A leftover file from a dead boot has
      // no live pid; a stuck one stops advancing. Either way the stall window closes on schedule.
      if (progress && progress.step > lastStep && pidIsAlive(progress.pid)) {
        lastStep = progress.step;
        lastPhase = progress.phase;
        stallDeadline = Date.now() + timeoutMs;
      }
    }
    const now = Date.now();
    if (now >= stallDeadline || now >= hardDeadline) {
      const waited = Math.ceil((now - started) / 1000);
      throw new Error(
        lastPhase
          ? `Frizz did not become healthy on port ${port} after ${waited}s; its last reported boot step was "${lastPhase}" and it stopped making progress`
          : `Frizz did not become healthy on port ${port} within ${waited}s`
      );
    }
    await delay(150);
  }
}

export function sourceWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  // A durable artifact re-exec runs its deployed CLI from ~/.frizz/builds, not this checkout.
  // Preserve the original canonical checkout explicitly so Update & Restart continues to build
  // from the source the operator launched, rather than treating the artifact cache as source.
  return env.FRIZZ_SOURCE_DIR
    ? resolve(env.FRIZZ_SOURCE_DIR)
    : resolve(import.meta.dirname, "..");
}

export function sourceLabel(): string {
  return realpathSync(sourceWorkspaceDir());
}

/**
 * The tail of this workspace's most recent run log, for a failure message that can show what the
 * server was doing when it gave up.
 *
 * This used to read `<stateDir>/dev.log` — a file Frizz has never written since the detached
 * supervisor was removed — and had no callers, so the diagnostic it appeared to offer always came
 * back empty. It now reads the run log that `@frizz/server/logging` actually produces.
 */
export function logTail(stateDir: string, maxChars = 4000): string {
  try {
    const value = readFileSync(latestLogPath(defaultLogRoot(stateDir)), "utf8");
    return value.slice(-maxChars).trim();
  } catch {
    return "";
  }
}

export interface StopProjectLaunchOptions {
  stateDir: string;
  target: ProjectLaunchTarget;
  /** A port to try when no live status file names one — the dev launcher probes its preferred port. */
  fallbackPort?: () => Promise<number | undefined>;
  fetcher?: typeof fetch;
  adapter?: ProcessPlatformAdapter;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the owner record to disappear after the stop was accepted. */
  timeoutMs?: number;
}

/** `stale`: no board answered; a dead owner's record was reaped, which is not the same as stopping one. */
export type StopProjectLaunchResult = { kind: "not-running" } | { kind: "stopped"; stale: boolean };

/**
 * Stop the board that owns a project, the way the dev launcher's `--stop` has always done it
 * (src/index.ts stopWorkspace), extracted so the registry launcher can offer the same flag —
 * which it advertised in its own farewell for a release without handling it at all (audit
 * 2026-09-11, finding 2).
 *
 * The protocol, and why every step is what it is: the owner record names the pid and the token; a
 * live owner is asked to stop over HTTP with that token, which is the only cross-process proof a
 * launcher holds. A live owner that refuses is LEFT ALONE — never turn a process-generation
 * observation into a later `kill`, because the pid can be recycled in the gap. An owner that is
 * provably stale (dead, or a different process wearing its pid) is reaped through the same
 * delegate-fencing acquisition every launch uses, never by unlinking its record.
 */
export async function stopProjectLaunch(options: StopProjectLaunchOptions): Promise<StopProjectLaunchResult> {
  const { stateDir, target } = options;
  const adapter = options.adapter ?? defaultProcessPlatformAdapter;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const owner = readProjectLaunchOwner(stateDir);
  if (!owner) return { kind: "not-running" };
  const status = liveWorkspaceOwner(stateDir, target, adapter);
  const controlPort = status?.port ?? (status ? undefined : await options.fallbackPort?.());
  const controlled = controlPort
    ? await requestFrizzStop(controlPort, expectedOwnerHealth(target, owner), owner.token, fetcher)
    : false;
  if (!controlled && !processGenerationIsStale(owner, adapter)) {
    throw new Error(
      "Frizz refused to stop a live owner without authenticated token-bound control; the owner was left untouched"
    );
  }
  const reap = (): boolean => {
    if (!readProjectLaunchOwner(stateDir)) return true;
    // A process can exit after accepting the stop but before its finally block removes ownership.
    // Reap through the same delegate-fencing protocol; never unlink the record directly.
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", { delegateDrainTimeoutMs: 250, adapter });
    if (reaped.kind !== "acquired") return false;
    reaped.lease.release();
    return true;
  };
  const deadline = adapter.now() + (options.timeoutMs ?? 10_000);
  while (adapter.now() < deadline) {
    if (reap()) return { kind: "stopped", stale: !controlled };
    await sleep(100);
  }
  // The last poll can race a supervisor's finally block by a few milliseconds. One more
  // generation-safe observation before calling this a timeout.
  await sleep(100);
  if (reap()) return { kind: "stopped", stale: !controlled };
  throw new Error(`supervisor pid ${owner.pid} did not stop within ${Math.round((options.timeoutMs ?? 10_000) / 1000)}s`);
}

export interface RunningFrizzStatus {
  port: number;
  pid: number;
  version?: string;
  state?: string;
  message?: string;
}

/**
 * The board serving a project right now — its port, the supervisor's pid, and the version it
 * reports on its status route — or null when nothing live owns the project. Read-only, and the
 * answer behind the registry launcher's `--status`.
 */
export async function runningFrizzStatus(options: {
  stateDir: string;
  target: ProjectLaunchTarget;
  fetcher?: typeof fetch;
  adapter?: ProcessPlatformAdapter;
}): Promise<RunningFrizzStatus | null> {
  const fetcher = options.fetcher ?? fetch;
  const owner = liveWorkspaceOwner(options.stateDir, options.target, options.adapter ?? defaultProcessPlatformAdapter);
  if (!owner?.port) return null;
  const expected = expectedOwnerHealth(options.target, readProjectLaunchOwner(options.stateDir));
  if (!(await probeFrizz(owner.port, expected, fetcher))) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  let control: { version?: string; state?: string; message?: string } = {};
  try {
    // Same-origin gated, and Node's fetch carries no Origin: without this every read was a 403 and
    // `--status` printed "version: unknown" for a healthy board (measured on Windows 2026-09-11).
    const response = await fetcher(`http://127.0.0.1:${owner.port}${FRIZZ_ROUTE_PREFIX}/control/status`, {
      signal: controller.signal,
      headers: { origin: `http://127.0.0.1:${owner.port}`, "cache-control": "no-store" },
    });
    if (response.ok) {
      const body = (await response.json()) as { version?: unknown; state?: unknown; message?: unknown };
      control = {
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(typeof body.state === "string" ? { state: body.state } : {}),
        ...(typeof body.message === "string" ? { message: body.message } : {}),
      };
    }
  } catch {
    // The status route is the supervisor's; a legacy or mid-restart board answers health without it.
  } finally {
    clearTimeout(timeout);
  }
  return { port: owner.port, pid: owner.pid, ...control };
}
