import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useMemo, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import type { ProjectCard } from "@frizz/shared"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { consoleDispatchProject, pickConsoleDispatchProject, useConsoleDispatchPick } from "../lib/consoleDispatchProject.ts"
import { OPAQUE_SURFACE_BASE } from "../lib/overlaySurface.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { ProjectSquare } from "./ProjectRail.tsx"

// THE CONSOLE'S NEW-THREAD TARGET: which project a thread started on the Console runs in, and the chip
// that says so. One hook for every surface that starts a thread there — the sidebar's prompt box
// (ConsoleSidebar.tsx), ⌘K's "New thread" dialog and the phone's new-thread page (NewThreadModal.tsx) —
// so they share one chip and one remembered choice (lib/consoleDispatchProject.ts). Each wraps its form
// in <ProjectScope project={project.slug}>: the dispatch, the model lists, the agent-settings gear and
// an attachment's upload all go to that project.

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

const DESKTOP_CHIP =
  "group inline-flex min-w-0 max-w-[min(14rem,40vw)] cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-transparent py-1 pl-[5px] pr-2 text-left text-[12px] leading-4 text-fg/90 outline-none transition-colors hover:bg-hover-strong data-[state=open]:bg-hover-strong"
// On the phone's new-thread page the chip rides beside the phone's model chip (MobileModelSheet.tsx
// PhoneProfileSelector), so it takes that chip's shape: 32px of pill, 44px of target, 13.5px type.
const PHONE_CHIP =
  "relative inline-flex h-[32px] min-w-0 max-w-[45vw] shrink items-center gap-[6px] rounded-full border border-border-strong bg-bg pl-[7px] pr-[11px] text-left text-[13.5px] font-medium text-fg outline-none after:absolute after:inset-x-0 after:-inset-y-[6px] after:content-[''] active:bg-hover"

/**
 * The prompt box's PROJECT chip: where a task typed here will run. Shaped like the profile pill beside
 * it (ProfileGridSelector's trigger) so the two read as one strip of settings for the next thread: the
 * same 26px height and border, and the same ink distance from its words to its chevron. The square sits
 * 5px inside the border, as the approved mockup has it — a filled mark needs less room than a word.
 * Measured 2026-10-11 (sans): square → name 6.75px of ink; the square centred on the name's cap band to 0.23px.
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
          className={phone ? PHONE_CHIP : DESKTOP_CHIP}
        >
          <ProjectSquare project={project} size={16} />
          <span className="min-w-0 truncate">{project.name}</span>
          {/* `-ml-[1.5px]`: on the shared 6px gap the name's ink sat 8.75px from the chevron's, where the profile
              pill beside it reads 7.14 (scripts/ink-gaps.mjs, 2026-10-11, sans). The trim brings it to 7.25. */}
          {phone ? (
            <ChevronDown aria-hidden size={13} strokeWidth={2.4} className="shrink-0 text-muted" />
          ) : (
            <ChevronDown aria-hidden size={13} className="-ml-[1.5px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
          )}
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          side="bottom"
          sideOffset={5}
          collisionPadding={8}
          className={`z-[110] ${OPAQUE_SURFACE_BASE} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-auto rounded-lg p-1.5`}
        >
          {projects.map((p) => (
            <RadixDropdown.Item
              key={p.id}
              onSelect={() => onPick(p.slug)}
              data-console-project-option={p.slug}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2"
            >
              <ProjectSquare project={p} size={16} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <Check aria-hidden size={13} className={p.slug === project.slug ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
