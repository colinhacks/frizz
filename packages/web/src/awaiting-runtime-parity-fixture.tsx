// THE SAME AWAITING FENCE, AT REST AND MID-TURN, SIDE BY SIDE — the surface the 2026-09-04 unification
// is judged on. It is not a design sheet: both columns mount the SHIPPED components through the SHIPPED
// call paths, so a difference on this page is a difference the maintainer would meet on a real board.
//
//   LEFT   the transcript tail at rest: <AwaitingBackgroundCard thread={…}> — what ChatView draws when
//          showsRestingCard(thread) is true, reading the fence off the thread's own `lastFence`.
//   RIGHT  the thread STEERED: <FenceCard fenceKind="awaiting"> — what ChatView's fence block draws once
//          the human's follow-up starts a turn, reading the fence out of the message it parsed. The
//          thread behind it carries NO `lastFence`, because the tailer clears it on the very user record
//          that bumps the thread; that is why the fence is a prop.
//
// The two columns must be the SAME CARD, right down to the markup — same heading, same glyph, same prose,
// same PR chips, same rows. The ONE licensed difference is the Snooze footer, which the right column has
// no rest to park (maintainer 2026-09-04: "you can remove the snooze button and stuff because the
// interactive elements obviously are no longer interactive, you should not be changing whether or not you
// truncate or don't truncate, or changing the rendering of the title or the description or any of that
// shit"). So the page also DIFFS the two subtrees itself, with the footer band stripped, and prints
// `identical` or the first divergence — a picture proves the shapes match, the diff proves the markup does.
//
//   nubx vite --port 5479 --strictPort      (from packages/web)
//   http://localhost:5479/awaiting-runtime-parity-fixture.html?font=sans   — ?font=mono for the other
//
// Nothing real is hit: rpc is stubbed exactly as the fence gallery does it.
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@frizz/shared"
import { AwaitingBackgroundCard } from "./components/AwaitingBackgroundCard.tsx"
import { FenceCard, ThreadSlugContext } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString()

type Live = Partial<Pick<ThreadView, "subAgents" | "bgShells" | "watches">>

// One CASE is one fence plus the live work behind it; the fixture builds both threads off it, so the two
// columns can only differ where the components differ.
interface Case {
  slug: string
  label: string
  body: string
  hints: AwaitingHint[]
  live: Live
}

const CASES: Case[] = [
  // THE SHELL-ONLY REST — the shape with a kind-naming heading of its own ("Background shells running")
  // and a terminal-square glyph. The fence card headed it "Awaiting" under an hourglass, so this is the
  // case where steering a worker visibly renamed its card.
  {
    slug: "shells",
    label: "shells only — the heading and the glyph that used to flip",
    body: "Left the compile matrix running on the quiet machine. When it reports I will fill the shared-axis chart and re-sweep the \"array of 50\" mentions in both posts.",
    hints: [{ kind: "shell", value: "b7w140a81" }, { kind: "for", value: "45m" }],
    live: {
      bgShells: [{ id: "toolu_shell1", taskId: "b7w140a81", label: "Compile matrix ×2 at 10 items, then the moltar bench", startedAt: ago(4), state: "running" }],
      watches: [{ id: "shell:parity:b7w140a81", kind: "shell", target: "b7w140a81", state: "armed", createdAt: ago(4) }],
    },
  },
  // A PR PARK — the fence card drew a RADAR here where the resting card draws an hourglass, and put the
  // ref in a chip beside the heading that the resting card never had.
  {
    slug: "pr",
    label: "a watched PR — the glyph, and the ref chip",
    body: "Both halves are pushed. Watching for the review; if CI goes red I will bisect rather than re-run.",
    hints: [{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "180d" }],
    live: {
      watches: [{
        id: "github:parity:acme/app#391", kind: "github", target: "acme/app#391", state: "armed", createdAt: ago(12),
        github: { checks: "running", running: 3, passed: 12, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "blocked", state: "open", polledAt: ago(1) },
      }],
    },
  },
  // A WORKER-NAMED HEADING over a mixed table, with prose that runs to a list. The title is honoured on
  // both sides, but the PROSE was not: the resting card block-renders the body and the fence card applied
  // the queue's character-level wrap only on the queue, so the same handoff wrapped on one surface and
  // bled past the card's edge on the other.
  {
    slug: "mixed",
    label: "a declared title, markdown prose, every kind of row",
    body: "Waiting for `main` to stabilize before cutting the 0.6.0 release that carries the acme/app#22 fix.\n\n- an hourly timer re-checks: tip quiet, frozen-lockfile install green, typecheck green\n- once the release publishes, the approved comment goes on acme/app#22 with the version number\n- the unbreakable token release/2026-08-27-hotfix-abcdefghijklmnopqrst is what the wrap rule has to survive",
    hints: [{ kind: "title", value: "0.6.0 release hold" }, { kind: "timer", value: "tmr_a1" }, { kind: "for", value: "2h" }],
    live: {
      subAgents: [{ id: "toolu_a", label: "Audit the parser for edge cases", subagentType: "frizz:opus-high", startedAt: ago(2), state: "running" }],
      bgShells: [{ id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(4), state: "running" }],
      watches: [
        { id: "shell:parity:bzvtnt3ig", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(4) },
        { id: "timer:parity:tmr_a1", kind: "timer", target: "tmr_a1", state: "armed", createdAt: ago(6), timer: { fireAt: ahead(34), prompt: "Re-check: tip quiet, frozen-lockfile install green, typecheck green" } },
      ],
    },
  },
  // ONE `prs:` NOTHING REGISTERED — the chip rides the TITLE ROW, in the `aside` slot the GitHub wake
  // card uses for its ref. The only shape where a ref sits beside the heading, so it is the one to judge
  // the heading's own wrap against.
  {
    slug: "pr-aside",
    label: "one unregistered `prs:` — the ref on the title row",
    body: "Opened against the fork; nothing to poll until a maintainer looks at it.",
    hints: [{ kind: "title", value: "Fork PR, upstream review" }, { kind: "pr", value: "withastro/astro#17487" }, { kind: "for", value: "180d" }],
    live: {},
  },
  // SEVERAL `prs:` NOTHING REGISTERED — the chips take a wrapped row of their own under the prose. The
  // resting card showed none of them at all, so at rest the refs existed nowhere on the card.
  {
    slug: "prs-many",
    label: "several unregistered `prs:` — the wrapped chip row",
    body: "All three adoption PRs are open and green, in their maintainers' hands.",
    hints: [
      { kind: "pr", value: "withastro/astro#17487" },
      { kind: "pr", value: "vitejs/vite#23019" },
      { kind: "pr", value: "strapi/strapi#26864" },
      { kind: "for", value: "180d" },
    ],
    live: {},
  },
]

const base = (id: string, live: Live): ThreadView => ({
  id,
  title: "Awaiting parity",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: `sess-${id}`,
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: [],
  ...live,
} as unknown as ThreadView)

// AT REST: the server has excused the thread on its declared park, the runtime is idle, and the board is
// holding the fence. This is exactly what showsRestingCard() gates the tail card on.
const restThread = (c: Case): ThreadView => ({
  ...base(`${c.slug}-rest`, c.live),
  awaitingBackground: true,
  lastFence: { kind: "awaiting", body: c.body, hints: c.hints },
} as unknown as ThreadView)

// STEERED: the human replied, the worker is running again. The board no longer holds the fence — the
// tailer clears `lastFence` on the user record that bumps the thread — so the card can only be drawn from
// the fence the transcript parsed out of the message, which is the prop.
const runThread = (c: Case): ThreadView => ({ ...base(`${c.slug}-run`, c.live), runtime: "running" } as unknown as ThreadView)

setBoard({
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  threads: CASES.flatMap((c) => [restThread(c), runThread(c)]),
  errors: [],
  warnings: [],
} as unknown as BoardSnapshot)

/** The licensed difference, and the only one: the Snooze band. Stripped before the diff so the check is
 *  about everything else — heading, glyph, prose, chips, rows, spacing classes and all. */
function comparable(root: HTMLElement | null): string {
  if (!root) return ""
  const copy = root.cloneNode(true) as HTMLElement
  copy.querySelector("[data-awaiting-snooze]")?.remove()
  // The shell yields its bottom padding to that band, so the class rides with it.
  const card = copy.querySelector("[data-awaiting-background]")
  if (card) card.className = card.className.replace(/\s*\bpb-0\b/, "")
  // Both cards tick a live clock; a row that rolled over between the two renders is not a divergence.
  for (const status of copy.querySelectorAll("[data-wait-status]")) status.textContent = "·"
  // …and a class list is a SET, not a string: the card's shell interpolates an empty className, so the
  // one with no footer carries a trailing space the other does not. That is not a rendering difference.
  return copy.innerHTML
    .replaceAll("-rest", "-slug")
    .replaceAll("-run", "-slug")
    .replace(/class="([^"]*)"/g, (_, cls: string) => `class="${cls.trim().split(/\s+/).join(" ")}"`)
}

function Pair({ c }: { c: Case }) {
  const restRef = useRef<HTMLDivElement>(null)
  const runRef = useRef<HTMLDivElement>(null)
  const [verdict, setVerdict] = useState("…")
  useEffect(() => {
    const a = comparable(restRef.current)
    const b = comparable(runRef.current)
    if (a === b) return setVerdict("identical")
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1
    setVerdict(`DIVERGES at ${i}: rest “${a.slice(i, i + 90)}” · run “${b.slice(i, i + 90)}”`)
  }, [])
  return (
    <section data-case={c.slug} className="flex flex-col gap-2">
      <p className="text-[11px] text-muted">{c.label}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-muted/45">At rest — the transcript tail</p>
          <div ref={restRef}>
            <AwaitingBackgroundCard thread={restThread(c)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-muted/45">Steered — the fence in the transcript</p>
          <div ref={runRef}>
            <ThreadSlugContext.Provider value={`${c.slug}-run`}>
              <FenceCard fenceKind="awaiting" body={c.body} hints={c.hints} />
            </ThreadSlugContext.Provider>
          </div>
        </div>
      </div>
      <p data-parity={c.slug} className={`text-[11px] ${verdict === "identical" ? "text-emerald-500" : "text-red-400"}`}>
        {verdict}
      </p>
    </section>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <div className="mx-auto flex w-[min(1000px,calc(100%-32px))] flex-col gap-10 py-8">
        {CASES.map((c) => <Pair key={c.slug} c={c} />)}
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
