import { execFileSync, spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

// HOW A REPO SCRIPT RUNS `gh`. One rule, so the release and token scripts cannot drift apart.
//
// On the maintainer's Mac plain `gh` is signed out, and Keyward signs it in one run at a time:
// `keyward --reason "<the task>" -- gh …`. Keyward reads only the first word of the command, so nothing
// can wrap a whole script: `keyward -- node script.mjs` hands the script nothing, and each `gh` the
// script runs has to go through Keyward itself. Everywhere else — a contributor's signed-in `gh`, CI
// with a token in its environment — plain `gh` is right, so that is tried first.
//
// This is for scripts a person or a worker runs by hand. Frizz's server never comes here: it reads
// GitHub with its own credential (packages/server/src/github-credential.ts).

function onPath(name, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

/** Whether this environment reaches GitHub through Keyward rather than a signed-in plain `gh`. */
export function ghNeedsKeyward(env = process.env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return false
  const status = spawnSync("gh", ["auth", "status", "--active"], { env, stdio: "ignore", timeout: 8000 })
  if (status.status === 0) return false
  return onPath("keyward", env)
}

/**
 * `[command, args]` for one `gh` run. `reason` is shown on the Touch ID sheet, so it says what the
 * script is doing in words the maintainer recognises. The answer is worked out once per process.
 */
let useKeyward
export function ghCommand(reason, args, env = process.env) {
  useKeyward ??= ghNeedsKeyward(env)
  return useKeyward ? ["keyward", ["--reason", reason, "--", "gh", ...args]] : ["gh", args]
}

/** `execFileSync` for `gh`, through Keyward where that is how this machine reaches GitHub. */
export function execGh(reason, args, options) {
  const [command, argv] = ghCommand(reason, args)
  return execFileSync(command, argv, options)
}

/** Test-only: forget the per-process answer. */
export function resetGhCommand() {
  useKeyward = undefined
}
