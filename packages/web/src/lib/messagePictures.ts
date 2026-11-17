// A MESSAGE THAT SHOWS THE HUMAN A PICTURE NEVER FOLDS (2026-11-17, maintainer: "We should probably just
// never collapse any message containing screenshots").
//
// A worker puts a picture in front of the human on purpose: the worker contract says nothing it LOOKS at
// reaches the human's screen, and only a ```lightbox fence (or a Markdown image, or a picture it sends) does.
// So a picture is always written for the human, wherever in the stretch it lands — and the stretch fold
// (lib/stretchFolds) keeps only the lead and the sign-offs, so a gallery posted mid-work, between tool calls
// and before the write-up, went behind the hairline with the narration around it. ChatView's rows keep any
// message this says yes to, the way they keep a question's home.
//
// What counts is what the transcript DRAWS as a picture: a ```lightbox gallery with at least one entry, a
// bare image-path line (lib/imagePaths, drawn as a BlockImage), a Markdown `![…](…)` image, and a
// SendUserFile delivery carrying images (lib/toolActivity isPictureTool) — in the prose and in a signal
// fence's body, which a done or awaiting card renders as Markdown too. A picture a tool merely RETURNED (an
// image Read, a take_screenshot) is the worker looking, not showing, and still folds with its call. Anything
// quoted inside a code block is code, not a picture.
//
// Pure string logic, no DOM.

import { insideFence, type TranscriptToolCall } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { splitProseAttachments } from "./imagePaths.ts"
import { parseLightboxBody } from "./lightbox.ts"
import { isPictureTool } from "./toolActivity.ts"

export interface PictureMsgLike {
  role: string
  kind?: string
  text: string
  tools?: readonly Pick<TranscriptToolCall, "sentImages">[]
}

// Cheap gate before any parse: every spelling below holds one of these.
const MAY_SHOW = /lightbox|!\[|\.(?:png|jpe?g|gif|webp)/i
const LIGHTBOX_OPENER = /^\s{0,3}(`{3,}|~{3,})\s*lightbox\s*$/i
// `![alt](dest…`: an image with a destination.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*[^\s)]/
const CODE_SPAN = /(`+)[\s\S]*?\1/g

/** Markdown the prose renderer draws whole: a `![…](…)` image, or a lightbox fence left in place (inside a
 *  `<details>` section, splitProseAttachments lifts nothing out). Lines quoted in a code block are code. */
function markdownShowsPicture(md: string): boolean {
  const quoted = insideFence(md)
  const lines = md.split("\n")
  let offset = 0
  for (let i = 0; i < lines.length; offset += lines[i].length + 1, i++) {
    if (quoted(offset)) continue
    const line = lines[i]
    const opener = line.match(LIGHTBOX_OPENER)
    if (opener) {
      const close = new RegExp(`^\\s{0,3}${opener[1][0] === "`" ? "`" : "~"}{${opener[1].length},}\\s*$`)
      let end = i + 1
      while (end < lines.length && !close.test(lines[end])) end++
      if (end < lines.length && parseLightboxBody(lines.slice(i + 1, end).join("\n")).length > 0) return true
      continue
    }
    if (MARKDOWN_IMAGE.test(line.replace(CODE_SPAN, ""))) return true
  }
  return false
}

function proseShowsPicture(md: string): boolean {
  return splitProseAttachments(md).some((p) => p.kind === "image" || p.kind === "lightbox" || (p.kind === "md" && markdownShowsPicture(p.text)))
}

/** True when the agent message puts a picture or a video in front of the human (see the header). */
export function showsPicture(m: PictureMsgLike): boolean {
  if (m.role !== "assistant" || m.kind === "event") return false
  if (m.tools?.some(isPictureTool)) return true
  if (!MAY_SHOW.test(m.text)) return false
  return splitFenceBlocks(m.text).some((seg) => proseShowsPicture(seg.kind === "prose" ? seg.text : seg.body))
}
