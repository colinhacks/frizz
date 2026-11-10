import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"
// DiffBlock imports this sheet too, and it is in the lazy thread-surfaces chunk (components/lazySurfaces):
// imported here as well, the sheet stays in the entry's CSS, where it always was, for the classes it
// styles outside that chunk (ImageFrame's `frizz-image-frame`, the tool rows).
import "./lib/diff/diff.css"
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RouterProvider } from "react-router"
import { router } from "./routes.tsx"
import { connectSync } from "./api/socket.ts"
import { initConsoleFeed } from "./api/consoleFeed.ts"
import { initTranscriptLive } from "./api/transcript-live.ts"
import { initSupervisorStatus } from "./api/supervisorStatus.ts"
import { initFont } from "./lib/font.ts"
import { initCodeWrap } from "./lib/codeWrap.ts"
import { initTheme } from "./lib/theme.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installCodeTabInterceptor } from "./lib/switch-code-tab.ts"
import { installCodeExpandInterceptor } from "./lib/expand-code.ts"
import { installDisclosureInterceptor } from "./lib/toggle-disclosure.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { primeRoute, threadParam } from "./lib/router.ts"
import { loadThreadSurfaces } from "./components/lazySurfaces.tsx"
import { store } from "./store.ts"
import { stepOffStaleLayerEntries } from "./lib/backDismiss.ts"
import { innerPath } from "./lib/base-path.ts"
import { projectScopedQueryKeyHash } from "./lib/queryKeyScope.ts"
import { boundTranscriptCache } from "./lib/transcriptCacheBound.ts"
import { parseStandaloneThreadPath } from "./lib/standaloneThreadRoute.ts"

const settingsFixture = typeof window !== "undefined" && window.location.pathname.endsWith("/settings-formatting-fixture.html")
// innerPath, not location.pathname: under a project prefix the deep link is `/project/nub/thread/x/full`.
const standaloneThreadSlug = typeof window !== "undefined" ? parseStandaloneThreadPath(innerPath()) : null

// A reload with a phone sheet up restores the sheet's same-URL history entry with no sheet to own it.
// Step off it before anything pushes, so the page sits on the router's own entry (see lib/backDismiss).
if (!settingsFixture) stepOffStaleLayerEntries()

if (!settingsFixture && !standaloneThreadSlug) {
  // Adopt a cold/deep URL before React takes its first store snapshot — still SYNCHRONOUS, and still
  // before the first render, which is the whole point: it is what makes a deep-linked drawer painted
  // open on the first frame instead of animating in afterwards. The router resolves the same path a
  // beat later and `useRouteToStore` re-applies it, which is idempotent.
  primeRoute()
}

// A page whose first paint is a thread — a full-screen page, a `?thread=` link, a drawer the route just
// primed — needs the thread-surfaces chunk now, beside the board read; every other page fetches it once
// its board has painted (components/lazySurfaces.tsx).
if (!settingsFixture && (standaloneThreadSlug || threadParam(location.search) !== null || store.drawers.length > 0 || store.paneSlug)) {
  void loadThreadSurfaces()
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      // Every cache entry is scoped to the project the page is showing — see lib/queryKeyScope.ts.
      // This is a client-level default rather than 19 hand-prefixed key shapes precisely so that the
      // twentieth is scoped too, without its author knowing this problem exists.
      queryKeyHashFn: projectScopedQueryKeyHash,
    },
  },
})

// One multiplexed /ws (board + transcript push + notify); falls back to SSE + polling if /ws is
// unavailable (a pre-restart server). The socket writes transcript pushes into this queryClient's cache.
if (!settingsFixture) {
  initTheme()
  connectSync(queryClient)
  // The Console's feed writes its projects' transcript pushes into the same cache (api/consoleFeed.ts).
  initConsoleFeed(queryClient)
  // Observer-driven transcript liveness: any mounted surface observing ["transcript", slug] is kept
  // fresh centrally (socket subscription within budget, activity-edge refetch beyond) — components
  // never manage subscriptions themselves.
  initTranscriptLive(queryClient)
  // The ONE listener for the control-action wake event, so an accepted restart costs one status read
  // rather than one per surface reading the supervisor — see api/supervisorStatus.ts.
  initSupervisorStatus(queryClient)
  // The transcripts no surface shows are held to the few most recently seen (lib/transcriptCacheBound.ts).
  boundTranscriptCache(queryClient)
  initFont()
  initCodeWrap()
  installExternalLinkInterceptor()
  installLocalFileLinkInterceptor(queryClient)
  installCodeCopyInterceptor()
  installCodeTabInterceptor()
  installCodeExpandInterceptor()
  installDisclosureInterceptor()
  installThreadLinkInterceptor()
}

// No StrictMode: it double-mounts effects, which would open each live socket twice in dev.
if (!settingsFixture) {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      {/* The last-resort catch. App wraps its own surfaces far more finely (sidebar / queue / each
          drawer), so anything reaching this one broke above all of them — a throw in App's own body,
          or in the standalone thread page. It still renders a page with the error ON it, which is
          the whole difference between a bad render and the blank window this replaced. */}
      <RootErrorBoundary>
        <RouterProvider router={router} />
      </RootErrorBoundary>
    </QueryClientProvider>,
  )
}
