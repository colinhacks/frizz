// Whether `scripts/adhoc-stack.mjs` may serve the folder it was pointed at.
//
// A server serves the folder its resolver names: the Git repository its working directory is in, or
// failing that the nearest folder at or above it that holds a `.frizz/.id` or a manifest
// (`resolveProjectDir`, packages/server/src/project.ts). So `--project=<a plain folder>` under a real
// project boots THAT project: its board, its `.frizz/threads/`, and its folder as every worker's
// working directory, under whatever HOME the stack was given. Nothing said so. The json line simply
// had no `launcher`, because the folder the caller named was never registered (found 2026-11-10: a
// scratch folder under a real project, caught before anything was dispatched into it).
//
// A stack is disposable and the folder above is not, so an explicit `--project` that would serve
// another folder is refused. The default, the directory the stack was started in, keeps resolving
// upward: that is how `nub scripts/adhoc-stack.mjs` run from inside this checkout serves the checkout.

/** The refusal to print, or undefined when the stack serves the folder it was given. */
export function adhocProjectRefusal({ given, served, explicit }) {
  if (!explicit || given === served) return undefined
  return [
    `--project=${given} is not a project of its own.`,
    `Frizz would serve ${served} instead, the nearest folder above it with a Git repository, a .frizz/.id or a manifest, and run its workers there.`,
    `Pass that folder to serve it on purpose, or run \`git init\` in ${given} to make it its own project.`,
  ].join(" ")
}
