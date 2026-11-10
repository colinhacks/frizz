// How the two registry artifacts are bundled (scripts/build-package.mjs writes them). The options
// live here, apart from the script that empties and fills `dist/`, so a test can bundle the shell in
// memory exactly as a release does and then start it (scripts/build-package.test.mjs).
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** The stable shell is this one file. */
export const SHELL_ENTRIES = { "frizz.js": "src/production.ts" }

export const PACKAGE_BUILD_OPTIONS = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  absWorkingDir: WORKSPACE,
  banner: {
    js: 'import { createRequire as __frizzCreateRequire } from "node:module"; const require = __frizzCreateRequire(import.meta.url);',
  },
  // Left for Node to resolve where the artifact is installed. The server installs the watcher; the
  // shell installs nothing, so its bundle may only reach either one through an `import()` it never runs.
  external: ["@parcel/watcher", "vite"],
  logLevel: "silent",
}
