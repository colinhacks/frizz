import { createRoot } from "react-dom/client"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

function SidebarTitle({ backend, model, children }: { backend: "claude" | "codex" | "acp"; model?: string; children: string }) {
  const thread: ThreadView = {
    id: model ?? backend,
    kind: "session",
    title: children,
    titleLocked: true,
    backend,
    model,
    runtime: "turn-idle",
    status: "active",
    statusText: "Active",
    mechanism: null,
    humanBlocked: false,
    needsYou: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    unread: false,
    archived: false,
    hasPlan: false,
    pendingQuestion: false,
    foreign: false,
    state: "open",
    subAgents: [],
    bgShells: [],
    watches: [],
    questions: [],
  }
  return <ThreadRow t={thread} />
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto max-w-[680px] space-y-6 rounded-lg border border-border bg-panel p-4 shadow-xl shadow-black/30">
        <div>
          <p className="mb-2 text-[11px] text-muted">Sidebar/list title marks</p>
          <div className="space-y-2 rounded-md bg-panel-2 p-3">
            <SidebarTitle backend="claude">Investigate source maps and preserve the first useful human title</SidebarTitle>
            <SidebarTitle backend="codex">Implement the durable title protocol for new Codex sessions</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:opencode">Port the fixture runner to OpenCode</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:cursor">Port the fixture runner to Cursor</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:gemini">Port the fixture runner to Gemini</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:copilot">Port the fixture runner to Copilot</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:qwen">Port the fixture runner to Qwen</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:kimi">Port the fixture runner to Kimi</SidebarTitle>
            <SidebarTitle backend="acp" model="acp:grok">Port the fixture runner to Grok</SidebarTitle>
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] text-muted">Queue-card and drawer headers intentionally have no provider mark</p>
          <div className="rounded-md border border-border px-4 py-3 font-semibold text-[15px] leading-snug text-fg">
            Investigate permissions sidebar placement
          </div>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<TooltipProvider><Fixture /></TooltipProvider>)
