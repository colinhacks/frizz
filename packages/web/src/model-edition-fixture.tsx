import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { AntigravityModels, ClaudeModel, CodexModel } from "@frizz/shared"
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

const antigravityMode = params.get("antigravity")
const antigravityModels: AntigravityModels | undefined = antigravityMode === "ultra"
  ? {
      available: true,
      version: "1.5.16",
      defaultModel: "gemini-4-neon",
      tier: "Google AI Ultra",
      models: [
        { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
        { id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
        { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
        { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
        { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", efforts: [] },
        { id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", efforts: [] },
        { id: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)", efforts: [] },
        { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", efforts: [] },
      ],
    }
  : antigravityMode === "signed-out"
    ? { available: true, models: [], error: "Antigravity is not signed in. Run `agy` in a terminal and sign in." }
    : undefined

// `?signedOut=codex` (or `claude,codex`) marks those providers signed out, as useDispatchProfile does.
const allGroups = dispatchProfileGroups(
  codexModels,
  [],
  claudeModels,
  undefined,
  undefined,
  (params.get("signedOut") ?? "").split(",").filter(Boolean),
  undefined,
  antigravityModels ? { installed: true, models: antigravityModels } : undefined,
)
// A running thread's picker holds only its own backend's rows (useThreadComposerControls).
const threadGroups = allGroups.filter((group) => group.id === (antigravityModels ? "antigravity" : "claude"))

const initialProfile = params.get("selected") === "gemini"
  ? { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "high" }
  : params.get("selected") === "other"
    ? { provider: "antigravity", model: "antigravity:claude-opus-5-5", effort: "medium" }
    : params.get("selected") === "orchestrator"
      ? { provider: "antigravity", model: "antigravity:gemini-pro-orchestrator-neon", effort: "" }
      : { provider: "claude", model: "opus", effort: "high" }

function Fixture() {
  const [profile, setProfile] = useState(initialProfile)
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
