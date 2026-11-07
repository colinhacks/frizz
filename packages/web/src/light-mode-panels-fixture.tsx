import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { InteractionRecord } from "@frizz/shared"
import { BackgroundShellSheet } from "./components/BackgroundShellSheet.tsx"
import { MarkdownDrawer } from "./components/MarkdownDrawer.tsx"
import { FileViewerPanel } from "./components/FileViewerPanel.tsx"
import { ProviderErrorCard } from "./components/ProviderErrorCard.tsx"
import { RestartOverlay } from "./components/RestartOverlay.tsx"
import { SignInModal } from "./components/SignInModal.tsx"
import { InteractionCard } from "./components/InteractionCards.tsx"
import { ImageFrame, FRAMED_IMAGE } from "./components/ImageFrame.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { DrawerErrorSheet } from "./components/ErrorBoundary.tsx"
import { initFont } from "./lib/font.ts"
import { setThemePreference } from "./lib/theme.ts"
import "./styles.css"

// Complementary renderer coverage: real panels, deterministic responses, no provider or filesystem
// mutations. The real-server flow is covered separately by verify-light-mode.mjs.
const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "cards"
setThemePreference(params.get("theme") === "dark" ? "dark" : "light")
initFont()
const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const markdown = "---\ntitle: Palette verification\nstatus: ready\n---\n# Palette verification\n\nNeutral surfaces, light outlines and one restrained accent.\n\n## Checklist\n\n- [x] Sans-serif interface\n- [x] Outlined questions and buttons\n- [x] Light and dark renderers\n\n| Surface | Result |\n| --- | --- |\n| Question | White, light-gray outline |\n| Prompt | Neutral gray |\n\n```ts\nconst appearance = 'light'\n```"
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, location.href)
  if (!url.pathname.startsWith("/_frizz/rpc/")) return nativeFetch(input, init)
  const method = url.pathname.split("/").at(-1)
  if (method === "localMarkdown") return json({ path: "/fixture/review.md", markdown, truncated: false })
  if (method === "localFile") return json({ path: "/fixture/theme.ts", text: "// Browser-local appearance\nexport const palette = {\n  canvas: '#f7f7f7',\n  question: '#ffffff',\n  outline: '#dcdcdc',\n}\n", truncated: false })
  if (method === "backgroundShellOutput") return json({ state: "running", command: "nub run test", output: "✔ Theme preferences\n✔ Settings migration\n✔ Question selection\n\nChecking browser rendering…\n", stoppable: true, stopNote: null })
  if (method === "authStatus") return json({ claude: "signed-out", codex: "signed-out", emails: {} })
  return json({})
}
const record: InteractionRecord = {
  protocolVersion: 1, contentFormat: "plain-text", provider: { kind: "codex" }, source: { kind: "runtime", id: "runtime" },
  owner: { projectId: "project", threadSlug: "thread", sessionId: "session", turnId: "turn", itemId: "item", sessionEpoch: 1, capabilityRevision: 2 },
  providerRequestId: "request", id: "approval", lifecycle: "pending", recordRevision: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: null, completedAt: null, resolution: null, cancellationReason: null,
  allowedDecisions: [{ id: "accept", semantic: "approve", label: "Approve once" }, { id: "acceptForSession", semantic: "approve", label: "Approve for session" }, { id: "decline", semantic: "deny", label: "Deny" }],
  payload: { kind: "command-approval", title: "Run the verification suite", command: { summary: "Tests", preview: "nub run test", redacted: true } },
}
const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="140"><rect width="500" height="140" fill="#f7f7f7"/><rect x="32" y="28" width="436" height="84" rx="12" fill="white" stroke="#dcdcdc"/><text x="52" y="77" fill="#292929" font-family="sans-serif" font-size="18">Neutral surfaces and light outlines</text></svg>')}`
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main data-panel-fixture={mode} className="mx-auto min-h-screen max-w-[760px] bg-bg p-5 text-fg">
        {mode === "cards" && <div className="flex flex-col gap-5">
          <InteractionCard record={record} />
          <ProviderErrorCard provider="Codex" error={{ code: "rate_limit_exceeded", message: "The provider is temporarily unavailable.", retrying: true, details: "The request will be retried without losing the transcript." }} />
          <ProviderErrorCard provider="Codex" error={{ code: "authentication_failed", message: "Sign in again to continue this thread." }} />
          <ImageFrame><img className={FRAMED_IMAGE} src={picture} alt="Palette reference" /></ImageFrame>
        </div>}
        {mode === "shell" && <BackgroundShellSheet id={1} slug="theme" shellId="shell" label="Checking the theme" startedAt={new Date(Date.now() - 95000).toISOString()} depth={0} widthDepth={0} />}
        {mode === "markdown" && <MarkdownDrawer id={1} path="/fixture/review.md" title="Palette verification" depth={0} widthDepth={0} />}
        {mode === "file" && <div className="h-[calc(100vh-40px)] border border-border"><FileViewerPanel slug="theme" path="/fixture/theme.ts" active /></div>}
        {mode === "signin" && <SignInModal backend="claude" onClose={() => {}} onAuthed={() => {}} />}
        {mode === "restart" && <RestartOverlay open message="Preparing the verified application build…" />}
        {mode === "stalled" && <RestartOverlay open stalled silentFor="3m" />}
        {mode === "render-error" && <DrawerErrorSheet id={1} depth={0} widthDepth={0} error={new Error("The transcript could not be rendered")} onRetry={() => {}} />}
      </main>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
)
