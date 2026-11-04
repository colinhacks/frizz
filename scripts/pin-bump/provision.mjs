#!/usr/bin/env node
// Provision the Claude Code or Codex build THIS checkout pins, without the server's boot sweep.
//
//   nub scripts/pin-bump/provision.mjs claude
//   nub scripts/pin-bump/provision.mjs codex
//
// A bump worktree names a build no running server pins yet, and a Frizz server's boot sweep deletes
// every provisioned runtime it does not pin. So the new build has to be fetched by hand before it can
// be probed, and fetched AGAIN if a server restarted in between (it happened to 2.1.311, 2.1.312 and
// Codex 0.163.0). This calls the production provisioner directly, which fetches into the real runtimes
// root and touches nothing else. Run it from the checkout whose pin you want: it reads that checkout's
// `runtimes.ts`, so from a bump worktree it fetches the new build and from `main` the current one.
// Prints `{"bin", "label", "fetched"}`; `fetched: false` means the build was already there.
import { fileURLToPath, pathToFileURL } from "node:url"
import { join } from "node:path"

const backend = process.argv[2]
if (backend !== "claude" && backend !== "codex") {
  console.error("usage: nub scripts/pin-bump/provision.mjs <claude|codex>")
  process.exit(1)
}
const root = fileURLToPath(new URL("../..", import.meta.url))
const runtimes = await import(pathToFileURL(join(root, "packages/server/src/runtimes.ts")).href)
const coordinates = runtimes.runtimeCoordinates(backend)
if (!coordinates) throw new Error(`no ${backend} coordinates for this platform`)
const pin = backend === "claude" ? runtimes.CLAUDE_CODE_VERSION : runtimes.CODEX_VERSION
console.error(`provisioning ${backend} ${pin} into ${runtimes.runtimesRoot()}`)
const provisioned = await runtimes.provisionRuntime(backend, { root: runtimes.runtimesRoot(), coordinates })
console.log(JSON.stringify(provisioned))
