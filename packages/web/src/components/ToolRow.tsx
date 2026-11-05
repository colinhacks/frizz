import { ChevronRight } from "lucide-react"
import { splitToolPath } from "../lib/toolRow.ts"
import { store } from "../store.ts"

// The pieces every tool row shares (lib/diff/diff.css draws the rail they sit on). Its own file because
// DiffBlock draws a row too and ChatView imports DiffBlock.

// Repo-relative display: strip the project prefix (pure noise — every path shares it) but keep the REST
// intact; the row truncates only when genuinely too long. Commands, patterns and queries pass through.
export function shortenTarget(detail: string): string {
  const root = store.board?.projectDir
  if (root && detail.startsWith(root + "/")) return detail.slice(root.length + 1)
  return detail
}

// A path as a row draws it: the folder dim, the filename bright. The folder is the half that truncates, so
// a narrow column reads `packages/web/sr…ChatView.tsx` rather than losing the one part that names the file.
export function ToolPathText({ path }: { path: string }) {
  const { dir, base } = splitToolPath(path)
  return (
    <span className="frizz-tool-path">
      {dir && <span className="frizz-tool-path-dir">{dir}</span>}
      <span className="frizz-tool-path-base">{base}</span>
    </span>
  )
}

// A row's chevron, or the same 12px of nothing on a row with no body. A chevron on only some rows moved
// the readings beside them, so a column of durations had two right edges (maintainer 2026-11-05 chose the
// design that reserves it on every row).
export function ToolRowChevron({ open = false, shown = true }: { open?: boolean; shown?: boolean }) {
  if (!shown) return <span aria-hidden="true" className="w-3 shrink-0" />
  return <ChevronRight aria-hidden="true" size={12} className={`frizz-tool-chevron${open ? " rotate-90" : ""}`} />
}
