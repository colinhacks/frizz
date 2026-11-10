// MAKES A FORKED DAEMON CRASH ON CUE, FROM OUTSIDE IT.
//
// A daemon is a detached process with no stdio, and nothing in its protocol makes it throw, so the only
// way to test what an uncaught error leaves behind is to put one there. NODE_OPTIONS carries a preload
// into the daemon and nothing else: each host forks its daemon with the server's own environment and
// hands the agent's environment over in the payload, so `fork` is given a snapshot taken before the
// preload was added and the agent never loads it.
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export type CrashKind = "throw" | "reject"

/** Runs `fork`, which must start its daemon before it resolves, and returns what it resolved with beside
 *  a `crash` that makes that daemon throw an error nobody catches, or reject a promise nobody handles. */
export async function forkArmedToCrash<T>(
  dir: string,
  fork: (agentEnv: NodeJS.ProcessEnv) => Promise<T>,
): Promise<{ forked: T; crash: (kind: CrashKind) => void }> {
  const cue = join(dir, "crash-cue")
  const preload = join(dir, "crash-on-cue.mjs")
  writeFileSync(preload, [
    `import { readFileSync } from "node:fs"`,
    `const timer = setInterval(() => {`,
    `  let kind`,
    `  try { kind = readFileSync(${JSON.stringify(cue)}, "utf8") } catch { return }`,
    `  clearInterval(timer)`,
    `  if (kind === "reject") void Promise.reject(new Error("rejected on cue"))`,
    `  else throw new Error("thrown on cue")`,
    `}, 20)`,
    `timer.unref()`,
    ``,
  ].join("\n"))
  const agentEnv = { ...process.env }
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `${before ?? ""} --import=${pathToFileURL(preload).href}`.trim()
  try {
    return {
      forked: await fork(agentEnv),
      // Renamed into place, so the daemon never reads the cue half-written and takes the wrong branch.
      crash: (kind) => { writeFileSync(`${cue}.tmp`, kind); renameSync(`${cue}.tmp`, cue) },
    }
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = before
  }
}
