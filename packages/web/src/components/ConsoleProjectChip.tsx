import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useMemo, type ReactNode } from "react"
import { ArrowUpRight, ChevronDown } from "lucide-react"
import type { ProjectCard } from "@frizz/shared"
import { projectHref } from "../lib/base-path.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { consoleDispatchProject, pickConsoleDispatchProject, useConsoleDispatchPick } from "../lib/consoleDispatchProject.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { ProjectSquare } from "./ProjectRail.tsx"
import { PROMPT_CONTROL_CELL, PromptControlGroup } from "./ui/PromptControlGroup.tsx"

// THE CONSOLE'S NEW-THREAD TARGET: which project a thread started on the Console runs in, and the chip
// that says so. One hook for every surface that starts a thread there — the sidebar's prompt box
// (ConsoleSidebar.tsx), ⌘K's "New thread" dialog and the phone's new-thread page (NewThreadModal.tsx) —
// so they share one chip and one remembered choice (lib/consoleDispatchProject.ts). Each wraps its form
// in <ProjectScope project={project.slug}>: the dispatch, the model lists, the agent-settings gear and
// an attachment's upload all go to that project.
//
// THE CHIP STANDS IN THE BOX'S TOP-RIGHT CORNER, inside it, above the text (maintainer 2026-11-15: "the
// project dropdown in the 'All projects' view needs to be inside the sidebar prompt box", then of the strip
// along the bottom, "i think it should be top left", and of the top-left corner, "actually top right"). It
// stands on the 7px inset the corner controls share (Composer's header row, lib/iconRhythm.ts
// PROMPT_HEADER_ROW), over Send in the bottom-right corner, in the model pill's shape. It stood just OUTSIDE
// the box's upper left, in the status row's crumb, from 2026-11-06 to 2026-11-15, and in the bottom strip
// before that. Its menu picks that project, and each row also opens the project in a new tab.

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

// On a desktop the chip is a pill in the model pill's shape: the same 24px hairline (PromptControlGroup), its
// name in the same petite caps, and no chevron, as the box's other dropdowns have none. `ml-auto` puts it at the
// row's right end. The row is its own, so the name has the box's whole width before it truncates.
const DESKTOP_CHIP_SLOT = "ml-auto flex min-w-0 max-w-full"

/**
 * The PROJECT chip: where a task typed in this box will run. A phone draws it in its tool row beside the
 * model chip; a desktop, in the box's top-right corner (DESKTOP_CHIP_SLOT).
 */
function ProjectChip({ project, projects, onPick }: { project: ProjectCard; projects: ProjectCard[]; onPick: (slug: string) => void }) {
  const phone = useIsMobile()
  const trigger = (
    <RadixDropdown.Trigger asChild>
      <button
        type="button"
        aria-label={`Project: ${project.name}`}
        title={`${project.name}: the project a new thread runs in`}
        data-console-project-chip={project.slug}
        className={phone ? PHONE_CHIP : `group inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 ${PROMPT_CONTROL_CELL} bg-transparent text-left text-muted outline-none transition-colors hover:bg-hover-strong hover:text-fg data-[state=open]:bg-hover-strong data-[state=open]:text-fg ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
      >
        {/* `shrink-0`: the square sizes itself by inline style, and a truncating name beside it squeezed it to 10px. */}
        <span className="shrink-0">
          <ProjectSquare project={project} size={phone ? 16 : 14} />
        </span>
        {phone ? (
          <>
            <span className="min-w-0 truncate">{project.name}</span>
            <ChevronDown aria-hidden size={13} strokeWidth={2.4} className="shrink-0 text-muted" />
          </>
        ) : (
          // Lifted a pixel, as the model pill's value is (ProfileGridSelector): petite caps sit on the baseline.
          <span className="relative -top-px min-w-0 truncate">{project.name}</span>
        )}
      </button>
    </RadixDropdown.Trigger>
  )
  return (
    <RadixDropdown.Root modal={false}>
      {phone ? trigger : (
        <div className={DESKTOP_CHIP_SLOT}>
          <PromptControlGroup>{trigger}</PromptControlGroup>
        </div>
      )}
      <RadixDropdown.Portal>
        {/* On a desktop the menu hangs from the chip's right end, its edge on the chip's hairline, since the chip
            stands in the box's right corner. On a phone `alignOffset` puts the menu's squares under the chip's: a
            row's square stands 13px inside the menu (its 1px border, 6px of padding and the row's own 6px), and
            the chip's 6px inside the chip. The width cap gives a long name the room the crumb's menu does
            (ProjectCrumb.tsx), plus the rail's 36px. The left collision margin is the smaller one so that offset
            survives a box against the window's edge: when the chip stood in the status row, in the one-thread pane
            up to 1440px, it started 12px in, the menu 5px, and a margin of 8 pushed the menu 3px right of the
            chip's square. */}
        <RadixDropdown.Content
          align={phone ? "start" : "end"}
          alignOffset={phone ? -7 : -1}
          side="bottom"
          sideOffset={5}
          collisionPadding={{ top: 8, right: 8, bottom: 8, left: 4 }}
          className={`${OPAQUE_PORTAL_SURFACE_CLASS} relative flex min-w-[200px] overflow-hidden rounded-lg ${phone ? "max-w-[280px]" : "max-w-[316px]"}`}
        >
          {/* THE RAIL: the new-tab arrows stand in a strip of their own down the menu's right edge, past one
              hairline from top to bottom (maintainer 2026-11-06, choosing it from fifteen treatments). With the
              arrow at the end of each row and the row's fill running under it, every arrow read as the row's own
              end, as if a click anywhere opened a new tab. The strip sits outside the scroller, so it spans the
              menu however far the list scrolls. */}
          {!phone && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-9 border-l border-border bg-[color-mix(in_oklab,var(--color-inset)_35%,transparent)]" />
          )}
          {/* `[overflow-y:auto]` and not Tailwind's `overflow-y-auto`, which styles.css gives a stable scrollbar
              gutter: 7px of empty room on the right of a list that rarely scrolls, so its rows stood 14px from the
              right edge and 7px from the left. With the scrollbar hidden too, a long list still scrolls by wheel
              and by the arrow keys, and the arrows stay over the rail. */}
          <RadixDropdown.RadioGroup
            value={project.slug}
            onValueChange={onPick}
            className={`scrollbar-none max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-0 flex-1 p-1.5 [overflow-y:auto] ${phone ? "" : "pr-[42px]"}`}
          >
            {projects.map((p) => (
              // TWO MENU ITEMS ON ONE ROW, so the arrow keys reach the link as they reach the row, and the
              // browser opens the link on its own click, as it does the crumb's "Open on GitHub". Each lights
              // alone. The chosen project is the filled row, with no check: a check at the row's far end stood
              // beside the arrow as a second unrelated mark.
              <div key={p.id} className="group/row flex items-center">
                <RadixDropdown.RadioItem
                  value={p.slug}
                  data-console-project-option={p.slug}
                  className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded pl-1.5 pr-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2 data-[state=checked]:bg-panel-2 data-[state=checked]:font-medium"
                >
                  <ProjectSquare project={p} size={16} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </RadixDropdown.RadioItem>
                {/* Not on a phone: a small target beside the row is a mis-tap that leaves the page being typed on.
                    The cell is the rail's width and hangs into it by a negative margin, 6px clear of the row; its
                    lit square is drawn inside it. */}
                {!phone && (
                  <RadixDropdown.Item asChild textValue="">
                    <a
                      href={projectHref(p.slug)}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Open ${p.name} in a new tab`}
                      title="Open in a new tab"
                      data-console-project-open={p.slug}
                      className="relative z-[1] -mr-[42px] ml-1.5 flex h-[26px] w-9 shrink-0 cursor-pointer items-center justify-center text-muted-70 no-underline outline-none before:absolute before:inset-x-[7px] before:inset-y-[3px] before:rounded before:content-[''] group-hover/row:text-muted data-[highlighted]:text-fg data-[highlighted]:before:bg-hover-strong"
                    >
                      <ArrowUpRight aria-hidden size={14} className="relative" />
                    </a>
                  </RadixDropdown.Item>
                )}
              </div>
            ))}
          </RadixDropdown.RadioGroup>
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
