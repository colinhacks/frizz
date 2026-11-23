import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

// A PATH lookup with nothing else around it. It lived in backend/acp-agents.ts, which imports the shared
// index, so the launcher's GitHub sign-in check (github-credential.ts) bundled zod and yaml to find `gh`.

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== "win32") accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

/** Find `command` on PATH (or verify it as an absolute path). Windows also tries PATHEXT suffixes. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(command)) return isExecutableFile(command) ? command : undefined
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase())
      if (isExecutableFile(candidate)) return candidate
      if (ext && isExecutableFile(join(dir, command + ext))) return join(dir, command + ext)
    }
  }
  return undefined
}
