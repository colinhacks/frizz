import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import type { ThreadLinkView } from "@frizz/shared"
import { resolveOpenableFile, type LocalFileRoot } from "./local-file.ts"
import type { ThreadLinkRow } from "./storage.ts"

export function threadLinkView(row: ThreadLinkRow): ThreadLinkView {
  return { id: row.id, kind: row.kind, label: row.label, target: row.target }
}

export function resolveThreadLink(target: string, projectDir: string, roots: readonly LocalFileRoot[]): Pick<ThreadLinkView, "kind" | "target"> {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target)
    if (url.username || url.password) throw new Error("Link URLs must not contain credentials")
    // Registration never requests the URL or claims that a dev server is running.
    return { kind: "link", target: url.href }
  }
  let path = target
  if (/^file:/i.test(target)) {
    const url = new URL(target)
    if (url.search || url.hash) throw new Error("File links must not contain a query or fragment")
    path = fileURLToPath(url)
  } else if (!isAbsolute(target) && /^[a-z][a-z\d+.-]*:/i.test(target)) {
    throw new Error("Register an HTTP(S) URL or a local file")
  }
  const resolved = resolveOpenableFile(path, projectDir, roots)
  if (!resolved) throw new Error("Local file was not found or is outside Frizz's trusted roots")
  return { kind: "file", target: resolved }
}
