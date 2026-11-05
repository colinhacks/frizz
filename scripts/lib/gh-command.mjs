import { execFileSync, spawnSync } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"

// HOW A REPO SCRIPT RUNS `gh`. One rule, so the release and token scripts cannot drift apart.
//
// On the maintainer's Mac plain `gh` holds a read-only sign-in, and a write goes through Keyward, which
// hands `gh` a token that can write for one run at a time: `keyward --reason "<the task>" -- gh …`.
// Keyward reads only the first word of the command, so nothing can wrap a whole script:
// `keyward -- node script.mjs` hands the script nothing, and each `gh` write the script makes has to go
// through Keyward itself. In a Frizz worker on that Mac, plain `gh` reads with
// Frizz's read-only credential, so a script reads plainly and only its writes go through Keyward.
// Everywhere else — a contributor's signed-in `gh`, CI with a token in its environment — plain `gh` is
// right for both.
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

/** Whether plain `gh` here is Frizz's read-only credential (see frizzGithubWorkerEnv on the server). */
export function ghIsFrizzReadOnly(env = process.env) {
  return Boolean(env.GH_CONFIG_DIR) && existsSync(join(env.GH_CONFIG_DIR, "frizz-read-only"))
}

/** Whether this environment reaches GitHub through Keyward rather than a signed-in plain `gh`. */
export function ghNeedsKeyward(env = process.env, { write = false } = {}) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return false
  // Where Keyward is installed, plain `gh` only reads: its sign-in is a read-only token (the
  // maintainer's own, or Frizz's in a worker), so a write on it would fail with a 403. Every write goes
  // through Keyward there, whatever `gh auth status` says.
  if (write) return onPath("keyward", env)
  if (ghIsFrizzReadOnly(env)) return false
  const status = spawnSync("gh", ["auth", "status", "--active"], { env, stdio: "ignore", timeout: 8000 })
  if (status.status === 0) return false
  return onPath("keyward", env)
}

/**
 * `[command, args]` for one `gh` run. `reason` is shown on the Touch ID sheet, so it says what the
 * script is doing in words the maintainer recognises. `write` marks a run that changes something on
 * GitHub. The answer is worked out once per process for each of the two.
 */
const answers = new Map()
export function ghCommand(reason, args, { write = false, env = process.env } = {}) {
  if (!answers.has(write)) answers.set(write, ghNeedsKeyward(env, { write }))
  return answers.get(write) ? ["keyward", ["--reason", reason, "--", "gh", ...args]] : ["gh", args]
}

/** `execFileSync` for `gh`, through Keyward where that is how this machine reaches GitHub. */
export function execGh(reason, args, { write = false, ...options } = {}) {
  const [command, argv] = ghCommand(reason, args, { write })
  return execFileSync(command, argv, options)
}

/** Test-only: forget the per-process answer. */
export function resetGhCommand() {
  answers.clear()
}
