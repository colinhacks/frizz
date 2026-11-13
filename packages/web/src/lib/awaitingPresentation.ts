import { awaitingQuestions, awaitingSteps, RETIRED_AWAITING_KINDS, type AwaitingHint, type ThreadWatchView } from "@frizz/shared"
import { githubRefUrl } from "./githubRef.ts"

/** AN ```awaiting FENCE THAT NAMES QUESTIONS DRAWS NO CARD (maintainer 2026-10-08: "if there are
 *  questions that are getting rendered, we don't even need to bother rendering the awaiting card").
 *
 *  Since 2026-10-05 `questions:` is how a later rest keeps an old question's card (lib/questionAnchor),
 *  so a worker woken by CI with two answers still owed re-fences on nothing new — and the rest drew an
 *  hourglass card restating the ask directly above the question cards that ARE the ask. The cards are
 *  the actionable thing and the handoff; what else the fence names is live work, which the ops summary
 *  above the queue card's prompt box, the drawer's ops strip and the /full rail already list with the
 *  same rows. So the card goes, and the fence's prose stays as plain handoff text (ChatView Message),
 *  because it is the worker's own words.
 *
 *  NOT WHEN IT ALSO HANDS OVER `steps:` — the Done verb lives on that card and nowhere else. */
export function awaitingDefersToQuestions(hints: readonly AwaitingHint[] | undefined): boolean {
  return awaitingQuestions(hints).length > 0 && awaitingSteps(hints).length === 0
}

/** The awaiting card's KIND (TranscriptCard's KindLabel, the small line over the title) — on every awaiting
 *  card that is not a shell-only rest or a steps card. It was the card's TITLE until 2026-10-13, and a LAST
 *  RESORT one: true of every park on the board and specific to none, so a fence that wrote its own `title:`
 *  replaced it. As the kind it names itself once, small, and the worker's `title:` goes under it instead of
 *  in its place (awaitingBackgroundKind). */
export const AWAITING_KIND = "Awaiting"

/** The kind over a rest on background shells and nothing else — the maintainer's own name for that shape
 *  (2026-08-04: 'the card that says "awaiting background work" should be renamed to "background shells
 *  running"'). That rest is not awaiting anything, so it never wears AWAITING_KIND. */
export const SHELLS_KIND = "Background shells running"

/** What the card says when the fence carries NO prose — an empty body, or one that was nothing but
 *  machinery lines, which never reach the reader. Only reachable on a card that also has no rows: a
 *  fence in a sub-agent's own transcript, or a quiet park whose names have all just settled and whose
 *  wake has not gone out yet. That second shape is why it exists in the queue at all, and it stood there
 *  for 2m 30s on 2026-10-29 — a passed command watch's wake held by the quiet window, exempt since
 *  (server wake-store.ts). It exists because a card that is a bare heading says less than a sentence
 *  does. */
export const AWAITING_NO_PROSE = "Waiting for an external update."

/** The KIND over a card handing the human `steps:` — the one fence shape whose wait is on the READER
 *  (TranscriptCard's KindLabel). The worker's `title:` goes under it; with none, the kind alone heads the
 *  card. It was the first card to name its kind apart from its title (a chip, 2026-10-05); every block
 *  type does since 2026-10-13, as a small line.
 *
 *  "Awaiting human", not "To do" (maintainer 2026-10-10: "lets call this 'Awaiting human'"). "To do"
 *  named a list, and a worker filled it like one — commands it could have run itself beside the one
 *  approval it could not. This names the WAIT: the thread is stopped on a person, which is true only of
 *  an act nobody else can perform. The worker contract tells the worker the card's heading in the same
 *  words. */
export const STEPS_KIND = "Awaiting human"

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
    // An `issues:` entry is the same chip with the issue path — the card is about it in exactly the
    // way it is about a `prs:` entry, and the ref exists nowhere else on the card either.
    if (hint.kind !== "pr" && hint.kind !== "issue") return []
    const ref = hint.value.trim()
    if (!ref || seen.has(`${hint.kind}:${ref}`)) return []
    seen.add(`${hint.kind}:${ref}`)
    return [{ ref, url: githubRefUrl(ref, hint.kind === "issue" ? "issue" : "pull") }]
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
// handoff wants no filler and no divider above one. A card that has neither — a fence in a sub-agent's
// own transcript, with no thread and so no rows, or a park whose names have all just settled — says
// AWAITING_NO_PROSE instead, and that is the card's call to make rather than this function's.
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
// The answer lines are machinery too: `status:` (2026-10-05) and the `needs_input:` it replaced, in both
// spellings the parser reads.
const FENCE_SYNTAX_KEYS = new Set<string>([...RETIRED_AWAITING_KINDS, "shells", "agents", "timers", "prs", "issues", "monitors", "commands", "for", "title", "status", "needs_input", "needs-input"])
function stripFenceSyntax(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const key = /^\s*([a-z][a-z_-]*):/i.exec(line)?.[1]?.toLowerCase()
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
 *  so the popover says what it knows and invents no wait.
 *
 *  `watches` is the thread's registered rows, read for one thing: a monitor's description (`frizzctl
 *  monitor add`, a check's since 2026-11-12 and a persistent one's since 2026-11-03). A lone one is NAMED by the worker's own words the way a PR
 *  is named by its ref: it is the one thing on the row the reader would recognise. Any other mix is counted,
 *  because "the monitor “X” and a monitor" says less than "2 monitors". */
export function awaitingWaitClause(hints: readonly AwaitingHint[], watches: readonly ThreadWatchView[] = []): string | null {
  const count = (kind: AwaitingHint["kind"]) => hints.filter((h) => h.kind === kind && h.value.trim()).length
  const commands = count("command")
  const lone = commands === 1 ? fenceMonitors(hints, watches)[0] : undefined
  const named = lone ? monitorDescription(lone) : undefined
  const parts = [
    // Steps first: the reader is the one being waited on, which outranks anything frizz is watching.
    plural(count("step"), "step from you", "steps from you"),
    plural(count("question"), "answer from you", "answers from you"),
    ...prWatchRefs(hints).map((pr) => pr.ref),
    named ? `the monitor “${named}”` : null,
    plural(count("shell"), "background shell", "background shells"),
    plural(count("agent"), "sub-agent", "sub-agents"),
    plural(count("timer"), "timer", "timers"),
    named ? null : plural(commands, "monitor", "monitors"),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `waiting on ${joinList(parts)}` : null
}

/** The armed PERSISTENT command watches a fence's `commands:` entries name, in fence order, deduped. An id
 *  that names a check, or nothing the board knows, is not one. */
function fenceMonitors(hints: readonly AwaitingHint[], watches: readonly ThreadWatchView[]): ThreadWatchView[] {
  const byId = new Map(watches.filter((w) => w.kind === "command" && w.state === "armed" && monitorDescription(w)).map((w) => [w.target, w]))
  const seen = new Set<string>()
  return hints.flatMap((h) => {
    const id = h.value.trim()
    const monitor = h.kind === "command" ? byId.get(id) : undefined
    if (!monitor || seen.has(id)) return []
    seen.add(id)
    return [monitor]
  })
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
 *  that row. A persistent command watch's description is the same kind of name (2026-11-03) — the worker's words for what
 *  it watches, which is required at registration so there is always one to show. Everything else the
 *  fence carries — the ids, the duration, the worker's own prose — stays off it, exactly as it does on
 *  the rail. `watches` is read only to find that description by its `cmw_…` id. */
export function hintGloss(hints: readonly AwaitingHint[], watches: readonly ThreadWatchView[] = []): string | null {
  const pr = hints.find((h) => h.kind === "pr")
  if (pr) return `PR ${pr.value}`
  const issue = hints.find((h) => h.kind === "issue")
  if (issue) return `Issue ${issue.value}`
  const monitor = fenceMonitors(hints, watches)[0]
  return monitor ? `Monitor: ${monitorDescription(monitor)}` : null
}

/** A monitor's description, a check's or a persistent one's — undefined for a row registered without. */
function monitorDescription(watch: ThreadWatchView): string | undefined {
  return watch.command?.description || watch.command?.monitor?.description || undefined
}
