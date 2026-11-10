// Immutable web artifacts are deliberately tooling-owned. The stable control plane never watches
// the Frizz checkout; ordinary stopped-then-fresh launches select or build and promote one digest.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import {
  DETACHED_DAEMON_ENTRIES,
  detachedDaemonOutputName,
} from "@frizz/server/detached-daemons";
import { frizzPaths } from "@frizz/server/frizz-paths";
import {
  WORKER_PLUGIN_REQUIRED_FILES,
  assertWorkerPluginClosure,
} from "./worker-plugin-closure.ts";

export interface FrizzArtifactManifest {
  version: 1 | 2;
  digest: string;
  createdAt: string;
  sourceDir: string;
  sourceRevision: string;
  /** Complete relevant canonical-source input set; absent on pre-fingerprint artifacts. */
  sourceFingerprint?: string;
  nodeVersion: string;
  /** Host/runtime boundary for the deploy closure (native modules are Node-ABI specific). */
  host?: {
    platform: string;
    arch: string;
    nodeMajor: number;
    nodeModules: string;
  };
  /** Immutable host-specific native dependency closure selected by the runtime bundle. */
  dependencyCell?: string;
  webFiles: Record<string, string>;
  runtimeFiles: Record<string, string>;
}

export interface FrizzArtifactHost {
  platform: string;
  arch: string;
  nodeMajor: number;
  nodeModules: string;
}

export function currentArtifactHost(): FrizzArtifactHost {
  return {
    platform: platform(),
    arch: arch(),
    nodeMajor: Number(process.versions.node.split(".")[0]),
    nodeModules: process.versions.modules,
  };
}

/** Reject a promoted closure before its server child can load incompatible native dependencies. */
export function assertArtifactHostCompatible(
  artifact: Pick<FrizzArtifact, "digest" | "manifest">,
  host: FrizzArtifactHost = currentArtifactHost()
): void {
  const built = artifact.manifest.host;
  if (!built)
    throw new Error(
      `Frizz artifact ${artifact.digest} does not record host compatibility; stop Frizz and rerun frizz-dev on this machine to build a compatible immutable artifact`
    );
  const mismatches: string[] = [];
  if (built.platform !== host.platform) mismatches.push(`platform ${built.platform} != ${host.platform}`);
  if (built.arch !== host.arch) mismatches.push(`architecture ${built.arch} != ${host.arch}`);
  if (built.nodeMajor !== host.nodeMajor) mismatches.push(`Node major ${built.nodeMajor} != ${host.nodeMajor}`);
  if (built.nodeModules !== host.nodeModules) mismatches.push(`Node ABI ${built.nodeModules} != ${host.nodeModules}`);
  if (mismatches.length > 0)
    throw new Error(
      `Frizz artifact ${artifact.digest} is incompatible with this host (${mismatches.join(", ")}); stop Frizz and rerun frizz-dev on this machine to build a compatible immutable artifact`
    );
}

function artifactHostMatches(
  built: FrizzArtifactManifest["host"],
  host: FrizzArtifactHost
): built is FrizzArtifactHost {
  return !!built &&
    built.platform === host.platform &&
    built.arch === host.arch &&
    built.nodeMajor === host.nodeMajor &&
    built.nodeModules === host.nodeModules;
}

export interface FrizzArtifact {
  digest: string;
  dir: string;
  webDir: string;
  runtimeDir: string;
  manifest: FrizzArtifactManifest;
}

export interface StableArtifactPointer {
  version: 1;
  current: string;
  previous?: string;
  updatedAt: string;
}

export interface EnsureStableArtifactOptions {
  /** Injectable for the launcher regression tests; production uses buildFrizzArtifact. */
  build?: (sourceDir: string, root: string) => FrizzArtifact;
  /** Human-facing lifecycle updates; callers retain control of rendering. */
  onProgress?: (message: string) => void;
}

export interface BuildFrizzArtifactOptions {
  /** Human-facing lifecycle updates; successful build-tool output stays deliberately quiet. */
  onProgress?: (message: string) => void;
  /** Injectable command boundary for artifact-order regression tests. */
  runCommand?: (args: string[], source: string) => void;
}

/**
 * Run out of the captured snapshot, never imported: it carries the SNAPSHOT's worker-plugin list, which
 * is the only one entitled to judge the snapshot's tree. See the script's own header for the update
 * deadlock that came of asserting a running build's list against a newer checkout.
 */
const WORKER_PLUGIN_CLOSURE_SCRIPT = "scripts/assert-worker-plugin-closure.mjs";

export interface FrizzSourceSnapshot {
  /** Temporary workspace root; remove this whole directory after the build. */
  dir: string;
  /** Snapshot-local ui workspace consumed by build tools. */
  sourceDir: string;
  /** Canonical checkout path recorded in the artifact manifest. */
  originalSourceDir: string;
  sourceRevision: string;
  sourceFingerprint: string;
}

interface SourceArtifactIdentity {
  source: string;
  revision: string;
  fingerprint: string;
}

/** CACHE: every artifact here is rebuildable from source, and this is the biggest thing Frizz stores. */
export function defaultArtifactRoot(home = homedir()): string {
  return join(frizzPaths({ home }).cache, "builds");
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A manifest path, in the ONE separator a manifest is allowed to speak.
 *
 * `relative()` answers in the host's separator, so a Windows build recorded `cc-worker\bin\frizz`
 * where every reader spells that key `cc-worker/bin/frizz` — including the closure list every
 * artifact is verified against (`WORKER_PLUGIN_REQUIRED_FILES`, worker-plugin-closure.ts), which is
 * a plain object lookup and cannot normalize for itself. The result was a Windows artifact that
 * built cleanly and then failed its own manifest validation the instant it was published, with no
 * way to succeed. `/` also keeps the manifest — and therefore the digest keyed on it — the same
 * document on every host; the readers all rejoin these with `join()`, which takes `/` anywhere.
 */
const manifestKey = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

function collectFiles(
  root: string,
  path = root,
  entries: Record<string, string> = {}
): Record<string, string> {
  for (const name of readdirSync(path).sort()) {
    const file = join(path, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) collectFiles(root, file, entries);
    else if (stat.isSymbolicLink())
      entries[manifestKey(root, file)] = `link:${manifestLinkTarget(file)}`;
    else if (stat.isFile()) entries[manifestKey(root, file)] = digestFile(file);
  }
  return entries;
}

/**
 * A recorded symlink target, normalized the same way and for the same reason.
 *
 * The artifact's one internal link — `runtime/node_modules` into the dependency cell — is written
 * from `relative()`, so on Windows it is stored and read back with backslashes. Normalizing here
 * only works if the VERIFIER normalizes too, so both sides call this; see readFrizzArtifact.
 */
function manifestLinkTarget(file: string): string {
  return readlinkSync(file).replaceAll("\\", "/");
}

/**
 * Did this rename fail because the destination directory is ALREADY PUBLISHED — i.e. we lost the
 * race to an identical builder — rather than for a reason that must surface?
 *
 * Every platform spells that one condition differently, and Windows does not spell it as a name
 * collision at all: Linux says EEXIST, macOS says ENOTEMPTY, and Windows says EPERM, because
 * `MoveFileEx` refuses to replace an existing DIRECTORY under any flag and reports the refusal as
 * "operation not permitted". Accepting a bare EPERM would swallow a genuine permission fault, so
 * the winner's completed `manifest.json` has to be there as the witness — which it always is, since
 * a published directory is a renamed COMPLETE staging tree, never a partial one.
 */
function renameLostPublishRace(error: unknown, destination: string): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST" || code === "ENOTEMPTY") return true;
  return code === "EPERM" && existsSync(join(destination, "manifest.json"));
}

function stableFileMap(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

/** The directory name is a commitment to source identity, runtime compatibility, and every file.
 *
 * `source` is in the key deliberately — that is what "source identity" means here, and the legacy
 * verifier below shows it always was, as `basename(sourceDir)` before it became the canonical realpath.
 * The consequence is worth knowing before it surprises someone: MOVING OR RENAMING THE CHECKOUT
 * INVALIDATES THE ENTIRE BUILD CACHE, because every cached digest committed to the old path. Measured
 * on this machine after `.../projects/fray` became `.../projects/frizz` (2026-08-11): `9574d530` and
 * `f2ac154a` are the same commit with an identical fingerprint, dependency cell and byte-identical
 * `webFiles`, differing only in that string — 112 builds, 2.3 GB, of which 4 are still reachable for
 * reuse. That is a one-time rebuild, not a fault, and it is the price of the commitment.
 *
 * If a garbage collector is ever written for `~/.frizz/builds`, "unreachable for reuse" is NOT the same
 * as "safe to delete": a worker's plugin, hooks and MCP entry point all live inside the build it was
 * spawned on and are re-read from that path for the life of the process (dispatch.ts workerPluginDir).
 * 11 distinct build dirs were held by live workers at the time of writing, several of them old. Deleting
 * one under a running worker strips its whole contract, and per that same function's note it would do so
 * silently. Exclude any build referenced by a live process. */
function artifactDigestFromIdentity(identity: {
  sourceDir: string;
  sourceRevision: string;
  sourceFingerprint?: string;
  nodeVersion: string;
  host?: FrizzArtifactHost;
  webFiles: Record<string, string>;
  runtimeFiles: Record<string, string>;
  dependencyCell?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: canonicalSourceDir(identity.sourceDir),
        sourceRevision: identity.sourceRevision,
        sourceFingerprint: identity.sourceFingerprint,
        nodeVersion: identity.nodeVersion,
        host: identity.host,
        webFiles: stableFileMap(identity.webFiles),
        runtimeFiles: stableFileMap(identity.runtimeFiles),
        dependencyCell: identity.dependencyCell,
      })
    )
    .digest("hex");
}

/** Compatibility verifier for artifacts built before canonical source identity became part of the key. */
function legacyArtifactDigest(manifest: FrizzArtifactManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: basename(manifest.sourceDir),
        sourceRevision: manifest.sourceRevision,
        sourceFingerprint: manifest.sourceFingerprint,
        nodeVersion: manifest.nodeVersion,
        host: manifest.host,
        webFiles: manifest.webFiles,
        runtimeFiles: manifest.runtimeFiles,
        dependencyCell: manifest.dependencyCell,
      })
    )
    .digest("hex");
}

function assertNoExternalArtifactSymlinks(
  root: string,
  path = root,
  allowedExternalTarget?: string
): void {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      assertNoExternalArtifactSymlinks(root, file, allowedExternalTarget);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = resolve(dirname(file), readlinkSync(file));
    if (!containedPath(root, target) && target !== allowedExternalTarget)
      throw new Error(
        `Frizz artifact contains a symlink outside its immutable closure: ${relative(root, file)}`
      );
  }
}

function gitRevision(sourceDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function canonicalSourceDir(sourceDir: string): string {
  try {
    return realpathSync(sourceDir);
  } catch {
    return resolve(sourceDir);
  }
}

function workerPluginSourceDir(sourceDir: string): string {
  return resolve(sourceDir, "cc-worker");
}

// cc-worker intentionally shares the board/update implementation with `board/`. The deploy artifact
// is allowed no source-checkout reach-back, so carry the exact board closure beside the plugin at
// runtime/board (the shims' existing relative imports resolve there).
function workerPluginBoardClosureSourceDir(sourceDir: string): string {
  return resolve(sourceDir, "board");
}

/**
 * The frizz source closure, as an explicit ALLOWLIST of repo-root entries.
 *
 * The workspace used to live in a `ui/` subtree, so a snapshot could be "that one directory, plus a
 * reach-back to cc-worker and the board closure". The workspace is now the repo root itself, and the
 * root also holds `.claude/worktrees` (entire sibling checkouts), `plans/`, `attachments/`, and
 * scratch dirs. This MUST stay an allowlist rather than an extension of the ignore set: a blocklist
 * silently swallows every new root directory, which bloats the snapshot and — worse — makes the
 * fingerprint a moving target, so every capture would race "source changed during capture".
 */
const FRIZZ_SOURCE_DIRECTORIES = ["src", "packages", "scripts", "board", "cc-worker"] as const;
const FRIZZ_SOURCE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  // The root package's own tsconfig — `tsc -b … .` in the snapshot cannot resolve without it.
  "tsconfig.json",
] as const;

/** The allowlisted source directories that actually exist, as snapshot trees rooted at `destination`. */
function frizzSourceTrees(source: string, destination: string): SnapshotTree[] {
  return FRIZZ_SOURCE_DIRECTORIES.filter((name) => existsSync(join(source, name))).map((name) => ({
    source: join(source, name),
    destination: join(destination, name),
  }));
}

// A detached daemon is spawned as its own `node <file>` process, so it must be a REAL FILE beside
// the bundle — an import edge into index.js is not enough. Fail the BUILD when one is missing:
// shipping it costs a live outage that only shows up on a promoted artifact, with a misleading
// "daemon exited before it became ready" (2026-07-23). See server/src/detached-daemons.ts.
function assertDetachedDaemonClosure(runtimeSrc: string): void {
  for (const entry of DETACHED_DAEMON_ENTRIES) {
    const emitted = detachedDaemonOutputName(entry);
    if (!existsSync(join(runtimeSrc, emitted)))
      throw new Error(
        `Frizz runtime bundle is missing the detached daemon ${emitted} (built from ${entry}); it is spawned as its own node process and must exist beside index.js`
      );
  }
}

// Build products and control-plane state must not turn a source edit fingerprint into a moving
// target. Everything else is included, including tracked, staged, unstaged, and relevant untracked
// files, because pnpm/Vite/deploy can consume them without Git knowing about them.
const SOURCE_FINGERPRINT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".frizz",
  ".parcel-cache",
  ".turbo",
  ".vite",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);

const SOURCE_SNAPSHOT_PREFIX = ".source-snapshot-";
const SOURCE_SNAPSHOT_MAX_ATTEMPTS = 3;
const INTERRUPTED_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEPENDENCY_LINK_CACHE_DIRECTORIES = new Set([".cache", ".vite", ".vite-temp"]);

function ignoredFingerprintFile(name: string): boolean {
  return name === ".DS_Store" || name.endsWith(".tsbuildinfo");
}

/** Deterministic closure key for every source/config/lockfile input that can affect an artifact. */
export function relevantSourceFingerprint(sourceDir: string): string {
  const source = canonicalSourceDir(sourceDir);
  const hash = createHash("sha256");
  hash.update("frizz-native-cell-v2\0");
  const visit = (root: string, label: string, directory = root): void => {
    for (const name of readdirSync(directory).sort()) {
      if (ignoredFingerprintFile(name)) continue;
      const file = join(directory, name);
      const stat = lstatSync(file);
      const path = `${label}/${relative(root, file)}`;
      if (stat.isDirectory()) {
        if (SOURCE_FINGERPRINT_IGNORED_DIRECTORIES.has(name)) continue;
        hash.update(`directory\0${path}\0`);
        visit(root, label, file);
      } else if (stat.isSymbolicLink()) {
        hash.update(`link\0${path}\0${readlinkSync(file)}\0`);
      } else if (stat.isFile()) {
        hash.update(`file\0${path}\0`).update(readFileSync(file));
      }
    }
  };
  for (const name of FRIZZ_SOURCE_DIRECTORIES) {
    const directory = join(source, name);
    if (existsSync(directory)) visit(directory, name);
  }
  for (const name of FRIZZ_SOURCE_FILES) {
    const file = join(source, name);
    if (existsSync(file)) hash.update(`file\0${name}\0`).update(readFileSync(file));
  }
  return hash.digest("hex");
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove only snapshots whose creating process is gone (or impossibly old). */
function reapInterruptedSourceSnapshots(root: string): void {
  const now = Date.now();
  for (const name of readdirSync(root)) {
    const match = /^\.source-snapshot-(\d+)-[a-f0-9-]+$/.exec(name);
    if (!match) continue;
    const path = join(root, name);
    const pid = Number(match[1]);
    let expired = false;
    try {
      expired = now - lstatSync(path).mtimeMs > INTERRUPTED_SNAPSHOT_MAX_AGE_MS;
    } catch {
      continue;
    }
    if (pid === process.pid || !pidIsAlive(pid) || expired)
      rmSync(path, { recursive: true, force: true });
  }
}

interface SnapshotTree {
  source: string;
  destination: string;
}

function containedPath(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

/**
 * Clone one relevant source tree. APFS clonefile makes regular files copy-on-write on macOS; other
 * filesystems honestly fall back to an ordinary copy. Source symlinks are allowed only when their
 * relative target is another captured source input, so no snapshot can reach back into mutable
 * checkout source.
 */
function cloneRelevantSourceTree(
  tree: SnapshotTree,
  trees: readonly SnapshotTree[],
  directory = tree.source
): void {
  const destinationDirectory = join(tree.destination, relative(tree.source, directory));
  mkdirSync(destinationDirectory, { recursive: true });
  for (const name of readdirSync(directory).sort()) {
    if (ignoredFingerprintFile(name)) continue;
    const sourcePath = join(directory, name);
    const destinationPath = join(destinationDirectory, name);
    const stat = lstatSync(sourcePath);
    if (stat.isDirectory()) {
      if (SOURCE_FINGERPRINT_IGNORED_DIRECTORIES.has(name)) continue;
      cloneRelevantSourceTree(tree, trees, sourcePath);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(sourcePath);
      if (isAbsolute(target))
        throw new Error(`Frizz source snapshot cannot retain absolute symlink ${sourcePath}`);
      const resolvedTarget = resolve(dirname(sourcePath), target);
      const targetTree = trees.find((candidate) => containedPath(candidate.source, resolvedTarget));
      if (!targetTree)
        throw new Error(
          `Frizz source snapshot cannot retain symlink ${sourcePath} outside the captured source closure`
        );
      const snapshotTarget = join(
        targetTree.destination,
        relative(targetTree.source, resolvedTarget)
      );
      symlinkSync(relative(dirname(destinationPath), snapshotTarget), destinationPath);
      continue;
    }
    if (stat.isFile())
      copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE);
  }
}

/**
 * Build tools need the already-installed native dependency graph. Keep its root store shared and
 * read-only by convention, while recreating package-level link farms inside the snapshot so their
 * workspace links resolve to snapshot source. An install that mutates node_modules concurrently is
 * outside the source-snapshot guarantee; the lockfile remains part of the source fingerprint and a
 * dependency-changing install must complete before launching frizz-dev.
 */
function attachInstalledDependencyClosure(source: string, snapshot: string): void {
  const installed = join(source, "node_modules");
  if (!existsSync(installed))
    throw new Error("Frizz source dependencies are not installed; run the project install first");
  symlinkSync(installed, join(snapshot, "node_modules"), "dir");
  const packages = join(source, "packages");
  if (!existsSync(packages)) return;
  for (const name of readdirSync(packages)) {
    const packageModules = join(packages, name, "node_modules");
    if (!existsSync(packageModules)) continue;
    cpSync(packageModules, join(snapshot, "packages", name, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        if (path === packageModules) return true;
        const entry = basename(path);
        return !DEPENDENCY_LINK_CACHE_DIRECTORIES.has(entry);
      },
    });
  }
}

/**
 * Stop the snapshot from inheriting an ancestor's ignore rules, or the web build silently ships a
 * stylesheet with NO Tailwind utilities in it.
 *
 * The snapshot is built inside the artifact root, which lives under `~/.frizz` — and `~/.frizz`
 * carries a `.gitignore` of `*` on purpose, the `.venv/.gitignore` trick that keeps this scratch
 * tree out of any repo a user happens to init above it (see project-root.ts). Tailwind v4 finds its
 * class names by SCANNING the source tree, and its scanner honours ancestor `.gitignore` files, so
 * that one `*` makes every `.tsx` in the snapshot invisible to it. Nothing fails: Vite exits 0, the
 * bundle is complete, and the emitted CSS still holds `@theme` variables, imported stylesheets and
 * every hand-written component rule — just not one utility class. The app is entirely Tailwind, so
 * the whole UI renders unstyled.
 *
 * Measured on 4.3.2, one variable, same tree: 114,660 bytes at a neutral path, 28,849 under
 * `~/.frizz`, 114,660 again with the ancestor `.gitignore` moved aside.
 *
 * An empty `.git` DIRECTORY is enough — the scanner treats a directory holding one as a repository
 * root and stops walking up for ignore files, which restores auto-detection to byte-identical output
 * (verified: same content hash as a build at a neutral path). It is deliberately not a real `git
 * init`: with no `HEAD` inside, git's own discovery does not accept it as a repository and keeps
 * walking up exactly as it does today, so no build step can mistake the snapshot for a checkout and
 * read a revision out of it. It also needs no subprocess, and cannot fire a user's init templates or
 * hooks.
 *
 * `@source` does not substitute for this. The directory form is filtered by the same ignore rules
 * (28,849 bytes, unchanged); the glob form does bypass them but only covers what it is spelled to
 * cover, and re-deriving Tailwind's own auto-detection by hand got 46,190 of the 114,660 bytes.
 *
 * `.git` is in SOURCE_FINGERPRINT_IGNORED_DIRECTORIES, so this marker cannot move the fingerprint.
 */
function markSnapshotAsScanRoot(snapshot: string): void {
  mkdirSync(join(snapshot, ".git"), { recursive: true, mode: 0o700 });
}

/**
 * Capture a coherent launch-owned source closure before any slow build command starts.
 *
 * It deliberately does NOT assert the worker-plugin closure. THIS process's list describes THIS
 * build's worker; `sourceDir` is a checkout that may already be newer, and during Update & Restart it
 * reliably is. See scripts/assert-worker-plugin-closure.mjs, which buildFrizzArtifact runs out of the
 * captured snapshot so the list and the tree come from the same place.
 */
export function captureFrizzSourceSnapshot(
  sourceDir: string,
  root = defaultArtifactRoot()
): FrizzSourceSnapshot {
  const source = canonicalSourceDir(sourceDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  reapInterruptedSourceSnapshots(root);
  let lastFailure = "source changed during capture";
  for (let attempt = 1; attempt <= SOURCE_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    const dir = join(root, `${SOURCE_SNAPSHOT_PREFIX}${process.pid}-${randomUUID()}`);
    // The snapshot mirrors the repo root itself, so cc-worker's `../../board` reach-back
    // and the workspace's own relative paths resolve inside it exactly as they do in the checkout.
    const snapshotSource = dir;
    const trees = frizzSourceTrees(source, dir);
    try {
      const beforeRevision = gitRevision(source);
      const beforeFingerprint = relevantSourceFingerprint(source);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const tree of trees) cloneRelevantSourceTree(tree, trees);
      for (const name of FRIZZ_SOURCE_FILES) {
        const file = join(source, name);
        if (existsSync(file))
          copyFileSync(file, join(dir, name), fsConstants.COPYFILE_FICLONE);
      }
      const snapshotFingerprint = relevantSourceFingerprint(snapshotSource);
      const afterFingerprint = relevantSourceFingerprint(source);
      const afterRevision = gitRevision(source);
      if (
        beforeRevision !== afterRevision ||
        beforeFingerprint !== snapshotFingerprint ||
        beforeFingerprint !== afterFingerprint
      ) {
        lastFailure = "source changed during capture";
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      markSnapshotAsScanRoot(snapshotSource);
      attachInstalledDependencyClosure(source, snapshotSource);
      return {
        dir,
        sourceDir: snapshotSource,
        originalSourceDir: source,
        sourceRevision: beforeRevision,
        sourceFingerprint: beforeFingerprint,
      };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      lastFailure = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object"
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (
        !lastFailure.includes("changed during capture") &&
        !["ENOENT", "ENOTDIR", "EISDIR", "ESTALE"].includes(code ?? "")
      )
        throw error;
      lastFailure = `${lastFailure} (source changed during capture)`;
    }
  }
  throw new Error(
    `Frizz source did not remain stable long enough to capture after ${SOURCE_SNAPSHOT_MAX_ATTEMPTS} attempts: ${lastFailure}`
  );
}

function writeAtomic(path: string, value: unknown): void {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(staging, path);
}

function validArtifactRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    containedPath("/frizz-artifact-root", resolve("/frizz-artifact-root", path)) &&
    resolve("/frizz-artifact-root", path) !== "/frizz-artifact-root"
  );
}

function validArtifactFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([path, digest]) =>
      validArtifactRelativePath(path) &&
      typeof digest === "string" &&
      (/^[a-f0-9]{64}$/.test(digest) || /^link:.+/.test(digest))
  );
}

function validArtifactManifest(
  manifest: unknown,
  digest: string
): manifest is FrizzArtifactManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Partial<FrizzArtifactManifest>;
  const host = value.host;
  return (
    (value.version === 1 || value.version === 2) &&
    value.digest === digest &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.sourceDir === "string" && value.sourceDir.length > 0 && isAbsolute(value.sourceDir) &&
    typeof value.sourceRevision === "string" && value.sourceRevision.length > 0 &&
    (value.sourceFingerprint === undefined || /^[a-f0-9]{64}$/.test(value.sourceFingerprint)) &&
    typeof value.nodeVersion === "string" && value.nodeVersion.length > 0 &&
    validArtifactFileMap(value.webFiles) && validArtifactFileMap(value.runtimeFiles) &&
    (value.dependencyCell === undefined || /^[a-f0-9]{64}$/.test(value.dependencyCell)) &&
    (host === undefined ||
      (!!host &&
        typeof host.platform === "string" && host.platform.length > 0 &&
        typeof host.arch === "string" && host.arch.length > 0 &&
        Number.isSafeInteger(host.nodeMajor) && host.nodeMajor > 0 &&
        typeof host.nodeModules === "string" && /^\d+$/.test(host.nodeModules)))
  );
}

/** Build a deployable server/runtime closure plus static web into one content-addressed directory. */
function commandFailureOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { stdout?: Buffer | string; stderr?: Buffer | string };
  return [record.stdout, record.stderr]
    .filter((value): value is Buffer | string => value !== undefined)
    .map((value) => value.toString().trim())
    .filter(Boolean)
    .join("\n")
    .slice(-4_000);
}

function runArtifactCommand(args: string[], source: string): void {
  try {
    // Nub owns the build execution so both Vite/Rolldown and esbuild run through the same Node 26
    // loader contract as the source launcher. Successful tool chatter stays hidden behind the
    // launcher progress UI, while failures retain their useful trailing output.
    execFileSync("nub", ["--cwd", source, ...args], {
      cwd: source,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = commandFailureOutput(error);
    throw new Error(
      `Command failed: nub ${args.join(" ")} from ${source}${
        detail ? `\n${detail}` : ""
      }`
    );
  }
}

// @parcel/watcher ships each platform's binary as its own optional package, copied below with the
// rest of its closure. It was one of three until the database moved to node:sqlite and sign-in
// moved off node-pty, both of which published every OS's prebuilds inside one package and needed a
// host filter here.
const RUNTIME_NATIVE_EXTERNALS = [
  "@parcel/watcher",
] as const;

interface FrizzDependencyCellManifest {
  version: 1;
  digest: string;
  createdAt: string;
  host: FrizzArtifactHost;
  inputs: string;
  files: Record<string, string>;
}

interface FrizzDependencyCell {
  digest: string;
  dir: string;
  modulesDir: string;
  manifest: FrizzDependencyCellManifest;
}

function dependencyCellRoot(root: string): string {
  return join(root, "cells");
}

function dependencyCellInputs(source: string, host: FrizzArtifactHost): string {
  const inputs = [
    "package.json",
    "pnpm-lock.yaml",
    "packages/server/package.json",
    "packages/shared/package.json",
    "packages/rpc/package.json",
  ];
  const hash = createHash("sha256");
  for (const input of inputs) {
    const file = join(source, input);
    hash.update(`${input}\0`);
    if (existsSync(file)) hash.update(readFileSync(file));
    else hash.update("<absent>");
  }
  hash.update(`host\0${JSON.stringify(host)}`);
  return hash.digest("hex");
}

function dependencyCellDigest(inputs: string, files: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify({ inputs, files: stableFileMap(files) }))
    .digest("hex");
}

function validDependencyCellManifest(
  manifest: unknown,
  digest: string
): manifest is FrizzDependencyCellManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Partial<FrizzDependencyCellManifest>;
  return value.version === 1 && value.digest === digest &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.inputs === "string" && /^[a-f0-9]{64}$/.test(value.inputs) &&
    validArtifactFileMap(value.files) &&
    artifactHostMatches(value.host, currentArtifactHost());
}

function readFrizzDependencyCell(digest: string, root: string): FrizzDependencyCell {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid Frizz dependency cell digest");
  const dir = join(dependencyCellRoot(root), digest);
  let manifest: FrizzDependencyCellManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`Frizz dependency cell ${digest} is missing its manifest`);
  }
  if (!validDependencyCellManifest(manifest, digest) ||
    dependencyCellDigest(manifest.inputs, manifest.files) !== digest ||
    !existsSync(join(dir, "node_modules")))
    throw new Error(`Frizz dependency cell ${digest} failed manifest validation`);
  try {
    assertNoExternalArtifactSymlinks(join(dir, "node_modules"));
  } catch {
    throw new Error(`Frizz dependency cell ${digest} failed immutable closure validation`);
  }
  for (const [file, expected] of Object.entries(manifest.files)) {
    const path = join(dir, file);
    const valid = expected.startsWith("link:")
      ? (() => { try { return lstatSync(path).isSymbolicLink() && `link:${manifestLinkTarget(path)}` === expected; } catch { return false; } })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid) throw new Error(`Frizz dependency cell ${digest} has a changed or missing file: ${file}`);
  }
  return { digest, dir, modulesDir: join(dir, "node_modules"), manifest };
}

function packageDirectory(requireFrom: NodeRequire, name: string): string {
  try {
    return dirname(requireFrom.resolve(`${name}/package.json`));
  } catch {
    // A few packages intentionally do not export their package metadata. Their entry still has a
    // conventional nearest package.json, which is sufficient for copying the exact resolved copy.
    let directory = dirname(requireFrom.resolve(name));
    while (dirname(directory) !== directory) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name)
        return directory;
      directory = dirname(directory);
    }
    throw new Error(`unable to locate package root for ${name}`);
  }
}

function copyResolvedPackageClosure(source: string, modules: string): void {
  const serverRequire = createRequire(join(source, "packages", "server", "package.json"));
  const copied = new Set<string>();
  const copyPackage = (name: string, requireFrom: NodeRequire, optional = false): void => {
    if (copied.has(name)) return;
    let packageDir: string;
    try {
      packageDir = realpathSync(packageDirectory(requireFrom, name));
    } catch (error) {
      if (optional) return;
      throw error;
    }
    copied.add(name);
    const destination = join(modules, ...name.split("/"));
    cpSync(packageDir, destination, {
      recursive: true,
      preserveTimestamps: true,
      filter: (path) => {
        if (path === packageDir) return true;
        const relativePath = relative(packageDir, path);
        if (relativePath === "node_modules" || relativePath.startsWith(`node_modules${sep}`)) return false;
        return true;
      },
    });
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const packageRequire = createRequire(join(packageDir, "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
      copyPackage(dependency, packageRequire);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort())
      copyPackage(dependency, packageRequire, true);
  };
  for (const dependency of RUNTIME_NATIVE_EXTERNALS) copyPackage(dependency, serverRequire);
}

function ensureFrizzDependencyCell(source: string, root: string): FrizzDependencyCell {
  const host = currentArtifactHost();
  const inputs = dependencyCellInputs(source, host);
  const cells = dependencyCellRoot(root);
  mkdirSync(cells, { recursive: true, mode: 0o700 });
  // The input digest narrows the scan without assuming dependency-cell output names in advance.
  for (const entry of readdirSync(cells)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    try {
      const cell = readFrizzDependencyCell(entry, root);
      if (cell.manifest.inputs === inputs) return cell;
    } catch {}
  }
  const staging = join(cells, `.staging-${process.pid}-${randomUUID()}`);
  try {
    const modules = join(staging, "node_modules");
    mkdirSync(modules, { recursive: true, mode: 0o700 });
    copyResolvedPackageClosure(source, modules);
    assertNoExternalArtifactSymlinks(modules);
    const files = collectFiles(staging);
    const digest = dependencyCellDigest(inputs, files);
    const manifest: FrizzDependencyCellManifest = {
      version: 1, digest, createdAt: new Date().toISOString(), host, inputs, files,
    };
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    const destination = join(cells, digest);
    try { renameSync(staging, destination); }
    catch (error) {
      // Losing a concurrent race is fine — the winner staged identical content under the same
      // content identity. Anything else is a real staging failure and must surface.
      if (!renameLostPublishRace(error, destination)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
    return readFrizzDependencyCell(digest, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Publish a completed staging directory; an identical concurrent publisher wins safely.
 *
 * `workerPluginClosure: false` on the read-back, because this artifact was built from a checkout that
 * may be newer than the process publishing it — see readFrizzArtifact's own note. Its closure was
 * already asserted, moments ago, by the one list entitled to judge it: the snapshot's.
 */
export function publishFrizzArtifactStaging(
  staging: string,
  digest: string,
  root = defaultArtifactRoot()
): FrizzArtifact {
  const dir = join(root, digest);
  try {
    renameSync(staging, dir);
  } catch (error) {
    // Another identical builder may publish between our existence check and rename. Its complete
    // immutable directory is the winner; validate it rather than reporting a spurious failure.
    if (!renameLostPublishRace(error, dir)) throw error;
    rmSync(staging, { recursive: true, force: true });
  }
  return readFrizzArtifact(digest, root, { workerPluginClosure: false });
}

export function buildFrizzArtifact(
  sourceDir: string,
  root = defaultArtifactRoot(),
  options: BuildFrizzArtifactOptions = {}
): FrizzArtifact {
  options.onProgress?.("Capturing current Frizz source");
  const snapshot = captureFrizzSourceSnapshot(sourceDir, root);
  const source = snapshot.sourceDir;
  const workerPlugin = workerPluginSourceDir(source);
  const workerPluginBoardClosure = workerPluginBoardClosureSourceDir(source);
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  const runCommand = options.runCommand ?? runArtifactCommand;
  try {
    // First, and out of the SNAPSHOT: the worker-plugin closure is the snapshot's own opinion about
    // what its worker needs, so only the snapshot can hold both halves of the question at once. It runs
    // before the slow steps so a renamed hook costs a second rather than a web build.
    options.onProgress?.("Checking the captured worker-plugin closure");
    runCommand([WORKER_PLUGIN_CLOSURE_SCRIPT, source], source);
    // Vite/Rolldown transpiles TypeScript but does not typecheck it. Validate the coherent captured
    // snapshot — not the mutable checkout before capture — so an intermediate edit with a missing
    // import can never become a valid immutable artifact and fail later as a browser global.
    // `typecheck:artifact` is `typecheck` less the web package's test files. None of them is in an
    // artifact, a cold check of them adds 8s to every build (a snapshot carries no .tsbuildinfo), and
    // a test another agent is halfway through editing should not refuse a restart. `typecheck` is
    // the gate that covers them, before a change lands.
    options.onProgress?.("Type-checking captured Frizz source");
    runCommand(["run", "typecheck:artifact"], source);
    options.onProgress?.("Building immutable artifact: web UI");
    runCommand(["run", "--filter", "@frizz/web", "build"], source);
    const webSource = join(source, "packages", "web", "dist");
    if (!existsSync(webSource))
      throw new Error("Frizz web build did not produce packages/web/dist");
    mkdirSync(staging, { mode: 0o700 });
    // esbuild absorbs Frizz's CLI, server and workspace code into one Node 26 ESM entry. Only the
    // native loaders stay external; their complete host-specific closure lives in an immutable cell
    // below, never in the mutable source checkout or an enormous deploy tree. The detached daemons
    // are the one exception: frizz spawns them as their own node processes, so each is bundled as a
    // real file beside index.js and asserted below.
    options.onProgress?.("Building immutable artifact: bundled runtime");
    mkdirSync(join(staging, "runtime", "src"), { recursive: true, mode: 0o700 });
    runCommand(
      [
        "scripts/build-runtime.mjs",
        join(staging, "runtime", "src", "index.js"),
        ...DETACHED_DAEMON_ENTRIES,
      ],
      source
    );
    assertDetachedDaemonClosure(join(staging, "runtime", "src"));
    options.onProgress?.("Finalizing immutable artifact");
    const cell = ensureFrizzDependencyCell(source, root);
    symlinkSync(relative(join(staging, "runtime"), cell.modulesDir), join(staging, "runtime", "node_modules"), "dir");
    // dispatch.ts resolves four parents above the deployed server module, which lands at this
    // runtime root. Keep the plugin inside the verified runtime closure rather than pointing a
    // promoted server back at mutable checkout source.
    cpSync(workerPlugin, join(staging, "runtime", "cc-worker"), {
      recursive: true,
      preserveTimestamps: true,
    });
    cpSync(workerPluginBoardClosure, join(staging, "runtime", "board"), {
      recursive: true,
      preserveTimestamps: true,
    });
    // Again, and on the tree that actually ships: the two cpSyncs above are what the closure describes,
    // and the snapshot's own list is the only one entitled to say whether they landed whole.
    runCommand([WORKER_PLUGIN_CLOSURE_SCRIPT, join(staging, "runtime")], source);
    cpSync(webSource, join(staging, "web"), {
      recursive: true,
      preserveTimestamps: true,
    });
    const webFiles = collectFiles(join(staging, "web"));
    const runtimeFiles = collectFiles(join(staging, "runtime"));
    const digest = artifactDigestFromIdentity({
      sourceDir: snapshot.originalSourceDir,
      sourceRevision: snapshot.sourceRevision,
      sourceFingerprint: snapshot.sourceFingerprint,
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles,
      runtimeFiles,
      dependencyCell: cell.digest,
    });
    const dir = join(root, digest);
    if (existsSync(join(dir, "manifest.json"))) {
      // Same digest means same source, so this is our own artifact under another builder's hand — and
      // the closure question belongs to that source either way. Same reason as the publish read-back.
      rmSync(staging, { recursive: true, force: true });
      return readFrizzArtifact(digest, root, { workerPluginClosure: false });
    }
    const manifest: FrizzArtifactManifest = {
      version: 2,
      digest,
      createdAt: new Date().toISOString(),
      sourceDir: snapshot.originalSourceDir,
      sourceRevision: snapshot.sourceRevision,
      sourceFingerprint: snapshot.sourceFingerprint,
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles,
      runtimeFiles,
      dependencyCell: cell.digest,
    };
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o400 }
    );
    return publishFrizzArtifactStaging(staging, digest, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

export interface ReadFrizzArtifactOptions {
  /**
   * Check the artifact against THIS build's WORKER_PLUGIN_REQUIRED_FILES. Default true, and right for
   * every boot-path read: the launcher is selecting an artifact to serve from, and an old one that
   * predates a widened closure has to be rebuilt rather than run.
   *
   * The BUILD path passes false, and the difference is who is entitled to answer. An artifact this
   * process just built out of the checkout carries the CHECKOUT's worker, not this build's, so this
   * build's list is not a fact about it — it is a stale opinion, and it can only ever produce a false
   * failure. When source NARROWS the closure that false failure is total: on 2026-08-26 the running
   * instance refused its own update, naming cc-worker/bin/browser-mcp.mjs, which `dafe4309` had just
   * deleted along with the entry that required it. Update & Restart is the only control that moves an
   * instance past a stale opinion, so nothing on that path may be gated on one — the same position
   * promoteCurrentSourceArtifact takes on the artifact it replaces.
   */
  workerPluginClosure?: boolean;
}

export function readFrizzArtifact(
  digest: string,
  root = defaultArtifactRoot(),
  options: ReadFrizzArtifactOptions = {}
): FrizzArtifact {
  const checkWorkerPluginClosure = options.workerPluginClosure ?? true;
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw new Error("invalid Frizz artifact digest");
  const dir = join(root, digest);
  const manifestPath = join(dir, "manifest.json");
  let manifest: FrizzArtifactManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as FrizzArtifactManifest;
  } catch {
    throw new Error(`Frizz artifact ${digest} is missing its manifest`);
  }
  if (!validArtifactManifest(manifest, digest) ||
    (manifest.version === 2 && !manifest.dependencyCell) ||
    (checkWorkerPluginClosure &&
      !WORKER_PLUGIN_REQUIRED_FILES.every((file) => manifest.runtimeFiles[file])) ||
    !existsSync(join(dir, "web")) ||
    !existsSync(join(dir, "runtime", "src", "index.js"))
  ) {
    throw new Error(`Frizz artifact ${digest} failed manifest validation`);
  }
  const calculated = artifactDigestFromIdentity(manifest);
  // Existing v1 artifacts used the checkout basename. They remain readable, but source matching
  // below still requires the canonical path, so a collision cannot be selected for a new checkout.
  if (calculated !== digest && legacyArtifactDigest(manifest) !== digest)
    throw new Error(`Frizz artifact ${digest} failed root digest validation (calculated ${calculated})`);
  try {
    if (checkWorkerPluginClosure) assertWorkerPluginClosure(join(dir, "runtime"));
    const cell = manifest.dependencyCell
      ? readFrizzDependencyCell(manifest.dependencyCell, root)
      : undefined;
    const modules = join(dir, "runtime", "node_modules");
    if (cell && (!lstatSync(modules).isSymbolicLink() ||
      resolve(dirname(modules), readlinkSync(modules)) !== cell.modulesDir))
      throw new Error("artifact runtime dependency cell link does not match its manifest");
    assertNoExternalArtifactSymlinks(join(dir, "runtime"), join(dir, "runtime"), cell?.modulesDir);
    assertNoExternalArtifactSymlinks(join(dir, "web"));
  } catch {
    throw new Error(`Frizz artifact ${digest} failed immutable closure validation`);
  }
  for (const [file, expected] of Object.entries(manifest.webFiles)) {
    const path = join(dir, "web", file);
    const valid = expected.startsWith("link:")
      ? (() => {
          try {
            return (
              lstatSync(path).isSymbolicLink() &&
              `link:${manifestLinkTarget(path)}` === expected
            );
          } catch {
            return false;
          }
        })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid)
      throw new Error(
        `Frizz artifact ${digest} has a changed or missing web file: ${file}`
      );
  }
  for (const [file, expected] of Object.entries(manifest.runtimeFiles)) {
    const path = join(dir, "runtime", file);
    const valid = expected.startsWith("link:")
      ? (() => {
          try {
            return (
              lstatSync(path).isSymbolicLink() &&
              `link:${manifestLinkTarget(path)}` === expected
            );
          } catch {
            return false;
          }
        })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid)
      throw new Error(
        `Frizz artifact ${digest} has a changed or missing runtime file: ${file}`
      );
  }
  return {
    digest,
    dir,
    webDir: join(dir, "web"),
    runtimeDir: join(dir, "runtime"),
    manifest,
  };
}

export function readStableArtifact(
  stateDir: string,
  root = defaultArtifactRoot()
): FrizzArtifact | null {
  try {
    const pointer = JSON.parse(
      readFileSync(join(stateDir, "stable.json"), "utf8")
    ) as StableArtifactPointer;
    if (pointer.version !== 1 || typeof pointer.current !== "string")
      return null;
    return readFrizzArtifact(pointer.current, root);
  } catch {
    return null;
  }
}

function currentSourceArtifactIdentity(sourceDir: string): SourceArtifactIdentity {
  const source = canonicalSourceDir(sourceDir);
  return {
    source,
    revision: gitRevision(source),
    fingerprint: relevantSourceFingerprint(source),
  };
}

function manifestMatchesSource(
  manifest: Pick<FrizzArtifactManifest, "sourceDir" | "sourceRevision" | "sourceFingerprint">,
  source: SourceArtifactIdentity
): boolean {
  return (
    canonicalSourceDir(manifest.sourceDir) === source.source &&
    manifest.sourceRevision === source.revision &&
    manifest.sourceFingerprint === source.fingerprint
  );
}

/** Read only enough metadata to narrow a global cache scan; final candidates still receive full verification. */
function readArtifactManifestCandidate(
  digest: string,
  root: string
): FrizzArtifactManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, digest, "manifest.json"), "utf8")
    ) as FrizzArtifactManifest;
    return validArtifactManifest(manifest, digest) ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Select an already verified artifact produced from the current canonical launcher source.
 * A project-local pointer is deliberately not required: artifacts are content-addressed globally,
 * while the pointer only records this project's selected, rollback-safe version.
 */
export function findReusableFrizzArtifact(
  sourceDir: string,
  root = defaultArtifactRoot(),
  sourceIdentity?: SourceArtifactIdentity
): FrizzArtifact | null {
  if (!existsSync(root)) return null;
  const source = sourceIdentity ?? currentSourceArtifactIdentity(sourceDir);
  const candidates: Array<{ digest: string; createdAt: string }> = [];
  for (const entry of readdirSync(root)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    const manifest = readArtifactManifestCandidate(entry, root);
    if (
      manifest &&
      manifestMatchesSource(manifest, source) &&
      artifactHostMatches(manifest.host, currentArtifactHost())
    )
      candidates.push({ digest: entry, createdAt: manifest.createdAt });
  }
  candidates.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.digest.localeCompare(a.digest)
  );
  for (const candidate of candidates) {
    try {
      const artifact = readFrizzArtifact(candidate.digest, root);
      if (
        manifestMatchesSource(artifact.manifest, source) &&
        artifactHostMatches(artifact.manifest.host, currentArtifactHost())
      )
        return artifact;
    } catch {
      // A corrupt matching candidate is skipped; unrelated cache entries were never hashed.
    }
  }
  return null;
}

/**
 * A workspace pointer is a convenient rollback record, not permission to serve an old checkout.
 * Compare it to the source closure at each fresh supervisor launch so `frizz-dev` can keep its
 * no-HMR promise while still picking up edits after the user deliberately stops and relaunches.
 */
export function artifactMatchesCurrentSource(
  artifact: Pick<FrizzArtifact, "manifest">,
  sourceDir: string
): boolean {
  return artifactHostMatches(artifact.manifest.host, currentArtifactHost()) && manifestMatchesSource(
    artifact.manifest,
    currentSourceArtifactIdentity(sourceDir)
  );
}

/**
 * Make ordinary first launch self-contained without ever serving checkout source or HMR. A healthy
 * running supervisor retains its immutable snapshot; after it is stopped, the next launch selects
 * only a verified artifact made from the checkout's current source closure. It reuses a global
 * candidate when possible, otherwise builds and atomically promotes a complete candidate.
 */
export function ensureStableFrizzArtifact(
  stateDir: string,
  sourceDir: string,
  root = defaultArtifactRoot(),
  options: EnsureStableArtifactOptions = {}
): FrizzArtifact {
  options.onProgress?.("Checking current workspace artifact");
  const source = currentSourceArtifactIdentity(sourceDir);
  const selected = readStableArtifact(stateDir, root);
  if (
    selected &&
    artifactHostMatches(selected.manifest.host, currentArtifactHost()) &&
    manifestMatchesSource(selected.manifest, source)
  ) {
    options.onProgress?.("Reusing current immutable artifact");
    return selected;
  }
  options.onProgress?.("Checking verified artifact cache");
  const reusable = findReusableFrizzArtifact(sourceDir, root, source);
  const artifact = reusable
    ? (() => {
        options.onProgress?.("Reusing cached immutable artifact");
        return reusable;
      })()
    : (() => {
        options.onProgress?.("No matching artifact found; building immutable artifact");
        return options.build
          ? options.build(sourceDir, root)
          : buildFrizzArtifact(sourceDir, root, { onProgress: options.onProgress });
      })();
  options.onProgress?.("Promoting verified immutable artifact");
  promoteFrizzArtifact(stateDir, artifact.digest, root);
  return artifact;
}

/**
 * Update & Restart's artifact step: build the checkout's current source, promote it, and hand back
 * the artifact it replaced as the single rollback target.
 *
 * The currently promoted artifact is read ONLY for that rollback slot; it is deliberately NOT a
 * precondition. One built before source tightened artifact validation — a new
 * WORKER_PLUGIN_REQUIRED_FILES entry, say — stops verifying while its child keeps serving perfectly
 * happily, and refusing to update THEN disables the one control that moves the instance past it.
 * promoteFrizzArtifact takes the same position on a broken previous pointer.
 */
export function promoteCurrentSourceArtifact(
  stateDir: string,
  sourceDir: string,
  root = defaultArtifactRoot(),
  options: EnsureStableArtifactOptions = {}
): { candidate: FrizzArtifact; previous: FrizzArtifact | undefined } {
  const previous = readStableArtifact(stateDir, root) ?? undefined;
  options.onProgress?.("Building immutable artifact from current source");
  const candidate = options.build
    ? options.build(sourceDir, root)
    : buildFrizzArtifact(sourceDir, root, { onProgress: options.onProgress });
  options.onProgress?.("Promoting verified immutable artifact");
  promoteFrizzArtifact(stateDir, candidate.digest, root);
  return { candidate, previous };
}

/** Atomically select a verified artifact. The old current digest remains the single rollback slot. */
export function promoteFrizzArtifact(
  stateDir: string,
  digest: string,
  root = defaultArtifactRoot()
): StableArtifactPointer {
  readFrizzArtifact(digest, root);
  let previous: string | undefined;
  try {
    const old = JSON.parse(
      readFileSync(join(stateDir, "stable.json"), "utf8")
    ) as StableArtifactPointer;
    // Do not retain a broken pointer as the rollback target when repairing a damaged selection.
    if (typeof old.current === "string")
      previous = readFrizzArtifact(old.current, root).digest;
  } catch {}
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pointer: StableArtifactPointer = {
    version: 1,
    current: digest,
    ...(previous && previous !== digest ? { previous } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(join(stateDir, "stable.json"), pointer);
  return pointer;
}
