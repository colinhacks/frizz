import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import type { ThreadView } from "@frizz/shared"
import "./styles.css"

// The measuring surface for the OPTICAL rhythm of frizz's icon strips — the thread HEADER's action
// row and the composer's right rail. Both are clusters of small marks whose CSS spacing is uniform and
// whose PERCEIVED spacing was not, because every glyph wears a different amount of dead padding inside
// its box (maintainer 2026-08-04: "I'm sure the spacing is consistent in terms of the CSS, but what
// matters here is the visual spacing"). A third strip, the thread lifecycle footer, was measured here
// until 2026-10-05, when it went: its snooze and mark-as-done verbs joined the header strip after a
// rule, and its goal joined the thread composer's rail — both rendered below.
//
// The header strip joined on 2026-08-26, when Restart worker moved up out of the footer into it ("the
// restart worker button should be at the top") and the AI-rename refresh appeared beside the title. A
// verb that changes strips changes rhythm, so both ends are rendered here.
//
// It renders the REAL components, never a mock-up of them, so `scripts/ink-gaps.mjs` measures the
// shipping geometry. Both strips are here together deliberately: they are the same problem, and a
// fix that squares one while leaving the other is the failure this fixture exists to catch.
//
// The gate mocks below are the price of that: three of the controls hide themselves unless the
// server answers, and a fixture missing half the strip measures a rhythm the app never draws.

// Match the application's sans UI; only code and terminal output use monospace.
document.documentElement.dataset.font = "sans"

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  // RestartWorkerButton is dev-build-only and asks the launcher at runtime (lib/devBuild.ts).
  if (url.pathname === "/_frizz/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", dev: true }), {
      headers: { "content-type": "application/json" },
    })
  }
  return nativeFetch(input, init)
}

const { ThreadLifecycleActions } = await import("./components/ThreadLifecycle.tsx")
const { RecurringPromptControl } = await import("./components/RecurringPromptControl.tsx")
const { HeaderActions } = await import("./components/HeaderActions.tsx")
const { AiRenameButton } = await import("./components/AiRenameButton.tsx")
const { Composer } = await import("./components/Composer.tsx")
const { TooltipProvider } = await import("./components/Tooltip.tsx")

// Every field the header strip's availability checks and the rail's goal read. A BROKER-backed, live,
// snoozed Claude session is the one state that renders every mark at once.
const thread = {
  id: "icon-rhythm-demo",
  title: "Icon rhythm",
  status: "active",
  state: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  claudeRuntime: "broker",
  permissionMode: "default",
  sessionId: "icon-rhythm-session",
  subAgents: [],
  bgShells: [],
  // Drives the ContextMeter's arc. 62% is a mid-fill dial — a nearly-empty or nearly-full ring paints
  // a different amount of ink, and the point of this fixture is to compare ink.
  context: { tokens: 124_000, window: 200_000 },
  // Draws the header's alarm clock in its amber "a snooze is set" tone. Far enough out that it stays in
  // the future for any run.
  snoozedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  // NO `watches`, and that is not an omission. This carried one to draw ArmedWatches' eye — the Goal
  // mark's right-hand neighbour. That readout was
  // removed on 2026-08-14 (it duplicated the rows under the prompt box), so the Goal is the last mark in
  // the cluster and there is no right-hand gap left to measure. Seeding a watcher here would now paint
  // nothing and quietly imply the fixture still covers a gap it cannot.
  watches: [], questions: [],
} as unknown as ThreadView

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Fixture() {
  // Non-empty so the send button paints its ACTIVE fill — the brightest mark in the rail, and the one
  // the paperclip is read against.
  const [value, setValue] = useState("Measure the rail.")
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <main className="min-h-screen bg-bg p-8">
          <div className="flex w-full max-w-[720px] flex-col gap-8">
            {/* The HEADER strip, in the queue card's shape — the title row (whose hover reveals the
                rename refresh) on the left, the shared action icons on the right. `group/thread-title`
                is what the refresh mark listens to; the fixture forces it visible instead, because a
                mark measured only under a live pointer cannot be measured at all. */}
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Thread header actions</h2>
              <div data-header-shell className="rounded-lg border border-border bg-panel">
                <div className="flex items-center gap-2 px-5 py-3.5 [&_[data-ai-rename]]:opacity-100">
                  <div className="min-w-0 flex-1">
                    <div className="group/thread-title flex min-w-0 items-center gap-2">
                      <div className="min-w-0 shrink truncate font-semibold text-[15px] leading-snug">Icon rhythm</div>
                      <AiRenameButton thread={thread} />
                    </div>
                  </div>
                  {/* The strip's own `gap-0.5` cluster, as both real headers draw it: the shared actions,
                      then the rule and the two lifecycle verbs. */}
                  <div className="flex shrink-0 items-center gap-0.5">
                    <HeaderActions
                      thread={thread}
                      collapsed={false}
                      onCollapse={() => {}}
                      onDoc={() => {}}
                      expand
                      onDone={() => {}}
                    />
                    <ThreadLifecycleActions thread={thread} />
                  </div>
                </div>
              </div>
            </section>
            {/* The THREAD composer's rail: the goal at its left end, then attach and send — what every
                queue card and thread view draws (ThreadComposerBox passes the goal as `railLead`). */}
            <section data-goal-rail className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Composer rail · thread composer with its goal</h2>
              <Composer
                value={value}
                onChange={setValue}
                onSubmit={() => {}}
                surface="iconRhythmFixtureGoal"
                placeholder="Reply to the agent…"
                railLead={<RecurringPromptControl thread={thread} />}
              />
            </section>
            <section data-plain-rail className="flex flex-col gap-2">
              <h2 className="text-[11px] uppercase tracking-wide text-muted">Composer rail · plain</h2>
              <Composer
                value={value}
                onChange={setValue}
                onSubmit={() => {}}
                surface="iconRhythmFixturePlain"
                placeholder="Ask anything"
              />
            </section>
          </div>
        </main>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><Fixture /></BrowserRouter>)
