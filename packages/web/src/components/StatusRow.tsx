import { House, Settings as SettingsIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { projectSlug } from "../lib/base-path.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"
import { ProjectCrumb } from "./ProjectCrumb.tsx"
import { PROJECTS_HREF } from "../lib/homeView.ts"
import { GithubTrigger } from "./GithubTrigger.tsx"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX: where you are at the left, the
// controls at the right.
//
//   ⌂ / frizz ▾                                                             ↻  GitHub  ⚙
//
// It rides the dispatch composer wherever that composer is: the sidebar's own top on a normal board,
// the Console's sidebar, and the centered first-task box on a brand-new project (FirstTaskView), which
// hides the sidebar entirely. Anywhere you can start a thread, this is above it.
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described.
// In the column there is nothing to pass behind it, so the surface is gone: no fill, no border, no
// shadow, no z-index. Its two ends land on the composer's own border, which is what makes a borderless
// strip read as belonging to the box below it.
//
// A BREADCRUMB LEADS, THE ICONS ARE RIGHT-JUSTIFIED (maintainer 2026-10-26: "drop the owner/repo … instead
// make it <homeicon> / <breadcrumb dropdown> then right-justify the icons … settings icon should be far
// right"). Until then the row ran home │ settings · reload │ quota chips at the left and the owner/repo,
// a link to the repo, alone at the right. Now the left end says where you are — the way out, a slash,
// and this project as a dropdown that switches to any other (ProjectCrumb.tsx, which also carries the
// repo link the right end used to be) — and the right end is the row's controls: reload, the GitHub
// picker's door (GithubTrigger.tsx), and settings last, in the corner.
//
// NOTHING HERE DEPENDS ON THE SELECTED MODEL. The usage gauge and the MCP plug rode this row until 2026-11-06,
// when they moved beside the model chip they answer to (AgentMarks.tsx).
//
// No dividers. The row had two while one run of icons held both the door out and the in-app buttons;
// the slash is the breadcrumb's own separator, and the space between the two ends is the other.
//
// THE 272px SIDEBAR IS THE BINDING WIDTH, not the viewport. The row lives in a column that floors at
// 272px in the tablet band, so the crumb is the one thing that gives way (min-w-0, truncating its name)
// and every icon is shrink-0, always reachable. Any NEW mark added here has to be re-checked at 272px.
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer. Each mark wears a different amount of dead space inside its own layout box, so a uniform
// `gap-2` drew six different distances on this row once (measured 2026-08-14, `scripts/ink-gaps.mjs
// --pad=0`, 8.00px to 20.00px). The fix is per-mark, not per-gap: STATUS_ROW_ACTION collapses each icon
// square onto its glyph's ink, and then one `gap-3` is the whole rhythm of the right end. Readings for
// the current row are in StatusRow.test.ts.
//
// THE BREADCRUMB'S GAP IS SET BY ITS HOVER SURFACES, not by its ink. The house's square and the crumb's
// pill each paint 6px past their ink, so at `gap-1.5` both lit surfaces ran edge to edge into the slash
// (measured 0px) and the open menu's pill looked jammed against it (maintainer 2026-10-26: "i dont love
// this spacing. UIs are conflicting here"). `gap-2.5` leaves 4px between the slash and either surface
// when lit, and 10px of ink a side at rest: the slash stands centred between the house and the name.

// THE CONSOLE'S CRUMB IS THE PROJECT CHIP, after the same house: `⌂ / ▣ acme ▾`. The chip picks where the
// prompt below it goes, and each row of its menu opens that project in a new tab (ConsoleProjectChip.tsx).
// The row read `⌂ / All projects ▾` until 2026-10-29, a second project menu over the chip that then rode
// inside the prompt box, and then the house alone (maintainer 2026-11-01: "keep the home icon!"). From
// 2026-11-06 the chip stood alone (maintainer: "we drop the home icon from console"), because a Projects |
// Console pill above the row was the way to the grid; the pill went on 2026-11-10, and the house came back
// as the way out.

/**
 * Takes nothing beyond the Console's flag and its chip, and reads its live values itself. Its call sites
 * are leaves of very different trees — the sidebar column and the fresh-project centered box — and the
 * second one (FirstTaskView) subscribes to no store state of its own. valtio's useSnapshot tracks the
 * properties actually READ, so this re-renders on a board change and on nothing else.
 */
export function StatusRow({ onConsole = false, projectChip }: { onConsole?: boolean; projectChip?: ReactNode } = {}) {
  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {onConsole ? <ConsoleBreadcrumb chip={projectChip} /> : <Breadcrumb />}
      {/* THE ICONS, right-justified, with settings in the corner. Each is shrink-0, so the crumb gives way
          before any of them does. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {/* Greyed when there is no update to install; null only before a supervisor has answered, when
            the gap collapses and the row stays even. */}
        <RestartFrizzButton />
        {/* Not on the Console: the picker it opens is one project's, mounted by that project's page. */}
        {!onConsole && <GithubTrigger />}
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className={STATUS_ROW_ACTION}
          onClick={() => (store.showSettings = true)}
        >
          <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/** The way out and this project, as a dropdown: a project board's alone (above). */
function Breadcrumb() {
  const board = useBoard()
  // A missing board is not evidence that this project is named "frizz". Keep the crumb neutral until a
  // board keyframe supplies an actual name; reconnects retain their adopted board.
  const identity = projectIdentity(board)
  // Host-STRICT: the board carries `githubRepo` only when the origin remote is github.com (see
  // BoardSnapshot), which is exactly the case where a link to github.com is a right destination. The
  // display label alone cannot decide this — a GitLab origin yields an owner/repo there too.
  const githubRepo = board?.githubRepo ?? null

  // The crumb reads the project's own name — owner/repo is the repo, not the project, and lives in the
  // crumb's menu — falling back to the repo half of the label for a board that predates `projectName`.
  const name =
    identity.state === "verified"
      ? board?.projectName?.trim() || identity.repo
      : identity.state === "local"
        ? identity.name
        : null
  // The launching project is served unprefixed, so its path names no slug; the board carries it.
  const currentSlug = board?.projectSlug ?? projectSlug()

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5">
      <HomeLink />
      <span aria-hidden="true" className="shrink-0 select-none text-muted-45">/</span>
      <span
        className="flex min-w-0 items-center"
        data-project-identity-state={identity.state}
        aria-busy={identity.state === "loading" || undefined}
      >
        {name ? (
          <ProjectCrumb name={name} currentSlug={currentSlug} githubRepo={githubRepo} />
        ) : (
          // Only before the first board keyframe, or on a keyframe with nothing nameable in it. A repo
          // with no git remote is NOT this case — it has a name (its directory) and shows it.
          <span className="identity-placeholder w-24" aria-hidden="true" />
        )}
      </span>
    </nav>
  )
}

/** The Console's: the way out, and the chip saying which project the prompt box sends to. */
function ConsoleBreadcrumb({ chip }: { chip: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5">
      <HomeLink />
      <span aria-hidden="true" className="shrink-0 select-none text-muted-45">/</span>
      <span className="flex min-w-0 items-center">{chip}</span>
    </nav>
  )
}

/**
 * THE DOOR OUT, and the breadcrumb's root. A 24px target like the icons at the other end, trimmed onto its ink by STATUS_ROW_ACTION's own `-mx-1.5` alone: the
 * house's ink then starts on the composer's outer border edge, as the gear's ends on it at the row's other
 * end (both measured 2026-10-26, 0px). It carried an extra `-ml-px` until then, which did not ADD to the
 * trim but REPLACED it — `margin-left` outranks `margin-inline` in the stylesheet — and left the house 5px
 * inside the border while the owner/repo at the other end ran flush.
 *
 * A ROUTER Link, like the rail's identical door at ProjectRail.tsx. It was a raw `<a href="/">` from
 * 2026-08-19 until 2026-09-04, which hard-loaded the document: measured at 116-411ms with a 0.15 CLS, and
 * it threw away the app socket and the whole query cache on the way out. It goes to the grid even while
 * the Console is the kept home (lib/homeView.ts): PROJECTS_HREF, not `/`, which would forward straight
 * back to the Console.
 */
function HomeLink() {
  return (
    <Link to={PROJECTS_HREF} title="All projects" aria-label="All projects" className={STATUS_ROW_ACTION}>
      <House size={STATUS_ROW_ICON} aria-hidden="true" />
    </Link>
  )
}
