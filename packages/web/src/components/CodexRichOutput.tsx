import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import {
  Archive,
  CalendarClock,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LayoutTemplate,
  MessageSquareCode,
  Network,
  PackageCheck,
  Upload,
} from "lucide-react"
import type { CodexHostDirective, CodexHostDirectiveValue } from "../lib/codexHostDirectives.ts"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"
import { getThemeSnapshot, subscribeTheme } from "../lib/theme.ts"
import { createMermaidRenderQueue } from "../lib/mermaidRenderQueue.ts"

function text(attrs: CodexHostDirective["attrs"], key: string): string | undefined {
  const value = attrs[key]
  return typeof value === "string" && value ? value : undefined
}

function number(attrs: CodexHostDirective["attrs"], key: string): number | undefined {
  const value = attrs[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function webUrl(attrs: CodexHostDirective["attrs"], key: string): string | undefined {
  const value = text(attrs, key)
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
  } catch { return undefined }
}

function Card({ directive, icon, title, meta, children }: { directive: CodexHostDirective; icon: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <section
      data-codex-directive={directive.name}
      className={`min-w-0 ${BLOCK_RADIUS} border border-border bg-panel-2/75 p-4`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted" aria-hidden>{icon}</span>
        <div className="max-w-[calc(100%-1.5rem)] shrink-0 break-words text-[12px] font-medium leading-4 text-fg">{title}</div>
        {meta && <div className="min-w-0 truncate text-[11px] font-normal leading-4 text-muted">{meta}</div>}
      </div>
      {children}
    </section>
  )
}

function Detail({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <div className={`ml-6 mt-1 break-words text-[11px] leading-4 text-muted${mono ? " font-mono-keep" : ""}`}>{children}</div>
}

function TemplateCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const displayName = text(attrs, "display_name") ?? text(attrs, "skill_name") ?? "Artifact template"
  const kind = text(attrs, "artifact_kind")
  const skill = text(attrs, "skill_name")
  const directory = text(attrs, "skill_directory")
  const [preview, setPreview] = useState(Boolean(directory))
  return (
    <Card directive={directive} icon={<LayoutTemplate size={15} />} title={displayName} meta={kind ? `${kind} template` : "Template"}>
      {skill && <Detail mono>{skill.startsWith("$") ? skill : `$${skill}`}</Detail>}
      {preview && directory && (
        <img
          src={localImageUrl(`${directory}/assets/preview.png`)}
          alt={`${displayName} template preview`}
          loading="lazy"
          onError={() => setPreview(false)}
          className="ml-6 mt-2 max-h-44 max-w-[calc(100%-1.5rem)] rounded-md border border-border object-contain"
        />
      )}
    </Card>
  )
}

function CodeCommentCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const file = text(attrs, "file")
  const start = number(attrs, "start")
  const end = number(attrs, "end") ?? start
  const priority = number(attrs, "priority")
  const location = file ? `${file}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}` : "Code location unavailable"
  return (
    <Card directive={directive} icon={<MessageSquareCode size={15} />} title={text(attrs, "title") ?? "Review finding"} meta={priority === undefined ? undefined : `P${priority}`}>
      {text(attrs, "body") && <Detail>{text(attrs, "body")}</Detail>}
      {file ? (
        <button type="button" className="local-file-action ml-6 mt-1 max-w-[calc(100%-1.5rem)] break-all text-left font-mono-keep text-[11px] leading-4 text-accent underline decoration-dotted underline-offset-2" data-local-path={file} title={location}>
          {location}
        </button>
      ) : <Detail mono>{location}</Detail>}
    </Card>
  )
}

const GIT_PRESENTATION = {
  "git-stage": [PackageCheck, "Changes staged"],
  "git-commit": [GitCommitHorizontal, "Commit created"],
  "git-create-branch": [GitBranch, "Branch created"],
  "git-push": [Upload, "Branch pushed"],
  "git-create-pr": [GitPullRequest, "Pull request created"],
} as const

function GitCard({ directive }: { directive: CodexHostDirective }) {
  const [Icon, title] = GIT_PRESENTATION[directive.name as keyof typeof GIT_PRESENTATION]
  const branch = text(directive.attrs, "branch")
  const url = webUrl(directive.attrs, "url")
  const draft = directive.attrs.isDraft === true
  const label = `${title}${draft ? " as draft" : ""}`
  return (
    <Card
      directive={directive}
      icon={<Icon size={15} />}
      title={url ? <a className="text-accent underline underline-offset-2" href={url} target="_blank" rel="noopener noreferrer">{label}</a> : label}
      meta={branch && <span className="font-mono-keep">{branch}</span>}
    />
  )
}

function ThreadCard({ directive }: { directive: CodexHostDirective }) {
  const id = text(directive.attrs, "threadId")
  const pending = text(directive.attrs, "pendingWorktreeId")
  return (
    <Card directive={directive} icon={<Network size={15} />} title={pending ? "Thread setup queued" : "Thread created"} meta={(id || pending) && <span className="font-mono-keep">{id ?? pending}</span>} />
  )
}

function LifecycleCard({ directive }: { directive: CodexHostDirective }) {
  const reason = text(directive.attrs, "reason")
  return (
    <Card directive={directive} icon={<Archive size={15} />} title="Archive suggested" meta={reason} />
  )
}

function scheduleSummary(value: CodexHostDirectiveValue | undefined): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  const interval = value.match(/(?:^|;)INTERVAL=(\d+)(?:;|$)/)?.[1]
  if (/(?:^|;)FREQ=HOURLY(?:;|$)/.test(value)) return `Every ${interval ?? "1"} hour${interval === "1" || interval === undefined ? "" : "s"}`
  if (/(?:^|;)FREQ=WEEKLY(?:;|$)/.test(value)) return "Weekly schedule"
  return "Custom schedule"
}

function AutomationCard({ directive }: { directive: CodexHostDirective }) {
  const attrs = directive.attrs
  const mode = text(attrs, "mode")
  const name = text(attrs, "name") ?? "Automation"
  const schedule = scheduleSummary(attrs.rrule)
  const status = text(attrs, "status")
  const summary = [name, mode, status, schedule].filter(Boolean).join(" · ")
  return (
    <Card directive={directive} icon={<CalendarClock size={15} />} title="Automation suggested" meta={summary}>
      {text(attrs, "prompt") && <Detail>{text(attrs, "prompt")}</Detail>}
    </Card>
  )
}

export function CodexDirectiveCard({ directive }: { directive: CodexHostDirective }) {
  if (directive.name === "artifact-template") return <TemplateCard directive={directive} />
  if (directive.name === "code-comment") return <CodeCommentCard directive={directive} />
  if (directive.name.startsWith("git-")) return <GitCard directive={directive} />
  if (directive.name === "created-thread") return <ThreadCard directive={directive} />
  if (directive.name === "archive" || directive.name === "archive-thread") return <LifecycleCard directive={directive} />
  return <AutomationCard directive={directive} />
}

type MermaidModule = typeof import("mermaid")["default"]
let mermaidModule: Promise<MermaidModule> | undefined
let nextMermaidRender = 0

function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => mermaid)
  return mermaidModule
}

function mermaidColors() {
  const root = getComputedStyle(document.documentElement)
  const color = (name: string) => root.getPropertyValue(name).trim()
  return {
    background: color("--color-panel-2"), primaryColor: color("--color-panel-2"), primaryTextColor: color("--color-fg"), primaryBorderColor: color("--color-control-strong"), lineColor: color("--color-muted"), secondaryColor: color("--color-border"), tertiaryColor: color("--color-bg"), fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  }
}

const mermaidRenderer = createMermaidRenderQueue(
  async (request) => {
    const mermaid = await loadMermaid()
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: request.resolved === "dark" ? "dark" : "base", themeVariables: request.palette })
    return mermaid.render(request.id, request.source)
  },
  (id) => document.getElementById(`d${id}`)?.remove(),
)

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId()
  const { resolved } = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  const [state, setState] = useState<{ html?: string; error?: string }>({})
  const generation = useRef(0)
  // Declared above the early returns (hook order) — a rendered diagram is a large SVG, and rebuilding
  // it from markup on every unrelated re-render is exactly what useInnerHtml exists to prevent.
  const inner = useInnerHtml(state.html ?? "")
  useEffect(() => {
    let live = true
    const currentGeneration = ++generation.current
    setState((previous) => previous.error ? { html: previous.html } : previous)
    if (source.length > 50_000) {
      setState({ error: "Diagram source exceeds the 50 KB rendering limit" })
      return () => { live = false }
    }
    const id = `frizz-mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}-${++nextMermaidRender}`
    void mermaidRenderer.enqueue({ id, source, resolved, palette: mermaidColors() })
      .then(({ svg }) => { if (live && generation.current === currentGeneration) setState({ html: svg }) })
      .catch((error: unknown) => {
        if (!live || generation.current !== currentGeneration) return
        const message = error instanceof Error ? error.message.split(/\n| for text:/, 1)[0] : "Unknown diagram error"
        setState({ error: message.slice(0, 240) })
      })
    return () => { live = false }
  }, [reactId, resolved, source])

  if (state.error) {
    return (
      <section data-mermaid-state="error" className={`${BLOCK_RADIUS} border border-border bg-panel-2/75 p-4`}>
        <div className="text-[12px] font-medium text-fg">Diagram unavailable</div>
        <div className="mt-1 text-[11px] text-muted">{state.error}</div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono-keep text-[11px] text-muted">{source}</pre>
      </section>
    )
  }
  if (!state.html) return <div data-mermaid-state="loading" role="status" aria-label="Rendering diagram" className={`h-24 animate-pulse ${BLOCK_RADIUS} bg-panel-2`} />
  return <div data-mermaid-state="ready" className={`overflow-x-auto ${BLOCK_RADIUS} border border-border bg-panel-2/75 p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full`} dangerouslySetInnerHTML={inner} />
}
