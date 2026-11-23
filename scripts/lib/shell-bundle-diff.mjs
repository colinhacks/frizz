// Has the `frizz` shell changed since the one npm serves? Asked of the bundles themselves.
//
// The release preflight asked whether any file under `src/` had changed. That counted files the shell
// never carries (frizz 0.13.25 was cut for `src/worker-plugin-closure.ts`, a build-time list) and missed
// the server and shared files it does carry (`supervisor-pages.ts` changed the shell in 0.13.22 and
// 0.13.24). So this builds the shell at the commit being released, exactly as a release builds it,
// downloads the shell npm serves, and compares the two one source file at a time, by the `// path`
// line esbuild writes above each file's code. A bundle carries no comments, so an edit that only
// touches comments changes nothing here. plans/shell-release-cadence.md has the history.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";

import { SHELL_BUILD_OPTIONS, SHELL_ENTRIES, WORKSPACE } from "./package-build.mjs";

const SECTION = /^\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/;

/**
 * Where a section's code came from, the same on every machine. A package's files sit under a different
 * store on CI (`node_modules/.pnpm/ws@8.21.0/node_modules/ws/…`) and here (`../../.cache/nub/…`), so a
 * package is named from its last `node_modules/` on.
 */
export function sectionName(source) {
  const at = source.lastIndexOf("node_modules/");
  return at === -1 ? source : source.slice(at);
}

/**
 * A section's code with what differs between two builds of the same source taken out.
 *
 * - A CommonJS package is wrapped under its file's path, which names the machine's package store, so
 *   that path is cut back to its last `node_modules/` as `sectionName` does.
 * - Two files that both declare `join` are bundled as `join` and `join2`, so a file added anywhere
 *   renumbers names in files that did not change: `join` becomes `join2`. A name's trailing digits are
 *   dropped on both sides, which hides only a change between two names that differ in them alone.
 */
export function comparable(code) {
  return code
    .replace(/(["'`])[^"'`\n]*node_modules\//g, "$1node_modules/")
    .replace(/\b([A-Za-z_$][A-Za-z_$]*?)\d+\b/g, "$1");
}

/** A bundle as its sections: the source each came from, and its code as `comparable` leaves it. */
export function bundleSections(text) {
  const sections = new Map();
  let name = "(bundle preamble)";
  let lines = [];
  const flush = () => sections.set(name, comparable((sections.has(name) ? `${sections.get(name)}\n` : "") + lines.join("\n")).trim());
  for (const line of text.split("\n")) {
    const match = SECTION.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    name = sectionName(match[1]);
    lines = [];
  }
  flush();
  return sections;
}

/** What differs between two shell bundles, by the source file each section came from. */
export function shellSectionChanges(published, candidate) {
  const [before, after] = [bundleSections(published), bundleSections(candidate)];
  const changes = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) === after.get(name)) continue;
    changes.push({ name, change: !before.has(name) ? "added" : !after.has(name) ? "removed" : "changed" });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

const LOADERS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".json": "json" };

/**
 * The shell built from `commit`, not from the working tree, which on this machine routinely holds other
 * agents' unfinished edits. Every file of this repository is read from git at that commit; packages come
 * from the checkout's `node_modules`, which is the lockfile's. Imports are resolved against the checkout,
 * so a file the commit has and the checkout does not fails the build rather than reading something else.
 */
export async function buildShellAt(commit, workspace = WORKSPACE) {
  const atCommit = {
    name: "frizz-at-commit",
    setup(bundler) {
      bundler.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args) => {
        const relative = path.relative(workspace, args.path);
        if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) return undefined;
        const contents = execFileSync("git", ["show", `${commit}:${relative.split(path.sep).join("/")}`], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 });
        return { contents, loader: LOADERS[path.extname(args.path)] ?? "js", resolveDir: path.dirname(args.path) };
      });
    },
  };
  const [[outName, entry]] = Object.entries(SHELL_ENTRIES);
  const result = await build({
    ...SHELL_BUILD_OPTIONS,
    absWorkingDir: workspace,
    entryPoints: [entry],
    outfile: path.join(workspace, "dist", outName),
    write: false,
    plugins: [atCommit],
  });
  return new TextDecoder().decode(result.outputFiles[0].contents);
}

/** One file out of a package tarball as npm serves it: gzip over ustar, every entry under `package/`. */
export function fileInTarball(tgz, wanted) {
  const tar = gunzipSync(tgz);
  const field = (header, start, length) => header.toString("utf8", start, start + length).replace(/\0[\s\S]*$/, "");
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    offset += 512;
    if (name === wanted) return tar.toString("utf8", offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is not in the tarball`);
}

/** The shell bundle npm serves for one version, from its packument entry's tarball. */
export async function publishedShellBundle(tarballUrl) {
  const response = await fetch(tarballUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${tarballUrl}`);
  return fileInTarball(Buffer.from(await response.arrayBuffer()), `package/dist/${Object.keys(SHELL_ENTRIES)[0]}`);
}

/**
 * The changes as one line: this repository's files by path, packages once each by name. A package's
 * files come and go together, and listing yaml's fifty would bury the one source file that matters.
 */
export function describeShellChanges(changes, shown = 6) {
  const files = [];
  const packages = new Map();
  for (const { name, change } of changes) {
    const inPackage = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(name);
    if (!inPackage) files.push(change === "changed" ? name : `${name} (${change})`);
    else packages.set(inPackage[1], packages.has(inPackage[1]) && packages.get(inPackage[1]) !== change ? "changed" : change);
  }
  const named = [...files, ...[...packages].map(([name, change]) => (change === "changed" ? `package ${name}` : `package ${name} (${change})`))];
  return named.length <= shown ? named.join(", ") : `${named.slice(0, shown).join(", ")} and ${named.length - shown} more`;
}
