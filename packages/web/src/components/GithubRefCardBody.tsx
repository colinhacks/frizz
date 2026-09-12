import type { GithubRefCard } from "@frizz/shared"
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { AGE_LADDER_YEARS_FROM_DAYS, compactAge } from "../lib/activityTime.ts"
import { PRIMER } from "../lib/primer.ts"
import { githubLabelColors } from "../lib/githubLabelColors.ts"

// The CONTENTS of a GitHub hovercard — the panel GithubHovercards.tsx anchors under a `#123` or a
// commit hash. Split from the hover machinery so it can be rendered from a fixture with a literal
// card and judged on its own, with no network and no pointer.
//
// It is a deliberate replica of github.com's own hovercard, because that is what the maintainer asked
// for and because the reader already knows how to read it: repo + date, then the title carrying its
// number, then the state pill, then an excerpt with labels, then who opened it and when. The COLOURS
// are GitHub's own state palette rather than this app's, for the same reason — green/purple/red/grey
// on an issue is a vocabulary people arrive already fluent in, and re-spelling it in accent-yellow
// would make a familiar object unreadable.

// GitHub's state colours (Primer dark), from `lib/primer.ts` — which is where they live now that the
// PR watch row, the picker and the file rail draw the same states and had each reached for a different
// Tailwind hue instead. A PILL IS A SOLID FILL, so every one of these is a `bg*Emphasis`: the lighter
// `fg*` pair is for a bare glyph, and a `#3fb950` pill would out-shout the title above it.
// Read off github.githubassets.com 2026-08-14: `--bgColor-open-emphasis` resolves to success, closed
// to danger, draft to neutral, and a merged/completed state to done.
const STATE_STYLE: Record<string, { bg: string; icon: LucideIcon; label: string }> = {
  OPEN_ISSUE: { bg: PRIMER.bgSuccessEmphasis, icon: CircleDot, label: "Open" },
  CLOSED_ISSUE: { bg: PRIMER.bgDoneEmphasis, icon: CircleCheck, label: "Closed" },
  NOT_PLANNED: { bg: PRIMER.bgNeutralEmphasis, icon: CircleSlash, label: "Closed as not planned" },
  OPEN_PR: { bg: PRIMER.bgSuccessEmphasis, icon: GitPullRequest, label: "Open" },
  DRAFT: { bg: PRIMER.bgNeutralEmphasis, icon: GitPullRequestDraft, label: "Draft" },
  MERGED: { bg: PRIMER.bgDoneEmphasis, icon: GitMerge, label: "Merged" },
  CLOSED_PR: { bg: PRIMER.bgDangerEmphasis, icon: GitPullRequestClosed, label: "Closed" },
}

/** The pill key for one card — the state plus the two things that qualify it (kind, close reason). */
export function stateKey(card: GithubRefCard): string | null {
  if (card.kind === "commit") return null
  if (card.state === "MERGED") return "MERGED"
  if (card.state === "DRAFT") return "DRAFT"
  if (card.state === "OPEN") return card.kind === "pr" ? "OPEN_PR" : "OPEN_ISSUE"
  if (card.state === "CLOSED") {
    if (card.kind === "pr") return "CLOSED_PR"
    return card.stateReason === "NOT_PLANNED" ? "NOT_PLANNED" : "CLOSED_ISSUE"
  }
  return null
}

// "Aug 1", or "Aug 1, 2025" once the year differs from today's — the header line's short date, which
// is GitHub's own treatment.
export function shortDate(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ""
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ""
  const sameYear = t.getFullYear() === new Date(nowMs).getFullYear()
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })
}

// GitHub's COARSE recency: a card says `2w ago`, never `358h ago`. The LADDER is the coarse part and
// it is this function's own — anything past a year falls back to the date, because "1y ago" stops being
// information about a two-year-old commit. The SPELLING is the app's, so `compactAge` carries every
// reading under a year rather than this file keeping a second ladder that says the same spans in
// different words (it spelled them out — "2 weeks ago" — until the 2026-08-31 sweep).
export function coarseAgo(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const days = Math.floor(Math.max(0, nowMs - t) / 86_400_000)
  if (days >= AGE_LADDER_YEARS_FROM_DAYS) return `on ${shortDate(iso, nowMs)}`
  return compactAge(iso, nowMs) ?? ""
}

// GitHub's five-block diffstat, MEASURED off github.com rather than designed from taste (2026-08-14,
// the commit in the maintainer's own screenshot). Both the rule and the squares are theirs:
//
//   nubjs/nub@92ed4cc, per file    blocks drawn        floor(share × 5)
//     +254 −19   (273)             add add add add ·   4.65 / 0.35
//     +7    −0   (7)               add add add add add
//     +76  −12   (88)              add add add add ·   4.32 / 0.68
//     +51   −7   (58)              add add add add ·   4.40 / 0.60
//
// So it is a FLOOR of each side's share with the remainder left NEUTRAL — not a round, and with no
// "a nonzero side always shows" guarantee: 19 deleted lines out of 273 genuinely draw no red square.
// That reads correctly at a glance ("this change is almost entirely additions") and it is the
// vocabulary the reader already has from github.com, which is the whole reason to mirror it.
export function diffBlocks(additions: number, deletions: number): ("add" | "del" | "none")[] {
  const total = additions + deletions
  if (total <= 0) return Array<"none">(5).fill("none")
  const add = Math.min(5, Math.floor((additions / total) * 5))
  const del = Math.min(5 - add, Math.floor((deletions / total) * 5))
  return [
    ...Array<"add">(add).fill("add"),
    ...Array<"del">(del).fill("del"),
    ...Array<"none">(5 - add - del).fill("none"),
  ]
}

// Primer dark, read off github.githubassets.com the same day: the SQUARES take the emphasis fills
// (`--bgColor-success-emphasis` etc.), the NUMBERS beside them take the lighter foreground pair. They
// are deliberately different values — a solid `#3fb950` square would out-shout the text it labels.
const DIFF_TEXT = { add: PRIMER.fgSuccess, del: PRIMER.fgDanger } as const
const BLOCK_STYLE = {
  add: { backgroundColor: PRIMER.bgSuccessEmphasis, borderColor: PRIMER.bgSuccessEmphasis },
  del: { backgroundColor: PRIMER.bgDangerEmphasis, borderColor: PRIMER.bgDangerEmphasis },
  // The empty block is neutral at 0x33, over Primer's own `--borderColor-default` hairline.
  none: { backgroundColor: "color-mix(in srgb, var(--gh-bg-neutral-emphasis) 20%, transparent)", borderColor: "var(--gh-neutral-border)" },
} as const

function Diffstat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    // items-baseline, not items-center: the numbers and the gauge are two marks on one line, so the
    // squares are placed off the shared TEXT BASELINE rather than by centering two unequal boxes.
    <div className="flex items-baseline gap-1.5 text-[12px] tabular-nums">
      <span data-gh-add style={{ color: DIFF_TEXT.add }}>+{additions.toLocaleString()}</span>
      <span data-gh-del style={{ color: DIFF_TEXT.del }}>−{deletions.toLocaleString()}</span>
      {/* 8px squares, 1px apart, 2px radius — github.com's own DiffSquares metrics.
          `self-baseline` puts the row's BOTTOM on the text baseline, so a box of height H needs
          `(H − cap)/2` to centre it on the cap band instead. `cap` is the resolved font's cap
          height, so the browser recomputes it when the font setting flips — the only hand-written
          number is GitHub's own 8px, and `0.5*8px` is written out as 4px.
          The house formula `0.5em − 0.5cap` is for a ONE-EM glyph and is wrong here: at 12px it
          pushed these 8px squares 2.00px BELOW the cap band (measured 2026-08-14). */}
      <span data-gh-blocks className="ml-0.5 inline-flex gap-[1px] self-baseline translate-y-[calc(4px_-_0.5cap)]">
        {diffBlocks(additions, deletions).map((kind, i) => (
          <span key={i} className="size-[8px] rounded-[2px] border" style={BLOCK_STYLE[kind]} />
        ))}
      </span>
    </div>
  )
}

function StatePill({ card }: { card: GithubRefCard }) {
  const key = stateKey(card)
  const style = key ? STATE_STYLE[key] : undefined
  if (!style) return null
  const Icon = style.icon
  return (
    <span
      data-gh-pill
      className="inline-flex items-baseline gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-[color:var(--gh-on-emphasis)]"
      style={{ backgroundColor: style.bg }}
    >
      {/* ITEMS-BASELINE, not items-center, and the size in `em` rather than px. Every one of these
          lucide glyphs is symmetric about its viewBox centre, so centring the BOX on the cap band
          centres the ink — and `cap` is the resolved font's own cap height, which is what makes one
          rule correct in both of this app's fonts. `items-center` was 0.23px low in sans and 0.83px
          low in mono (measured 2026-08-14): a px-pinned glyph beside text that scales cannot be right
          in both, which is the whole reason this is derived rather than fitted. */}
      <Icon
        strokeWidth={2}
        aria-hidden
        // -mr-px collapses the glyph's own measured right dead space (0.94px of empty viewBox at
        // this size) onto its ink, so the pill's `gap-1` reads as ~5px of INK rather than 5.94 —
        // Law 2 of the optical-spacing skill: set the gap once, and let each mark pay for its inset.
        className="size-[1.1em] shrink-0 self-baseline -mr-px translate-y-[calc(0.55em_-_0.5cap)]"
      />
      <span data-gh-pill-label>{style.label}</span>
    </span>
  )
}

// GitHub label hues are API data. The shared treatment preserves each hue as a tint while blending its
// foreground into the document's semantic ink, which keeps white and pale-yellow labels readable.
function LabelChip({ name, color }: { name: string; color: string }) {
  const label = githubLabelColors(color)
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-[1px] text-[11px] font-medium"
      style={{ color: label.foreground, backgroundColor: label.background, borderColor: label.border }}
    >
      {name}
    </span>
  )
}

// An issue or PR body is MARKDOWN and github.com renders its inline code as code — `nub install`
// arrives as a mono chip, not as a pair of visible backticks. A COMMIT message is not markdown, and
// github.com leaves its backticks literal for exactly that reason. Mirroring both is why `code` is a
// parameter here rather than always-on.
//
// Inline code and NOTHING ELSE. The full markdown pipeline is deliberately not reachable from here: it
// would autolink `#123` inside the excerpt, which is an anchor inside a hovercard that a hover on the
// anchor opened — and it would render images and links into a panel that is `aria-hidden` decoration.
const INLINE_CODE = /`([^`\n]+)`/g

export function renderExcerpt(text: string, code: boolean): (string | { code: string })[] {
  if (!code) return [text]
  const out: (string | { code: string })[] = []
  let consumed = 0
  for (const match of text.matchAll(INLINE_CODE)) {
    if (match.index > consumed) out.push(text.slice(consumed, match.index))
    out.push({ code: match[1] })
    consumed = match.index + match[0].length
  }
  if (consumed < text.length) out.push(text.slice(consumed))
  return out
}

function Excerpt({ text, code, className }: { text: string; code: boolean; className: string }) {
  return (
    <div className={className}>
      {renderExcerpt(text, code).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <code key={i} className="rounded-[3px] bg-panel-2 px-[3px] py-[1px] font-mono-keep text-[0.92em]">
            {part.code}
          </code>
        ),
      )}
    </div>
  )
}

// Only GitHub's own image hosts. The card is drawn by this app, not by prose, so this is not a
// sanitizer — it is the one rule that keeps a hovercard from ever fetching an image from anywhere a
// GitHub API response happened to name.
//
// `camo` is in the list because it is where a COMMIT's avatar comes from: an author with no linked
// GitHub account resolves to a Gravatar, which GitHub serves through its own image proxy rather than
// hot-linking. Same owner, same trust; leaving it out silently greyed out every commit card's byline.
const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "camo.githubusercontent.com"])

function avatarSrc(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && AVATAR_HOSTS.has(parsed.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

function Byline({ card, nowMs }: { card: GithubRefCard; nowMs: number }) {
  const src = avatarSrc(card.authorAvatar)
  const who = card.authorLogin ?? card.authorName ?? "Someone"
  const verb = card.kind === "commit" ? "committed" : card.kind === "pr" ? "opened this pull request" : "opened this issue"
  const when = coarseAgo(card.at, nowMs)
  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted">
      {src ? (
        <img data-gh-avatar src={src} alt="" className="size-[18px] shrink-0 rounded-full" />
      ) : (
        <span data-gh-avatar className="size-[18px] shrink-0 rounded-full bg-border" />
      )}
      <span data-gh-byline-text className="truncate">
        <span className="text-fg">{who}</span> {verb} {when}
      </span>
    </div>
  )
}

// One fixed width for every card, so a column of them (and a hover that flips between two) never
// jumps. It yields on a narrow viewport rather than overflowing it.
const CARD_WIDTH = "w-[360px] max-w-[min(360px,calc(100vw-24px))] leading-normal"

export function GithubRefCardBody({ card, nowMs = Date.now() }: { card: GithubRefCard; nowMs?: number }) {
  const hasDiff = card.additions !== undefined && card.deletions !== undefined

  if (card.kind === "commit") {
    return (
      <div className={CARD_WIDTH}>
        {/* items-baseline: the glyph belongs to the FIRST LINE of a headline that wraps, and a flex
            column's baseline IS its first line's — so it stays on that line however many follow. The
            wrapper carries the headline's own `text-[14px]`, because `em` and `cap` resolve against
            the glyph's OWN inherited size and aligning a 13px glyph to 14px text would bake that
            accident into the number. A hand-fitted `mt-[3px]` here read 0.43px low in sans and
            2.97px low in mono (measured 2026-08-14). */}
        <div className="flex items-baseline gap-2 px-3 pt-3 pb-2.5">
          <span data-gh-commit-glyph className="shrink-0 self-baseline -mr-px text-[14px] translate-y-[calc(0.5em_-_0.5cap)]">
            <GitCommitHorizontal className="size-[1em] text-muted" aria-hidden />
          </span>
          <div className="min-w-0">
            {/* The title is the card's click-through, like github.com's own hovercard. `tabIndex={-1}`
                because the whole panel is `aria-hidden` and mouse-only (see GithubHovercards.tsx):
                a tabbable anchor inside a hidden panel would be a focus target screen readers are
                told does not exist. */}
            <a
              data-gh-title
              href={card.url}
              target="_blank"
              rel="noreferrer noopener"
              tabIndex={-1}
              className="block text-[14px] font-semibold leading-snug text-fg hover:underline"
            >
              {card.title}
            </a>
            {/* A commit message is NOT markdown, so its backticks stay LITERAL — which is exactly what
                github.com does with the same text. Its hard wraps do NOT survive, for the same
                reason: a message wrapped at 72 columns re-wrapped into a 360px card comes out as a
                ragged ladder of half-lines. Normal white-space collapses those newlines to spaces and
                the excerpt reflows, which is what github.com's own card shows. */}
            {card.body ? <Excerpt text={card.body} code={false} className="mt-1.5 line-clamp-6 text-[12px] text-muted" /> : null}
            {hasDiff ? (
              <div className="mt-2.5">
                <Diffstat additions={card.additions!} deletions={card.deletions!} />
              </div>
            ) : null}
          </div>
        </div>
        <Byline card={card} nowMs={nowMs} />
      </div>
    )
  }

  const number = card.ref.slice(card.ref.indexOf("#"))
  return (
    <div className={CARD_WIDTH}>
      <div className="px-3 pt-3 pb-3">
        <div className="text-[12px] text-muted">
          <span className="underline decoration-border underline-offset-2">{card.repo}</span>
          {card.at ? ` on ${shortDate(card.at, nowMs)}` : ""}
        </div>
        {/* Title + number are ONE link, exactly as github.com draws it. `tabIndex={-1}` for the same
            reason as the commit card's: the panel is aria-hidden, so nothing in it may take focus. */}
        <a
          data-gh-title
          href={card.url}
          target="_blank"
          rel="noreferrer noopener"
          tabIndex={-1}
          className="mt-1 block text-[14px] font-semibold leading-snug text-fg hover:underline"
        >
          {card.title} <span className="font-normal text-muted">{number}</span>
        </a>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatePill card={card} />
          {hasDiff ? <Diffstat additions={card.additions!} deletions={card.deletions!} /> : null}
        </div>
      </div>
      {card.body || card.labels.length > 0 ? (
        <div className="border-t border-border px-3 py-2.5">
          {card.body ? <Excerpt text={card.body} code className="line-clamp-2 text-[12px] text-muted" /> : null}
          {card.labels.length > 0 ? (
            <div className={`flex flex-wrap gap-1 ${card.body ? "mt-2" : ""}`}>
              {card.labels.map((label) => (
                <LabelChip key={label.name} name={label.name} color={label.color} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <Byline card={card} nowMs={nowMs} />
    </div>
  )
}
