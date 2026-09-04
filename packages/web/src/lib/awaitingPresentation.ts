import { RETIRED_AWAITING_KINDS, type AwaitingHint } from "@frizz/shared"
import { githubRefUrl } from "./githubRef.ts"

/** The awaiting card's TITLE when the worker named none — which is most fences. It is true of every
 *  park on the board and specific to none, so it is a LAST RESORT: a fence that wrote its own `title:`
 *  heads the card with that instead (awaitingFenceTitle, read by awaitingBackgroundLabel). */
export const AWAITING_FALLBACK_TITLE = "Awaiting"

/** What the card says when the fence carries NO prose — an empty body, or one that was nothing but
 *  machinery lines, which never reach the reader. Only reachable on a card that also has no rows (a
 *  fence in a sub-agent's own transcript), and it exists because a card that is a bare heading says
 *  less than a sentence does. */
export const AWAITING_NO_PROSE = "Waiting for an external update."

/** The PRs this fence is parked on, in fence order, deduped — clickable, because the fence line is the
 *  only place the ref exists and a card that names a PR without reaching it is a dead end (maintainer
 *  2026-07-31: "obviously this should have a link to the PR being watched").
 *
 *  `url` is null when the value is not `owner/repo#N`. A malformed ref still names what the worker
 *  meant, so the card shows it as plain text rather than hiding it or offering a broken link — and the
 *  server refuses to park on it either way, so it cannot pass silently. */
export function prWatchRefs(hints: readonly AwaitingHint[]): { ref: string; url: string | null }[] {
  const seen = new Set<string>()
  return hints.flatMap((hint) => {
    if (hint.kind !== "pr") return []
    const ref = hint.value.trim()
    if (!ref || seen.has(ref)) return []
    seen.add(ref)
    return [{ ref, url: githubRefUrl(ref) }]
  })
}

/** THE WORKER'S OWN PROSE for a hover popover — the fence's Markdown BODY, else its legacy `reason:`.
 *
 *  An awaiting fence is FRONTMATTER, then Markdown (2026-08-17; the frontmatter itself became YAML on
 *  2026-08-24): structural keys, a `---` delimiter, and below it as much prose as the worker wants —
 *  OPTIONAL prose, since what frizz actually requires is a live item and a `for:`. `reason:` is the
 *  one-line form that shape replaced, and it was retired outright at the YAML cutover; it survives here
 *  only to read a fence stored before then. Reading only `reason:` therefore drops the handoff of every
 *  fence written the CURRENT way, which is what the rail popover did until this existed.
 *
 *  The FIRST PARAGRAPH only, and its internal line breaks flattened: a body may run to 500 characters of
 *  headings and bullets, and a hover label is not where you read that. It is the lede a worker already
 *  writes — the card below the rail renders the whole thing.
 *
 *  Null when the fence carries neither, which is an ordinary park: a popover that invents prose is worse
 *  than one that just names the state. */
export function awaitingProse(fence: { body?: string }): string | null {
  const lede = (fence.body ?? "").split(/\n\s*\n/).map((para) => para.trim()).find(Boolean)
  return lede ? reasonSentence(capForHover(lede.replace(/\s*\n\s*/g, " "))) : null
}

/** One paragraph is still a paragraph. Cut on a word boundary so a long lede reads as trimmed rather
 *  than broken — the awaiting card carries the full body for anyone who wants it. */
function capForHover(prose: string): string {
  if (prose.length <= HOVER_PROSE_MAX) return prose
  const cut = prose.slice(0, HOVER_PROSE_MAX)
  const space = cut.lastIndexOf(" ")
  return `${(space > HOVER_PROSE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "")}…`
}

const HOVER_PROSE_MAX = 240

/** THE WORKER'S OWN PROSE, PRESENTED AS A SENTENCE — capitalized, because everywhere frizz draws it, it
 *  stands alone: its own paragraph under the rail popover's sentence, its own line in the awaiting card.
 *
 *  Workers write it lowercase, and that is frizz's own doing — the shipped contract's example read
 *  `reason: what you are waiting for, in one line`, so a fence arrived as a fragment and rendered as one
 *  ("At rest — waiting on acme/app#391" over "the tap submission is queued…", maintainer 2026-08-19:
 *  "why is that second sentence fucking lowercase?"). The example now models a sentence, but a worker's
 *  contract is FROZEN INTO ITS SYSTEM PROMPT AT DISPATCH: every session already running keeps writing
 *  the old shape, so the presentation has to carry it and always will. (`reason:` as a KEY is retired —
 *  2026-08-24 — but the handoff it carried simply moved below the `---`, and it arrives just as lowercase
 *  from a frozen contract, so this is unchanged by the cutover.)
 *
 *  It only ever touches the FIRST LETTER, and not when the first word is code — an identifier
 *  (`awaitingFragments`), a path (`packages/web`), a ref (`v2.1`, `#391`) or a lowercase-by-name tool
 *  (`npm`, `gh`). Capitalizing "npm" is not a typo the way capitalizing an identifier is a WRONG NAME,
 *  and a reason that opens on a bare command is the one case where leaving it alone reads better. */
export function reasonSentence(reason: string): string {
  const first = (reason.split(/\s/, 1)[0] ?? "").replace(/[.,:;]+$/, "")
  const isCode = /[^a-zA-Z]/.test(first) || /[A-Z]/.test(first.slice(1)) || LOWERCASE_BY_NAME.has(first)
  return isCode ? reason : reason.charAt(0).toUpperCase() + reason.slice(1)
}

/** Tools whose names are lowercase BY NAME, not by accident — the ones that actually open a reason in
 *  this repo. A short list on purpose: it exists to catch the common opener, not to enumerate every
 *  command on earth, and a miss costs one capital letter rather than a wrong name. */
const LOWERCASE_BY_NAME = new Set(["npm", "npx", "pnpm", "nub", "nubx", "gh", "git", "node", "bun", "tsc", "vite", "curl", "ssh"])

// THE CARD'S PROSE, and under the structural grammar the FRONTMATTER IS NOT PART OF IT.
//
// A fence's frontmatter is structure and nothing else, so anything left in `body` ABOVE the `---` is a
// line the parser did NOT recognise — a worker still writing the deleted `watch:`, or a typo. (The live
// keys are the plural YAML sequences of 2026-08-24: `shells:`/`agents:`/`timers:`/`prs:` plus `for:`.)
// Joining that into the card's sentence printed raw fence syntax at the human: "watch: bvg44v4ij — CI on
// #1227 is running…" (maintainer 2026-08-16: "why the fuck is the awaiting block looking like this?").
// It is not prose, it is a malformed declaration — the worker gets BUMPED for it (scheduler SOURCE 12),
// which is where that belongs, and the card says what it can rather than showing the machinery.
//
// NULL, not a placeholder sentence: the card's heading and rows already state the wait, so an empty
// handoff wants no filler and no divider above one. The one card that has neither — a fence in a
// sub-agent's own transcript, with no thread and so no rows — says AWAITING_NO_PROSE instead, and that
// is the card's call to make rather than this function's.
export function awaitingProseBlock(body: string | undefined): string | null {
  return body ? stripFenceSyntax(body) || null : null
}

/** RAW FENCE SYNTAX MUST NEVER REACH THE READER (maintainer 2026-08-16, with a screenshot of a card
 *  reading "watch: bvg44v4ij / for: 40m / reason: CI on #1227 is running…" — "why the fuck is the
 *  awaiting block looking like this?").
 *
 *  A line the parser refused lands in the BODY, which is exactly right for the WORKER — it has to see
 *  what frizz ignored — and exactly wrong for the human, who is being shown machinery. Until 2026-08-24
 *  the card dodged this by preferring the `reason:` hint over the body; `reason:` is retired, so the
 *  filter has to be explicit.
 *
 *  It strips ONLY a line whose key is a key: a retired kind, or one of the live YAML keys. That
 *  narrowness is the point — a handoff that opens "Note: the macOS leg is flaky" is prose, and a filter
 *  keyed on "has a colon" would eat it. */
const FENCE_SYNTAX_KEYS = new Set<string>([...RETIRED_AWAITING_KINDS, "shells", "agents", "timers", "prs", "for", "title"])
function stripFenceSyntax(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const key = /^\s*([a-z][a-z-]*):/i.exec(line)?.[1]?.toLowerCase()
      return !(key && FENCE_SYNTAX_KEYS.has(key))
    })
    .join("\n")
    .trim()
}

/** WHAT THIS THREAD IS WAITING ON, as a CLAUSE — the middle of a sentence the row's popover finishes.
 *
 *  The rail's rows carry a TITLE and nothing else (maintainer 2026-08-19: "there should never ever be
 *  any fucking thing in the sidebar except for the fucking title"), so every fence detail that used to
 *  ride a subtitle moved into the row's popover — and it has to READ there, not merely be present. The
 *  first cut printed one fragment per hint kind, stacked ("Watching acme/app#391 — new activity wakes
 *  it" over "Waiting on a background shell" over the reason), which is a machine dumping its record
 *  rather than a sentence telling you anything (maintainer, same day: "that popover text looks fucking
 *  terrible").
 *
 *  So: ONE verb over ONE list. "waiting on" is what a person actually says about all of it — a PR, a
 *  shell, a child, a clock — and a single conjoined list is what makes four facts read as one thought.
 *  The PR keeps its REF because that names a thing you might go look at; everything else is COUNTED,
 *  because a runtime id ("bzvtnt3ig") means nothing on a hover and three of them is a wall.
 *
 *  Order is fixed by KIND, not by the order the worker wrote the fence in, so two fences naming the
 *  same things read identically. Null when the fence names nothing — a park the server refuses anyway,
 *  so the popover says what it knows and invents no wait. */
export function awaitingWaitClause(hints: readonly AwaitingHint[]): string | null {
  const count = (kind: AwaitingHint["kind"]) => hints.filter((h) => h.kind === kind && h.value.trim()).length
  const parts = [
    ...prWatchRefs(hints).map((pr) => pr.ref),
    plural(count("shell"), "background shell", "background shells"),
    plural(count("agent"), "sub-agent", "sub-agents"),
    plural(count("timer"), "timer", "timers"),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `waiting on ${joinList(parts)}` : null
}

/** "a timer" / "2 timers" / nothing at all — the counted form, because the ids themselves are noise. */
function plural(n: number, one: string, many: string): string | null {
  if (n <= 0) return null
  return n === 1 ? `a ${one}` : `${n} ${many}`
}

/** "a", "a and b", "a, b and c" — the Oxford comma is deliberately absent; this is one short spoken
 *  list in a hover label, not a specification. */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("")
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** THE MOBILE BOARD'S one-line gloss, and the LAST inline caption frizz draws under a thread title.
 *
 *  The desktop rail dropped its subtitle entirely (maintainer 2026-08-19) and moved every fence detail
 *  into the row's hover popover. A phone has no hover, so the mobile row keeps the one fragment worth a
 *  line without one: a PR ref names a THING rather than describing a wait, and it exists nowhere else on
 *  that row. Everything else the fence carries — the ids, the duration, the worker's own prose — stays
 *  off it, exactly as it does on the rail. */
export function hintGloss(hints: readonly AwaitingHint[]): string | null {
  const pr = hints.find((h) => h.kind === "pr")
  return pr ? `PR ${pr.value}` : null
}
