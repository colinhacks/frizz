import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"

let settings: Record<string, unknown> = {
  permissionMode: "auto",
  notifications: true,
  projectRail: false,
  childThreads: false,
}

// Every settingsSet ATTEMPT the drawer makes, in order, with the millisecond it arrived. The autosave
// e2e test reads this to prove a picker writes on the click while a keystroke writes ONCE, after the
// debounce — and, with ?retryableFailures=N, that a replayable refusal is replayed rather than lost.
const writes: { at: number; body: Record<string, unknown>; ok: boolean }[] = []
Object.assign(window, { __settingsWrites: writes })

// How many of the first writes are refused the way a mid-update server refuses one: a 503 carrying
// `retryable: true`, which parseRpcResponse turns into the error isRetryableRpcError() recognizes.
let retryableFailures = Number(new URLSearchParams(location.search).get("retryableFailures") ?? 0)

const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-frizz-boot": "settings-fixture" },
})

const rpcRetryableError = () => new Response(JSON.stringify({ error: "Frizz is updating and restarting.", retryable: true }), {
  status: 503,
  headers: { "content-type": "application/json", "x-frizz-boot": "settings-fixture" },
})

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_frizz/rpc/settingsGet") return rpcResult(settings)
  if (url.pathname === "/_frizz/rpc/settingsSet") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    if (retryableFailures > 0) {
      retryableFailures -= 1
      writes.push({ at: performance.now(), body, ok: false })
      return rpcRetryableError()
    }
    // Echo what was sent, as the server does — the drawer publishes the RESPONSE into its query cache,
    // so a fixture that echoed a fixed object would quietly revert every write it claimed to accept.
    settings = body
    writes.push({ at: performance.now(), body, ok: true })
    return rpcResult(settings)
  }
  if (url.pathname === "/_frizz/rpc/codexModels") return rpcResult([])
  if (url.pathname === "/_frizz/rpc/acpAgents") return rpcResult([])
  if (url.pathname === "/_frizz/rpc/githubPromptDefaults") {
    return rpcResult({
      prompt: "Triage this GitHub issue/PR and make recommendations. Classify it, be dubious, and say what you actually checked.",
    })
  }
  return nativeFetch(input, init)
}

Object.defineProperty(window, "Notification", {
  configurable: true,
  value: { permission: "denied", requestPermission: async () => "denied" },
})

const [{ SettingsDrawer }, { queryClient }, { TooltipProvider }, { initCodeWrap }] = await Promise.all([
  import("./components/SettingsDrawer.tsx"),
  import("./main.tsx"),
  import("./components/Tooltip.tsx"),
  import("./lib/codeWrap.ts"),
])

// main.tsx skips its whole init for this page, so the one a drawer row can be SEEN to drive — the
// "Wrap code" preference reaching <html> — is installed here, as the app installs it.
initCodeWrap()

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <SettingsDrawer />
    </TooltipProvider>
  </QueryClientProvider>,
)
