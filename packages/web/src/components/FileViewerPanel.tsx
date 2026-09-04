import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { closeFilePanel, addContextItem, store } from "../store.ts"
import { draftKey, draftStore, useProjectDir, useThreadSessionId } from "../lib/drafts.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { useLiveLocalFile } from "../hooks.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { LOCAL_FILE_POLL_MS, highlightedSource, localFileQuery } from "../lib/localFileQuery.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitFrontmatter } from "../lib/frontmatter.ts"
import { isLocalMarkdownFile, localFileDir } from "../lib/markdownTargets.ts"
import { contextChipLabel, insertTokenIntoProse, locateInSource, uniqueToken } from "../lib/composerContext.ts"
import { Frontmatter, FOOTER_STYLE, OpenAction } from "./MarkdownDrawer.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The /full page's SPLIT file viewer: the same built-in markdown reader as MarkdownDrawer, framed as
// a PANEL BESIDE the thread instead of a sheet over it — on /full the transcript is the whole point,
// and covering it to read a file defeated the page. Two additions over the drawer reader:
//
//   · a Rendered ⇄ Source toggle (the source view shows the file verbatim, frontmatter included);
//   · ⌘I over a selection in EITHER view stages that selection as a context item on the thread's
//     composer — an `@file:line` chip inline in the prose at the caret (see lib/composerContext.ts).
//
// Line numbers for a source-view selection are exact (character offsets against the raw text); for a
// rendered-view selection they are best-effort (whitespace-insensitive unique match), because the
// markdown pipeline re-wraps and re-writes what the DOM shows.

// The character offset of (node, offsetInNode) within `root`, by summing every text node before it.
// The source <pre> renders one string child, but browsers MAY split large text on parse — walking is
// what keeps the offset right either way.
function charOffsetIn(root: Element, node: Node, offset: number): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) return total + offset
    total += current.textContent?.length ?? 0
  }
  // An element-node boundary (triple-click selections end on one): count text fully before it.
  if (node instanceof Element && root.contains(node)) {
    const inner = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let sum = 0
    for (let current = inner.nextNode(); current; current = inner.nextNode()) {
      const pos = node.compareDocumentPosition(current)
      if (pos & Node.DOCUMENT_POSITION_PRECEDING || node.contains(current)) sum += current.textContent?.length ?? 0
    }
    return sum
  }
  return null
}

function lineOfOffset(raw: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, raw.length)
  for (let i = 0; i < end; i++) if (raw.charCodeAt(i) === 10) line++
  return line
}

export function FileViewerPanel({ slug, path }: { slug: string; path: string }) {
  // Markdown reads through the reader gate (`.md` only) and renders; anything else reads through the
  // text gate — the same roots since 2026-09-03 — and is source, full stop. The read itself lives in
  // lib/localFileQuery so the rail can PREWARM it on hover through the identical key.
  //
  // LIVE while open: the server watches the file and the socket invalidates this query on every save
  // (useLiveLocalFile), so the panel follows a worker's edits as they land. The poll is the fallback
  // for a socket that is not up; data stays on screen across a refetch, so neither path flickers.
  const markdown = isLocalMarkdownFile(path)
  const live = useLiveLocalFile(path)
  const body = useQuery({ ...localFileQuery(path), refetchInterval: live ? false : LOCAL_FILE_POLL_MS })
  // Canonical path from the server (symlinks resolved) — the base for relative links, the label, and
  // the path stamped on context items, exactly as in MarkdownDrawer.
  const resolved = body.data?.path ?? path
  const raw = body.data?.markdown ?? ""
  const { front, body: source } = splitFrontmatter(markdown ? raw : "")
  const [view, setView] = useState<"rendered" | "source">(markdown ? "rendered" : "source")
  const html = useMarkdownHtml(source, { baseDir: localFileDir(resolved), asDocument: true })
  const inner = useInnerHtml(html)
  // Highlighted ONLY when the source view is actually showing, and memoised across mounts by
  // localFileQuery: a markdown file opens rendered, and hljs over its raw text was a blocking task
  // nothing displayed. A hover on the rail's file row has usually already paid for this.
  const sourceHtml = useInnerHtml(useMemo(() => (view === "source" ? highlightedSource(resolved, raw) : ""), [raw, resolved, view]))
  const renderedRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLPreElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(renderedRef, html)
  const title = resolved.split("/").filter(Boolean).pop() || resolved

  // ⌘I / Ctrl-I: stage the current selection (when it lives inside this panel) as a context item —
  // splicing its `@file:line` token into the draft AT THE CARET — then FOCUS the composer
  // (maintainer 2026-08-31: "Hit Command-I, which adds the chip. Type immediately into the prompt
  // box."). A textarea keeps its own caret across blur, so the reference lands exactly where the
  // writer was typing (maintainer 2026-09-02: the chip landed "at the beginning of the prompt box
  // instead of where the cursor currently exists"), and prose can interleave with references —
  // `… @guide.md:3 like so, and @guide.md:16 like this` — which is what lets the agent tie each
  // comment to its selection. A bare ⌘I with no selection just focuses the box. Window-level,
  // capture-phase: the selection owns no focusable element, so a local key handler would never see
  // the chord.
  const projectDir = useProjectDir()
  const sessionId = useThreadSessionId(slug)
  useEffect(() => {
    const composerTextarea = () => document.querySelector<HTMLTextAreaElement>("main[data-standalone-thread] textarea")
    // The caret the reference belongs at, in PROSE coordinates (the textarea's value IS the draft's
    // prose — attachments live on trailing lines the composer peels off). A never-touched textarea
    // reports 0/0; that means "no caret yet", and the reference belongs at the END of what was
    // already typed, not in front of it.
    function caretIn(ta: HTMLTextAreaElement | null, prose: string): number {
      if (!ta) return prose.length
      const untouched = document.activeElement !== ta && ta.selectionStart === 0 && ta.selectionEnd === 0 && ta.value.length > 0
      return untouched ? prose.length : Math.min(ta.selectionStart ?? prose.length, prose.length)
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i") return
      const root = rootRef.current
      const selection = window.getSelection()
      const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const inPanel = !!(root && range && root.contains(range.commonAncestorContainer))
      const text = inPanel ? selection!.toString() : ""
      if (!inPanel || !text.trim()) {
        // No stageable selection: the chord still lands the writer in the prompt box.
        e.preventDefault()
        e.stopPropagation()
        const ta = composerTextarea()
        if (!ta) return
        if (document.activeElement !== ta && ta.selectionStart === 0 && ta.selectionEnd === 0 && ta.value.length > 0) {
          ta.setSelectionRange(ta.value.length, ta.value.length)
        }
        ta.focus()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // Exact lines when the selection sits in the verbatim <pre>; best-effort otherwise.
      let lines: { startLine: number; endLine: number } | null = null
      const pre = sourceRef.current
      if (pre && pre.contains(range!.commonAncestorContainer)) {
        const start = charOffsetIn(pre, range!.startContainer, range!.startOffset)
        const end = charOffsetIn(pre, range!.endContainer, range!.endOffset)
        if (start !== null && end !== null) {
          lines = { startLine: lineOfOffset(raw, Math.min(start, end)), endLine: lineOfOffset(raw, Math.max(0, Math.max(start, end) - 1)) }
        }
      } else {
        lines = locateInSource(raw, text)
      }
      const ta = composerTextarea()
      const key = draftKey.followUp(projectDir, slug, sessionId)
      const { prose, attachments } = splitComposerValue(draftStore.get(key))
      // The token is the chip's own label behind an `@` — what the human reads in the box is the
      // reference itself, not a number pointing at one.
      const token = uniqueToken(contextChipLabel({ path: resolved, ...(lines ?? {}) }), store.composerContext[slug] ?? [], prose)
      const spliced = insertTokenIntoProse(prose, caretIn(ta, prose), token)
      draftStore.set(key, joinComposerValue(spliced.prose, attachments.map((attachment) => attachment.path)))
      addContextItem(slug, { token, path: resolved, text, ...(lines ?? {}) })
      // Collapsing the selection is the acknowledgment — the reference appearing in the composer is
      // the payload, and a still-highlighted range invites a second ⌘I that would stage a duplicate.
      selection!.removeAllRanges()
      // The caret goes just past the new reference — but only after React commits the new draft into
      // the controlled textarea; setting it against the old value would clamp or drift.
      requestAnimationFrame(() => {
        const el = composerTextarea()
        if (!el) return
        el.setSelectionRange(spliced.caret, spliced.caret)
        el.focus()
      })
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [slug, resolved, raw, projectDir, sessionId])

  return (
    <div ref={rootRef} data-file-viewer-panel className="flex h-full min-h-0 flex-col">
      <SheetHeader
        title={title}
        subtitle={resolved}
        onClose={closeFilePanel}
        actions={
          // The active segment's fill must contrast the HEADER it sits on (bg-panel) — an earlier
          // bg-panel fill was invisible there and the state read only from text brightness. A
          // non-markdown file has no rendered form, so it gets no toggle.
          !markdown ? null : <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11px] font-medium" role="group" aria-label="File view">
            {(["rendered", "source"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-pressed={view === mode}
                className={`rounded px-2 py-0.5 transition-colors ${view === mode ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
              >
                {mode === "rendered" ? "Rendered" : "Source"}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {body.isLoading ? (
          <div className="text-[13px] text-muted">Loading…</div>
        ) : body.error ? (
          <div className="text-[13px] text-red-400/90">Couldn’t read this file: {(body.error as Error).message}</div>
        ) : view === "source" ? (
          raw ? (
            // Highlighted through the same hljs pipeline as every transcript code body (lib/codeBody);
            // the grammar comes from the filename. The invariant codeBody.test pins — highlighted
            // markup carries the SAME TEXT — is what keeps the ⌘I char-offset walk exact over the
            // added spans. `hljs` on the element is what the palette hangs off (styles.css).
            <pre
              ref={sourceRef}
              className="hljs whitespace-pre-wrap break-words bg-transparent font-mono-keep text-[12px] leading-5 text-fg/90"
              style={{ tabSize: 2 }}
              dangerouslySetInnerHTML={sourceHtml}
            />
          ) : (
            <div className="text-[13px] text-muted">This file is empty.</div>
          )
        ) : html ? (
          <>
            {front && <Frontmatter source={front} />}
            <div ref={renderedRef} className="md-body" dangerouslySetInnerHTML={inner} />
          </>
        ) : (
          <div className="text-[13px] text-muted">This file is empty.</div>
        )}
        {!body.isLoading && !body.error && body.data?.truncated && (
          <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
            This file is too long to render in full — everything above the cut is shown. Open it to read the rest.
          </p>
        )}
      </div>
      <div
        className="shrink-0 flex items-center justify-between gap-3 border-t border-border/60 bg-panel px-5 pt-3"
        style={FOOTER_STYLE}
      >
        <span className="min-w-0 truncate text-[11px] text-muted/70">Select text and press ⌘I to add it to the chat</span>
        <OpenAction path={resolved} />
      </div>
    </div>
  )
}
