import type { TranscriptToolCall } from "@frizz/shared"

// The two halves of a tool row's header, one class string each, because six components draw the header
// and a row whose groups disagree about `items-center` versus `items-baseline` sits a pixel off the rows
// around it with nothing in its CSS looking wrong. Baseline, because a row mixes sans prose, mono paths and
// an 11.5px reading, and only the baseline puts those on one line.
export const TOOL_ROW_LEAD = "flex min-w-0 items-baseline gap-2"
export const TOOL_ROW_TAIL = "flex shrink-0 items-baseline gap-2"

// What a settled call's rail node says when it says more than "this ran". `edit` is set by the Edit row
// itself, which is the one row that knows it changed something; lib/diff/diff.css draws all three. A live
// call draws its liveness mark in the node's place, so it has no value here.
export type ToolRailNode = "edit" | "failed" | "cancelled"

export function toolRailNode(status: TranscriptToolCall["status"] | undefined): ToolRailNode | undefined {
  return status === "failed" || status === "cancelled" ? status : undefined
}

// A path in two pieces, so a row can dim the folder and keep the filename whole when the column runs out
// of room: the folder is the half that truncates. Either separator, as lib/paths.ts reads them.
export function splitToolPath(path: string): { dir: string; base: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  return { dir: path.slice(0, cut), base: path.slice(cut) }
}
