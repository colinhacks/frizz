import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RouterProvider } from "react-router"
import { router } from "./routes.tsx"
import { connectSync } from "./api/socket.ts"
import { initTranscriptLive } from "./api/transcript-live.ts"
import { initSupervisorStatus } from "./api/supervisorStatus.ts"
import { initFont } from "./lib/font.ts"
import { initTheme } from "./lib/theme.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { primeRoute } from "./lib/router.ts"
import { innerPath } from "./lib/base-path.ts"
import { projectScopedQueryKeyHash } from "./lib/queryKeyScope.ts"
import { parseStandaloneThreadPath } from "./lib/standaloneThreadRoute.ts"

const settingsFixture = typeof window !== "undefined" && window.location.pathname.endsWith("/settings-formatting-fixture.html")
// innerPath, not location.pathname: under a project prefix the deep link is `/project/nub/thread/x/full`.
const standaloneThreadSlug = typeof window !== "undefined" ? parseStandaloneThreadPath(innerPath()) : null

if (!settingsFixture && !standaloneThreadSlug) {
  // Adopt a cold/deep URL before React takes its first store snapshot — still SYNCHRONOUS, and still
  // before the first render, which is the whole point: it is what makes a deep-linked drawer painted
  // open on the first frame instead of animating in afterwards. The router resolves the same path a
  // beat later and `useRouteToStore` re-applies it, which is idempotent.
  primeRoute()
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
  // Observer-driven transcript liveness: any mounted surface observing ["transcript", slug] is kept
  // fresh centrally (socket subscription within budget, activity-edge refetch beyond) — components
  // never manage subscriptions themselves.
  initTranscriptLive(queryClient)
  // The ONE listener for the control-action wake event, so an accepted restart costs one status read
  // rather than one per surface reading the supervisor — see api/supervisorStatus.ts.
  initSupervisorStatus(queryClient)
  initFont(queryClient)
  installExternalLinkInterceptor()
  installLocalFileLinkInterceptor()
  installCodeCopyInterceptor()
  installThreadLinkInterceptor()
}

// No StrictMode: it double-mounts effects, which would open the terminal
// WebSocket (and xterm instance) twice per selection in dev.
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
