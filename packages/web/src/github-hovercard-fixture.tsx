import { createRoot } from "react-dom/client"
import "./styles.css"
import type { GithubRefCard } from "@frizz/shared"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { GithubRefCardBody } from "./components/GithubRefCardBody.tsx"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import { OPAQUE_SURFACE_BASE } from "./lib/overlaySurface.ts"

// TWO halves, because they answer two different questions.
//
// THE GALLERY is the hovercard's CONTENTS, every state at once, with no network and no pointer — so
// the card can be looked at, measured and cropped.
//
// THE LIVE half below it drives the WHOLE client path in one go: real prose through the real
// `useMarkdownHtml` → the sanitizer's `data-gh-ref` stamp → the batched `githubRefPreview` request →
// the store → the delegated pointer listener → the anchored card. Only `fetch` is stubbed, so
// everything between the markdown and the picture is the shipped code.
//
// THE FONT IS SET FROM THE QUERY STRING (`?font=mono`), because this app ships in two and a fixture
// that sets neither silently renders the MONO default — which is exactly how a glyph measured at a
// 0.00px residual once shipped riding high in the maintainer's sans window (CLAUDE.md).

const NOW = Date.parse("2026-08-14T12:00:00Z")

const base = {
  repo: "nubjs/nub",
  url: "https://github.com/nubjs/nub/issues/660",
  labels: [] as { name: string; color: string }[],
  fetchedAt: NOW,
} as const

const CARDS: { id: string; caption: string; card: GithubRefCard }[] = [
  {
    id: "issue-open",
    caption: "Open issue — the maintainer's reference shot",
    card: {
      ...base,
      ref: "nubjs/nub#660",
      kind: "issue",
      title: "A failing optionalDependency build fails the whole install; npm and pnpm exit 0",
      body: "When an `optionalDependencies` entry has a lifecycle script that exits non-zero, `nub install` fails. npm and pnpm complete the install.",
      state: "OPEN",
      at: "2026-08-02T03:52:56Z",
      authorLogin: "colinhacks",
      labels: [{ name: "bug", color: "d73a4a" }],
      comments: 4,
    },
  },
  {
    id: "issue-closed",
    caption: "Closed issue, several labels",
    card: {
      ...base,
      ref: "nubjs/nub#412",
      kind: "issue",
      title: "Workspace protocol resolution drops the version range",
      body: "A `workspace:^` dependency resolves to the raw folder rather than the published range, so a publish emits an unusable manifest.",
      state: "CLOSED",
      at: "2026-06-11T09:14:00Z",
      authorLogin: "colinhacks",
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "resolver", color: "0e8a16" },
        { name: "good first issue", color: "7057ff" },
        { name: "pale yellow", color: "fff5b1" },
        { name: "white", color: "ffffff" },
        { name: "near black", color: "010101" },
        { name: "malformed", color: "not-a-color" },
      ],
    },
  },
  {
    id: "issue-not-planned",
    caption: "Closed as not planned — a different answer wearing the same word",
    card: {
      ...base,
      ref: "nubjs/nub#288",
      kind: "issue",
      title: "Add a --legacy-peer-deps alias",
      body: "npm accepts it, so nub should too.",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      at: "2026-03-02T16:40:00Z",
      authorLogin: "octocat",
      labels: [{ name: "wontfix", color: "ffffff" }],
    },
  },
  {
    id: "pr-open",
    caption: "Open pull request",
    card: {
      ...base,
      ref: "nubjs/nub#701",
      kind: "pr",
      url: "https://github.com/nubjs/nub/pull/701",
      title: "resolver: keep an optional-only path optional through the whole graph",
      body: "A package is optional only when every path to it is optional, so one fully-required path keeps it required and its failure still fails the install.",
      state: "OPEN",
      at: "2026-08-12T20:02:00Z",
      authorLogin: "colinhacks",
      labels: [{ name: "enhancement", color: "a2eeef" }],
      additions: 254,
      deletions: 19,
      changedFiles: 4,
    },
  },
  {
    id: "pr-draft",
    caption: "Draft — not ready for you, and the pill is the only thing that says so",
    card: {
      ...base,
      ref: "nubjs/nub#705",
      kind: "pr",
      url: "https://github.com/nubjs/nub/pull/705",
      title: "wip: teach the lockfile reader about optionality",
      body: "",
      state: "DRAFT",
      at: "2026-08-13T11:30:00Z",
      authorLogin: "colinhacks",
    },
  },
  {
    id: "pr-merged",
    caption: "Merged pull request",
    card: {
      ...base,
      ref: "nubjs/nub#690",
      kind: "pr",
      url: "https://github.com/nubjs/nub/pull/690",
      title: "install: warn rather than fail when an optional build exits non-zero",
      body: "Skip-and-record, not skip-and-hide: each skipped package is warned with the build error.",
      state: "MERGED",
      at: "2026-07-30T08:00:00Z",
      authorLogin: "colinhacks",
      additions: 76,
      deletions: 12,
    },
  },
  {
    id: "pr-closed",
    caption: "Closed without merging",
    card: {
      ...base,
      ref: "nubjs/nub#655",
      kind: "pr",
      url: "https://github.com/nubjs/nub/pull/655",
      title: "Try treating every failed build as non-fatal",
      body: "Superseded — this made a required dependency's failure invisible too.",
      state: "CLOSED",
      at: "2026-07-20T08:00:00Z",
      authorLogin: "octocat",
      additions: 3,
      deletions: 41,
    },
  },
  {
    id: "commit",
    caption: "Commit — the maintainer's second reference shot",
    card: {
      ...base,
      ref: "nubjs/nub@92ed4cc",
      kind: "commit",
      url: "https://github.com/nubjs/nub/commit/92ed4cc",
      title: "aube: an optional dependency's build failure no longer fails the install",
      body: "A package reachable only through `optionalDependencies` is one the project declared it can live without, so npm and pnpm both treat a failed build for it as non-fatal. aube failed the whole install: `run_dep_lifecycle_scripts` never consulted optionality at all.",
      state: "",
      at: "2026-07-31T10:55:44Z",
      authorName: "Colin McDonnell",
      additions: 254,
      deletions: 19,
      changedFiles: 4,
    },
  },
  {
    id: "commit-tiny",
    caption: "A one-line commit — no body, no diffstat to draw",
    card: {
      ...base,
      ref: "nubjs/nub@af3901b",
      kind: "commit",
      url: "https://github.com/nubjs/nub/commit/af3901b",
      title: "docs: fix a typo in the install guide",
      body: "",
      state: "",
      at: "2026-08-14T10:30:00Z",
      authorName: "Colin McDonnell",
      additions: 1,
      deletions: 1,
    },
  },
]

// The batched request the store makes, answered locally. It is the ONLY thing stubbed here: the
// request is still built, sent and parsed by lib/githubHovercards.ts, so a regression in the batching
// or the ref harvesting still fails this fixture.
const BY_REF = new Map(CARDS.map(({ card }) => [card.ref, card]))
const originalFetch = globalThis.fetch.bind(globalThis)
let requestLog: string[][] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.includes("githubRefPreview")) return originalFetch(input as RequestInfo, init)
  const refs: string[] = JSON.parse(new URL(url, location.origin).searchParams.get("input") ?? "{}").refs ?? []
  requestLog.push(refs)
  ;(window as unknown as { __ghRefRequests: string[][] }).__ghRefRequests = requestLog
  // Stamp the fetch time the way the SERVER does, so the client's own staleness rule is exercised
  // against a real clock. `?stale=1` back-dates it past the TTL, which is the only way to drive the
  // hover's stale-while-revalidate branch deterministically.
  const stampedAt = new URLSearchParams(location.search).has("stale") ? Date.now() - 10 * 60_000 : Date.now()
  const cards = refs.map((ref) => BY_REF.get(ref)).filter(Boolean).map((card) => ({ ...card!, fetchedAt: stampedAt }))
  const missing = refs.filter((ref) => !BY_REF.has(ref))
  // A beat of latency, so a hover that lands before the batch returns is exercised rather than
  // accidentally always racing ahead of it.
  await new Promise((r) => setTimeout(r, 120))
  return new Response(JSON.stringify({ result: { cards, missing } }), { status: 200, headers: { "content-type": "application/json" } })
}) as typeof globalThis.fetch

const PROSE = `An open issue #660, a merged pull request #690, a draft #705 and the commit
nubjs/nub@92ed4cc. A number that names nothing: #4242. The author's literal bytes stay literal:
\`#660\`.`

function LiveProse() {
  return <div className="md-body" data-live-prose dangerouslySetInnerHTML={{ __html: useMarkdownHtml(PROSE) }} />
}

function Fixture() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <p className="mb-6 text-sm text-muted">
        GitHub hovercard contents — font: <code>{document.documentElement.dataset.font}</code>
      </p>
      <div className="flex flex-wrap items-start gap-6">
        {CARDS.map(({ id, caption, card }) => (
          <section key={id} data-case={id} className="flex flex-col gap-2">
            <div className="text-xs text-muted">{caption}</div>
            {/* The same surface + radius PopoverContent gives it in the app, so what is measured here
                is what ships rather than a bare panel. */}
            <div data-card className={`${OPAQUE_SURFACE_BASE} overflow-hidden rounded-lg`}>
              <GithubRefCardBody card={card} nowMs={NOW} />
            </div>
          </section>
        ))}
      </div>

      <section data-live className="mt-10 flex flex-col gap-2 border-t border-border pt-6">
        <div className="text-xs text-muted">
          Live: real markdown → real anchors → the batched request → hover. Point at any reference.
        </div>
        <LiveProse />
      </section>
      <GithubHovercards />
    </main>
  )
}

const font = new URLSearchParams(location.search).get("font")
document.documentElement.dataset.font = font === "mono" ? "mono" : "sans"
const theme = new URLSearchParams(location.search).get("theme")
document.documentElement.dataset.theme = theme === "light" ? "light" : "dark"
// The autolinker is inert until the board hands it a repo, exactly as in the app.
setGithubRepo("nubjs/nub")
createRoot(document.getElementById("root")!).render(<Fixture />)
