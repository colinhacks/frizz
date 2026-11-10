// How the two registry artifacts are bundled (scripts/build-package.mjs writes them). The options
// live here, apart from the script that empties and fills `dist/`, so a test can bundle the shell in
// memory exactly as a release does and then start it (scripts/build-package.test.mjs).
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** The stable shell is this one file. */
export const SHELL_ENTRIES = { "frizz.js": "src/production.ts" }

/** The server's control-plane child. Its detached daemons are bundled beside it (build-package.mjs). */
export const SERVER_CHILD_ENTRY = { "dev-child.js": "packages/server/src/dev-child.ts" }

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  absWorkingDir: WORKSPACE,
  // `require` for the CommonJS a bundle carries, resolved from where the bundle is installed.
  banner: {
    js: 'import { createRequire as __frizzCreateRequire } from "node:module"; const require = __frizzCreateRequire(import.meta.url);',
  },
  logLevel: "silent",
}

// The shell installs nothing. It may name the watcher and Vite only in an `import()` it never runs.
export const SHELL_BUILD_OPTIONS = { ...common, external: ["@parcel/watcher", "vite"] }

// THE SERVER CARRIES THE WATCHER'S JAVASCRIPT. `@parcel/watcher` is not external here, so its loader
// and the four packages that loader needs (picomatch, is-glob, is-extglob, detect-libc) are bundled at
// the versions this workspace's lockfile holds. What is left for the user's machine to install is the
// platform's binary, which the loader asks for by name (`@parcel/watcher-darwin-arm64`, …) through
// the banner's `require`, and which packages/server-release/package.json pins exactly.
//
// Until 2026-11-10 the watcher was external and `frizz-server` depended on it, so every install and
// every update resolved four semver ranges (`picomatch ^4.0.3`, …) on the user's machine, with the
// launcher's `--min-release-age=0` lifting their release-age guard for all of it.
//
// `*.node` stays external: the loader's fallbacks name a locally built binary by path, inside a `try`.
export const SERVER_BUILD_OPTIONS = { ...common, external: ["vite", "*.node"] }
