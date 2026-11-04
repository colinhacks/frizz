import { execFileSync, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, lstatSync, readlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { resolveProject } from "../packages/server/src/project.ts";
import {
  acquireGlobalLaunchLockSync,
  portReservationPath,
  resolveGitWorktree,
  tryReservePort,
} from "../packages/server/src/project-identity.ts";
import {
  acquireProjectLaunchOwner,
  defaultProcessPlatformAdapter,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  registerProjectLaunchDelegate,
  type ProcessPlatformAdapter,
  type ProjectLaunchTarget,
} from "../packages/server/src/project-launch.ts";
import { frizzPaths, launchHostDir, projectStateDir } from "@frizz/server/frizz-paths";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  canBindPort,
  choosePort,
  portUnavailableMessage,
  probeBindPort,
  helpText,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  parseCliArgs,
  askLaunchRoute,
  hostWorkspace,
  isHostWorkspace,
  resolveLaunchIntent,
  prepareBeforeGlobalLaunchLock,
  probeFrizz,
  JOIN_PROBE_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  durableReexecArgs,
  readPreferredPort,
  waitForWorkspace,
  requestFrizzStop,
  resolveWorkspace,
  runningFrizzStatus,
  sourceWorkspaceDir,
  resolveLaunchControlTarget,
  stopProjectLaunch,
  supervisorNeedsAttention,
  workspaceLaunchTarget,
  type Workspace,
  cleanupSandbox,
  prepareSandbox,
  SANDBOX_DROPPED_XDG_ROOTS,
} from "./launcher.ts";
import { claimIdentityFingerprint, claimIdentityPath, loadOrCreateClaimIdentity } from "./identity.ts";
import { DEFAULT_PORT, DEFAULT_DEV_PORT } from "@frizz/shared";
import { listProjects, registerProject } from "@frizz/server/project-registry";

test("artifact re-exec keeps the original canonical Frizz source directory", () => {
  const source = mkdtempSync(join(tmpdir(), "frizz-canonical-source-"));
  const artifactRuntime = join(tmpdir(), "frizz-builds", "digest", "runtime", "src");
  assert.equal(
    sourceWorkspaceDir({ FRIZZ_SOURCE_DIR: source }),
    source,
    "a deployed runtime must not infer its cache path as build source"
  );
  assert.notEqual(sourceWorkspaceDir({}), artifactRuntime);
});

interface IdentityResult {
  root: string;
  id: string;
  stateDir: string;
  identityScope: "repository" | "worktree";
}

type IdentityMode = "cli" | "server";

const launcherModuleUrl = pathToFileURL(
  join(import.meta.dirname, "launcher.ts")
).href;
const projectModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "packages", "server", "src", "project.ts")
).href;
const projectIdentityModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "packages", "server", "src", "project-identity.ts")
).href;
const projectLaunchModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "packages", "server", "src", "project-launch.ts")
).href;
const cliEntry = join(import.meta.dirname, "index.ts");
const uiRoot = join(import.meta.dirname, "..");

function spawnLaunchProtocolChild(
  kind: "owner" | "delegate",
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = {}
) {
  const source =
    kind === "owner"
      ? `
    import { createServer } from "node:http"
    import { acquireProjectLaunchOwner, projectLaunchTokenProof } from ${JSON.stringify(
      projectLaunchModuleUrl
    )}
    const target = JSON.parse(process.env.TARGET)
    const lease = acquireProjectLaunchOwner(target, "supervisor")
    let control
    let port
    if (process.env.FAIL_CONTROL === "1") {
      control = createServer((req, res) => {
        if (req.url === "/_frizz/health") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            ok: true,
            projectId: target.projectId,
            projectDir: target.projectDir,
            bootId: "failed-control-fixture",
            ownerProof: projectLaunchTokenProof(target, lease.token),
          }))
          return
        }
        res.writeHead(req.url === "/_frizz/control/stop" ? 503 : 404)
        res.end()
      })
      await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve))
      port = control.address().port
    }
    console.log(JSON.stringify({ token: lease.token, pid: lease.pid, processStart: lease.processStart, port }))
    const finish = () => {
      lease.release()
      if (control?.listening) control.close(() => process.exit(0))
      else process.exit(0)
    }
    process.on("SIGTERM", finish)
    setInterval(() => {}, 1000)
  `
      : `
    import { registerProjectLaunchDelegate } from ${JSON.stringify(
      projectLaunchModuleUrl
    )}
    const target = JSON.parse(process.env.TARGET)
    const lease = registerProjectLaunchDelegate(target, process.env.TOKEN)
    console.log(JSON.stringify({ pid: lease.pid, processStart: lease.processStart }))
    let ownerGoneAt = 0
    const finish = () => { clearInterval(timer); lease.release(); process.exit(0) }
    const timer = setInterval(() => {
      try { process.kill(Number(process.env.OWNER_PID), 0); ownerGoneAt = 0 }
      catch {
        ownerGoneAt ||= Date.now()
        if (Date.now() - ownerGoneAt >= Number(process.env.EXIT_DELAY_MS ?? 300)) finish()
      }
    }, 10)
    process.on("SIGTERM", finish)
  `;
  const child = spawnChild(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: uiRoot,
      env: { ...process.env, TARGET: JSON.stringify(target), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const line = new Promise<Record<string, unknown>>(
    (resolveLine, rejectLine) => {
      child.stdout.on("data", () => {
        const newline = stdout.indexOf("\n");
        if (newline >= 0)
          resolveLine(
            JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>
          );
      });
      child.once("exit", (code, signal) => {
        if (!stdout.includes("\n"))
          rejectLine(
            new Error(`launch child exited ${code}/${signal}: ${stderr}`)
          );
      });
    }
  );
  void line.catch(() => {});
  return { child, line };
}

async function stopDisposableChild(
  child: ReturnType<typeof spawnChild>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function runRealCli(
  cwd: string,
  home: string,
  args: string[]
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const name of [
    "FRIZZ_DEV_CHILD",
    "FRIZZ_DIRECT_SUPERVISOR",
    "FRIZZ_DAEMON_CHILD",
    "FRIZZ_DEV_REEXEC",
    "FRIZZ_LAUNCH_OWNER_TOKEN",
    "FRIZZ_LAUNCH_PROJECT_ID",
    "FRIZZ_LAUNCH_PROJECT_DIR",
    "FRIZZ_LAUNCH_STATE_DIR",
    "FRIZZ_LAUNCH_IDENTITY_SCOPE",
  ])
    delete env[name];
  const child = spawnChild(process.execPath, [cliEntry, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
  timeout.unref?.();
  try {
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null
    ];
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function spawnIdentityChild(
  mode: IdentityMode,
  cwd: string,
  home: string,
  barrier: string,
  ready: string
) {
  const source = `
    import { existsSync, writeFileSync } from "node:fs"
    import { resolveWorkspace } from ${JSON.stringify(launcherModuleUrl)}
    import { resolveProject } from ${JSON.stringify(projectModuleUrl)}

    const [mode, cwd, home, barrier, ready] = process.argv.slice(1)
    writeFileSync(ready, "ready")
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(barrier)) Atomics.wait(wait, 0, 0, 5)
    const value = mode === "cli" ? resolveWorkspace(cwd, home) : resolveProject(cwd, home)
    const root = mode === "cli" ? value.root : value.dir
    const identityScope = value.identityScope === "worktree" ? "worktree" : "repository"
    process.stdout.write(JSON.stringify({
      root,
      id: value.id,
      stateDir: value.stateDir,
      identityScope,
    }))
  `;
  const child = spawnChild(
    process.execPath,
    ["--input-type=module", "-e", source, mode, cwd, home, barrier, ready],
    {
      cwd: uiRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<IdentityResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(`identity child exited ${code ?? signal}: ${stderr.trim()}`)
        );
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as IdentityResult);
      } catch (error) {
        reject(
          new Error(`identity child returned invalid JSON: ${stdout}`, {
            cause: error,
          })
        );
      }
    });
  });
  // Readiness failures are reported below; attach a handler immediately so an early child exit does
  // not become an unhandled rejection while its siblings are still reaching the barrier.
  void result.catch(() => {});
  return { child, result };
}

async function runIdentityRace(
  base: string,
  specs: Array<{ mode: IdentityMode; cwd: string }>,
  home: string
): Promise<IdentityResult[]> {
  const barrier = join(base, "identity-race.go");
  const readyPaths = specs.map((_, index) =>
    join(base, `identity-race-${index}.ready`)
  );
  const children = specs.map((spec, index) =>
    spawnIdentityChild(spec.mode, spec.cwd, home, barrier, readyPaths[index]!)
  );
  try {
    const deadline = Date.now() + 10_000;
    while (!readyPaths.every(existsSync)) {
      if (Date.now() >= deadline)
        throw new Error("identity children did not reach the race barrier");
      await delay(10);
    }
    writeFileSync(barrier, "go");
    return await Promise.all(children.map(({ result }) => result));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

function assertOneIdentity(
  results: IdentityResult[],
  repo: string,
  home: string
): string {
  assert.ok(results.length > 1);
  const [first] = results;
  assert.ok(first);
  assert.deepEqual(
    [...new Set(results.map(({ root }) => root))],
    [realpathSync(repo)]
  );
  assert.deepEqual([...new Set(results.map(({ id }) => id))], [first.id]);
  assert.deepEqual(
    [...new Set(results.map(({ stateDir }) => stateDir))],
    [projectStateDir(first.id, home)]
  );
  assert.deepEqual(
    [...new Set(results.map(({ identityScope }) => identityScope))],
    ["repository"]
  );
  assert.deepEqual(
    execFileSync("git", ["config", "--local", "--get-all", "frizz.id"], {
      cwd: repo,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/u),
    [first.id]
  );
  assert.deepEqual(readdirSync(join(frizzPaths({ home }).data, "projects")).sort(), [
    first.id,
  ]);
  assert.equal(existsSync(join(repo, ".frizz", "frizz.id")), false);
  return first.id;
}

test("CLI options default to immutable mode and make source/HMR explicit", () => {
  assert.deepEqual(parseCliArgs([]), {
    noApp: false,
    appMode: false,
    foreground: true,
    stop: false,
    status: false,
    help: false,
    dev: false,
    debug: false,
    port: undefined,
    link: false,
    sandbox: false,
    sessions: false,
  });
  assert.deepEqual(parseCliArgs(["--no-app", "--foreground", "--port=5123"]), {
    noApp: true,
    appMode: false,
    foreground: true,
    stop: false,
    status: false,
    help: false,
    dev: false,
    debug: false,
    port: 5123,
    link: false,
    sandbox: false,
    sessions: false,
  });
  assert.equal(parseCliArgs(["--dev"]).dev, true);
  // --debug swaps the compact readout for the full event feed; it is orthogonal to --dev.
  assert.equal(parseCliArgs(["--debug"]).debug, true);
  assert.equal(parseCliArgs(["--debug"]).dev, false);
  assert.equal(parseCliArgs(["--no-app", "--debug"]).debug, true);
  // A repository path is REFUSED, not ignored. One server serves every project, so `frizz /some/repo`
  // asked a question the launcher no longer has — and someone with it in a script deserves to be told.
  assert.throws(
    () => parseCliArgs(["--no-app", "/tmp/repo with spaces"]),
    /takes no repository path/
  );
  assert.equal(parseCliArgs(["--app"]).appMode, true);
  assert.throws(() => parseCliArgs(["--port", "nope"]), /invalid --port/);
  assert.throws(() => parseCliArgs(["--port"]), /requires a value/);
  assert.equal(parseCliArgs(["--foreground"]).foreground, true);
  assert.throws(() => parseCliArgs(["--detach"]), /always runs in the foreground/);
  assert.throws(() => parseCliArgs(["--app", "--no-app"]), /either/);
  assert.throws(() => parseCliArgs(["one", "two"]), /takes no repository path/);
  // The network flags are retired for the R pane. They name the replacement rather than reading as a
  // typo, because they lived in scripts and shell history.
  for (const argv of [["up"], ["--cloud"], ["--host"], ["--host=0.0.0.0"], ["--allowed-host", "x"], ["--public-origin", "https://x.dev"]]) {
    assert.throws(() => parseCliArgs(argv), /was retired .* press R in its terminal/, argv.join(" "));
  }
  assert.throws(() => parseCliArgs(["--mystery"]), /unknown option/);
  assert.match(helpText(), /always runs in the foreground/);
  assert.match(helpText(), /default browser/);
  assert.match(helpText(), /--debug\s+stream the full event feed/);
  // --app still parses (above) but is legacy, so the help no longer advertises it.
  assert.doesNotMatch(helpText(), /--app /);
  assert.match(
    helpText(),
    /--dev\s+explicitly use the unsafe source watcher and Vite\/HMR/
  );
  assert.doesNotMatch(helpText(), /--host|--public-origin|--cloud|FRIZZ_HOST/);
  assert.match(helpText(), /press R in the terminal running it/);
  // The command name is a parameter, so no description may hard-code one. `--foreground` did, and
  // read as advice about a different binary whenever the launcher was invoked under another name.
  assert.doesNotMatch(helpText("frizzctl"), /frizz-dev/);
  assert.match(helpText("frizzctl"), /--foreground\s+accepted for compatibility; frizzctl/);
});

test("help stays readable: one description column, and nothing wider than a terminal", () => {
  // --allowed-host is exactly as wide as the old column, so adding it silently pushed its own
  // description two columns right of every other option's and forced a hanging line.
  const columns = new Set<number>();
  for (const line of helpText().split("\n")) {
    assert.ok(line.length <= 100, `help line is ${line.length} columns: ${line}`);
    const entry = /^ {2}(\S+(?: \S+)?) {2,}\S/.exec(line);
    if (entry) columns.add(entry[0].length - 1);
  }
  assert.equal(columns.size, 1, `options, environment and commands must share one column, saw ${[...columns]}`);
});

test("workspace identity canonicalizes a symlink and survives spaces", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz launcher "));
  const repo = join(base, "repo with spaces");
  const alias = join(base, "repo alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    const direct = resolveWorkspace(repo, home);
    const linked = resolveWorkspace(alias, home);
    assert.equal(linked.root, direct.root);
    assert.equal(linked.id, direct.id);
    assert.equal(linked.stateDir, direct.stateDir);
    assert.match(linked.root, /repo with spaces$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("main and linked worktrees concurrently resolve to three stable isolated Frizz instances", async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz linked worktree race "));
  const main = join(base, "main repo with spaces");
  const linkedOne = join(base, "linked worktree one");
  const linkedTwo = join(base, "linked worktree two");
  const linkedAlias = join(base, "linked one alias");
  const home = join(base, "home");
  const legacyId = "11111111-1111-4111-8111-111111111111";
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "linked-one", linkedOne],
      { cwd: main }
    );
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "linked-two", linkedTwo],
      { cwd: main }
    );
    execFileSync("git", ["config", "--local", "--add", "frizz.id", legacyId], {
      cwd: main,
    });
    symlinkSync(linkedOne, linkedAlias);
    mkdirSync(projectStateDir(legacyId, home), { recursive: true });
    writeFileSync(
      join(projectStateDir(legacyId, home), "legacy-state"),
      "preserved"
    );

    const results = await runIdentityRace(
      base,
      [
        { mode: "cli", cwd: main },
        { mode: "server", cwd: main },
        { mode: "cli", cwd: linkedOne },
        { mode: "server", cwd: linkedAlias },
        { mode: "cli", cwd: linkedTwo },
        { mode: "server", cwd: linkedTwo },
      ],
      home
    );
    const roots = [main, linkedOne, linkedTwo].map((path) =>
      realpathSync(path)
    );
    const byRoot = new Map(
      roots.map((root) => [
        root,
        results.filter((result) => result.root === root),
      ])
    );
    assert.deepEqual(
      [...new Set(results.map((result) => result.root))].sort(),
      roots.sort()
    );

    for (const [root, group] of byRoot) {
      assert.equal(group.length, 2, `CLI and server agree for ${root}`);
      assert.equal(new Set(group.map(({ id }) => id)).size, 1);
      assert.equal(new Set(group.map(({ stateDir }) => stateDir)).size, 1);
      assert.equal(
        new Set(group.map(({ identityScope }) => identityScope)).size,
        1
      );
    }

    const representatives = roots.map((root) => byRoot.get(root)![0]!);
    assert.equal(new Set(representatives.map(({ id }) => id)).size, 3);
    assert.equal(
      new Set(representatives.map(({ stateDir }) => stateDir)).size,
      3
    );
    assert.equal(
      new Set(representatives.map(({ stateDir }) => join(stateDir, "ui.db")))
        .size,
      3
    );

    const mainResult = byRoot.get(realpathSync(main))![0]!;
    assert.equal(
      mainResult.id,
      legacyId,
      "main worktree retains the pre-migration repository identity"
    );
    assert.equal(mainResult.identityScope, "repository");
    assert.equal(
      mainResult.stateDir,
      projectStateDir(legacyId, home)
    );
    assert.equal(
      readFileSync(join(mainResult.stateDir, "legacy-state"), "utf8"),
      "preserved"
    );
    for (const linked of [linkedOne, linkedTwo]) {
      const result = byRoot.get(realpathSync(linked))![0]!;
      assert.equal(result.identityScope, "worktree");
      assert.notEqual(result.id, legacyId);
      const config = resolveGitWorktree(linked).identityConfig;
      assert.ok(config);
      assert.equal(
        execFileSync(
          "git",
          ["config", "--file", config, "--get-all", "frizz.id"],
          { encoding: "utf8" }
        ).trim(),
        result.id
      );
    }
    assert.equal(
      execFileSync("git", ["config", "--local", "--get-all", "frizz.id"], {
        cwd: main,
        encoding: "utf8",
      }).trim(),
      legacyId
    );
    assert.throws(
      () =>
        execFileSync(
          "git",
          ["config", "--local", "--get", "extensions.worktreeConfig"],
          { cwd: main, stdio: "ignore" }
        ),
      "Frizz does not mutate the repository-wide worktreeConfig extension"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linked worktree identity survives moves and is retired on removal", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz worktree lifecycle "));
  const main = join(base, "main");
  const linked = join(base, "linked old");
  const moved = join(base, "linked moved");
  const alias = join(base, "moved alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync("git", ["worktree", "add", "-q", "-b", "movable", linked], {
      cwd: main,
    });

    const before = resolveWorkspace(linked, home);
    const privateConfig = resolveGitWorktree(linked).identityConfig;
    assert.ok(privateConfig && existsSync(privateConfig));
    execFileSync("git", ["worktree", "move", linked, moved], { cwd: main });
    symlinkSync(moved, alias);

    const afterMove = resolveWorkspace(alias, home);
    assert.equal(afterMove.id, before.id);
    assert.equal(afterMove.stateDir, before.stateDir);
    assert.equal(afterMove.root, realpathSync(moved));
    assert.equal(resolveGitWorktree(moved).identityConfig, privateConfig);

    rmSync(alias);
    execFileSync("git", ["worktree", "remove", moved], { cwd: main });
    assert.equal(existsSync(privateConfig), false);
    execFileSync("git", ["worktree", "add", "-q", moved, "movable"], {
      cwd: main,
    });
    const replacement = resolveWorkspace(moved, home);
    assert.notEqual(
      replacement.id,
      before.id,
      "a removed worktree's private identity is not inherited"
    );
    assert.notEqual(replacement.stateDir, before.stateDir);
    assert.equal(
      existsSync(before.stateDir),
      true,
      "historical state is preserved rather than reassigned"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("simultaneous first-run CLI processes commit one project identity", async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz cli identity race "));
  const repo = join(base, "repo with spaces");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(home);
    const results = await runIdentityRace(
      base,
      Array.from({ length: 8 }, () => ({ mode: "cli" as const, cwd: repo })),
      home
    );
    assertOneIdentity(results, repo, home);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("simultaneous CLI and direct-server starts share one identity namespace through aliases", async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz mixed identity race "));
  const repo = join(base, "canonical repo with spaces");
  const alias = join(base, "symlink repo alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    mkdirSync(home);
    const results = await runIdentityRace(
      base,
      Array.from({ length: 8 }, (_, index) => ({
        mode: index % 2 === 0 ? ("cli" as const) : ("server" as const),
        cwd: index % 3 === 0 ? alias : repo,
      })),
      home
    );
    assertOneIdentity(results, repo, home);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("invalid or duplicated git-local project ids fail closed before state paths are derived", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz invalid identity "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync(
      "git",
      ["config", "--local", "--add", "frizz.id", "../../outside"],
      { cwd: repo }
    );
    assert.throws(
      () => resolveWorkspace(repo, home),
      /expected exactly one UUID/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /expected exactly one UUID/
    );
    assert.equal(existsSync(join(frizzPaths({ home }).data, "projects")), false);

    execFileSync("git", ["config", "--local", "--unset-all", "frizz.id"], {
      cwd: repo,
    });
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "--add",
        "frizz.id",
        "11111111-1111-1111-1111-111111111111",
      ],
      { cwd: repo }
    );
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "--add",
        "frizz.id",
        "22222222-2222-2222-2222-222222222222",
      ],
      { cwd: repo }
    );
    assert.throws(
      () => resolveWorkspace(repo, home),
      /expected exactly one UUID/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /expected exactly one UUID/
    );
    assert.equal(existsSync(join(repo, ".frizz", "frizz.id")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linked-worktree identity config fails closed and recovers from an interrupted Git config lock", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz linked invalid identity "));
  const main = join(base, "main");
  const linked = join(base, "linked");
  const home = join(base, "home");
  const repositoryId = "11111111-1111-4111-8111-111111111111";
  const validWorktreeId = "22222222-2222-4222-8222-222222222222";
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], {
      cwd: main,
    });
    execFileSync(
      "git",
      ["config", "--local", "--add", "frizz.id", repositoryId],
      { cwd: main }
    );
    const config = resolveGitWorktree(linked).identityConfig;
    assert.ok(config);

    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "frizz.id",
      "../../outside",
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /linked-worktree frizz\.id is invalid/
    );
    rmSync(config);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "frizz.id",
      validWorktreeId,
    ]);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "frizz.id",
      validWorktreeId,
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /linked-worktree frizz\.id is invalid/
    );

    rmSync(config);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "frizz.id",
      repositoryId,
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /must differ from the repository/
    );

    rmSync(config);
    writeFileSync(`${config}.lock`, "partial interrupted config\n");
    assert.throws(
      () => resolveWorkspace(linked, home),
      /unable to persist linked-worktree/
    );
    assert.equal(existsSync(join(frizzPaths({ home }).data, "projects")), false);
    rmSync(`${config}.lock`);

    const recovered = resolveWorkspace(linked, home);
    assert.equal(recovered.identityScope, "worktree");
    assert.notEqual(recovered.id, repositoryId);
    assert.equal(
      execFileSync(
        "git",
        ["config", "--file", config, "--get-all", "frizz.id"],
        { encoding: "utf8" }
      ).trim(),
      recovered.id
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an interrupted Git config write fails without inventing an id and recovers cleanly", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz config lock recovery "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    const configLock = join(repo, ".git", "config.lock");
    writeFileSync(configLock, "partial interrupted config\n");
    assert.throws(() => resolveWorkspace(repo, home), /unable to persist/);
    assert.throws(() =>
      execFileSync("git", ["config", "--local", "--get-all", "frizz.id"], {
        cwd: repo,
        stdio: "ignore",
      })
    );
    assert.equal(existsSync(join(frizzPaths({ home }).data, "projects")), false);

    rmSync(configLock);
    const recovered = resolveWorkspace(repo, home);
    assert.match(recovered.id, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(readdirSync(join(frizzPaths({ home }).data, "projects")), [
      recovered.id,
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a malformed repository config never degrades direct startup into a random namespace", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz malformed config "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    const config = join(repo, ".git", "config");
    writeFileSync(config, `${readFileSync(config, "utf8")}\n[unterminated\n`);
    assert.throws(
      () => resolveWorkspace(repo, home),
      /unable to resolve Git repository root/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /unable to resolve Git repository root/
    );
    assert.equal(existsSync(join(frizzPaths({ home }).data, "projects")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("submodules keep an independent ordinary-repository identity", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz submodule identity "));
  const upstream = join(base, "submodule upstream");
  const parent = join(base, "parent repo");
  const submodule = join(parent, "modules", "child module");
  const alias = join(base, "submodule alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", upstream]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: upstream,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: upstream,
    });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "submodule initial"],
      { cwd: upstream }
    );
    execFileSync("git", ["init", "-q", parent]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: parent,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: parent,
    });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "parent initial"],
      { cwd: parent }
    );
    execFileSync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        upstream,
        "modules/child module",
      ],
      { cwd: parent }
    );
    symlinkSync(submodule, alias);

    const parentWorkspace = resolveWorkspace(parent, home);
    const childWorkspace = resolveWorkspace(submodule, home);
    const aliasedChild = resolveWorkspace(alias, home);
    assert.equal(parentWorkspace.identityScope, "repository");
    assert.equal(childWorkspace.identityScope, "repository");
    assert.notEqual(childWorkspace.id, parentWorkspace.id);
    assert.notEqual(childWorkspace.stateDir, parentWorkspace.stateDir);
    assert.equal(aliasedChild.id, childWorkspace.id);
    assert.equal(aliasedChild.root, childWorkspace.root);
    assert.equal(
      resolveGitWorktree(submodule).gitDir,
      resolveGitWorktree(submodule).commonGitDir
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("bare and non-Git directories retain their explicit fail-closed/degraded behavior", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz non-worktree identity "));
  const bare = join(base, "bare repo.git");
  const plain = join(base, "plain directory");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", "--bare", bare]);
    mkdirSync(plain);
    // No worktree is not a broken repository: it resolves as a plain directory now.
    const bareWorkspace = resolveWorkspace(bare, home);
    assert.match(bareWorkspace.id, /^[0-9a-f-]{36}$/u);
    assert.throws(
      () => resolveProject(bare, home),
      /unable to resolve Git repository root/
    );
    // Git is not required to launch. A plain directory gets a DURABLE id, not a fresh one per run.
    const plainWorkspace = resolveWorkspace(plain, home);
    assert.match(plainWorkspace.id, /^[0-9a-f-]{36}$/u);
    assert.equal(resolveWorkspace(plain, home).id, plainWorkspace.id, "the id survives the next launch");

    const degraded = resolveProject(plain, home);
    assert.equal(degraded.dir, realpathSync(plain));
    assert.match(degraded.id, /^[0-9a-f-]{36}$/u);
    assert.equal(degraded.identityScope, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing id stays lock-free for a source supervisor child", async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz existing identity "));
  const repo = join(base, "repo");
  const alias = join(base, "alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    const initial = resolveWorkspace(repo, home);
    const release = await acquireGlobalLaunchLock(home);
    try {
      const startedAt = Date.now();
      const childProject = resolveProject(alias, home);
      assert.equal(childProject.id, initial.id);
      assert.equal(childProject.dir, initial.root);
      assert.equal(childProject.stateDir, initial.stateDir);
      assert.ok(
        Date.now() - startedAt < 1_000,
        "valid existing identity should not wait on the launch lock"
      );
    } finally {
      release();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("health probes accept only the expected Frizz workspace identity", async () => {
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        projectId: "p1",
        projectDir: "/tmp/repo",
        bootId: "boot",
        ownerProof: "proof",
      })
    );
  assert.equal(
    (
      await probeFrizz(
        5000,
        { projectId: "p1", projectDir: "/tmp/repo" },
        fetcher as typeof fetch
      )
    )?.projectDir,
    "/tmp/repo"
  );
  assert.equal(
    (
      await probeFrizz(
        5000,
        {
          projectId: "p1",
          projectDir: "/tmp/repo",
          ownerProof: "proof",
        },
        fetcher as typeof fetch
      )
    )?.ownerProof,
    "proof"
  );
  assert.equal(
    await probeFrizz(
      5000,
      {
        projectId: "p1",
        projectDir: "/tmp/repo",
        ownerProof: "forged",
      },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFrizz(
      5000,
      { projectId: "other", projectDir: "/tmp/repo" },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFrizz(
      5000,
      { projectId: "p1", projectDir: "/tmp/hostile-other-worktree" },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFrizz(
      5000,
      { projectId: "p1", projectDir: "/tmp/repo" },
      (async () => new Response("nope")) as typeof fetch
    ),
    null
  );
});

test("token-bound status and control remain usable when external generation proof is unavailable", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "frizz-no-process-proof-"));
  const target: ProjectLaunchTarget = {
    projectId: randomUUID(),
    projectDir,
    stateDir: join(projectDir, "state"),
  };
  const owner = acquireProjectLaunchOwner(target, "supervisor");
  try {
    const record = readProjectLaunchOwner(target.stateDir)!;
    const unavailable: ProcessPlatformAdapter = {
      current: () => ({
        pid: record.pid + 10_000,
        processStart: "opaque:external-cli",
      }),
      observe: () => ({ confidence: "unavailable" }),
      isAlive: (pid) => pid === record.pid || pid === record.pid + 10_000,
      now: () => Date.now(),
      sleep: () => {},
    };
    const statusPath = join(target.stateDir, "dev-supervisor.lock");
    const status = {
      pid: record.pid,
      processStart: record.processStart,
      publisherToken: randomUUID(),
      ownerToken: record.token,
      projectId: target.projectId,
      projectDir: target.projectDir,
      port: 5099,
      state: "ready",
    };
    writeFileSync(statusPath, JSON.stringify(status));
    assert.deepEqual(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      status
    );

    writeFileSync(
      statusPath,
      JSON.stringify({ ...status, ownerToken: randomUUID() })
    );
    assert.equal(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      null
    );
    writeFileSync(
      statusPath,
      JSON.stringify({ ...status, projectDir: `${target.projectDir}-forged` })
    );
    assert.equal(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      null
    );
    writeFileSync(statusPath, JSON.stringify(status));

    const expected = expectedOwnerHealth(target, record);
    const proof = projectLaunchTokenProof(target, owner.token);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/_frizz/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            projectId: target.projectId,
            projectDir: target.projectDir,
            bootId: "boot",
            ownerProof: proof,
          })
        );
      }
      assert.equal(
        new Headers(init?.headers).get("x-frizz-launch-token"),
        owner.token
      );
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as typeof fetch;
    assert.equal(
      await requestFrizzStop(status.port, expected, owner.token, fetcher),
      true
    );
    assert.equal(requests.length, 2);
  } finally {
    owner.release();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test(
  "real frizz --stop reaps a dead v2 owner without attempting to signal it",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "frizz-real-dead-owner-stop-"));
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target);
    try {
      assert.ok((await owner.line).token);
      const exited = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await exited;

      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /stopped Frizz/u);
      assert.equal(readProjectLaunchOwner(target.stateDir), null);
    } finally {
      await stopDisposableChild(owner.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real frizz --stop never falls back to a PID signal when authenticated control fails",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(
      join(tmpdir(), "frizz-real-live-owner-stop-refusal-")
    );
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target, {
      FAIL_CONTROL: "1",
    });
    try {
      const ownerRecord = await owner.line;
      assert.ok(Number.isInteger(ownerRecord.port));
      writeFileSync(
        join(target.stateDir, "dev-supervisor.lock"),
        JSON.stringify({
          pid: ownerRecord.pid,
          processStart: ownerRecord.processStart,
          ownerToken: ownerRecord.token,
          projectId: target.projectId,
          projectDir: target.projectDir,
          port: ownerRecord.port,
          state: "ready",
        })
      );
      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /without authenticated token-bound control/u);
      assert.equal(
        owner.child.exitCode,
        null,
        "the unrelated live PID remains untouched"
      );
      assert.equal(
        owner.child.signalCode,
        null,
        "the unrelated live PID receives no signal"
      );
      assert.equal(
        readProjectLaunchOwner(target.stateDir)?.token,
        ownerRecord.token
      );
      assert.equal(
        existsSync(join(target.stateDir, "stable.json")),
        false,
        "a failed --stop must not fall through to artifact selection or a fresh launch"
      );
      assert.equal(
        existsSync(join(target.stateDir, "dev.log")),
        false,
        "a failed --stop must not spawn the detached supervisor"
      );
    } finally {
      await stopDisposableChild(owner.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real frizz --stop refuses live opaque and observable weak owners without token control",
  { timeout: 20_000 },
  async () => {
    const base = mkdtempSync(
      join(tmpdir(), "frizz-real-unverifiable-owner-stop-")
    );
    try {
      for (const [index, kind] of (["opaque", "weak"] as const).entries()) {
        const repo = join(base, `repo-${index}`);
        const home = join(base, `home-${index}`);
        mkdirSync(repo);
        execFileSync("git", ["init", "-q"], { cwd: repo });
        const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
        const live = spawnChild(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" }
        );
        assert.ok(live.pid);
        let marker = `opaque:${randomUUID()}`;
        if (kind === "weak") {
          let observed = defaultProcessPlatformAdapter.observe(live.pid);
          const deadline = Date.now() + 2_000;
          while (!observed.processStart && Date.now() < deadline) {
            await delay(10);
            observed = defaultProcessPlatformAdapter.observe(live.pid);
          }
          if (!observed.processStart || observed.confidence !== "weak") {
            await stopDisposableChild(live);
            continue;
          }
          marker = observed.processStart;
        }
        const adapter: ProcessPlatformAdapter = {
          current: () => ({ pid: live.pid!, processStart: marker }),
          observe: (pid) =>
            pid === live.pid
              ? {
                  processStart: marker,
                  confidence: marker.startsWith("ps-utc:")
                    ? "weak"
                    : "unavailable",
                }
              : { confidence: "unavailable" },
          isAlive: (pid) =>
            pid === live.pid &&
            live.exitCode === null &&
            live.signalCode === null,
          now: () => Date.now(),
          sleep: () => {},
        };
        const lease = acquireProjectLaunchOwner(target, "supervisor", {
          adapter,
        });
        try {
          const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
          assert.equal(result.code, 1);
          assert.equal(result.signal, null);
          assert.match(
            result.stderr,
            /without authenticated token-bound control/u
          );
          assert.equal(
            readProjectLaunchOwner(target.stateDir)?.token,
            lease.token
          );
          assert.equal(live.exitCode, null);
          assert.equal(live.signalCode, null);
        } finally {
          lease.release();
          await stopDisposableChild(live);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real frizz --stop drains a dead owner's delegate before removing token status",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "frizz-real-delegate-stop-"));
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target);
    let delegate: ReturnType<typeof spawnLaunchProtocolChild> | undefined;
    try {
      const ownerRecord = await owner.line;
      delegate = spawnLaunchProtocolChild("delegate", target, {
        TOKEN: String(ownerRecord.token),
        OWNER_PID: String(ownerRecord.pid),
        EXIT_DELAY_MS: "300",
      });
      const delegateRecord = await delegate.line;
      const statusPath = join(target.stateDir, "server.lock");
      writeFileSync(
        statusPath,
        JSON.stringify({
          pid: delegateRecord.pid,
          processStart: delegateRecord.processStart,
          ownerToken: ownerRecord.token,
          projectId: target.projectId,
          projectDir: target.projectDir,
          port: 5095,
          state: "ready",
        })
      );

      const ownerExit = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await ownerExit;
      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /stopped Frizz/u);
      assert.equal(readProjectLaunchOwner(target.stateDir), null);
      assert.equal(existsSync(statusPath), false);
      await stopDisposableChild(delegate.child);
    } finally {
      await stopDisposableChild(owner.child);
      if (delegate) await stopDisposableChild(delegate.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test("workspace status rejects a reused PID generation without probing a port or signalling", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz-reused-status-generation-"));
  const target: ProjectLaunchTarget = {
    projectId: randomUUID(),
    projectDir: base,
    stateDir: join(base, "state"),
  };
  const ownerGeneration = { pid: 710, processStart: "linux:boot:owner" };
  const delegateGeneration = {
    pid: 711,
    processStart: "linux:boot:old-delegate",
  };
  let self = ownerGeneration;
  const processTable = new Map([
    [ownerGeneration.pid, ownerGeneration.processStart],
    [delegateGeneration.pid, delegateGeneration.processStart],
  ]);
  const adapter: ProcessPlatformAdapter = {
    current: () => self,
    observe: (pid) => {
      const processStart = processTable.get(pid);
      return processStart
        ? { processStart, confidence: "exact" }
        : { confidence: "unavailable" };
    },
    isAlive: (pid) => processTable.has(pid),
    now: () => Date.now(),
    sleep: () => {},
  };
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter });
  self = delegateGeneration;
  const delegate = registerProjectLaunchDelegate(
    target,
    owner.token,
    "control-plane",
    { adapter }
  );
  self = ownerGeneration;
  const status = {
    pid: delegate.pid,
    processStart: delegate.processStart,
    publisherToken: randomUUID(),
    ownerToken: owner.token,
    projectId: target.projectId,
    projectDir: target.projectDir,
    port: 5098,
    state: "ready",
  };
  try {
    writeFileSync(join(target.stateDir, "server.lock"), JSON.stringify(status));
    assert.deepEqual(
      liveWorkspaceOwner(target.stateDir, target, adapter),
      status
    );

    processTable.set(delegate.pid, "linux:boot:reused-delegate");
    assert.equal(liveWorkspaceOwner(target.stateDir, target, adapter), null);

    const legacyState = join(base, "legacy-state");
    mkdirSync(legacyState);
    writeFileSync(
      join(legacyState, "server.lock"),
      JSON.stringify({
        pid: delegate.pid,
        processStart: delegate.processStart,
        port: 5097,
        state: "ready",
      })
    );
    assert.equal(liveWorkspaceOwner(legacyState, undefined, adapter), null);
  } finally {
    delegate.release();
    owner.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test("workspace status compares a stored generation with a real disposable process", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "frizz-real-status-generation-"));
  const child = spawnChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    {
      stdio: "ignore",
    }
  );
  try {
    assert.ok(child.pid);
    let observed = defaultProcessPlatformAdapter.observe(child.pid);
    const deadline = Date.now() + 2_000;
    while (!observed.processStart && Date.now() < deadline) {
      await delay(10);
      observed = defaultProcessPlatformAdapter.observe(child.pid);
    }
    if (!observed.processStart || observed.confidence === "unavailable") {
      // linux, darwin and win32 all read an external process's birth, so a skip on one of them is a
      // regression in that branch rather than a platform limit — fail instead of going quiet.
      assert.ok(
        !["darwin", "linux", "win32"].includes(process.platform),
        `${process.platform} must observe an external process generation`
      );
      t.skip("this platform cannot observe an external process generation");
      return;
    }

    const path = join(base, "server.lock");
    const stale = {
      pid: child.pid,
      processStart: `${observed.processStart}-prior-generation`,
      port: 5096,
      state: "ready",
    };
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(liveWorkspaceOwner(base), null);

    const current = { ...stale, processStart: observed.processStart };
    writeFileSync(path, JSON.stringify(current));
    assert.deepEqual(liveWorkspaceOwner(base), current);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise<void>((resolveClose) =>
      child.once("close", () => resolveClose())
    );
    rmSync(base, { recursive: true, force: true });
  }
});

test("port selection prefers the well-known port over a remembered one, and JUMPS rather than scanning past it", async () => {
  const used = new Set([DEFAULT_PORT, 19393, 19394]);
  const available = async (port: number) => !used.has(port);
  // The well-known port wins even when this project remembers a different one that is free: one
  // server serves the machine, so the address is not the launching project's to choose.
  assert.equal(await choosePort(undefined, 9999, async () => true), DEFAULT_PORT);
  assert.equal(await choosePort(undefined, undefined, async () => true), DEFAULT_PORT);
  // A remembered port is still the SECOND candidate, so an old bookmark resolves when 9393 is taken.
  assert.equal(await choosePort(undefined, 9999, available), 9999);
  // THE POINT: with both taken the next candidate is 19393, never 9394. Windows reserves ports in
  // contiguous 100-port blocks, so a +1 scan burns every candidate inside the same reservation and
  // then reports "no free port" with tens of thousands free.
  assert.equal(await choosePort(undefined, undefined, available), 19395);
  await assert.rejects(choosePort(DEFAULT_PORT, undefined, available), /already in use/);
});

test("the dev server has its own well-known port, so frizz-dev never fights the singleton for 9393", async () => {
  assert.notEqual(DEFAULT_DEV_PORT, DEFAULT_PORT);
  assert.equal(
    await choosePort(undefined, undefined, async () => true, DEFAULT_DEV_PORT),
    DEFAULT_DEV_PORT
  );
  assert.equal(
    await choosePort(undefined, undefined, async (port) => port !== DEFAULT_DEV_PORT, DEFAULT_DEV_PORT),
    19494
  );
});

test("a health probe can name the project it is asking about", async () => {
  const asked: string[] = [];
  const answer = (body: Record<string, unknown>) =>
    (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  const healthy = { ok: true, projectId: "beta-id", projectDir: "/repos/beta", bootId: "b1" };

  // Unprefixed asks the launching project, exactly as before.
  assert.ok(
    await probeFrizz(9393, { projectId: "beta-id", projectDir: "/repos/beta" }, answer(healthy))
  );
  assert.match(asked[0], /\/_frizz\/health$/);

  // A slug asks THAT project. The server answers it from the registry without opening the project,
  // so asking is no longer opening — see registeredTenantHealth.
  assert.ok(
    await probeFrizz(9393, { projectId: "beta-id", projectDir: "/repos/beta", slug: "beta" }, answer(healthy))
  );
  assert.match(asked[1], /\/_frizz\/beta\/health$/);

  // The identity gate is unchanged: a server serving someone else is refused, slug or no slug.
  assert.equal(
    await probeFrizz(9393, { projectId: "alpha-id", projectDir: "/repos/alpha", slug: "beta" }, answer(healthy)),
    null
  );
});

// THE REGRESSION: the join probe ran on the same 1s budget as "is the server I just started up yet",
// against a route that could take seconds. Two runs of `frizz dev` in one directory seven minutes
// apart, 2026-08-12: the first answered in 943ms and joined, the second took 1052ms and started a
// second Frizz on a second port. Whether the machine ends up with one scheduler or two must not be
// decided by a coin flip, so the join gets a budget sized for a server that is genuinely busy.
test("the join probe outwaits a busy server instead of starting a rival one", async () => {
  const healthy = { ok: true, projectId: "beta-id", projectDir: "/repos/beta", bootId: "b1" };
  const expected = { projectId: "beta-id", projectDir: "/repos/beta", slug: "beta" };
  // A server that answers correctly, just not within the liveness budget.
  const slow = (delayMs: number) =>
    ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(JSON.stringify(healthy), { headers: { "content-type": "application/json" } })),
          delayMs
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;

  assert.ok(JOIN_PROBE_TIMEOUT_MS > HEALTH_PROBE_TIMEOUT_MS);
  // A budget shorter than the server's answer gives up on it — this is the bug, pinned.
  assert.equal(await probeFrizz(9494, expected, slow(60), 20), null);
  // The join budget waits it out and joins.
  assert.ok(await probeFrizz(9494, expected, slow(60), 5_000));
});

test("a port held by a system reservation is not reported as a port in use", () => {
  // EACCES means nothing is listening — netstat shows the port free and bind() still fails — so
  // "already in use" sends people hunting a process that does not exist.
  const reserved = portUnavailableMessage(DEFAULT_PORT, "EACCES");
  assert.match(reserved, /reserved by the system/);
  assert.match(reserved, /excludedportrange/);
  assert.doesNotMatch(reserved, /already in use/);
  assert.match(portUnavailableMessage(DEFAULT_PORT, "EADDRINUSE"), /already in use/);
  assert.match(portUnavailableMessage(DEFAULT_PORT), /already in use/);
});

test("a bind probe reports why it failed, not merely that it did", async () => {
  const held = createServer();
  await new Promise<void>((done) => held.listen(0, "127.0.0.1", () => done()));
  const port = (held.address() as AddressInfo).port;
  try {
    assert.equal(await probeBindPort(port, "127.0.0.1"), "EADDRINUSE");
    assert.equal(await canBindPort(port, "127.0.0.1"), false);
  } finally {
    await new Promise<void>((done) => held.close(() => done()));
  }
  assert.equal(await probeBindPort(port, "127.0.0.1"), undefined);
});

test("two distinct repositories concurrently reserve different launch ports without sharing launch ownership", async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz-concurrent-repo-ports-"));
  const home = join(base, "home");
  const repos = [join(base, "repo-one"), join(base, "repo-two")];
  for (const repo of repos) {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
  }
  const reservations: Array<{ workspace: Workspace; port: number; close: () => Promise<void> }> = [];
  try {
    await Promise.all(
      repos.map(async (repo) => {
        const workspace = resolveWorkspace(repo, home);
        const release = await acquireGlobalLaunchLock(home, 5_000);
        try {
          const port = await choosePort(undefined, readPreferredPort(workspace.stateDir));
          const server = createServer();
          await new Promise<void>((resolveListen, rejectListen) => {
            server.once("error", rejectListen);
            server.listen(port, "127.0.0.1", () => resolveListen());
          });
          reservations.push({
            workspace,
            port,
            close: () =>
              new Promise((resolveClose, rejectClose) =>
                server.close((error) => (error ? rejectClose(error) : resolveClose()))
              ),
          });
        } finally {
          // This mirrors the foreground launcher: serialize only allocation/startup, never runtime.
          release();
        }
      })
    );
    assert.equal(reservations.length, 2);
    assert.equal(new Set(reservations.map(({ port }) => port)).size, 2);
    assert.equal(new Set(reservations.map(({ workspace }) => workspace.id)).size, 2);
  } finally {
    await Promise.all(reservations.map(({ close }) => close()));
    rmSync(base, { recursive: true, force: true });
  }
});

test("concurrent allocators never choose the same port, even while both probe it as free", async () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-port-allocation-"));
  try {
    // Every port answers "free" to BOTH callers. That is exactly the bind-and-close TOCTOU window
    // canBindPort leaves open, and the reason allocation cannot rely on the probe alone once the
    // global lock stops spanning the child's boot.
    const available = async () => true;
    const reserve = (port: number) => tryReservePort(port, home);
    const [first, second] = await Promise.all([
      allocatePort(undefined, 4919, { available, reserve }),
      allocatePort(undefined, 4919, { available, reserve }),
    ]);
    assert.notEqual(first.port, second.port);
    assert.equal([first.port, second.port].includes(4919), true);

    // A released reservation is immediately reusable, so a restart keeps its remembered port.
    const reclaimed = first.port;
    first.release();
    const third = await allocatePort(undefined, reclaimed, { available, reserve });
    assert.equal(third.port, reclaimed);
    third.release();
    second.release();

    // A rejected explicit port must not leave its reservation behind.
    await assert.rejects(
      allocatePort(4917, undefined, { available: async () => false, reserve }),
      /already in use/
    );
    const afterFailure = tryReservePort(4917, home);
    assert.ok(afterFailure, "a failed explicit allocation leaked its reservation");
    afterFailure();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a port reservation is exclusive while its owner lives and reclaimed once it dies", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-port-reservation-"));
  try {
    const held = tryReservePort(4919, home);
    assert.ok(held);
    assert.equal(tryReservePort(4919, home), undefined);
    held();
    assert.equal(existsSync(portReservationPath(4919, home)), false);

    // A launcher killed mid-boot leaves its claim on disk; the next allocation must reclaim it
    // rather than skipping that port forever.
    mkdirSync(join(frizzPaths({ home }).state, "ports"), { recursive: true });
    writeFileSync(
      portReservationPath(4919, home),
      JSON.stringify({ pid: 999_999_999 })
    );
    const reclaimed = tryReservePort(4919, home);
    assert.ok(reclaimed, "a dead launcher's port reservation was never reclaimed");
    reclaimed();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a booting repository holds only its port reservation, never the machine-global lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-launch-serialization-"));
  try {
    const available = async () => true;
    const reserve = (port: number) => tryReservePort(port, home);

    const releaseFirst = await acquireGlobalLaunchLock(home, 5_000);
    const first = await allocatePort(undefined, undefined, { available, reserve });
    // The launcher releases the machine-global lock the moment allocation is done. Everything after
    // it — spawning the child and waiting out a progress-tracked boot that may run for minutes — is
    // guarded by the reservation alone. Holding the lock that long is what failed a third repository
    // launched in quick succession.
    releaseFirst();

    // So a second repository starting mid-boot takes the lock immediately, not after a boot-length
    // wait. The tiny budget is the assertion: it cannot pass if the first launch still held the lock.
    const releaseSecond = await acquireGlobalLaunchLock(home, 30);
    const second = await allocatePort(undefined, undefined, { available, reserve });
    releaseSecond();

    assert.notEqual(first.port, second.port);
    first.release();
    second.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspace lock parsing removes stale owners and retains a live supervisor", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-lock-test-"));
  try {
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: 999_999_999, port: 5000 })
    );
    assert.equal(liveWorkspaceOwner(dir), null);
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: process.pid, port: 0 })
    );
    assert.equal(liveWorkspaceOwner(dir), null);
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: process.pid, port: 5001, state: "ready" })
    );
    assert.deepEqual(liveWorkspaceOwner(dir), {
      pid: process.pid,
      port: 5001,
      state: "ready",
    });
    writeFileSync(join(dir, "launcher.json"), JSON.stringify({ port: 5001 }));
    assert.equal(readPreferredPort(dir), 5001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status treats failed or degraded supervisor truth as actionable even with a healthy prior child", () => {
  assert.equal(supervisorNeedsAttention(null), false);
  assert.equal(
    supervisorNeedsAttention({ pid: process.pid, port: 5001, state: "ready" }),
    false
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "restarting",
    }),
    false
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "failed",
      message: "config invalid",
    }),
    true
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "degraded",
      message: "watch failed",
    }),
    true
  );
});

test("global allocation lock is exclusive and recovers stale, partial, and crashed claims", async () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-global-lock-"));
  const homeAlias = `${home}-alias`;
  try {
    symlinkSync(home, homeAlias);
    const lockPath = join(home, ".frizz", "dev-launch.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 999_999_999 })
    );
    const release = await acquireGlobalLaunchLock(homeAlias);
    await assert.rejects(acquireGlobalLaunchLock(home, 30), /still owns/);
    release();

    // A process can die after atomically claiming the pathname but before its JSON is complete.
    writeFileSync(lockPath, '{"version":1');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const releasePartial = await acquireGlobalLaunchLock(home);
    releasePartial();

    // A fully-written owner from a process that exited without releasing is recoverable immediately.
    const crashSource = `
      import { acquireGlobalLaunchLockSync } from ${JSON.stringify(
        projectIdentityModuleUrl
      )}
      acquireGlobalLaunchLockSync(process.argv[1])
    `;
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", crashSource, home],
      { cwd: uiRoot }
    );
    assert.equal(existsSync(lockPath), true);
    const releaseCrashed = await acquireGlobalLaunchLock(home);
    releaseCrashed();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(homeAlias, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("separate repositories prepare concurrently while global startup allocation is held", async () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-global-launch-sequencing-"));
  let first: { prepared: string; release: () => void } | undefined;
  let second: { prepared: string; release: () => void } | undefined;
  try {
    first = await prepareBeforeGlobalLaunchLock(
      () => "repo-a artifact prepared",
      () => acquireGlobalLaunchLock(home)
    );

    let markSecondPrepared: (() => void) | undefined;
    const secondPrepared = new Promise<void>((resolve) => {
      markSecondPrepared = resolve;
    });
    const secondLaunch = prepareBeforeGlobalLaunchLock(
      () => {
        markSecondPrepared?.();
        return "repo-b artifact prepared";
      },
      () => acquireGlobalLaunchLock(home)
    );

    // Repo B reaches its completed preparation even though repo A still owns the only shared
    // allocation/start lock. It remains blocked only at acquisition.
    await secondPrepared;
    let secondAcquired = false;
    void secondLaunch.then((value) => {
      secondAcquired = true;
      second = value;
    });
    await delay(50);
    assert.equal(secondAcquired, false);

    first.release();
    first = undefined;
    second = await secondLaunch;
    assert.equal(second.prepared, "repo-b artifact prepared");
  } finally {
    second?.release();
    first?.release();
    rmSync(home, { recursive: true, force: true });
  }
});

test("global first-id lock rejects a reused PID generation instead of blocking on PID-only liveness", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-global-generation-lock-"));
  const lockPath = join(home, ".frizz", "dev-launch.lock");
  mkdirSync(join(home, ".frizz"), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: 700,
      processStart: "linux:boot:old",
      token: randomUUID(),
      at: new Date().toISOString(),
    })
  );
  const adapter: ProcessPlatformAdapter = {
    current: () => ({ pid: 701, processStart: "linux:boot:701" }),
    observe: (pid) =>
      pid === 700
        ? { processStart: "linux:boot:reused", confidence: "exact" }
        : { processStart: "linux:boot:701", confidence: "exact" },
    isAlive: () => true,
    now: () => Date.now(),
    sleep: () => {},
  };
  try {
    const release = acquireGlobalLaunchLockSync(home, 100, adapter);
    assert.equal(existsSync(lockPath), true);
    release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- installer shim shape (scripts/install-global-cli.mjs) -------------------------------------
//
// The installed shim's NAME and BODY are both per-platform, because a `#!` line is not a command on
// Windows: cmd.exe resolves a bare `frizz-dev` on PATH only through %PATHEXT%, and honours no
// shebang, so the installer writes `frizz-dev.cmd` there and a `#!/bin/sh` file everywhere else.
// These helpers pin the shape actually written on the running platform — asserting the POSIX one
// everywhere is what let an unrunnable shim pass as installed.
const windowsShim = process.platform === "win32";
const shimName = windowsShim ? "frizz-dev.cmd" : "frizz-dev";
// The shim embeds a REAL absolute path, so the separator is the platform's own. Build the pattern
// from `sep` rather than loosening it to `.`: a shim aimed at `src.index.ts` must still fail.
const shimEntry = new RegExp(`\\${sep}src\\${sep}index\\.ts`);
/** Same shape, no ownership marker — a foreign command that happens to sit at the shim's path. */
const foreignShim = (line: string) =>
  windowsShim ? `@echo off\r\n${line}\r\n` : `#!/bin/sh\n${line}\n`;
/** A marker-bearing shim of `version` aimed at `entry` — i.e. one this installer wrote, once. */
const ownedShim = (version: string, entry: string) =>
  windowsShim
    ? `@echo off\r\nrem # frizz-dev-source-launcher:${version}\r\nsetlocal\r\nset "FRIZZ_SOURCE_COMMAND=frizz-dev"\r\nnub --no-env-file "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\n# frizz-dev-source-launcher:${version}\nexec env FRIZZ_SOURCE_COMMAND='frizz-dev' nub --no-env-file '${entry}' "$@"\n`;
/** Node refuses to spawn a `.bat`/`.cmd` without a shell (CVE-2024-27980), so Windows needs one. */
const runShim = (shim: string, shimArgs: string[]) =>
  windowsShim
    ? execFileSync(`"${shim}"`, shimArgs, { encoding: "utf8", shell: true })
    : execFileSync(shim, shimArgs, { encoding: "utf8" });

test("installer manages only an executable source-backed immutable frizz-dev shim idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-global-bin-"));
  const script = join(import.meta.dirname, "..", "scripts", "install-global-cli.mjs");
  try {
    execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    const shim = join(dir, shimName);
    const body = readFileSync(shim, "utf8");
    assert.match(body, /frizz-dev-source-launcher:v5/);
    // Only nub's disk-read `.env*` vars are dropped; a shell-exported key still reaches the worker.
    assert.match(body, /nub --no-env-file/);
    // `setlocal` is batch's `env VAR=…`: the variable dies with the shim instead of leaking into
    // the console that ran it.
    assert.match(
      body,
      windowsShim ? /setlocal\r\nset "FRIZZ_SOURCE_COMMAND=frizz-dev"/ : /FRIZZ_SOURCE_COMMAND='frizz-dev'/
    );
    assert.match(body, shimEntry);
    assert.match(body, /\bnub\b/);
    assert.match(runShim(shim, ["--help"]), /Frizz source launcher/);
    assert.match(
      execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }),
      /frizz-dev:install/
    );
    assert.match(
      execFileSync(process.execPath, [script, "--check", `--bin-dir=${dir}`], {
        encoding: "utf8",
      }),
      /installed Frizz development source launcher/
    );
    execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(
      readFileSync(shim, "utf8"),
      body,
      "a repeat install keeps the owned shim stable"
    );
    execFileSync(
      process.execPath,
      [script, "--uninstall", `--bin-dir=${dir}`],
      { encoding: "utf8" }
    );
    assert.equal(existsSync(shim), false);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [script, "--check", `--bin-dir=${dir}`],
          { encoding: "utf8", stdio: "pipe" }
        ),
      (error: unknown) => {
        assert.match(
          String((error as { stderr?: unknown }).stderr),
          /not installed/
        );
        return true;
      }
    );

    writeFileSync(shim, foreignShim("echo unrelated"));
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error: unknown) => {
        assert.match(
          String((error as { stderr?: unknown }).stderr),
          /already exists and is not/
        );
        return true;
      }
    );
    execFileSync(
      process.execPath,
      [script, "--uninstall", `--bin-dir=${dir}`],
      { encoding: "utf8" }
    );
    assert.equal(
      existsSync(shim),
      true,
      "uninstall leaves unrelated commands alone"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer upgrades its OWN current-marker shim when the checkout path moved", () => {
  // Moving the checkout — or moving the CLI inside it, as the root-package layout did — changes the
  // path embedded in the shim. Ownership is the MARKER, so this is an upgrade, not a foreign file:
  // comparing the whole body made the installer refuse to replace a launcher it had written itself,
  // reporting "is not the Frizz source launcher" about a file whose first comment line is that marker.
  const dir = mkdtempSync(join(tmpdir(), "frizz-global-bin-moved-"));
  const script = join(import.meta.dirname, "..", "scripts", "install-global-cli.mjs");
  const shim = join(dir, shimName);
  const movedFrom = join(sep === "\\" ? "C:\\old" : "/old", "checkout", "packages", "cli", "src", "index.ts");
  try {
    writeFileSync(shim, ownedShim("v5", movedFrom), { mode: 0o755 });
    // No --force: the marker makes it ours to replace.
    execFileSync(process.execPath, [script, `--bin-dir=${dir}`], { encoding: "utf8" });
    const body = readFileSync(shim, "utf8");
    assert.match(body, shimEntry);
    assert.doesNotMatch(body, new RegExp(`old\\${sep}checkout`));
    execFileSync(process.execPath, [script, "--uninstall", `--bin-dir=${dir}`], { encoding: "utf8" });
    assert.equal(existsSync(shim), false, "uninstall removes a shim we own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer rejects marker-bearing stale or altered shims", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-global-bin-stale-"));
  const script = join(import.meta.dirname, "..", "scripts", "install-global-cli.mjs");
  const shim = join(dir, shimName);
  try {
    writeFileSync(
      shim,
      ownedShim("v3", join(sep === "\\" ? "C:\\missing" : "/missing", "deleted-index.ts")),
      { mode: 0o755 }
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, "--check", `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /not installed/
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /already exists and is not/
    );
    execFileSync(process.execPath, [script, "--uninstall", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(existsSync(shim), true, "uninstall leaves invalid shims alone");
    execFileSync(process.execPath, [script, "--force", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.match(readFileSync(shim, "utf8"), shimEntry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forced install replaces a symlink itself without changing its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-global-bin-symlink-"));
  const script = join(import.meta.dirname, "..", "scripts", "install-global-cli.mjs");
  const shim = join(dir, shimName);
  const protectedTarget = join(dir, "protected-command");
  const protectedBody = foreignShim("echo protected");
  try {
    writeFileSync(protectedTarget, protectedBody, { mode: 0o755 });
    symlinkSync(protectedTarget, shim);
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /already exists and is not/
    );
    assert.equal(readFileSync(protectedTarget, "utf8"), protectedBody);
    execFileSync(process.execPath, [script, "--force", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(readFileSync(protectedTarget, "utf8"), protectedBody);
    assert.match(readFileSync(shim, "utf8"), /frizz-dev-source-launcher:v5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent installer processes publish only complete shims and clean up temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-global-bin-atomic-"));
  const script = join(import.meta.dirname, "..", "scripts", "install-global-cli.mjs");
  try {
    // Capture stderr rather than discarding it: `stdio: "ignore"` made a real Windows failure here
    // report only "installer exited with null" — the signal, which is null for every ordinary exit —
    // while the errno that would have named the cause went to nowhere.
    const children = Array.from({ length: 8 }, () =>
      spawnChild(process.execPath, [script, `--bin-dir=${dir}`], {
        stdio: ["ignore", "ignore", "pipe"],
      })
    );
    const stderr = children.map((child) => {
      let text = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        text += chunk;
      });
      return () => text;
    });
    const results = await Promise.all(children.map((child) => once(child, "exit")));
    results.forEach(([code, signal], index) => {
      assert.equal(
        code,
        0,
        `installer exited with code ${String(code)} signal ${String(signal)}: ${stderr[index]!().trim() || "<no stderr>"}`
      );
    });
    const shim = readFileSync(join(dir, shimName), "utf8");
    assert.match(shim, /frizz-dev-source-launcher:v5/);
    assert.match(shim, shimEntry);
    assert.deepEqual(readdirSync(dir), [shimName]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A port with nothing listening on it, so /health can only ever fail to connect.
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

// ---- progress-tracked launch wait (boot-progress.ts) -------------------------------------------
// The flat 30s deadline conflated "something is wrong" with "this board is big and this machine is
// busy": the maintainer's own board tripped it on every launch while a perfectly healthy child kept
// booting behind the failure message. These pin the replacement contract.

test("waitForWorkspace: a boot that keeps reporting progress outlives the stall window", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-bootprogress-"));
  const port = await freePort();
  try {
    // Advance the published step every 40ms — well inside the 120ms stall window, indefinitely.
    let step = 0;
    const ticking = setInterval(() => {
      step++;
      writeFileSync(
        join(stateDir, "boot.progress"),
        JSON.stringify({ pid: process.pid, step, phase: `tailer producer ${step * 20}/5000`, at: new Date().toISOString() })
      );
    }, 40);
    const waiting = waitForWorkspace(port, { projectId: "p", projectDir: "/p" }, 120, { stateDir });
    // A flat 120ms deadline would have fired several times over by now.
    await delay(700);
    clearInterval(ticking);
    await assert.rejects(waiting, /stopped making progress/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("waitForWorkspace: a boot that STOPS reporting fails inside the stall window, naming its last step", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-bootprogress-"));
  const port = await freePort();
  try {
    writeFileSync(
      join(stateDir, "boot.progress"),
      JSON.stringify({ pid: process.pid, step: 3, phase: "board producer", at: new Date().toISOString() })
    );
    const started = Date.now();
    await assert.rejects(
      waitForWorkspace(port, { projectId: "p", projectDir: "/p" }, 300, { stateDir }),
      /last reported boot step was "board producer"/
    );
    assert.ok(Date.now() - started < 3_000, "a stalled boot must not be waited out to the hard cap");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("waitForWorkspace: with no state dir the historical flat deadline is unchanged", async () => {
  const port = await freePort();
  const started = Date.now();
  await assert.rejects(
    waitForWorkspace(port, { projectId: "p", projectDir: "/p" }, 250),
    /did not become healthy/
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 3_000, `flat deadline honored (waited ${waited}ms)`);
});





/**
 * The launch policy, which is the whole behaviour of typing `frizz` somewhere.
 *
 * Untested until 2026-08-11, and the gap showed: running it in a fresh checkout opened the LAST
 * project instead of that checkout. Each case below is one directory the operator can be standing in.
 */
test("launch intent: a directory Frizz already knows opens its own board", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz launch intent known "));
  const home = join(base, "home");
  const other = join(base, "other repo");
  const repo = join(base, "known repo");
  const plain = join(base, "notes");
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(plain, { recursive: true });
    execFileSync("git", ["init", "-q", other]);
    execFileSync("git", ["init", "-q", repo]);
    // Known from the REGISTRY alone, with another project opened more recently — the state in which
    // the wrong board used to win.
    const known = resolveWorkspace(repo, home);
    registerProject({ dir: known.root, id: known.id }, home);
    const recent = resolveWorkspace(other, home);
    registerProject({ dir: recent.root, id: recent.id }, home);

    const intent = resolveLaunchIntent(repo, home, {});
    assert.ok(intent.kind === "open");
    assert.equal(intent.workspace.id, known.id);
    // A sub-directory of that repository is the same board, not a second one.
    const child = join(repo, "packages", "web");
    mkdirSync(child, { recursive: true });
    const sub = resolveLaunchIntent(child, home, {});
    assert.ok(sub.kind === "open");
    assert.equal(sub.workspace.id, known.id);

    // Known from `.frizz/.id` alone: a folder added once and since dropped from the registry file.
    writeFileSync(join(plain, "todo.md"), "");
    const adopted = resolveWorkspace(plain, home);
    const again = resolveLaunchIntent(plain, home, {});
    assert.ok(again.kind === "open");
    assert.equal(again.workspace.id, adopted.id);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Maintainer 2026-10-10: "If the folder that you run it in is not a pre-existing Frizz project, it
// should just bring you to the root of the dashboard." A repository was adopted on sight until then.
test("launch intent: a repository Frizz has not seen lands on the dashboard, offered and unadopted", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz launch intent repo "));
  const home = join(base, "home");
  const host = join(base, "host repo");
  const fresh = join(base, "fresh repo");
  try {
    mkdirSync(home, { recursive: true });
    execFileSync("git", ["init", "-q", host]);
    execFileSync("git", ["init", "-q", fresh]);
    const hosted = resolveWorkspace(host, home);
    registerProject({ dir: hosted.root, id: hosted.id }, home);

    const intent = resolveLaunchIntent(join(fresh), home, {});
    assert.ok(intent.kind === "offer");
    assert.equal(intent.directory, realpathSync(fresh));
    assert.equal(isHostWorkspace(intent.workspace, home), true, "never hosted on another project");
    assert.equal(existsSync(join(fresh, ".frizz")), false);
    assert.equal(listProjects(home).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("launch intent: an unmarked directory and $HOME land on the dashboard and are not asked about", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz launch intent bare "));
  const home = join(base, "home");
  const host = join(base, "host repo");
  const bare = join(home, "Documents");
  try {
    mkdirSync(bare, { recursive: true });
    // Home directories carry manifests all the time — a package.json, a Makefile. That makes $HOME
    // no more a project than `~/Documents`, and the dashboard's own add refuses it anyway.
    writeFileSync(join(home, "package.json"), "{}\n");
    execFileSync("git", ["init", "-q", host]);
    const hosted = resolveWorkspace(host, home);
    registerProject({ dir: hosted.root, id: hosted.id }, home);

    for (const cwd of [bare, home]) {
      const intent = resolveLaunchIntent(cwd, home, {});
      assert.ok(intent.kind === "grid", cwd);
      // Not the registered project: a board borrowed from it stopped restarting once that folder
      // was deleted, which nobody who typed `frizz` in $HOME had any reason to expect (2026-10-11).
      assert.equal(isHostWorkspace(intent.workspace, home), true, cwd);
      assert.equal(existsSync(join(cwd, ".frizz")), false, cwd);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A new user's first `npx frizz` is typed in a fresh terminal — $HOME — or in ~/Documents, on a
// machine with no project to host the server on. It used to end in "cd into a repository and run
// frizz there".
test("launch intent: with no project at all, every directory still reaches the dashboard", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz launch intent first "));
  const home = join(base, "home");
  const documents = join(home, "Documents");
  const repo = join(home, "code", "acme");
  try {
    mkdirSync(documents, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);

    const fromHome = resolveLaunchIntent(home, home, {});
    assert.ok(fromHome.kind === "grid");
    const fromDocuments = resolveLaunchIntent(documents, home, {});
    assert.ok(fromDocuments.kind === "grid");
    const fromRepo = resolveLaunchIntent(repo, home, {});
    assert.ok(fromRepo.kind === "offer");
    assert.equal(fromRepo.directory, realpathSync(repo));

    // ONE stand-in host, Frizz's own folder, the same on every launch — and never a project: no
    // directory the operator was standing in is written to, and the registry stays empty.
    const host = hostWorkspace(home);
    assert.equal(host.root, realpathSync(launchHostDir(home)));
    assert.equal(isHostWorkspace(host, home), true);
    for (const intent of [fromHome, fromDocuments, fromRepo]) assert.deepEqual(intent.workspace, host);
    for (const dir of [home, documents, repo]) assert.equal(existsSync(join(dir, ".frizz")), false, dir);
    assert.equal(registerProject({ dir: host.root, id: host.id }, home).entry, undefined);
    assert.equal(listProjects(home).length, 0);

    // A real project never replaces it: only a launch typed inside that project is hosted there.
    const first = resolveWorkspace(repo, home);
    registerProject({ dir: first.root, id: first.id }, home);
    const later = resolveLaunchIntent(documents, home, {});
    assert.ok(later.kind === "grid");
    assert.deepEqual(later.workspace, host);
    const inside = resolveLaunchIntent(repo, home, {});
    assert.ok(inside.kind === "open");
    assert.equal(inside.workspace.id, first.id);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a launcher asks the running server where it lands, and decides for itself only when it cannot", async () => {
  const seen: Array<{ url: string; method?: string; token: string | null; origin: string | null; body: unknown }> = [];
  const answering = (...responses: Array<Response | Error>): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), method: init?.method, token: headers.get("x-frizz-launch-token"), origin: headers.get("origin"), body: JSON.parse(String(init?.body)) });
      const next = responses.shift() ?? new Response("gone", { status: 500 });
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const route = await askLaunchRoute(9393, "owner-token", "/code/app/src", {
    fetcher: answering(answer({ protocol: 1, path: "/project/app", project: { name: "app", dir: "/code/app" } })),
  });
  assert.deepEqual(route, { path: "/project/app", project: { name: "app", dir: "/code/app" } });
  // No Origin: a launcher is not a browser, and the token is the whole of what it is known by.
  assert.deepEqual(seen, [{
    url: "http://127.0.0.1:9393/_frizz/control/launch", method: "POST", token: "owner-token", origin: null,
    body: { protocol: 1, dir: "/code/app/src" },
  }]);

  // The public listener is up before the server behind it: wait a restart out, briefly.
  const recovering = answering(new Response("starting", { status: 503 }), new Response("starting", { status: 503 }), answer({ protocol: 1, path: "/" }));
  assert.deepEqual(await askLaunchRoute(9393, "t", "/x", { fetcher: recovering }), { path: "/" });
  assert.equal(await askLaunchRoute(9393, "t", "/x", { fetcher: answering(new Response("starting", { status: 503 })), patienceMs: 0 }), undefined);

  // Every other answer means "decide it here": a server from before the route, a refusal, a server
  // that is gone, an answer in another protocol, and a path that is not one of this origin's.
  for (const response of [
    new Response("Forbidden", { status: 403 }), new Response("Not found", { status: 404 }), new Error("ECONNREFUSED"),
    answer({ protocol: 2, path: "/" }), answer({ protocol: 1, path: "//evil.example/" }), new Response("<!doctype html>", { status: 200 }),
  ])
    assert.equal(await askLaunchRoute(9393, "t", "/x", { fetcher: answering(response) }), undefined);
});

test("boardAddress: a bare origin gains a slash, a grid or an offer does not", () => {
  assert.equal(boardAddress("http://127.0.0.1:9494"), "http://127.0.0.1:9494/");
  assert.equal(boardAddress("http://127.0.0.1:9494/project/frizz"), "http://127.0.0.1:9494/project/frizz/");
  // The grid is already `/`, and `//` reads as a typo in the one line the operator clicks.
  assert.equal(boardAddress("http://127.0.0.1:9494/"), "http://127.0.0.1:9494/");
  // A slash here lands INSIDE the query, changing the directory the page is asked about.
  assert.equal(boardAddress("http://127.0.0.1:9494/?add=%2Ftmp%2Fx"), "http://127.0.0.1:9494/?add=%2Ftmp%2Fx");
});

test("an update re-execs with the port alone; how the board is reached lives in the saved setup", () => {
  assert.deepEqual(durableReexecArgs({ entry: "/opt/frizz/src/index.js", port: 9393 }), ["/opt/frizz/src/index.js", "--port", "9393"]);
});

test("--sessions and --sign-out are parsed, in both the spaced and the = spelling", () => {
  assert.equal(parseCliArgs(["--sessions"]).sessions, true);
  assert.equal(parseCliArgs(["--sign-out", "abc123"]).signOut, "abc123");
  assert.equal(parseCliArgs(["--sign-out=abc123"]).signOut, "abc123");
  assert.equal(parseCliArgs(["--sign-out", "all"]).signOut, "all");
  // Absent rather than empty, so a caller can tell "not asked for" from "asked for nothing".
  assert.equal(parseCliArgs([]).signOut, undefined);
});

test("--sign-out without a device id is refused rather than signing everything out", () => {
  // The dangerous default. Treating a bare --sign-out as "all" would make a typo sign out every device.
  assert.throws(() => parseCliArgs(["--sign-out"]), /requires a device id/);
  assert.throws(() => parseCliArgs(["--sign-out", "--debug"]), /requires a device id/);
  assert.throws(() => parseCliArgs(["--sign-out="]), /requires a device id/);
});

test("a device id is not mistaken for a repository path", () => {
  // The positional guard throws on any bare argument, so the value has to be consumed by the flag.
  assert.doesNotThrow(() => parseCliArgs(["--sign-out", "q7mJx_uZ"]));
});

test("--sandbox parses, refuses the running-board queries, and prepares a disposable home", () => {
  assert.equal(parseCliArgs(["--sandbox"]).sandbox, true);
  assert.equal(parseCliArgs([]).sandbox, false);
  // The query flags ask the RUNNING board; a sandbox is a fresh one by definition.
  for (const query of [["--link"], ["--status"], ["--sessions"], ["--sign-out", "abc"]]) {
    assert.throws(() => parseCliArgs(["--sandbox", ...query]), /asks the running board/);
  }

  const cwd = process.cwd();
  const env: NodeJS.ProcessEnv = {};
  const sandbox = prepareSandbox(env);
  try {
    assert.equal(env.HOME, sandbox.home);
    assert.equal(env.USERPROFILE, sandbox.home);
    assert.equal(process.cwd(), realpathSync(sandbox.project));
    // The throwaway project is one Frizz already knows, so the launch opens its board rather than
    // the dashboard — and a repository, so a worker there has somewhere to commit.
    assert.ok(existsSync(join(sandbox.project, ".git")));
    assert.equal(resolveLaunchIntent(sandbox.project, sandbox.home, env).kind, "open");
    assert.ok(sandbox.home.startsWith(realpathSync(tmpdir())) || sandbox.home.startsWith(tmpdir()));
  } finally {
    process.chdir(cwd);
    cleanupSandbox(sandbox.home);
  }
  assert.equal(existsSync(sandbox.home), false);
});

// A fresh machine has no `~/.frizz`, and frizz-paths.ts reads that directory's EXISTENCE as "legacy
// install, route every root here". Until 2026-08-28 this sharing created it on the real home just to
// have somewhere to link the identity key from — so one sandbox launch on a fresh machine (or this
// suite) silently moved every later launch off the XDG roots, and the registry, projects and database
// written there looked gone.
test("--sandbox never creates ~/.frizz on a real home that has none", () => {
  const real = mkdtempSync(join(tmpdir(), "frizz-freshhome-"));
  const env: NodeJS.ProcessEnv = {};
  const cwd = process.cwd();
  const sandbox = prepareSandbox(env, real);
  try {
    assert.equal(existsSync(join(real, ".frizz")), false, "the real home keeps its fresh-install roots");
    assert.equal(existsSync(join(sandbox.home, ".frizz")), false, "and so does the sandbox");
    // The key is still shared: a first claim from the sandbox writes through the link into the real
    // home's state root, which is what makes it the machine's key rather than a throwaway.
    assert.equal(lstatSync(claimIdentityPath(sandbox.home)).isSymbolicLink(), true);
    assert.equal(readlinkSync(claimIdentityPath(sandbox.home)), claimIdentityPath(real));
    assert.equal(existsSync(dirname(claimIdentityPath(real))), true);
  } finally {
    process.chdir(cwd);
    rmSync(sandbox.home, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// The other way a sandbox can reach the real install: a set XDG variable wins over the home in
// frizz-paths.ts, so an inherited `$XDG_DATA_HOME` would put the sandbox's registry, identity key and
// saved remote setup straight into the operator's real roots, where the exit cleanup never looks.
test("--sandbox does not inherit the operator's XDG roots", () => {
  const real = mkdtempSync(join(tmpdir(), "frizz-xdghome-"));
  const xdg = join(real, "xdg");
  const env: NodeJS.ProcessEnv = {
    XDG_DATA_HOME: join(xdg, "data"),
    XDG_STATE_HOME: join(xdg, "state"),
    XDG_CACHE_HOME: join(xdg, "cache"),
    XDG_CONFIG_HOME: join(xdg, "config"),
  };
  const cwd = process.cwd();
  const sandbox = prepareSandbox(env, real);
  try {
    for (const name of SANDBOX_DROPPED_XDG_ROOTS) assert.equal(env[name], undefined, name);
    assert.equal(env.XDG_CONFIG_HOME, join(xdg, "config"), "a root frizz-paths.ts never reads is left alone");
    // With the roots gone, every home-scoped path is contained by the sandbox home on a linux resolve.
    const paths = frizzPaths({ home: sandbox.home, platform: "linux", env });
    for (const root of [paths.data, paths.state, paths.cache]) assert.ok(root.startsWith(sandbox.home), root);
    // The operator's state root gets the directory their identity key lives in — that end of the link is
    // theirs by design (see the next test) — and nothing else; their data and cache roots are untouched.
    assert.deepEqual(readdirSync(join(xdg, "state", "frizz")), [], "only the key's directory, still empty");
    assert.equal(existsSync(join(xdg, "data")), false, "no sandbox state under the real data root");
    assert.equal(existsSync(join(xdg, "cache")), false, "no sandbox state under the real cache root");
  } finally {
    process.chdir(cwd);
    cleanupSandbox(sandbox.home);
    rmSync(real, { recursive: true, force: true });
  }
});

// Production-shaped: `prepareSandbox()` with no arguments scrubs `process.env` itself, and the identity
// link is placed by paths that read `process.env` too. Sharing before the scrub put the sandbox end of
// the link at `$XDG_STATE_HOME/frizz/identity.key` and then had the sandbox read under its own home —
// so an XDG-configured operator's sandbox minted a throwaway key on its first claim (PR #43 review).
test("--sandbox keeps the operator's XDG-rooted identity readable after the scrub", async () => {
  const real = mkdtempSync(join(tmpdir(), "frizz-xdgident-"));
  const state = join(real, "xdg", "state");
  const saved = Object.fromEntries(["HOME", "USERPROFILE", ...SANDBOX_DROPPED_XDG_ROOTS].map((name) => [name, process.env[name]]));
  const cwd = process.cwd();
  process.env.XDG_STATE_HOME = state;
  process.env.XDG_DATA_HOME = join(real, "xdg", "data");
  delete process.env.XDG_CACHE_HOME;
  let sandbox: { home: string; project: string } | undefined;
  try {
    // Minted while the roots are set, so this IS the operator's key, at the XDG path.
    const realKey = claimIdentityPath(real);
    assert.equal(realKey, join(state, "frizz", "identity.key"));
    const machine = await claimIdentityFingerprint(await loadOrCreateClaimIdentity(real));
    sandbox = prepareSandbox(undefined, real);
    assert.equal(process.env.XDG_STATE_HOME, undefined);
    const sandboxKey = claimIdentityPath(sandbox.home);
    assert.ok(sandboxKey.startsWith(sandbox.home), sandboxKey);
    assert.equal(readlinkSync(sandboxKey), realKey, "the link's source is the operator's XDG-rooted key");
    assert.equal(readFileSync(sandboxKey, "utf8"), readFileSync(realKey, "utf8"), "and the sandbox reads it where it looks");
    // A claim from the sandbox goes through that link, so it is the machine's key, not a fresh one.
    assert.equal(await claimIdentityFingerprint(await loadOrCreateClaimIdentity(sandbox.home)), machine);
  } finally {
    process.chdir(cwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sandbox) cleanupSandbox(sandbox.home);
    rmSync(real, { recursive: true, force: true });
  }
});

test("--sandbox shares credentials with the real home, but no state", () => {
  // A fake "real" home with the files the cloud screens read.
  const real = mkdtempSync(join(tmpdir(), "frizz-realhome-"));
  // The operator's own `gh` sign-in is NOT shared: the server no longer reads it.
  mkdirSync(join(real, ".config", "gh"), { recursive: true });
  writeFileSync(join(real, ".config", "gh", "hosts.yml"), "github.com:\n  user: ada\n");
  mkdirSync(join(real, ".cloudflared"), { recursive: true });
  writeFileSync(join(real, ".cloudflared", "cert.pem"), "cert");
  writeFileSync(join(real, ".cloudflared", "0000-tunnel.json"), "{}");
  writeFileSync(join(real, ".cloudflared", "frizz.yml"), "tunnel: real\n");
  mkdirSync(join(real, ".frizz"), { recursive: true });
  writeFileSync(join(real, ".frizz", "cloud.json"), JSON.stringify({ hostname: "real.example.com", serve: "external" }));
  writeFileSync(join(real, ".frizz", "identity.key"), "real-key");
  // Frizz's own GitHub credential (github-credential.ts) — the legacy root, since `.frizz` exists here.
  mkdirSync(join(real, ".frizz", "github"), { recursive: true });
  writeFileSync(join(real, ".frizz", "github", "credential.json"), '{"kind":"token","token":"t"}');

  const cwd = process.cwd();
  const env: NodeJS.ProcessEnv = {};
  const sandbox = prepareSandbox(env, real);
  try {
    // Credentials come through, live.
    assert.equal(existsSync(join(sandbox.home, ".config", "gh")), false, "the operator's gh sign-in stays out");
    const sandboxGithub = join(frizzPaths({ home: sandbox.home, env }).data, "github");
    assert.equal(readFileSync(join(sandboxGithub, "credential.json"), "utf8"), '{"kind":"token","token":"t"}');
    // A renewal writes a sibling and renames it over the file; through the linked DIRECTORY it lands
    // in the real home, so the real board never holds a spent refresh token.
    writeFileSync(join(sandboxGithub, "credential.json.tmp"), "renewed");
    renameSync(join(sandboxGithub, "credential.json.tmp"), join(sandboxGithub, "credential.json"));
    assert.equal(readFileSync(join(real, ".frizz", "github", "credential.json"), "utf8"), "renewed");
    assert.equal(readFileSync(join(sandbox.home, ".cloudflared", "cert.pem"), "utf8"), "cert");
    assert.equal(readFileSync(join(sandbox.home, ".cloudflared", "0000-tunnel.json"), "utf8"), "{}");
    assert.equal(readFileSync(claimIdentityPath(sandbox.home), "utf8"), "real-key");
    // State does not: the real remote setup and the real tunnel config stay where they are, and a
    // frizz.yml written in the sandbox lands in the sandbox.
    assert.equal(existsSync(join(sandbox.home, ".frizz", "cloud.json")), false);
    assert.equal(existsSync(join(sandbox.home, ".cloudflared", "frizz.yml")), false);
    writeFileSync(join(sandbox.home, ".cloudflared", "frizz.yml"), "tunnel: sandbox\n");
    assert.equal(readFileSync(join(real, ".cloudflared", "frizz.yml"), "utf8"), "tunnel: real\n");
  } finally {
    process.chdir(cwd);
    cleanupSandbox(sandbox.home);
    rmSync(real, { recursive: true, force: true });
  }
});

// ---- stopProjectLaunch / runningFrizzStatus: the registry launcher's --stop and --status ------------
//
// The registry launcher's farewell has said "stop it with frizz --stop" since 0.12.10 while the flag
// fell through to the join path and opened a browser tab on the board (audit 2026-09-11, finding 2).
// These pin the extracted protocol against a fake owner, status file, process table and control plane:
// a live owner is asked over token-bound HTTP; one that refuses is left alone; a provably stale one
// is reaped through the same fencing acquisition every launch uses.

/** A project owned by a fake supervisor (pid 4100) whose status file names port 5091, plus the launcher that will stop it (pid 4200). */
function ownedProjectFixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "frizz-stop-launch-"));
  const target: ProjectLaunchTarget = { projectId: randomUUID(), projectDir, stateDir: join(projectDir, "state") };
  const supervisor = { pid: 4100, processStart: "linux:boot:4100" };
  const launcher = { pid: 4200, processStart: "linux:boot:4200" };
  const processTable = new Map([[supervisor.pid, supervisor.processStart], [launcher.pid, launcher.processStart]]);
  let self = supervisor;
  const adapter: ProcessPlatformAdapter = {
    current: () => self,
    observe: (pid) => {
      const processStart = processTable.get(pid);
      return processStart ? { processStart, confidence: "exact" } : { confidence: "unavailable" };
    },
    isAlive: (pid) => processTable.has(pid),
    now: () => Date.now(),
    sleep: () => {},
  };
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter });
  self = launcher;
  const status = {
    pid: supervisor.pid,
    processStart: supervisor.processStart,
    publisherToken: randomUUID(),
    ownerToken: owner.token,
    projectId: target.projectId,
    projectDir: target.projectDir,
    port: 5091,
    state: "ready",
  };
  writeFileSync(join(target.stateDir, "dev-supervisor.lock"), JSON.stringify(status));
  const proof = projectLaunchTokenProof(target, owner.token);
  const requests: string[] = [];
  /** A control plane that answers health and status, and honours (or refuses) a token-bound stop. */
  const controlPlane = (options: { stopStatus: number; version?: string }) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      assert.match(url, /^http:\/\/127\.0\.0\.1:5091\/_frizz\//);
      if (url.endsWith("/_frizz/health")) {
        return new Response(JSON.stringify({ ok: true, projectId: target.projectId, projectDir: target.projectDir, bootId: "boot", ownerProof: proof }));
      }
      if (url.endsWith("/_frizz/control/status")) {
        return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true, ...(options.version ? { version: options.version } : {}) }));
      }
      assert.ok(url.endsWith("/_frizz/control/stop"), url);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("x-frizz-launch-token"), owner.token);
      // An accepted stop is what makes the supervisor's finally block release the owner record.
      if (options.stopStatus === 202) owner.release();
      return new Response(JSON.stringify({ accepted: options.stopStatus === 202 }), { status: options.stopStatus });
    }) as typeof fetch;
  const dispose = () => {
    try { owner.release(); } catch { /* already released by the stop */ }
    rmSync(projectDir, { recursive: true, force: true });
  };
  return { target, owner, adapter, processTable, supervisor, status, requests, controlPlane, dispose };
}

test("stopProjectLaunch asks a live owner to stop with its token and reports stopped once the record is gone", async () => {
  const fixture = ownedProjectFixture();
  try {
    const result = await stopProjectLaunch({
      stateDir: fixture.target.stateDir,
      target: fixture.target,
      adapter: fixture.adapter,
      fetcher: fixture.controlPlane({ stopStatus: 202 }),
      sleep: async () => {},
    });
    assert.deepEqual(result, { kind: "stopped", stale: false });
    assert.deepEqual(fixture.requests.map((url) => url.slice(url.indexOf("/_frizz"))), ["/_frizz/health", "/_frizz/control/stop"]);
    assert.equal(readProjectLaunchOwner(fixture.target.stateDir), null);
  } finally {
    fixture.dispose();
  }
});

test("stopProjectLaunch reports not-running when nothing owns the project", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "frizz-stop-nothing-"));
  const target: ProjectLaunchTarget = { projectId: randomUUID(), projectDir, stateDir: join(projectDir, "state") };
  try {
    assert.deepEqual(
      await stopProjectLaunch({ stateDir: target.stateDir, target, fetcher: (async () => assert.fail("no request without an owner")) as typeof fetch }),
      { kind: "not-running" },
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("stopProjectLaunch leaves a live owner that refuses the token-bound stop untouched, and never signals it", async () => {
  const fixture = ownedProjectFixture();
  try {
    await assert.rejects(
      () => stopProjectLaunch({
        stateDir: fixture.target.stateDir,
        target: fixture.target,
        adapter: fixture.adapter,
        fetcher: fixture.controlPlane({ stopStatus: 503 }),
        sleep: async () => {},
      }),
      /refused to stop a live owner without authenticated token-bound control; the owner was left untouched/,
    );
    assert.equal(readProjectLaunchOwner(fixture.target.stateDir)?.token, fixture.owner.token);
  } finally {
    fixture.dispose();
  }
});

test("stopProjectLaunch reaps a provably stale owner through the fencing acquisition rather than a signal", async () => {
  const fixture = ownedProjectFixture();
  try {
    // The supervisor's pid now belongs to a different process: the owner record is stale, and the
    // status file (which names the same generation) is ignored, so no control request is made.
    fixture.processTable.set(fixture.supervisor.pid, "linux:boot:reused");
    const result = await stopProjectLaunch({
      stateDir: fixture.target.stateDir,
      target: fixture.target,
      adapter: fixture.adapter,
      fetcher: (async () => assert.fail("a stale owner is never asked over HTTP")) as typeof fetch,
      sleep: async () => {},
    });
    assert.deepEqual(result, { kind: "stopped", stale: true });
    assert.equal(readProjectLaunchOwner(fixture.target.stateDir), null);
  } finally {
    fixture.dispose();
  }
});

test("runningFrizzStatus reports the live owner's port, pid and the version its status route serves", async () => {
  const fixture = ownedProjectFixture();
  try {
    assert.deepEqual(
      await runningFrizzStatus({ stateDir: fixture.target.stateDir, target: fixture.target, adapter: fixture.adapter, fetcher: fixture.controlPlane({ stopStatus: 503, version: "0.13.0" }) }),
      { port: 5091, pid: 4100, version: "0.13.0", state: "ready" },
    );
    // A board that answers health but not the status route (a legacy supervisor) still reports itself.
    const healthOnly = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/_frizz/health")) return fixture.controlPlane({ stopStatus: 503 })(input);
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    assert.deepEqual(
      await runningFrizzStatus({ stateDir: fixture.target.stateDir, target: fixture.target, adapter: fixture.adapter, fetcher: healthOnly }),
      { port: 5091, pid: 4100 },
    );
    // Nothing live: a stale owner is null, not a broken report.
    fixture.processTable.delete(fixture.supervisor.pid);
    assert.equal(
      await runningFrizzStatus({ stateDir: fixture.target.stateDir, target: fixture.target, adapter: fixture.adapter, fetcher: (async () => assert.fail("no probe without a live owner")) as typeof fetch }),
      null,
    );
  } finally {
    fixture.dispose();
  }
});

// One server serves every project, and it publishes its owner record under the project it was
// launched from. `frizz --stop` in another project served by that board found no record there and
// said "not running" (pullfrog on #35, 2026-09-11). The unscoped health names the host; its record
// holds the token; the stop is the host's, token-bound, and the answer names where it was launched.
test("--stop and --status from a project served by a board launched elsewhere resolve to that launch", async () => {
  const host = ownedProjectFixture();
  const otherDir = mkdtempSync(join(tmpdir(), "frizz-served-"));
  try {
    const other: ProjectLaunchTarget = { projectId: randomUUID(), projectDir: otherDir, stateDir: join(otherDir, "state") };
    mkdirSync(other.stateDir, { recursive: true });
    const fetcher = host.controlPlane({ stopStatus: 202, version: "1.3.0" });
    const stateDirFor = (projectId: string) => (projectId === host.target.projectId ? host.target.stateDir : join(otherDir, "nowhere"));
    const control = await resolveLaunchControlTarget({ stateDir: other.stateDir, target: other, fetcher, ports: [5091], stateDirFor });
    assert.equal(control.host, false);
    assert.deepEqual(control.target, host.target);
    const status = await runningFrizzStatus({ stateDir: control.stateDir, target: control.target, adapter: host.adapter, fetcher });
    assert.equal(status?.version, "1.3.0");
    const result = await stopProjectLaunch({ stateDir: control.stateDir, target: control.target, adapter: host.adapter, fetcher, sleep: async () => {} });
    assert.deepEqual(result, { kind: "stopped", stale: false });
    assert.equal(readProjectLaunchOwner(host.target.stateDir), null);
    // A project that holds its own record is its own host, whatever answers on the singleton ports.
    const hostControl = await resolveLaunchControlTarget({ stateDir: other.stateDir, target: other, fetcher: (async () => { throw new Error("never asked"); }) as typeof fetch, stateDirFor });
    assert.equal(hostControl.host, true);
  } finally {
    host.dispose();
    rmSync(otherDir, { recursive: true, force: true });
  }
});
