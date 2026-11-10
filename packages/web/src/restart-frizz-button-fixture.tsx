import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"
import { store } from "./store.ts"

// The board ships in two fonts (html[data-font], applied before first paint in index.html), and a
// fixture that sets neither silently renders the MONO default — so make the choice explicit and
// switchable: ?font=mono for the mono stack, sans otherwise (the setting most real windows run).
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
// ?versionless drops the registry launcher's version fields, i.e. the frizz-dev / legacy popover.
const versions = params.has("versionless")
  ? {}
  : { version: "0.4.2", updateVersion: params.has("patch") ? "0.4.3" : "0.5.0", launcherVersion: "0.13.0" }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_frizz/control/status") {
    // ?rejected is a launcher that installed 0.5.0 and went back from it: nothing offered, and why.
    const offer = params.has("rejected")
      ? { updateAvailable: false, ...versions, updateVersion: undefined, rejectedUpdate: "0.5.0" }
      : { updateAvailable: !params.has("current"), ...versions }
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true, ...offer }), {
      headers: { "content-type": "application/json" },
    })
  }
  if (url.pathname === "/_frizz/control/update-restart") {
    const requests = Number(window.sessionStorage.getItem("restartFixtureRequests") ?? "0") + 1
    window.sessionStorage.setItem("restartFixtureRequests", String(requests))
    await new Promise((resolve) => window.setTimeout(resolve, 1_000))
    return new Response(JSON.stringify({ protocol: 1, state: "restarting" }), {
      headers: { "content-type": "application/json" },
    })
  }
  return nativeFetch(input, init)
}

const { AnchoredPanel, RestartActionButton, RestartFailureNotice, RestartFrizzButton } = await import("./components/RestartFrizzButton.tsx")
const { RestartOverlay } = await import("./components/RestartOverlay.tsx")
// ?mobile renders the phone Settings page's row for the same control, alone on the page's ground.
const { MobileUpdateRow } = await import("./components/SettingsDrawer.tsx")

// ?failure renders the supervisor's failure card on the same anchor the popover uses. It cannot be
// reached by clicking here — the card is raised by a status POLL reporting "failed", which this
// fixture's stubbed control plane never does — and it is the panel whose arrow has to clear the same
// corner arc, so it needs to be measurable beside the popover rather than only in a broken instance.
const failureMessage = params.get("failure") || "Frizz worker plugin closure is missing cc-worker/bin/browser-mcp.mjs"

// The real control's own shape: the card hangs off the SAME wrapper as the button, through the same
// AnchoredPanel, whose offset backs out of the button's `-mx-1.5` ink trim.
function FailureOnAnchor() {
  return (
    <div>
      <RestartActionButton update busy={false} version="0.4.2" updateVersion="0.5.0" onClick={() => undefined} />
      <AnchoredPanel>
        <RestartFailureNotice update message={failureMessage} onDismiss={() => undefined} />
      </AnchoredPanel>
    </div>
  )
}

function Fixture() {
  const snap = useSnapshot(store)
  const restarting = snap.controlPlaneState === "restarting"
  return (
    <main className="min-h-screen bg-bg p-3 sm:p-8">
      <RestartOverlay open={restarting} message={snap.controlPlaneMessage} />
      <div inert={restarting}>
        {/* A focusable background control so QA can prove Tab cannot reach behind the scrim. */}
        <button type="button" data-testid="decoy" className="mb-4 rounded border border-border px-2 py-1">decoy</button>
        {/* Left-aligned, so the panel opens rightward off a `w-fit` wrapper exactly as it does off the
            status row above the prompt box, which is where this button really lives. */}
        <div className="w-fit">
          {params.has("failure") ? <FailureOnAnchor /> : params.has("mobile") ? null : <RestartFrizzButton />}
        </div>
        {params.has("mobile") ? <div className="-mx-3 font-sans sm:-mx-8"><MobileUpdateRow /></div> : null}
      </div>
    </main>
  )
}

// RestartFrizzButton reads the supervisor through the shared status query (api/supervisorStatus.ts),
// so the fixture has to provide a client the way the real app's main.tsx does.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
)
