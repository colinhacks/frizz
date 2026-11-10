import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { frizzPaths } from "@frizz/server/frizz-paths";
import { compareReleaseVersions } from "./production-update.ts";

/** Bump the data epoch BEFORE introducing writes an older server cannot safely read. */
export const SERVER_PROTOCOL = 1;
export const SERVER_DATA_EPOCH = 1;

export interface ServerReleaseSpec {
  package: string;
  version: string;
  protocol: number;
  dataEpoch: number;
}

/** The protocol this shell can speak and the newest durable data it may open. */
export interface ServerCompatibility {
  protocol: number;
  dataEpoch: number;
}

export interface ServerGeneration extends ServerReleaseSpec {
  id: string;
  root: string;
  entry: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURRENT_COMPATIBILITY: ServerCompatibility = { protocol: SERVER_PROTOCOL, dataEpoch: SERVER_DATA_EPOCH };

function assertSpecShape(spec: ServerReleaseSpec): void {
  if (typeof spec.package !== "string" || typeof spec.version !== "string" || !PACKAGE.test(spec.package) || !VERSION.test(spec.version))
    throw new Error("invalid exact Frizz server package/version");
  if (!Number.isSafeInteger(spec.protocol) || spec.protocol < 1 || !Number.isSafeInteger(spec.dataEpoch) || spec.dataEpoch < 1)
    throw new Error("invalid Frizz server protocol/data epoch");
}

function assertSpec(spec: ServerReleaseSpec, compatibility: ServerCompatibility = CURRENT_COMPATIBILITY): void {
  assertSpecShape(spec);
  if (spec.protocol !== compatibility.protocol || spec.dataEpoch !== compatibility.dataEpoch)
    throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
}

/** Fail closed: a missing/corrupt selection must never silently downgrade a migrated database. */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Frizz server manifest");
  return value as Record<string, unknown>;
}

export function serverReleaseSpec(manifest: unknown, packageOverride?: string): ServerReleaseSpec {
  const metadata = record(record(manifest).frizzServer);
  const spec = {
    package: packageOverride ?? metadata.package,
    version: metadata.version,
    protocol: metadata.protocol,
    dataEpoch: metadata.dataEpoch,
  } as ServerReleaseSpec;
  assertSpec(spec);
  return spec;
}

/**
 * The oldest server release this shell works with, when it declares one (`frizzServer.minimum`).
 *
 * `version` is where a machine with no server starts. It says nothing about a machine that already
 * has one: the shell is fetched fresh by every `npx frizz` while the server moves only on Update, so
 * a new shell on a server several releases old is the ordinary pairing, not a rare one. A shell that
 * depends on something the server learned in a particular release names that release here, and the
 * store starts such a machine on the pinned release instead (ServerReleaseStore.load).
 *
 * The first use is 0.15.21: from 0.13.13 the shell hosts every launch outside a project on Frizz's
 * own folder (launcher.ts hostWorkspace), and an older server lists that folder on the dashboard as
 * a project named "host" (project-registry.ts registerProject learned to refuse it in 49000c91).
 */
export function serverReleaseMinimum(manifest: unknown): string | undefined {
  const metadata = record(record(manifest).frizzServer);
  const minimum = metadata.minimum;
  if (minimum === undefined) return undefined;
  if (typeof minimum !== "string" || !VERSION.test(minimum)) throw new Error("invalid minimum Frizz server version");
  // The pinned release is what a machine below the minimum is started on, so it has to satisfy it.
  const order = typeof metadata.version === "string" ? compareReleaseVersions(metadata.version, minimum) : null;
  if (order === null || order < 0) throw new Error("the pinned Frizz server is older than the minimum this launcher declares");
  return minimum;
}

function containedFile(root: string, name: string, directory = false): string {
  const path = realpathSync(join(root, name));
  const rel = relative(realpathSync(root), path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Frizz server artifact escapes its package: ${name}`);
  const stat = statSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`invalid Frizz server artifact: ${name}`);
  return path;
}

export function validateServerGeneration(
  root: string,
  spec: ServerReleaseSpec,
  id: string,
  compatibility: ServerCompatibility = CURRENT_COMPATIBILITY,
): ServerGeneration {
  assertSpec(spec, compatibility);
  if (!GENERATION.test(id)) throw new Error("invalid Frizz server generation id");
  const manifest = record(readJson(join(root, "package.json")));
  const metadata = record(manifest.frizzServer);
  if (manifest.name !== spec.package || manifest.version !== spec.version)
    throw new Error(`Frizz server install did not contain ${spec.package}@${spec.version}`);
  if (metadata.protocol !== spec.protocol || metadata.dataEpoch !== spec.dataEpoch)
    throw new Error("Frizz server protocol/data epoch is incompatible; the current server has not been stopped");
  const entry = containedFile(root, "dist/dev-child.js");
  // Protocol 1 includes both detached provider entries. Readiness alone does not exercise dispatch.
  containedFile(root, "dist/codex-app-server-daemon.js");
  containedFile(root, "dist/claude-agent-broker.js");
  containedFile(root, "web-dist/index.html");
  containedFile(root, "runtime/board/index.mjs");
  containedFile(root, "runtime/cc-worker/.claude-plugin/plugin.json");
  return { ...spec, id, root: realpathSync(root), entry };
}

export function serverGenerationLaunch(generation: ServerGeneration): { entry: string; environment: NodeJS.ProcessEnv } {
  return {
    entry: generation.entry,
    environment: {
      FRIZZ_STABLE_ARTIFACT: `npm:${generation.package}@${generation.version}`,
      FRIZZ_STABLE_WEB_DIST: join(generation.root, "web-dist"),
      FRIZZ_SCRIPTS_DIR: join(generation.root, "runtime/board"),
      FRIZZ_WORKER_PLUGIN_DIR: join(generation.root, "runtime/cc-worker"),
    },
  };
}

/** Resolve npm's JS entry, not npm.cmd: execFile must not invoke a shell (or its cd hooks). */
export function resolveNpmCli(env: NodeJS.ProcessEnv = process.env, executable = process.execPath): string {
  const candidates: string[] = [];
  if (env.npm_execpath?.endsWith("npm-cli.js")) candidates.push(env.npm_execpath);
  for (const directory of [dirname(executable), ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)]) {
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js"));
    try {
      const path = realpathSync(join(directory, "npm"));
      if (path.endsWith("npm-cli.js")) candidates.push(path);
    } catch { /* Not every PATH entry contains npm. */ }
  }
  const found = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!found) throw new Error("npm was not found beside Node or on PATH; install Node with npm to install Frizz server releases");
  return resolve(found);
}

export interface ServerPackageInstaller {
  install(prefix: string, spec: ServerReleaseSpec): Promise<void>;
  latestVersion(packageName: string): Promise<string>;
}

/** How long one npm operation may run: the registry probe, or installing a server release. */
export const NPM_OPERATION_TIMEOUT_MS = 180_000;

/**
 * What a failed npm child said, for the operator who clicked Update.
 *
 * The last lines of stderr are right for npm's own errors, which end in their summary. A child that
 * dies BEFORE npm starts ends in a stack and a property dump instead, and the tail alone cut off the
 * one line that named the fault: the board that could not update on 2026-10-11 reported
 * `at Module._compile (node:internal/modules/cjs/loader:1968:14)` and nothing of the
 * `Error: ENOENT: process.cwd failed … the current working directory was likely removed` six lines
 * above it. So the first uncaught-error line leads whenever the tail does not already hold it.
 */
export function npmFailureSummary(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const tail = lines.slice(-8);
  const cause = lines.find((line) => /^(?:[A-Z]\w*)?Error(?: \[\w+\])?: /u.test(line));
  return (cause && !tail.includes(cause) ? [cause, ...tail] : tail).join("\n");
}

export function npmServerPackageInstaller(
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): ServerPackageInstaller {
  const timeoutMs = options.timeoutMs ?? NPM_OPERATION_TIMEOUT_MS;
  const run = (args: string[], cwd?: string): Promise<string> => new Promise((resolveOutput, reject) => {
    let cli: string;
    try { cli = resolveNpmCli(env); } catch (error) { reject(error); return; }
    execFile(process.execPath, [cli, ...args], {
      env, cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) { resolveOutput(stdout); return; }
      // execFile reports its own kill as `killed`, with nothing on stderr and a message that is only
      // the command line. Say what happened instead.
      const limit = timeoutMs >= 60_000 ? `${Math.ceil(timeoutMs / 60_000)}m` : `${Math.ceil(timeoutMs / 1000)}s`;
      const why = error.killed ? `npm ${args[0]} did not finish within ${limit} and was stopped` : npmFailureSummary(stderr) || error.message;
      reject(new Error(`Frizz server npm operation failed: ${why}`));
    });
  });
  return {
    async install(prefix, spec) {
      assertSpec(spec);
      // Never execute dependency lifecycle scripts, read the user's project manifest, or mutate a
      // global installation. Nothing in the server needs one: its only native addon, the file watcher's,
      // ships every platform's binary as an optional package, which is why `--include=optional`.
      //
      // `--min-release-age=0`: the version comes from `latestVersion`, whose `npm view` ignores a user's
      // `min-release-age` window, so under one a fresh release would fail `notarget` until it aged.
      // The flag covers the whole install, so the install must hold nothing whose version this machine
      // chooses: the server declares no dependency, and names the watcher's binaries exactly (they have
      // no dependencies of their own). src/package-contents.test.ts holds the manifest to that.
      await run([
        "install", "--prefix", prefix, "--global=false", "--ignore-scripts", "--min-release-age=0", "--no-audit", "--no-fund",
        "--engine-strict", "--install-strategy=hoisted", "--include=optional", "--omit=dev", "--save-exact", `${spec.package}@${spec.version}`,
      ], prefix);
    },
    async latestVersion(packageName) {
      if (!PACKAGE.test(packageName)) throw new Error("invalid Frizz server package name");
      // npm 12 prints `view <spec> version --json` as a ONE-ELEMENT ARRAY where npm 11 printed the bare
      // string. Reading only the string made every probe throw, and the throw reads as "no update": a
      // launcher on npm 12 never offered a newer server and failed every click (measured 2026-09-25,
      // npm 11.20.0 `"0.15.2"` against npm 12.1.0 `["0.15.2"]`). More than one element is still refused.
      //
      // In the temp directory, not the inherited cwd. The launcher's cwd is the folder it was started
      // from, and once that folder is deleted every child that inherits it dies before npm's first
      // line (`uv_cwd ENOENT`), so the probe could never answer again (measured 2026-10-11). It also
      // keeps a project's own `.npmrc` out of a question about Frizz's package, as `install` does.
      const parsed: unknown = JSON.parse(await run(["view", `${packageName}@latest`, "version", "--json"], tmpdir()));
      const version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
      if (typeof version !== "string" || !VERSION.test(version)) throw new Error("npm returned an invalid Frizz server version");
      return version;
    },
  };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    // Windows cannot open a directory for fsync. The replacement itself is still atomic there.
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Best effort directory durability on filesystems without directory fsync. */ }
  } finally { rmSync(temp, { force: true }); }
}

export class ServerReleaseStore {
  readonly generations: string;
  readonly selection: string;
  /** One global data marker: every package override opens the same Frizz databases. */
  readonly compatibilityMarker: string;
  constructor(
    readonly spec: ServerReleaseSpec,
    private installer: ServerPackageInstaller,
    private roots = frizzPaths(),
    readonly compatibility: ServerCompatibility = CURRENT_COMPATIBILITY,
    /** The oldest release this shell works with; see serverReleaseMinimum. */
    readonly minimum?: string,
  ) {
    assertSpec(spec, compatibility);
    const key = createHash("sha256").update(spec.package).digest("hex").slice(0, 16);
    this.generations = join(roots.cache, "server-releases", key);
    this.selection = join(roots.state, "server-releases", key, "active.json");
    this.compatibilityMarker = join(roots.state, "server-releases", "data-compatibility.json");
  }

  private packageRoot(id: string): string { return join(this.generations, id, "node_modules", this.spec.package); }

  private readCompatibilityMarker(): ServerCompatibility | undefined {
    if (!existsSync(this.compatibilityMarker)) return undefined;
    try {
      const marker = record(readJson(this.compatibilityMarker));
      const compatibility = { protocol: marker.protocol, dataEpoch: marker.dataEpoch } as ServerCompatibility;
      assertSpecShape({ package: this.spec.package, version: this.spec.version, ...compatibility });
      return compatibility;
    } catch {
      throw new Error("invalid saved Frizz server data compatibility marker; refusing to risk a data downgrade");
    }
  }

  private assertMarkerIsSupported(): void {
    const marker = this.readCompatibilityMarker();
    if (!marker) return;
    if (marker.protocol !== this.compatibility.protocol || marker.dataEpoch > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
  }

  /**
   * Advance the global epoch only after the exact replacement has been staged and validated, but
   * before handing it to the caller that can launch it. A crash before first boot must never let an
   * older shell reopen the database the candidate may already have migrated.
   */
  private markCompatibilityBeforeLaunch(): void {
    const marker = this.readCompatibilityMarker();
    if (marker?.protocol !== undefined && marker.protocol !== this.compatibility.protocol)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if ((marker?.dataEpoch ?? 0) > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if (marker?.dataEpoch === this.compatibility.dataEpoch) return;
    atomicJson(this.compatibilityMarker, this.compatibility);
  }

  private async prepareInitial(version: string): Promise<ServerGeneration> {
    const generation = await this.prepare(version);
    this.markCompatibilityBeforeLaunch();
    return generation;
  }

  /**
   * The selected release, when it is older than this shell works with: `load` will start the pinned
   * one instead. Undefined for a machine with no selection, an unreadable one (`load` reports that),
   * and any selection at or above the minimum.
   */
  belowMinimum(): { selected: string; minimum: string; pinned: string } | undefined {
    if (this.minimum === undefined || !existsSync(this.selection)) return undefined;
    let selected: unknown;
    try { selected = record(readJson(this.selection)).version; } catch { return undefined; }
    if (typeof selected !== "string" || compareReleaseVersions(selected, this.minimum) !== -1) return undefined;
    return { selected, minimum: this.minimum, pinned: this.spec.version };
  }

  async load(): Promise<ServerGeneration> {
    this.assertMarkerIsSupported();
    if (!existsSync(this.selection)) return this.prepareInitial(this.spec.version);
    const selected = record(readJson(this.selection));
    const spec = selected as unknown as ServerReleaseSpec;
    assertSpecShape(spec);
    if (spec.package !== this.spec.package || typeof selected.id !== "string" || !GENERATION.test(selected.id))
      throw new Error("invalid saved Frizz server selection; refusing to fall back to an older server");
    // A new shell knows its exact epoch-compatible default. Stage that generation before recording
    // the data boundary; an older shell can never select this old pointer again after the marker wins.
    if (spec.protocol !== this.compatibility.protocol)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if (spec.dataEpoch < this.compatibility.dataEpoch) return this.prepareInitial(this.spec.version);
    if (spec.dataEpoch > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    // Older than this shell works with: start on the pinned release, as a machine with no selection
    // does. The caller commits it only once it is up, so a release that cannot boot leaves the old
    // selection in place — and nothing here runs while a server is serving, because `load` is the
    // cold start. Never the other way: a selection NEWER than the pin is what Update is for.
    if (this.belowMinimum()) return this.prepareInitial(this.spec.version);
    const root = this.packageRoot(selected.id);
    // Cache eviction is recoverable, but only by reinstalling the EXACT committed release.
    const generation = !existsSync(root)
      ? await this.prepare(spec.version)
      : validateServerGeneration(root, spec, selected.id, this.compatibility);
    this.markCompatibilityBeforeLaunch();
    return generation;
  }

  async prepare(version: string): Promise<ServerGeneration> {
    const spec = { ...this.spec, version };
    assertSpec(spec, this.compatibility);
    mkdirSync(this.generations, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const staging = join(this.generations, `${id}.staging`);
    const destination = join(this.generations, id);
    mkdirSync(staging, { mode: 0o700 });
    try {
      // An explicit private manifest keeps npm from discovering a package in an ancestor directory.
      writeFileSync(join(staging, "package.json"), '{"private":true}\n', { mode: 0o600 });
      await this.installer.install(staging, spec);
      validateServerGeneration(join(staging, "node_modules", spec.package), spec, id, this.compatibility);
      renameSync(staging, destination);
      return validateServerGeneration(this.packageRoot(id), spec, id, this.compatibility);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  commit(generation: ServerGeneration): void {
    if (generation.package !== this.spec.package || generation.root !== realpathSync(this.packageRoot(generation.id)))
      throw new Error("cannot select a Frizz server outside this release store");
    validateServerGeneration(generation.root, generation, generation.id, this.compatibility);
    const { package: packageName, version, protocol, dataEpoch, id } = generation;
    atomicJson(this.selection, { package: packageName, version, protocol, dataEpoch, id });
    // Old generations are intentionally retained: detached workers can still execute their files.
    // Neither npm cache cleanup nor a later update may remove a live worker's runtime closure.
  }
}
