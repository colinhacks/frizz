import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"

// STATUS-ROW FIXTURE — the row above the prompt box in its FULLY POPULATED state, which no sandboxed
// stack can produce: an adhoc stack has no restart-capable supervisor (so the reload button renders
// null) and no provider credentials under its temp HOME (so the fuel gauge has no reading to show).
// Stubbing the reads the row depends on is the only way to actually LOOK at the finished thing: the
// breadcrumb, reload, GitHub and settings on one line.
//
// It renders over a stand-in prompt box, because the row's two ends are supposed to land on that box's
// border and a row measured in a void cannot show that. The box holds the real agent marks, the gauge and
// the plug, whose hover and panels quotaGaugeHover.e2e.test.ts drives here.
//
// Query params drive the states worth eyeballing:
//   ?model=opus|sonnet|codex|acp — the model the prompt box has selected, which picks the gauge's
//                       provider and, for Claude, its model's own weekly cap. acp: no gauge at all.
//   ?remaining=<0-100> — every window at this much left, to step the needle across the dial
//   ?state=low        — Claude in the amber warn zone, Codex critical
//   ?state=weeklywall — a HEALTHY 5h window behind a nearly-spent weekly one: the gauge reads the weekly
//   ?state=opuswall   — Opus's own weekly cap nearly spent, the general ones healthy: the gauge reads it
//                       for Opus and ignores it for Sonnet
//   ?state=signedout  — Codex signed out, which renders NO gauge while a Codex model is selected
//   ?state=longemail  — an account address past the popover's width, to check the truncation
//   ?identity=loading|unavailable|gitlab|local|console
//                                  — gitlab: an owner/repo label with NO githubRepo (a non-GitHub
//                                    origin), whose crumb menu offers no GitHub link.
//                                    local: a remote-less directory. console: the Console's row,
//                                    which names the page rather than a project.
//   ?width=272                     — the column's width. 489 is the sidebar at a 1440px viewport; 272 is
//                                    its floor in the tablet band, where the crumb is what gives way.
//   ?font=mono                     — the stylesheet still keys its sans rules on html[data-font]; the
//                                    product pins sans, so mono is only for the day that attribute goes.

const params = new URLSearchParams(window.location.search)
const state = params.get("state") ?? "healthy"
const nowSeconds = Math.floor(Date.now() / 1000)

function windows(fiveHourUsed: number, weeklyUsed: number, opusUsed?: number) {
  return [
    { key: "5h", label: "5h", usedPercent: fiveHourUsed, resetsAt: nowSeconds + 2 * 3600 },
    { key: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt: nowSeconds + 3 * 86400 },
    ...(opusUsed === undefined ? [] : [{ key: "weekly-opus", label: "Opus wk", usedPercent: opusUsed, resetsAt: nowSeconds + 3 * 86400 }]),
  ]
}

const flat = params.get("remaining")
const quota =
  flat !== null
    ? {
        claude: { status: "ok", planType: "max", windows: windows(100 - Number(flat), 100 - Number(flat)) },
        codex: { status: "ok", planType: "pro", windows: windows(100 - Number(flat), 100 - Number(flat)) },
      }
    : state === "opuswall"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(20, 30, 94) },
        codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
      }
    : state === "low"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(82, 64) },
        codex: { status: "ok", planType: "pro", windows: windows(95, 71) },
      }
    : state === "weeklywall"
      ? {
          claude: { status: "ok", planType: "max", windows: windows(18, 93) },
          codex: { status: "ok", planType: "pro", windows: windows(24, 88) },
        }
      : {
          claude: { status: "ok", planType: "max", windows: windows(17, 38) },
          codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
        }

// `emails` is the account each credential belongs to — the popover's "signed in as who?" line. A
// signed-out provider carries none (the server omits it rather than leave a stale label under an em
// dash), and ?state=longemail pins the truncation at the popover's 15rem cap.
const emails =
  state === "signedout"
    ? { claude: "colin@pullfrog.com" }
    : state === "longemail"
      ? { claude: "colin.mcdonnell.with.a.long.name@some-long-company-domain.example.com", codex: "colinmcd94@gmail.com" }
      : { claude: "colin@pullfrog.com", codex: "colinmcd94@gmail.com" }

const auth =
  state === "signedout"
    ? { claude: "authed", codex: "signed-out", emails }
    : { claude: "authed", codex: "authed", emails }

// The prompt box's selection — the durable new-thread profile the gauge follows.
const model = params.get("model") ?? "opus"
const preferences = {
  backend: model === "codex" ? "codex" : model === "acp" ? "acp" : "claude",
  claude: { model: model === "sonnet" ? "sonnet" : "opus", effort: "high" },
  codex: { model: "gpt-5.5-codex", effort: "high" },
  acp: { model: "acp:gemini" },
}

// The crumb's menu: every registered project, the grid's own cards. A stale one must be left out.
const projectCard = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${slug}`, slug, name, path: `/Users/colin/Documents/${slug}`, lastOpenedAt: "2026-10-26T00:00:00.000Z", stale: false, iconStatus: "none", ...extra,
})
const projects = [
  projectCard("frizz", "frizz"),
  projectCard("nub", "nub"),
  projectCard("zod", "zod"),
  projectCard("pullfrog", "pullfrog"),
  projectCard("gone", "gone", { stale: true }),
]

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_frizz/control/status") return json({ protocol: 1, state: "ready", updateRestart: true })
  // Every RPC response is the {result} envelope, never the payload bare.
  if (url.pathname === "/_frizz/rpc/quota") return json({ result: quota })
  if (url.pathname === "/_frizz/rpc/authStatus") return json({ result: auth })
  if (url.pathname === "/_frizz/rpc/settingsGet") return json({ result: {} })
  if (url.pathname === "/_frizz/rpc/dispatchPreferencesGet") return json({ result: preferences })
  if (url.pathname === "/_frizz/rpc/projectsList") return json({ result: projects })
  // The GitHub mark in the row (`?norepo` hides it), and the plug in the box.
  if (url.pathname === "/_frizz/rpc/githubStatus") return json({ result: { inRepo: !params.has("norepo"), authed: true } })
  if (url.pathname === "/_frizz/rpc/codexModels" || url.pathname === "/_frizz/rpc/claudeModels" || url.pathname === "/_frizz/rpc/acpAgents") return json({ result: [] })
  if (url.pathname === "/_frizz/rpc/mcpStatus") return json({ result: { backend: preferences.backend, servers: [{ name: "linear", state: params.has("plugattention") ? "needs-auth" : "connected" }, { name: "sentry", state: "connected" }] } })
  return nativeFetch(input, init)
}

document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const { StatusRow } = await import("./components/StatusRow.tsx")
const { NewThreadAgentMarks } = await import("./components/AgentMarks.tsx")
const { store } = await import("./store.ts")
const identityMode = params.get("identity")

// StatusRow reads identity off the store itself, so the fixture seeds the store rather
// than passing props — which is also the only way to exercise the real read path.
store.board = (identityMode === "loading"
  ? null
  : identityMode === "unavailable"
    ? { projectLabel: "", threads: [] }
    : identityMode === "local"
      ? { projectName: "scratch-pad", projectLabel: "scratch-pad", threads: [] }
      : identityMode === "gitlab"
        ? { projectName: "frizz", projectLabel: "colinhacks/frizz", projectSlug: "frizz", threads: [] }
        : { projectName: "frizz", projectLabel: "colinhacks/frizz", githubRepo: "colinhacks/frizz", projectSlug: "frizz", threads: [] }) as never
const width = Number(params.get("width") ?? 489)

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    {/* The row's home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link
        outside a router context throws on render. In the app the row always sits under RouterProvider;
        a MemoryRouter gives the fixture the same context without touching the address bar. */}
    <MemoryRouter>
      <main className="min-h-screen bg-bg p-6 text-fg">
        {/* The sidebar column's real width at a 1440px viewport by default, so the row's split reads at the
            measure it actually ships at; `?width=272` is the column's floor. */}
        <div style={{ width }}>
          <StatusRow onConsole={identityMode === "console"} />
          <div className="rounded-xl border border-border bg-panel px-3 pb-2 pt-6 text-[13px] text-muted">
            A stand-in prompt box. The row's two ends land on THIS border.
            <div className="mt-4 flex min-h-7 items-center"><NewThreadAgentMarks /></div>
          </div>
        </div>
      </main>
    </MemoryRouter>
  </QueryClientProvider>,
)
