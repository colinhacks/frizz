#!/usr/bin/env nub
// The README prints `npx frizz --help`, and that copy went stale: on 2026-11-10 it listed six options
// where the launcher printed ten, and its own FAQ used two of the four it was missing (`--status`,
// `--stop`). So the block is not written by hand any more. This bundles the launcher the way a
// release does, runs its `--help`, and puts what it printed between the two markers in README.md.
//
//   nub scripts/sync-readme-help.mjs           rewrite the block
//   nub scripts/sync-readme-help.mjs --check   exit 1 if the README differs (the suite runs this)
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { SHELL_BUILD_OPTIONS, SHELL_ENTRIES, WORKSPACE } from "./lib/package-build.mjs"

export const README = join(WORKSPACE, "README.md")
const START = "<!-- help:start (written by scripts/sync-readme-help.mjs; edit the launcher's help, not this) -->"
const END = "<!-- help:end -->"

/** What `npx frizz --help` prints, from the launcher as a release would bundle it. */
export async function launcherHelp() {
  const [[outName, entry]] = Object.entries(SHELL_ENTRIES)
  const bundled = await build({ ...SHELL_BUILD_OPTIONS, entryPoints: [entry], outfile: join(WORKSPACE, "dist", outName), write: false })
  const root = mkdtempSync(join(tmpdir(), "frizz-help-"))
  try {
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", outName), bundled.outputFiles[0].contents)
    writeFileSync(join(root, "package.json"), readFileSync(join(WORKSPACE, "package.json")))
    // `--help` is answered before the launcher reads a home directory or a project; it is given an
    // empty one anyway, and none of the variables of a Frizz this runs under.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FRIZZ_") && !name.startsWith("NODE_")))
    const run = spawnSync(process.execPath, [join(root, "dist", outName), "--help"], { cwd: root, env: { ...env, HOME: root }, encoding: "utf8", timeout: 60_000 })
    if (run.status !== 0) throw new Error(`the launcher's --help exited ${run.status}: ${run.stderr.slice(0, 600)}`)
    return run.stdout.replace(/\s+$/, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The fenced block the README carries for that output. */
export function helpBlock(help) {
  return `${START}\n\`\`\`sh\n$ npx frizz --help\n\n${help}\n\`\`\`\n${END}`
}

/** The README with its help block replaced, or null when it has no markers to write between. */
export function withHelpBlock(readme, help) {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end === -1 || end < start) return null
  return readme.slice(0, start) + helpBlock(help) + readme.slice(end + END.length)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const readme = readFileSync(README, "utf8")
  const next = withHelpBlock(readme, await launcherHelp())
  if (next === null) throw new Error(`README.md has no "${START}" … "${END}" pair to write the help between`)
  if (process.argv.includes("--check")) {
    if (next !== readme) {
      console.error("README.md's help block is not what the launcher prints. Run: nub scripts/sync-readme-help.mjs")
      process.exit(1)
    }
    console.log("README.md's help block is what the launcher prints")
  } else if (next !== readme) {
    writeFileSync(README, next)
    console.log("README.md: help block rewritten")
  } else {
    console.log("README.md: help block already current")
  }
}
