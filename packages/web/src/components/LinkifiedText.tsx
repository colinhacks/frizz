import { useEffect, useMemo } from "react"
import { plainLinkSegments } from "../lib/plainLinks.ts"
import { noteGithubRefs } from "../lib/githubHovercards.ts"
import { useGithubRepoForLinks } from "../lib/useMarkdown.ts"

// Plain user text with the link-shaped runs made clickable — the render half of lib/plainLinks.ts.
// For the surfaces that show a human's words verbatim (the user bubble, an answers-card reply) where
// full markdown would rewrite what they typed: every text byte renders as-is, but a pasted URL or a
// GitHub ref becomes the same anchor it would be in agent prose, hovercard included.
export function LinkifiedText({ text }: { text: string }) {
  // A render input for the same reason useMarkdownHtml subscribes: the repo arrives from the board a
  // beat after the transcript, and on the Console it is this surface's project's, not the page's.
  const repo = useGithubRepoForLinks()
  const segments = useMemo(() => plainLinkSegments(text, repo), [text, repo])
  // Queue the hovercard fetch at render time, same contract as useGithubHovercardRefs — the delegated
  // pointerover has its own just-in-time request, but pre-noting means a hover is never blank.
  const refs = useMemo(
    () => segments.flatMap((s) => (s.kind === "link" && s.ghRef ? [s.ghRef] : [])),
    [segments],
  )
  useEffect(() => {
    if (refs.length > 0) noteGithubRefs(refs)
  }, [refs])
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <a
            key={i}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            data-gh-ref={s.ghRef ?? undefined}
            // Inherit the host's text colour (this renders on BOTH the off-white bubble and the dark
            // answers chip; md-body's accent yellow is illegible on the former) — the underline alone
            // carries "clickable", the same treatment .md-inline links get.
            className="underline underline-offset-2"
            // The user bubble is itself clickable while queued (click-to-unqueue) — a link click or
            // an Enter on a focused link must open the link, not retract the message.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {s.text}
          </a>
        ),
      )}
    </>
  )
}
