import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Check, ChevronDown } from "lucide-react"
import { Link } from "react-router"
import { rpc } from "../api/rpc.ts"
import { projectHref } from "../lib/base-path.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import { STATUS_ROW_CRUMB, STATUS_ROW_CRUMB_CHEVRON } from "../lib/statusRow.ts"
import { ProjectSquare } from "./ProjectRail.tsx"

// THE BREADCRUMB'S LAST CRUMB — `<home> / <this>` at the head of the status row above the prompt box: the
// page you are on, as a dropdown that switches to any other project (maintainer 2026-10-26: "instead make
// it <homeicon> / <breadcrumb dropdown>"). It replaced the owner/repo link that stood at the row's right
// end, so the way to the repo moved INTO this menu, as its last item.
//
// The project is named as the grid and the rail name it — the registry's name, which the operator can
// change — rather than by owner/repo: the crumb is the checked row of its own menu, and a crumb reading
// "colinhacks/frizz" over a menu that lists "frizz" would be two names for one place. Until the list
// answers it falls back to the name the board carries.
//
// EVERY ROW IS A REAL LINK, as the rail's squares are, so hovering one shows its address and ⌘-click,
// middle-click and "Open link in new tab" all work. A project whose directory is gone is left out: the
// grid is where one of those is reopened or forgotten, and a switch into it would land on nothing.
//
// The menu is the Console project chip's (ConsoleProjectChip.tsx) — the same surface, row and check —
// so the app's two project menus read as one control. They are never on one screen: the Console's status
// row draws the chip in this crumb's place (StatusRow.tsx).

/** One menu row: the chip's own row, so the two project menus match. The tone is each row's own. */
const ROW =
  "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] outline-none no-underline data-[highlighted]:bg-panel-2"

export function ProjectCrumb({
  name,
  currentSlug,
  githubRepo,
}: {
  /** What the crumb reads before the project list answers. */
  name: string
  /** The project this page shows, checked in the menu. */
  currentSlug: string | undefined
  /** owner/repo when the origin is github.com: the menu's way out to the repo. */
  githubRepo: string | null
}) {
  const list = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const projects = (list.data ?? []).filter((project) => !project.stale)
  const current = currentSlug ? list.data?.find((project) => project.slug === currentSlug) : undefined
  const label = current?.name ?? name
  return (
    <RadixDropdown.Root modal={false}>
      <RadixDropdown.Trigger asChild>
        {/* THE SAME HOVER SURFACE AS THE HOUSE beside it (STATUS_ROW_ACTION): 24px tall, `rounded-md`,
            `bg-hover-strong`, so the breadcrumb's two controls light up as one family rather than a square
            and a shorter, lower pill (it was 22px and sat 1px low until the maintainer read it off a
            screenshot, 2026-10-26: "i dont love this spacing. UIs are conflicting here").
            Its padding is 6px of INK a side: `pl-1.5` before the name, and `pr-[3px]` after the chevron,
            whose own box carries the other 3px. The negative margins hand that padding back to the
            layout, so the name's ink starts where the crumb's slot does and StatusRow's breadcrumb gap
            is measured ink to ink.
            The outer box centres its content on the 24px line; the inner one is `items-baseline` so the
            chevron can sit on the name's cap band: `self-baseline` plus the browser-computed `0.5em -
            0.5cap` translate centres a symmetric 1em glyph's ink on the cap band in any font at any
            size, where `items-center` would centre its BOX and leave it riding low beside lowercase. */}
        <button
          type="button"
          data-project-crumb={currentSlug ?? ""}
          aria-label={`${label}: switch project`}
          title="Switch project"
          className={STATUS_ROW_CRUMB}
        >
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="min-w-0 truncate">{label}</span>
            {/* lucide's chevron paints the middle half of its box, so a quarter of an em is dead space a
                side; `-ml-[0.25em]` takes the near quarter back and leaves the gap's 4px as INK between
                the name and the chevron, the reading a label and its handle want. */}
            <ChevronDown aria-hidden="true" className={STATUS_ROW_CRUMB_CHEVRON} />
          </span>
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          data-project-crumb-menu=""
          className={`${OPAQUE_PORTAL_SURFACE_CLASS} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] max-w-[280px] overflow-auto rounded-lg p-1.5`}
        >
          {projects.map((project) => (
            <RadixDropdown.Item key={project.id} asChild>
              <Link to={projectHref(project.slug)} data-project-crumb-option={project.slug} className={`${ROW} text-fg`}>
                <ProjectSquare project={project} size={16} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <Check aria-hidden="true" size={13} className={project.slug === currentSlug ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
              </Link>
            </RadixDropdown.Item>
          ))}
          {projects.length === 0 && (
            <div className="px-1.5 py-1 text-[12px] text-muted-60">{list.isLoading ? "Loading projects…" : "No projects"}</div>
          )}
          {githubRepo && (
            <>
              <RadixDropdown.Separator className="-mx-1.5 my-1.5 h-px bg-border" />
              <RadixDropdown.Item asChild>
                <a href={`https://github.com/${githubRepo}`} target="_blank" rel="noopener" data-project-crumb-github="" className={`${ROW} text-muted data-[highlighted]:text-fg`}>
                  {/* The square's 16px column, so the repo's words start under the project names. */}
                  <span className="flex w-4 shrink-0 justify-center">
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    Open <span className="font-mono-keep">{githubRepo}</span> on GitHub
                  </span>
                </a>
              </RadixDropdown.Item>
            </>
          )}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
