// Build the two registry artifacts. `frizz` is the stable shell; `frizz-server` is the replaceable
// server generation it installs. Each server entry is a real file because the supervisor starts the
// child and detached daemons in separate Node processes.
import { join, resolve } from "node:path"
import { rmSync, existsSync } from "node:fs"
import { build } from "esbuild"
import { DETACHED_DAEMON_ENTRIES, detachedDaemonOutputName } from "../packages/server/src/detached-daemons.ts"
import { SERVER_BUILD_OPTIONS, SERVER_CHILD_ENTRY, SHELL_BUILD_OPTIONS, SHELL_ENTRIES, WORKSPACE as workspace } from "./lib/package-build.mjs"

const serverRelease = resolve(workspace, "packages/server-release")
const mode = process.argv[2]
if (mode !== "--shell" && mode !== "--server") throw new Error("usage: build-package.mjs --shell | --server")

const shared = mode === "--shell" ? SHELL_BUILD_OPTIONS : SERVER_BUILD_OPTIONS
const entries = mode === "--shell" ? { ...SHELL_ENTRIES } : { ...SERVER_CHILD_ENTRY }
if (mode === "--server") {
  for (const entry of DETACHED_DAEMON_ENTRIES) entries[detachedDaemonOutputName(entry)] = entry
}
const dist = resolve(mode === "--shell" ? workspace : serverRelease, "dist")
rmSync(dist, { recursive: true, force: true })
for (const [outName, entry] of Object.entries(entries)) {
  await build({ ...shared, entryPoints: [entry], outfile: join(dist, outName) })
}
for (const outName of Object.keys(entries)) {
  if (!existsSync(join(dist, outName))) throw new Error(`build-package: expected ${outName} was not emitted`)
}
console.log(`built ${mode === "--shell" ? "frizz shell" : "frizz-server"}: ${Object.keys(entries).join(", ")}`)
