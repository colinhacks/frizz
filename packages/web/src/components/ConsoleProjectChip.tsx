import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useMemo, type ReactNode } from "react"
import { ArrowUpRight, Check, ChevronDown } from "lucide-react"
import type { ProjectCard } from "@frizz/shared"
import { projectHref } from "../lib/base-path.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { consoleDispatchProject, pickConsoleDispatchProject, useConsoleDispatchPick } from "../lib/consoleDispatchProject.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { STATUS_ROW_CRUMB, STATUS_ROW_CRUMB_CHEVRON } from "../lib/statusRow.ts"
import { ProjectSquare } from "./ProjectRail.tsx"

// THE CONSOLE'S NEW-THREAD TARGET: which project a thread started on the Console runs in, and the chip
// that says so. One hook for every surface that starts a thread there — the sidebar's prompt box
// (ConsoleSidebar.tsx), ⌘K's "New thread" dialog and the phone's new-thread page (NewThreadModal.tsx) —
// so they share one chip and one remembered choice (lib/consoleDispatchProject.ts). Each wraps its form
// in <ProjectScope project={project.slug}>: the dispatch, the model lists, the agent-settings gear and
// an attachment's upload all go to that project.
//
// THE CHIP STANDS AT THE UPPER LEFT OF THE BOX IT POINTS, not inside it (maintainer 2026-11-06: "the project
// chip should show up to the upper left in the console"): it says where the prompt goes, and the strip
// inside the box is what the prompt runs on. Its menu picks that project, and each row also opens the project
// in a new tab, the way to a project's page now that the Console's status row draws no house.

/** `enabled` false (a project's own page) reads nothing and names no project. */
export function useConsoleDispatchTarget(enabled = true): { project: ProjectCard | undefined; chip: ReactNode } {
  const { projects } = useConsoleProjectList(enabled)
  const project = consoleDispatchProject(projects, useConsoleDispatchPick())
  // Memoized: the form's footer is memoized on it, and a fresh element per keystroke would rebuild it.
  const chip = useMemo(
    () => (project ? <ProjectChip project={project} projects={projects} onPick={pickConsoleDispatchProject} /> : null),
    [project, projects],
  )
  return { project, chip }
}

// On the phone's new-thread page the chip rides beside the phone's model chip (MobileModelSheet.tsx
// PhoneProfileSelector), so it takes that chip's shape: 32px of pill, 44px of target, 13.5px type.
const PHONE_CHIP =
  "relative inline-flex h-[32px] min-w-0 max-w-[45vw] shrink items-center gap-[6px] rounded-full border border-border-strong bg-bg pl-[7px] pr-[11px] text-left text-[13.5px] font-medium text-fg outline-none after:absolute after:inset-x-0 after:-inset-y-[6px] after:content-[''] active:bg-hover"

/**
 * The PROJECT chip: where a task typed in the box below it will run. On a desktop it takes the breadcrumb's
 * shape, because it stands where a project page's breadcrumb does (lib/statusRow.ts): loose, with no border,
 * lit on hover, its square starting on the composer's left edge. It keeps a chevron where the dropdowns inside
 * the box have none: nothing else on this row says that it opens.
 */
function ProjectChip({ project, projects, onPick }: { project: ProjectCard; projects: ProjectCard[]; onPick: (slug: string) => void }) {
  const phone = useIsMobile()
  return (
    <RadixDropdown.Root modal={false}>
      <RadixDropdown.Trigger asChild>
        <button
          type="button"
          aria-label={`Project: ${project.name}`}
          title="The project a new thread runs in"
          data-console-project-chip={project.slug}
          className={phone ? PHONE_CHIP : `${STATUS_ROW_CRUMB} gap-1.5`}
        >
          <ProjectSquare project={project} size={16} />
          {phone ? (
            <>
              <span className="min-w-0 truncate">{project.name}</span>
              <ChevronDown aria-hidden size={13} strokeWidth={2.4} className="shrink-0 text-muted" />
            </>
          ) : (
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="min-w-0 truncate">{project.name}</span>
              <ChevronDown aria-hidden className={STATUS_ROW_CRUMB_CHEVRON} />
            </span>
          )}
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          side="bottom"
          sideOffset={5}
          collisionPadding={8}
          className={`${OPAQUE_PORTAL_SURFACE_CLASS} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-auto rounded-lg p-1.5`}
        >
          {projects.map((p) => (
            // TWO MENU ITEMS ON ONE ROW, so the arrow keys reach the link as they reach the row, and the
            // browser opens the link on its own click, as it does the crumb's "Open on GitHub". The row lights
            // as a whole whichever one is under the pointer, and the link lights again on top of that.
            <div key={p.id} className="flex items-center rounded has-[[data-highlighted]]:bg-panel-2">
              <RadixDropdown.Item
                onSelect={() => onPick(p.slug)}
                data-console-project-option={p.slug}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-fg outline-none"
              >
                <ProjectSquare project={p} size={16} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <Check aria-hidden size={13} className={p.slug === project.slug ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
              </RadixDropdown.Item>
              {/* Not on a phone: a small target beside the row is a mis-tap that leaves the page being typed on. */}
              {!phone && (
                <RadixDropdown.Item asChild textValue="">
                  <a
                    href={projectHref(p.slug)}
                    target="_blank"
                    rel="noopener"
                    aria-label={`Open ${p.name} in a new tab`}
                    title="Open in a new tab"
                    data-console-project-open={p.slug}
                    className="mr-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-70 no-underline outline-none data-[highlighted]:bg-hover-strong data-[highlighted]:text-fg"
                  >
                    <ArrowUpRight aria-hidden size={14} />
                  </a>
                </RadixDropdown.Item>
              )}
            </div>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
