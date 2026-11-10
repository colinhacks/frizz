// What is left of the launcher updating ITSELF, and the version arithmetic the server update shares.
//
// Through 0.12.13 an Update & Restart replaced the launcher: it resolved the new release
// through `npm exec`, asked that release where its bundle was (`--_frizz-print-launcher`), and
// execve'd into it, or on Windows started it detached and waited for it to answer
// (`--_frizz-production-reexec`). Since 0.13.0 (554afe613, 2026-09-11) the launcher stays as it is
// and an update swaps the server generation behind it (`updateMode: "child"` in production.ts,
// server-release.ts), so no current launcher SENDS that handoff.
//
// The RECEIVING half is still the only way a launcher before 0.13.0 updates into this release, and
// that is what this file keeps: the two flags, `reexecArgv` for the argv those launchers pass, and
// the global-install hint that 0.12.12 and 0.12.13 hand down through `GLOBAL_INSTALL_ENV`.
// `verify-server-updates.mjs --legacy-tarball=<frizz-0.12.10.tgz>` runs that handoff from the
// published 0.12.10.
//
// The sending half (the npm launcher, `resolveRegistrySuccessor`, the execve and detached handoffs,
// the successor wait, the npm adapter) had no caller for two months and was deleted on 2026-11-10.
// It kept being maintained meanwhile: an npm 12 fix and a release-age fix were each applied to it
// beside the live installer. If the launcher ever updates in place again, it is at
// `git show 49dbabc88:src/production-update.ts`.

export const PRODUCTION_REEXEC_FLAG = "--_frizz-production-reexec";

/**
 * Print the absolute path of the launcher bundle that is running and exit 0. Internal: this is how
 * a launcher before 0.13.0 finds the entry of the release it resolved through npm, so it can execve
 * into it (keeping its pid and its terminal) instead of guessing where npm put the execution cache.
 */
export const PRODUCTION_PRINT_LAUNCHER_FLAG = "--_frizz-print-launcher";

/** Where the newest version of a package is read from. The server installer is the one in use. */
export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
}

export interface RegistryUpdatePlan {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  packageSpec: string;
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
  adapter: RegistryReleaseAdapter
): Promise<RegistryUpdatePlan | null> {
  const latestVersion = (await adapter.latestVersion(packageName)).trim();
  const comparison = compareReleaseVersions(currentVersion, latestVersion);
  if (comparison === null)
    throw new Error(`cannot safely compare installed Frizz version ${currentVersion} with registry version ${latestVersion}`);
  if (comparison >= 0) return null;
  return { packageName, currentVersion, latestVersion, packageSpec: `${packageName}@${latestVersion}` };
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
 * Whether this bundle runs from a GLOBAL install (`npm i -g frizz`), the one shape a launcher's
 * self-update does not persist: the release goes into npm's `_npx` execution cache, the global bin
 * still points at the old package, and the next `frizz` from a shell is the old version again with
 * nothing said (audit 2026-09-11, finding 9). `npx frizz` re-resolves `latest` on every run, so it
 * self-heals.
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
