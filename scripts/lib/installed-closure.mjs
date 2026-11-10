// What npm put beside an installed `frizz-server`, held against what its manifest names.
//
// The published server declares no dependency: its bundle carries the file watcher's JavaScript, and
// its manifest names the watcher's platform binaries as exact optional dependencies
// (scripts/lib/package-build.mjs). So an installed generation is `frizz-server` and the binary or two
// that match the machine, and anything else there was resolved on that machine by a range nobody here
// reviewed. The package verifiers ask this of the generation a real launcher installed
// (verify-server-package.mjs on macOS, verify-linux-package.mjs in a container).
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Every package directly in a `node_modules` directory, a scoped one as `@scope/name`. */
export function installedPackages(nodeModules) {
  return readdirSync(nodeModules)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => (name.startsWith("@") ? readdirSync(join(nodeModules, name)).map((child) => `${name}/${child}`) : [name]))
    .sort()
}

/**
 * Why the generation installed at `nodeModules` is not exactly what its server names, or null when it
 * is. A server that still declares `dependencies` (every release before the closure was pinned) is not
 * judged: npm resolved those, and what they brought is not named anywhere.
 */
export function closureProblem(nodeModules) {
  const manifestPath = join(nodeModules, "frizz-server", "package.json")
  if (!existsSync(manifestPath)) return "no frizz-server is installed here"
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) return null
  const named = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  const beside = installedPackages(nodeModules).filter((name) => name !== "frizz-server")
  const unnamed = beside.filter((name) => !named.has(name))
  if (unnamed.length > 0) return `installed but named by nothing: ${unnamed.join(", ")}`
  if (named.size > 0 && beside.length === 0) return "none of the watcher's binaries was installed, so the server cannot watch a project"
  for (const name of beside) {
    const version = JSON.parse(readFileSync(join(nodeModules, name, "package.json"), "utf8")).version
    if (version !== manifest.optionalDependencies[name]) return `${name} is ${version}, and the server names ${manifest.optionalDependencies[name]}`
  }
  return null
}
