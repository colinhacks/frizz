#!/usr/bin/env node
import { bindHostIsExposed } from "@frizz/server/local-origin";
// The registry launcher is intentionally separate from index.ts. `frizz-dev` follows mutable
// checkout source; `frizz` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { adoptSessionState, liveSessions, loadSessionState, remoteDevicesLine, sessionEpochLogLine, sessionEpochNotice } from "@frizz/server/access-codes";
import { qrAreaOf, renderQrLines } from "@frizz/server/qr";
import { listSessions, signOutSession } from "./sessions-cli.ts";
import { SUPERVISOR_ACCESS_CODE_PATH } from "@frizz/server/restart-supervisor";
import { createAccessPane, type AccessPane } from "./access-pane.ts";
import { installPaneHost, type PaneHost } from "./pane-host.ts";
import { createRemoteController, type RemoteController } from "./remote-controller.ts";
import { frizzGithubLogin, frizzGithubSignIn } from "./github-claim-identity.ts";
import { probeCloudflared, probeTailscale } from "./remote-detect.ts";
import { createRemotePane, remoteReachedLine } from "./remote-pane.ts";
import { LOOPBACK_BIND_HOST } from "@frizz/server/local-origin";
import {
  establishCloudConfig,
} from "./cloud.ts";
import { noticeOnlyReadout, Readout, renderSupervisorActivity, tildePath } from "./readout.ts";
import {
  appendCrashRecord,
  attachTerminalMirror,
  createLogger,
  logEnvironment,
  runLogPath,
  setAmbientLogger,
  type Logger,
} from "@frizz/server/logging";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  cleanupSandbox,
  parseCliArgs,
  prepareSandbox,
  askLaunchRoute,
  hostWorkspace,
  probeFrizz,
  readFrizzHealth,
  readPreferredPort,
  resolveLaunchIntent,
  resolveLaunchControlTarget,
  runningFrizzStatus,
  stopProjectLaunch,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type LaunchIntent,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
} from "@frizz/server/project-launch";
import { createSupervisorShutdownHandler, startDevSupervisor } from "@frizz/server/dev-supervisor";
import { planRegistryUpdate, PRODUCTION_PRINT_LAUNCHER_FLAG, PRODUCTION_REEXEC_FLAG, reexecArgv } from "./production-update.ts";
import { describeGenerationSweep, npmServerPackageInstaller, serverGenerationLaunch, serverReleaseMinimum, serverReleaseSpec, ServerReleaseStore, type ServerGeneration } from "./server-release.ts";
import { acquireStableServerOwner, publishStableServerAddress, readStableServerOwner, releaseStableServerOwner, type ServerOwnerLease } from "./server-owner.ts";
import { offerPath, type LaunchRoute } from "@frizz/server/launch-routing";
import { GLOBAL_INSTALL_ENV, isGlobalInstall, keepUpdateHint } from "./production-update.ts";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
} from "./preflight.ts";
import { DEFAULT_PORT, fallbackPort } from "@frizz/shared";
import { registerProject } from "@frizz/server/project-registry";
import { resolveProjectLabel } from "@frizz/server/project-identity";

const PACKAGE_NAME = process.env.FRIZZ_REGISTRY_PACKAGE ?? "frizz";

/**
 * The version THIS bundle actually is, read from the package.json it ships inside.
 *
 * It used to be `process.env.npm_package_version ?? "0.0.1"`, and npm sets that variable only for
 * lifecycle scripts — NOT when a bin runs through the npx shim, which is how every real user starts
 * Frizz. So the launcher reported itself as `0.0.1` forever. Measured end-to-end against the published
 * package: a genuine 0.1.1 install served `artifactDigest: "npm:frizz@0.0.1"`, and still served
 * `0.0.1` after updating itself to 0.1.2.
 *
 * This is now the stable launcher's diagnostic version, not the separately selected server version
 * used for update comparisons. Read the manifest beside this bundle, never npm's invocation env.
 */
function resolvePackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {
    // Fall through — a launcher that cannot read its own manifest must still boot.
  }
  return process.env.npm_package_version ?? "0.0.1";
}

const PACKAGE_VERSION = resolvePackageVersion();
const rawArgs = process.argv.slice(2);
const reexec = rawArgs.includes(PRODUCTION_REEXEC_FLAG);
// Answered before anything else is touched: an OLDER launcher runs this through `npm exec` to learn
// where npm installed this release, then execve's into it. Nothing here may need a project, a lock,
// a Node floor or a terminal — the whole exchange is one path on stdout.
if (rawArgs.includes(PRODUCTION_PRINT_LAUNCHER_FLAG)) {
  console.log(fileURLToPath(import.meta.url));
  process.exit(0);
}
// A re-exec'd launch was started by the PREVIOUS release, whose argv may carry a project directory this
// release refuses (0.7.0–0.12.10 all append one); see reexecArgv. A human's argv is parsed as written.
const args = reexec ? reexecArgv(rawArgs) : rawArgs;
const fail = (error: unknown): never => {
  console.error(`frizz: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
};

const options: CliOptions = (() => {
  try { return parseCliArgs(args); } catch (error) { return fail(error); }
})();
if (options.help) {
  console.log(
    `Frizz production launcher

Usage: npx ${PACKAGE_NAME} [options]

Run it anywhere. One server serves EVERY project on this machine, each at its own
/project/<name> URL, so a second run joins the one already going. In a folder that is already a
project it opens that project's board; anywhere else it opens the dashboard, where projects are
added. Runs the npm-resolved immutable Frizz package, then opens it in your default browser. Use
frizz-dev only for a source checkout.

Options:
  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Frizz to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials (Frizz's
                         GitHub sign-in, cloudflared, Claude, Codex, the machine's frizz.sh
                         key) are shared
  --link                 print a fresh single-use access link for the running board
  --sessions             list the devices signed in to the running board
  --sign-out <id|all>    sign one device out, or every one of them
  --status               report the board running for this project: address, pid, version
  --stop                 stop the board running for this project (running agents keep going)
  --debug                stream the full event feed to the terminal instead of the compact readout
  -h, --help             show this help


To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a frizz.sh subdomain (no account needed), a Cloudflare Tunnel,
Tailscale, or a proxy of your own, and remembers the choice, so a plain launch serves it from then
on. The board stays on loopback, and a phone signs in with a single-use link: press L for one
as a QR, or run --link from another shell.`,
  );
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

// Before ANYTHING reads the home directory: the sandbox swaps $HOME for a throwaway, so every piece
// of state after this line — registry, lock, logs, session key, cloud.json — is a disposable copy.
const sandbox = options.sandbox ? prepareSandbox() : null;
if (sandbox) process.on("exit", () => cleanupSandbox(sandbox.home));

/** How this board is reached from outside — the saved setup, the transport, the origin. Built once the supervisor listens. */
let remote: RemoteController | null = null;
/** The keyboard: L for a link, R for the remote-access walkthrough. Held so shutdown can restore the shell. */
let paneHost: PaneHost | null = null;
/**
 * A global bin (`npm i -g frizz`) is the one launch shape a self-update does not outlive: the release
 * lands in npm's execution cache and the bin on disk keeps pointing at this version. Decided here,
 * from THIS bundle's path, and handed down through the environment — the successor's own path is
 * always the cache and could never tell.
 */
const globalInstall = process.env[GLOBAL_INSTALL_ENV] === "1" || isGlobalInstall(import.meta.dirname);
let accessPane: AccessPane | null = null;
/** Set when this start's session-epoch advance signed remote devices out; the readout says so. */
let sessionNotice: string | null = null;
let serverOwner: ServerOwnerLease | undefined;
// Cold-install errors and signals also release the lease. Live registered control-plane delegates
// retain its draining fence until their exact process generations are gone.
process.on("exit", () => { if (serverOwner) releaseStableServerOwner(serverOwner); });

/**
 * The folder the command was typed in. It is what the launch is ABOUT — and nothing else: the server
 * is never run on it, and this launcher holds no rule about it that a running server can answer.
 * A terminal left standing in a folder that has since been deleted has no cwd to read at all; that
 * launch is about nothing, which the home folder says (it is never a project).
 */
const launchDir = (() => {
  try { return process.cwd(); } catch { return homedir(); }
})();
const workspace: Workspace = (() => {
  try {
  // BEFORE workspace preparation, so a machine running a Node the server's database cannot survive
  // learns it here by name instead of from whichever internal step tripped over it first. On an
  // unsupported release SQLite does not misbehave, it SEGFAULTS, and a segfault mid-boot is
  // indistinguishable from Frizz being broken. The required executables list beside it is empty:
  // repository discovery can fall back to project markers when Git is absent (see preflight.ts).
  //
  // `--stop` and `--status` skip the Node floor deliberately: they only read a status file and signal
  // a process, both of which work on any runtime, and they are how someone shuts down a board after
  // switching to a Node that cannot run one.
  if (!reexec) {
    if (options.stop || options.status) assertRequiredExecutables();
    else assertLaunchPrerequisites();
  }
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1") {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  // ALWAYS Frizz's own folder, whatever folder the command was typed in. The server was run on the
  // project being opened until now, which made a rule about folders something this launcher had to
  // hold BEFORE any server existed to ask: which folder is a project, which to offer, which to
  // refuse. Four of the seven shell releases between 2026-10-01 and 2026-10-11 changed nothing else,
  // at hours each in npm's review. It also tied every board on the machine to one user folder —
  // delete or unmount it and nothing could restart or update. The folder is now only what the launch
  // is about, and the server answers that once it is up (resolveLanding, below);
  // plans/server-side-launch-routing.md.
  return hostWorkspace();
  } catch (error) { return fail(error); }
})();
// No `process.chdir(workspace.root)`: the launcher stays in the folder the command was typed in.
// It moved into the hosting project until 2026-10-11, a habit from one server per repository, and a
// host folder deleted later left every child the launcher started without a working directory.

/**
 * The port of the Frizz running on this machine, for the flags that talk to it rather than start it.
 * The machine-wide record first: it names a board whichever folder it was started on, including one
 * an older launcher is still running on a project.
 */
function runningBoardPort(): number | undefined {
  const machine = readStableServerOwner();
  if (machine.kind === "running") return machine.port;
  return liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace))?.port;
}

/** Where `--stop` and `--status` look for a board whose record is not under Frizz's own folder. */
function controlPorts(): number[] {
  const machine = readStableServerOwner();
  return [...new Set([...(machine.kind === "running" ? [machine.port] : []), DEFAULT_PORT, fallbackPort(DEFAULT_PORT)])];
}
if (options.stop) {
  // The farewell after a detached update has said "stop it with frizz --stop" since 0.12.10, and
  // `--help` never listed it, because nothing here handled it: the flag fell through to the join
  // path below and OPENED A BROWSER TAB on the board it was asked to stop (audit 2026-09-11,
  // finding 2). The protocol is the dev launcher's (src/index.ts stopWorkspace): token-bound HTTP
  // stop, then reap only a provably stale owner — never a signal to a pid that might be recycled.
  try {
    // One server, every project, so there is one board to stop and the folder this was typed in does
    // not choose it. Its record is under Frizz's own folder — or, for a board an older launcher is
    // still running, under the project that launcher started it on, which its ports name.
    const control = await resolveLaunchControlTarget({ stateDir: workspace.stateDir, target: workspaceLaunchTarget(workspace), ports: controlPorts() });
    const result = await stopProjectLaunch({ stateDir: control.stateDir, target: control.target });
    console.log(
      result.kind !== "stopped"
        ? "Frizz is not running"
        : result.stale
          // A board that died without releasing its record (a kill, a crash) reads as "running" to
          // every later launch until someone reaps it; say what happened rather than claiming a stop.
          ? "Frizz was not running; cleared the record a dead board left behind"
          : "stopped Frizz; running agents keep going — they are detached daemons",
    );
    process.exit(0);
  } catch (error) { fail(error); }
}
if (options.status) {
  const control = await resolveLaunchControlTarget({ stateDir: workspace.stateDir, target: workspaceLaunchTarget(workspace), ports: controlPorts() });
  const running = await runningFrizzStatus({ stateDir: control.stateDir, target: control.target });
  if (!running) {
    console.log("Frizz is not running");
    process.exit(1);
  }
  console.log(`running: http://127.0.0.1:${running.port}`);
  if (!control.host) console.log(`launched from: ${control.target.projectDir} (one server serves every project)`);
  console.log(`supervisor pid: ${running.pid}`);
  console.log(`version: ${running.version ?? "unknown"}`);
  if (running.state && running.state !== "ready") console.log(`state: ${running.state}${running.message ? ` — ${running.message}` : ""}`);
  process.exit(0);
}
if (options.sessions || options.signOut !== undefined) {
  // Reads and writes the RUNNING board's session directory, so there is nothing useful to say when
  // no board is up — starting one here would create an empty directory and answer a different question.
  const port = runningBoardPort();
  if (!port) {
    console.error("frizz: Frizz is not running");
    process.exit(1);
  }
  if (options.signOut !== undefined) await signOutSession(port, options.signOut);
  await listSessions(port);
}
if (options.link) {
  // Mint from the RUNNING board rather than starting one — the same query frizz-dev answers
  // (src/index.ts): the answer for a board running detached or in someone else's terminal, where
  // the interactive QR pane cannot install.
  const port = runningBoardPort();
  if (!port) {
    console.error("frizz: Frizz is not running");
    process.exit(1);
  }
  const response = await fetch(`http://127.0.0.1:${port}${SUPERVISOR_ACCESS_CODE_PATH}`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${port}` },
  }).catch(() => undefined);
  if (!response?.ok) {
    const detail = response ? (await response.json().catch(() => undefined))?.error : undefined;
    console.error(`frizz: ${detail ?? "could not mint an access link"}`);
    process.exit(1);
  }
  const { url } = (await response.json()) as { url: string };
  // The QR first: the whole point of a link is to reach a phone, and nobody types forty characters.
  // The window gets the glyph-free code when the terminal does not draw block elements itself and it
  // fits above the blank line, the URL and the prompt that follow it (see qr.ts).
  if (process.stdout.isTTY) for (const row of renderQrLines(url, { area: qrAreaOf(process.stdout, { indent: 2, rows: 3 }) })) console.log(`  ${row}`);
  console.log(process.stdout.isTTY ? `\n  ${url}` : url);
  process.exit(0);
}
// Every launch leaves a complete record on disk, so a crash is never silent. The forked control-plane
// child appends to this same file rather than writing to the terminal the readout is repainting.
const logger: Logger = setAmbientLogger(
  process.env.FRIZZ_LOG_FILE
    ? createLogger({ file: process.env.FRIZZ_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) }),
);
const readout = reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1"
  ? undefined
  : new Readout({ debug: options.debug });
/**
 * Where supervisor lifecycle beats print. Normally the boot readout — but a launcher that execve'd
 * itself into this release through Update Frizz has no boot to narrate and still owns the operator's
 * terminal, so it gets a notice-only one rather than falling silent for the rest of the session. The
 * detached fallback successor has no terminal at all (stdio ignored) and stays quiet, as before.
 */
const activityReadout =
  readout ?? (reexec && process.stdout.isTTY ? noticeOnlyReadout({}) : undefined);
attachTerminalMirror(logger, options.debug || process.env.FRIZZ_DEBUG === "1");
readout?.plan([
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("server", "starting");
logger.info("launcher", `Frizz launcher ${PACKAGE_VERSION} starting in ${launchDir}`);
const target = workspaceLaunchTarget(workspace);
const expected = expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir));

async function existingPort(): Promise<number | undefined> {
  const owner = liveWorkspaceOwner(workspace.stateDir, target);
  const ports = [owner?.port, readPreferredPort(workspace.stateDir)].filter((value): value is number => !!value);
  for (const port of new Set(ports)) if (await probeFrizz(port, expected)) return port;
  return undefined;
}

/**
 * THE RULES THIS LAUNCHER CARRIED before the server answered for itself — FROZEN.
 *
 * Which folder is a project, whether to register it, and where the browser lands are the running
 * server's to say (resolveLanding). These are what a launch falls back on when it cannot: a server
 * that predates the route, or one that is not answering. They are evaluated LAZILY, and never on
 * the way to a cold start, so no rule about folders runs before a server exists to own it. Change
 * the rule in packages/server/src/launch-routing.ts, not here — an edit here reaches nobody until
 * the next shell release, which is the thing this split exists to avoid.
 */
let legacyIntentCache: LaunchIntent | undefined;
function legacyIntent(): LaunchIntent {
  return (legacyIntentCache ??= resolveLaunchIntent(launchDir));
}

/**
 * The project a launch here opens under those rules, registered — which is what mints its URL
 * segment — or undefined when it opens none. Registration is idempotent: an id already in the
 * registry keeps the segment it was given.
 */
function legacyProject(): { id: string; root: string; name: string; slug: string } | undefined {
  const intent = legacyIntent();
  if (intent.kind !== "open") return undefined;
  const { id, root, name } = intent.workspace;
  try {
    const slug = registerProject({ dir: root, id, remoteOwner: resolveProjectLabel(root)?.split("/")[0] }, homedir()).entry?.slug;
    return slug ? { id, root, name, slug } : undefined;
  } catch {
    // The registry is an INDEX. If it cannot be written the dashboard still opens.
    return undefined;
  }
}

/**
 * Where to land under those rules: the project's board, the dashboard, or the dashboard with a
 * folder to ask about. `?add=` is a REQUEST, not a registration — nothing on disk changes until the
 * operator confirms on the page.
 */
function legacyLanding(): LaunchRoute {
  try {
    const intent = legacyIntent();
    if (intent.kind === "grid") return { path: "/" };
    if (intent.kind === "offer") return { path: offerPath(intent.directory) };
    const project = legacyProject();
    return project ? { path: `/project/${project.slug}`, project: { name: project.name, dir: project.root } } : { path: "/" };
  } catch (error) {
    // The server is up and every other project is on its dashboard; a folder Git cannot read is a
    // line to print, not a reason to leave the operator with nothing.
    return { path: "/", notice: `Could not open ${launchDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Where this launch lands: the running server's answer, or the frozen rules when it has none. */
async function resolveLanding(port: number, ownerToken: string | undefined): Promise<LaunchRoute> {
  const answered = ownerToken ? await askLaunchRoute(port, ownerToken, launchDir) : undefined;
  if (answered) return answered;
  logger.info("launcher", "the running server did not say where this launch lands; using this launcher's own rules");
  return legacyLanding();
}

/**
 * A board started by a launcher from before the machine-wide owner record (0.13.0), which this
 * launcher therefore cannot find by it. Such a board answers on the default ports; a launch that
 * opens a project joins it when it serves that project, exactly as it always has. Nothing about the
 * folder is read unless something is actually listening there.
 */
async function joinPreSplitFrizz(): Promise<number | undefined> {
  for (const port of new Set([DEFAULT_PORT, fallbackPort(DEFAULT_PORT)])) {
    if (!(await readFrizzHealth(port))) continue;
    let project: ReturnType<typeof legacyProject>;
    try { project = legacyProject(); } catch { return undefined; }
    if (!project) return undefined;
    if (await probeFrizz(port, { projectId: project.id, projectDir: project.root, slug: project.slug })) return port;
  }
  return undefined;
}

/**
 * Hand the operator the running board. This is deliberately the SAME contract as the source
 * launcher's openOrPrint (index.ts): a plain launch opens the default browser, `--app` opens the
 * dedicated app window, `--no-app` prints the URL and nothing else, and a browser that refuses to
 * open degrades to the URL instead of failing the launch.
 *
 * It printed the URL and stopped there from the day this file was written, so `npx frizz` never
 * opened anything while `frizz-dev` always did — the whole divergence the operator hit.
 */
async function openOrPrint(port: number, reused: boolean, landing: LaunchRoute): Promise<void> {
  const url = `http://127.0.0.1:${port}${landing.path}`;
  logger.info("launcher", `${reused ? "reusing" : "started"} Frizz at ${url}`);
  readout?.settle("server", "done", reused ? `already running on port ${port}` : `port ${port}`);
  let browser: string | undefined;
  if (!options.noApp) {
    readout?.begin("browser", options.appMode ? "requesting app window" : "requesting default browser");
    try {
      if (options.appMode) {
        await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
        browser = reused ? "focused the Frizz app window" : "opened the Frizz app window";
      } else {
        await launchBrowserTab(url);
        browser = "opened in your default browser";
      }
      logger.info("launcher", browser);
    } catch (error) {
      browser = `could not open the ${options.appMode ? "app window" : "default browser"} — open the address above`;
      logger.warn("launcher", `${browser}: ${error instanceof Error ? error.message : error}`);
    }
    readout?.settle("browser", "done", browser);
  } else {
    readout?.settle("browser", "done", url);
  }
  // A reuse did not choose this server's bind address or its proxy origin, so it must not claim either.
  const publicOrigin = reused ? undefined : remote?.origin();
  const warnings: string[] = [];
  if (sandbox) warnings.push(`Sandbox: everything here is throwaway (${sandbox.home}) and is deleted when this terminal closes.`);
  if (sessionNotice && !reused) warnings.push(sessionNotice);
  if (landing.notice) warnings.push(landing.notice);
  if (!readout) {
    console.log(`${reused ? "reusing" : "started"} Frizz${landing.project ? ` for ${landing.project.dir}` : ""}`);
    console.log(url);
    if (publicOrigin) console.log(`${publicOrigin}/`);
    for (const warning of warnings) console.log(warning);
    return;
  }
  const home = homedir();
  readout.ready(
    [
      { label: "Local", value: boardAddress(url), accent: true },
      ...(publicOrigin ? [{ label: "Public", value: `${publicOrigin}/`, accent: true }] : []),
      // Only a launch that OPENED a project names one: the dashboard and an offer are about no
      // project, and the folder the server runs on is Frizz's own.
      ...(landing.project ? [{ label: "Project", value: `${landing.project.name} — ${tildePath(landing.project.dir, home)}` }] : []),
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // This launch owns nothing and exits immediately, so ctrl-c would not stop what it reopened.
        "reopened the Frizz already running on this machine · stop it from the terminal that started it"
      : options.debug
        ? undefined
        : publicOrigin
          ? "press L for a sign-in link · R to change how this board is reached · ctrl-c to stop"
          : "press R to reach this board from a phone or another machine · ctrl-c to stop",
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    },
  );
}

async function runSupervisor(port: number, token: string, onPrepared: () => void = () => {}): Promise<never> {
  assertLaunchPrerequisites();
  if (!serverOwner) throw new Error("stable server launch is missing global ownership");
  const owner = adoptProjectLaunchOwner(target, token, "supervisor");
  const env = projectLaunchEnvironment(
    {
      ...process.env,
      FRIZZ_PRODUCTION_SUPERVISOR: "1",
      FRIZZ_SERVER_OWNERSHIP: JSON.stringify(projectLaunchEnvironment({}, serverOwner.target, serverOwner.token)),
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { FRIZZ_DEBUG: "1" } : {}),
    },
    target,
    owner.token,
  );
  const manifest: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const spec = serverReleaseSpec(manifest, process.env.FRIZZ_SERVER_PACKAGE);
  const installer = npmServerPackageInstaller(env);
  const store = new ServerReleaseStore(spec, installer, undefined, undefined, serverReleaseMinimum(manifest));
  // The one time starting Frizz replaces the server without a click on Update, so it is said out
  // loud and written down: the selection moves, and the log is where someone asks why it did.
  const raise = store.belowMinimum();
  if (raise)
    logger.info("launcher", `the installed Frizz server ${raise.selected} is older than this launcher works with (${raise.minimum}); starting on ${raise.pinned}`);
  activityReadout?.notice(
    "progress",
    "Starting",
    raise
      ? `installing Frizz server ${raise.pinned}: ${raise.selected} is older than this launcher works with`
      : "loading the selected Frizz server release",
  );
  let active = await store.load();
  let pending: ServerGeneration | undefined;
  let previous = active;
  // The release that served before the last COMMITTED update: what the supervisor goes back to when
  // the new one keeps stopping (`revertUpdate`). `previous` cannot say, because every later click on
  // Update moves it to whatever is serving then.
  let before: ServerGeneration | undefined;
  // A release this launcher went back from. It is not offered or installed again while this launcher
  // runs: it would only stop the same way. In memory only, so starting Frizz again offers it once more.
  let rejected: string | undefined;
  onPrepared();
  // Once a release is committed, the ones nothing runs from any more go (ServerReleaseStore.sweep).
  // In the background and never fatal: it is housekeeping, and this process is the listener.
  const sweepOldReleases = (): void => {
    void store.sweep({ keep: [active.id, previous.id, ...(before ? [before.id] : []), ...(pending ? [pending.id] : [])] }).then(
      (sweep) => {
        const line = describeGenerationSweep(sweep);
        if (line) logger.info("launcher", line);
      },
      (error: unknown) => logger.warn("launcher", `old Frizz server releases were not swept: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  // Whether the registry actually has something newer, refreshed on a timer and READ FROM CACHE.
  // The status endpoint is polled by every open tab, so it must never reach the network; and the
  // answer only changes when someone publishes, so a slow cadence is plenty.
  //
  // Seeded `false`, not `true`. It started optimistic so the button would not flip from Restart to
  // Update a second after load — but the flip that actually happens is the other way: right after
  // an update the successor seeded `true` again and the reloaded tab showed "Update Frizz" naming a
  // version it already was, and a click in that window failed with "already current" presented as
  // an error; offline, the seed never cleared at all and every click was a red failure (audit
  // 2026-09-11, finding 5). A Restart that becomes Update once the registry answers is the cheaper
  // mistake. Only a POSITIVE probe raises it; a probe that fails leaves the last known answer.
  let updateAvailable = false;
  // The newer version the last successful probe saw, so the status endpoint can NAME the update it is
  // advertising. Set together with the boolean: a number we have not observed would be a lie, so
  // until the registry answers the client gets its generic copy.
  let updateVersion: string | undefined;
  /** The last probe failure written to the log, so a probe that fails every half hour says so once. */
  let probeFailure: string | undefined;
  // A newer LAUNCHER, when npm has one. Nothing replaces a running launcher but stopping it and
  // running `npx frizz` again, and nothing said so: a board measured on 2026-11-09 had been up for
  // three days and through two shell releases. The same half-hourly probe asks, and each newer
  // version is said once: in the log, on the terminal once the boot readout is done, and in the
  // status the page reads.
  let launcherUpdate: string | undefined;
  let launcherAnnounced: string | undefined;
  let launcherNoticeReady = false;
  const shellPackage = typeof (manifest as { name?: unknown }).name === "string" ? (manifest as { name: string }).name : "frizz";
  const announceLauncherUpdate = (): void => {
    if (!launcherNoticeReady || !launcherUpdate || launcherUpdate === launcherAnnounced) return;
    launcherAnnounced = launcherUpdate;
    activityReadout?.notice("progress", "Launcher", `${launcherUpdate} is available · stop Frizz and run npx frizz again to get it`);
  };
  const refreshLauncherUpdate = async (): Promise<void> => {
    try {
      const latest = (await planRegistryUpdate(shellPackage, PACKAGE_VERSION, installer))?.latestVersion;
      if (latest && latest !== launcherUpdate)
        logger.info("launcher", `Frizz launcher ${latest} is available and this one is ${PACKAGE_VERSION}: stop Frizz and run npx frizz again to get it`);
      launcherUpdate = latest;
      announceLauncherUpdate();
    } catch {
      // The server's probe has already written why npm could not be asked.
    }
  };
  const refreshUpdateAvailable = async (): Promise<void> => {
    try {
      const checkedVersion = active.version;
      const plan = await planRegistryUpdate(spec.package, checkedVersion, installer);
      probeFailure = undefined;
      if (active.version !== checkedVersion) return;
      const offered = plan && plan.latestVersion !== rejected ? plan : null;
      updateAvailable = offered !== null;
      updateVersion = offered?.latestVersion;
    } catch (error) {
      // A registry we cannot reach is not evidence either way. Leave the last known answer — but
      // record why. This swallowed every failure, so a probe that could NEVER answer left a board
      // that simply stopped offering updates with nothing anywhere to say so: on 2026-10-11 one had
      // failed every half hour for twenty hours, and the first sign of it was a failed Update click.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== probeFailure) logger.warn("launcher", `could not check npm for a newer Frizz server: ${message}`);
      probeFailure = message;
    }
    await refreshLauncherUpdate();
  };
  void refreshUpdateAvailable();
  const updateAvailablePoll = setInterval(() => void refreshUpdateAvailable(), 30 * 60 * 1000);
  updateAvailablePoll.unref();

  // Persisted in Frizz's own state folder, so a restart does not sign every device out — and neither
  // does starting Frizz from a different folder, which it did while this lived under whichever
  // project the launch happened in. The first start here brings that project's state along
  // (adoptSessionState), so the move itself signs nobody out either.
  // Always, not only when public: the origin can be switched on later (press R), and a phone signed
  // in through one name stays signed in through the next. Loading it also applies SESSION_EPOCH, which
  // signs out every device from before a security bump, once.
  try {
    const projects = dirname(workspace.stateDir);
    const adopted = adoptSessionState(workspace.stateDir, readdirSync(projects).map((name) => join(projects, name)));
    if (adopted) logger.info("launcher", `carried the remote sign-in state over from ${adopted}`);
  } catch (error) {
    // Worst case is the one this avoids: remote devices sign in again, once.
    logger.warn("launcher", `could not carry the remote sign-in state over: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sessions = loadSessionState(workspace.stateDir);
  const epochRecord = sessionEpochLogLine(sessions.advance, sessions.signedOut);
  if (epochRecord) logger.warn("launcher", epochRecord);
  sessionNotice = sessionEpochNotice(sessions.signedOut);
  const supervisor = await startDevSupervisor({
    port,
    host: LOOPBACK_BIND_HOST,
    allowedHosts: [],
      // A spent code repaints the open QR pane as stale, so nobody photographs a dead link.
      onCodeConsumed: () => accessPane?.markConsumed(),
    onDeviceSignedIn: ({ label, devices }) => activityReadout?.notice("done", "Remote", `${label} signed in · ${remoteDevicesLine(devices)}`),
    onDeviceSignedOut: ({ label, devices }) =>
      activityReadout?.notice("done", "Remote", label === null ? "Every remote device signed out" : `${label} signed out · ${remoteDevicesLine(devices)}`),
    sessionKey: sessions.key,
    rotateSessionKey: sessions.rotateKey,
    sessionDirectory: sessions.directory,
    cwd: workspace.root,
    stateDir: workspace.stateDir,
    launchTarget: target,
    launchOwnerToken: owner.token,
    env,
    watch: false,
    childLaunchProvider: () => serverGenerationLaunch(pending ?? active),
    updateMode: "child",
    updateAvailable: () => updateAvailable,
    version: () => active.version,
    launcherVersion: PACKAGE_VERSION,
    updateVersion: () => updateVersion,
    // The terminal that owns the board says so when the board goes down and comes back. Everything
    // here is triggered from a browser tab or by a crash, so without this the foreground process is
    // the last place to learn what happened to it.
    onActivity: (event) => renderSupervisorActivity(activityReadout, event),
    // Every child leaves the terminal as it found it at its own fork, and the first one was forked
    // before the keyboard went raw — so without this R stopped working after the first update.
    onChildExit: () => paneHost?.reclaim(),
    updateRestart: async () => {
      previous = active;
      try {
        const plan = await planRegistryUpdate(spec.package, active.version, installer);
        if (!plan) { updateAvailable = false; updateVersion = undefined; return { state: "failed" as const, message: `Frizz ${active.version} is already current` }; }
        if (plan.latestVersion === rejected) {
          updateAvailable = false;
          updateVersion = undefined;
          return { state: "failed" as const, message: `Frizz ${rejected} kept stopping after it was installed, so it is not installed again. Stop Frizz and start it again to try it once more` };
        }
        updateAvailable = true;
        updateVersion = plan.latestVersion;
        logger.info("launcher", `update: installing Frizz server ${plan.latestVersion} while ${active.version} serves`);
        // Install while the current server serves. Selection remains provisional until the new
        // child is ready; the durable launcher, listener, terminal and tunnels never move.
        pending = await store.prepare(plan.latestVersion);
        return { state: "ready" as const, message: `Frizz ${plan.latestVersion} is installed and compatible` };
      } catch (error) {
        return { state: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    commitUpdate: () => {
      if (!pending) throw new Error("no server update was prepared");
      store.commit(pending);
      before = active;
      active = pending;
      pending = undefined;
      updateAvailable = false;
      updateVersion = undefined;
      sweepOldReleases();
    },
    rollbackUpdate: () => {
      // Also called when nothing was prepared (already current, a failed install): no line for those.
      if (pending || active.id !== previous.id)
        logger.warn("launcher", `update rolled back: serving Frizz server ${previous.version} again, not ${(pending ?? active).version}`);
      if (active.id !== previous.id) store.commit(previous);
      active = previous;
      pending = undefined;
    },
    revertUpdate: () => {
      if (!before || before.id === active.id) throw new Error("no earlier Frizz server release is held to go back to");
      store.commit(before);
      rejected = active.version;
      active = before;
      previous = before;
      before = undefined;
      pending = undefined;
      updateAvailable = false;
      updateVersion = undefined;
    },
    rejectedUpdate: () => rejected,
    launcherUpdate: () => launcherUpdate,
  });
  publishStableServerAddress(serverOwner, port);
  // A saved setup comes back, but no sign-in link is minted with it: one is minted only when asked for,
  // with L or --link. Until 2026-11-09 every public launch printed a fresh single-use link and its QR,
  // so a launch the maintainer did not mean to be public put a working way in on his screen and in the
  // terminal's scrollback (maintainer: "This should all be opt-in").
  remote = createRemoteController({ host: supervisor, port, log: logger, say: (message) => console.error(`frizz: ${message}`) });
  try {
    await remote.serveSaved();
  } catch (error) {
    // A saved setup that cannot come up must not take the board down with it: the board still serves
    // loopback, the readout says so, and R offers the setup again.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("remote", message);
    console.error(`frizz: the saved remote setup could not start: ${message}`);
  }

  // "Press L for a fresh link" — the only way to reissue without restarting. Null when stdout is not
  // a terminal, which leaves the plain records path untouched.
  accessPane = createAccessPane({ issue: () => supervisor.issueAccessLink() });
  const remotePane = createRemotePane({
    port,
    current: () => remote?.current() ?? null,
    apply: (next, applyOptions) => remote!.apply(next, applyOptions),
    setRelayAccess: (access) => remote!.setRelayAccess(access),
    claim: (name, progress) => establishCloudConfig(name, port, undefined, undefined, frizzGithubSignIn(), { say: progress, promptHint: false }),
    githubLogin: frizzGithubLogin,
    issueLink: () => supervisor.issueAccessLink(),
    devices: { count: () => supervisor.signedInDevices(), signOutAll: () => supervisor.signOutAllDevices() },
    probes: { cloudflared: probeCloudflared, tailscale: probeTailscale },
    onChanged: (config) => logger.info("remote", config ? `reached at https://${config.hostname}` : "loopback only"),
    // The readout above the pane still names the setup this launch started with; say the new one under it.
    onClosedAfterChange: (config) => activityReadout?.notice("done", "Remote", remoteReachedLine(config)),
    sandbox: sandbox !== null,
  });
  paneHost = installPaneHost({ bindings: { l: accessPane, L: accessPane, r: remotePane, R: remotePane } });

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => { owner.release(); if (serverOwner) releaseStableServerOwner(serverOwner); },
    // Acknowledge the first signal on the spot; the drain that follows is bounded but not instant.
    onStop: () => {
      logger.info("launcher", "stop signal received; draining the control plane");
      activityReadout?.notice("progress", "Stopping", "draining the control plane — press ctrl-c again to force");
    },
    exit: (code) => {
      logger.info("launcher", `stopped with code ${code}`);
      // Before the farewell, or the operator's shell is left in raw mode echoing nothing.
      paneHost?.dispose();
      // Down with the board: a surviving cloudflared keeps the hostname resolving to a 530.
      remote?.stop();
      const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
      process.stdout.write(
        code === 0
          ? `\n  Frizz stopped. Running agents keep going — they are detached daemons.${suffix}\n\n`
          : `\n  Frizz stopped with errors (exit ${code}).${suffix}\n\n`,
      );
      process.exit(code);
    },
    error: (line) => logger.error("supervisor", line.startsWith("[frizz] ") ? line.slice(10) : line),
  });
  // SIGHUP is what closing a terminal sends, and Node's default action for it is to die on the spot —
  // so without this the launcher was killed WITHOUT running `stop`, and the control-plane child (which
  // sits in its own process group, so the tty never signals it directly) was orphaned still holding the
  // port. That is the whole reason an "always foreground" board could outlive its terminal and need
  // `--stop` to reach. Verified on a live board: launcher pgid 31700, child pgid 31704, same tty.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  store.commit(active);
  sweepOldReleases();
  // In the log as well as on the terminal: a run log opens with the launcher's version and went on to
  // serve whatever the store selected without ever naming it.
  logger.info("launcher", `serving Frizz server ${active.version} (launcher ${PACKAGE_VERSION})`);
  activityReadout?.notice("done", "Server", `${active.version} · launcher ${PACKAGE_VERSION}`);
  launcherNoticeReady = true;
  announceLauncherUpdate();
  const heldSessions = liveSessions(sessions.directory).length;
  if (heldSessions > 0) activityReadout?.notice("done", "Remote", `${remoteDevicesLine(heldSessions)} · frizz --sessions lists them`);
  // The execve'd generation prints no boot block (it is not an interactive launch), so this one line
  // is the only thing that tells the operator the update finished and this terminal still owns it.
  if (reexec) {
    activityReadout?.notice(
      "done",
      "Updated",
      `Frizz ${active.version} is serving on port ${port} · ctrl-c to stop${globalInstall ? ` · ${keepUpdateHint(PACKAGE_NAME, PACKAGE_VERSION)}` : ""}`,
    );
  }
  return await new Promise<never>(() => {});
}

try {
  // Hold this across downloads, child handoffs and recovery. A 503 from the application is never
  // permission to start a second scheduler, and a custom port is just as discoverable as the default.
  const globalClaim = acquireStableServerOwner();
  if (globalClaim.kind === "busy") throw new Error("Frizz is starting or recovering on this machine; retry shortly");
  if (globalClaim.kind === "running") {
    if (options.port && options.port !== globalClaim.port)
      throw new Error(`Frizz is already running on port ${globalClaim.port}; --port cannot change a running server`);
    // The token in the record that named this server is what lets a launch in ANY folder ask it.
    await openOrPrint(globalClaim.port, true, await resolveLanding(globalClaim.port, globalClaim.owner.token));
    process.exit(0);
  }
  serverOwner = globalClaim.lease;
  if (process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1" || reexec) {
    if (!options.port) throw new Error("internal registry supervisor launch is missing --port");
    const token = projectLaunchOwnerTokenFromEnvironment(process.env);
    if (!token) throw new Error("registry supervisor launch is missing project ownership");
    await runSupervisor(options.port, token);
  }
  // A Frizz already running on Frizz's own folder that does not hold the machine-wide record — the
  // source launcher started outside a project. Its launch token is in the record it does publish.
  const existing = await existingPort();
  if (existing) {
    await openOrPrint(existing, true, await resolveLanding(existing, readProjectLaunchOwner(workspace.stateDir)?.token));
    process.exit(0);
  }
  const preSplit = await joinPreSplitFrizz();
  if (preSplit) { await openOrPrint(preSplit, true, legacyLanding()); process.exit(0); }
  const claim = tryAcquireProjectLaunchOwner(target, "launcher");
  if (claim.kind !== "acquired") throw new Error("Frizz is starting on this machine; retry shortly");
  let release: (() => void) | undefined = await acquireGlobalLaunchLock();
  let portReservation: (() => void) | undefined;
  try {
    const allocation = await allocatePort(options.port, readPreferredPort(workspace.stateDir), { host: LOOPBACK_BIND_HOST });
    const port = allocation.port;
    portReservation = allocation.release;
    // The supervisor owns the rest of this process's life (runSupervisor never returns), so start it
    // WITHOUT awaiting and race it against health. Awaiting it directly is what made everything below
    // unreachable: parseCliArgs pins `foreground` to true, so the old `if (options.foreground) await
    // runSupervisor(...)` always won and a cold `npx frizz` never printed its URL, never opened a
    // browser, and never released the lock it took — the detached-spawn branch that used to follow was
    // dead code the day parseCliArgs stopped honouring --detach.
    let didPrepare!: () => void;
    const prepared = new Promise<void>((resolve) => { didPrepare = resolve; });
    const running = runSupervisor(port, claim.lease.token, didPrepare);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, keeps `port` ours until the child listens. Holding it across
    // the progress-tracked wait below meant one cold `npx frizz` could sit on it for minutes while
    // every other repository's launcher gave up after a far shorter budget.
    release();
    release = undefined;
    // Cold installs have their own bounded npm timeout. Do not spend the server's boot/stall budget
    // waiting for a download, and do not hold the machine-global allocation lock while it runs.
    await Promise.race([prepared, running]);
    // Progress-tracked: a boot that keeps reporting steps keeps the launcher's patience, so a large
    // board on a busy machine is no longer indistinguishable from a wedge. See waitForWorkspace.
    // `running` stays in the race so a supervisor that dies while booting reports immediately.
    await Promise.race([
      waitForWorkspace(
        port,
        expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir)),
        undefined,
        { stateDir: workspace.stateDir },
      ),
      running,
    ]);
    // The child is listening now, so the port defends itself. The reservation must NOT span the
    // foreground server lifetime, or a stopped-but-unreleased claim would push this repository's next
    // launch off its remembered port.
    portReservation();
    portReservation = undefined;
    // The server is up, so it says where this launch lands. This launcher holds the machine-wide
    // token itself: it is the one that took the record.
    await openOrPrint(port, false, await resolveLanding(port, serverOwner.token));
    await running;
  } finally { release?.(); portReservation?.(); claim.lease.release(); }
} catch (error) {
  logger.error("launcher", `startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (readout) {
    const where = readout.activeStep();
    readout.fail(
      `${where ? `${where.label.toLowerCase()}: ` : ""}${error instanceof Error ? error.message : String(error)}`,
      logger.file ?? undefined,
    );
    process.exit(1);
  }
  fail(error);
}
