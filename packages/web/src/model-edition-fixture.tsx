import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { ClaudeModel, CodexModel } from "@frizz/shared"
import { ProfileGridSelector, type ProfileGridUpgrade } from "./components/ProfileGridSelector.tsx"
import { dispatchProfileGroups } from "./lib/dispatchPreferences.ts"
import "./styles.css"

// The Claude EDITION surfaces, in every state, for screenshots and the optical passes:
//
//   ?view=dispatch  — the new-thread picker: the model column sets each version one step dimmer.
//   ?view=thread    — a running thread's picker: the readout names the edition its worker RUNS, and the
//                     open menu carries the upgrade row. `?state=` picks it: available (the button),
//                     blocked (the button disabled by a running turn), staged (no live worker — the next
//                     turn starts on the new edition by itself), current (no row at all).
//   ?theme=light|dark. Sans always: the app pins `data-font="sans"` and a fixture that leaves it unset
//   renders the mono default nobody sees.

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
const theme = params.get("theme") === "light" ? "light" : "dark"
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme
const view = params.get("view") === "dispatch" ? "dispatch" : "thread"
const state = params.get("state") ?? "available"

// The 2.1.281 catalogue, as the claudeModels RPC answers it.
const claudeModels: ClaudeModel[] = [
  { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1", edition: "5.1" },
  { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5", edition: "5.5" },
  { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5", edition: "5" },
  { alias: "haiku", label: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001", edition: "4.5" },
]
const codexModels: CodexModel[] = [
  { slug: "gpt-6-astra", displayName: "GPT-6 Astra", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-sol", displayName: "GPT-6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
]

// `?signedOut=codex` (or `claude,codex`) marks those providers signed out, as useDispatchProfile does.
const allGroups = dispatchProfileGroups(codexModels, [], claudeModels, undefined, undefined, (params.get("signedOut") ?? "").split(",").filter(Boolean))
// A running thread's picker holds only its own backend's rows (useThreadComposerControls).
const threadGroups = allGroups.filter((group) => group.id === "claude")

function Fixture() {
  const [profile, setProfile] = useState({ provider: "claude", model: "opus", effort: "high" })
  const [upgraded, setUpgraded] = useState(false)
  const upgrade: ProfileGridUpgrade | undefined = view === "thread" && state !== "current"
    ? {
        latest: "Opus 5.5",
        staged: state === "staged" || upgraded,
        blockedReason: state === "blocked" ? "Wait for the current turn to finish" : null,
        pending: false,
        onUpgrade: () => setUpgraded(true),
      }
    : undefined
  return (
    <main className="flex min-h-screen items-end justify-center bg-bg p-6 pb-10">
      <section data-fixture-composer="" className="w-[min(560px,100%)] rounded-lg border border-border bg-panel p-3 shadow-xl">
        <p className="mb-8 text-[13px] text-muted">{view === "thread" ? "Reply to this thread…" : "Describe a new task…"}</p>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <ProfileGridSelector
            groups={view === "thread" ? threadGroups : allGroups}
            value={profile}
            onValueChange={setProfile}
            ariaLabel="Thread model and effort"
            menuAriaLabel="Choose Claude Code model and effort"
            compact
            side="top"
            className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
            runningModelLabel={view === "thread" && state !== "current" && !upgraded ? "Opus 5" : undefined}
            upgrade={upgrade}
            agentSettings={view === "dispatch"}
          />
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
