import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import { openGithubPicker } from "../store.ts"
import { isConsolePath } from "../lib/base-path.ts"
import { scopedKey, useProjectScope, useRpc } from "../lib/projectScope.tsx"

/**
 * What the picker does, in one line: the tooltip on this door and the heading of the room it opens
 * (GithubPickerModal), one string so the two never name it differently. Both read "Investigate this
 * issue and make recommendations" until 2026-10-26 — the lead line of the prompt an issue thread is
 * sent, which named neither a list of many issues and PRs nor the button that opens one.
 */
export const GITHUB_PICKER_TITLE = "Start threads from issues and PRs"

// THE one query definition every gh-gated surface shares (this trigger, App's sign-in hint, the
// picker) so their options can't drift apart.
//
// It deliberately overrides the app-wide `refetchOnWindowFocus: false` (main.tsx). This is the one
// query whose answer changes OUTSIDE this page: Frizz is signed in to GitHub from Settings in another
// tab or device, and the user comes back (Settings in THIS tab invalidates it directly). Nothing else
// re-asks — App's observer stays mounted for the life of the page, so the cache entry never goes
// inactive — and with focus-refetch off the Prompt Box kept the page-load
// answer FOREVER. Measured 2026-08-04 against a live stack: server flipped to authed:true, the icon
// stayed absent for 15s and through focus/visibility events, and only a reload brought it back.
// `staleTime` throttles the refetch so a burst of tab switches can't spawn a `gh` per switch.
// (Signing in from frizz's OWN terminal never blurs the window — that one still needs a reload.)
export function useGithubStatus() {
  const project = useProjectScope()
  const api = useRpc()
  return useQuery({
    queryKey: scopedKey(["githubStatus"], project),
    queryFn: () => api.githubStatus(),
    // The Console belongs to no repo: it asks only for a surface that names its project.
    enabled: project !== undefined || !isConsolePath(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // A NO IS NEVER FINAL — re-ask on a slow interval until it turns yes, then stop.
    //
    // Focus-refetch above covers "the user signed Frizz in elsewhere and came back". It does NOT cover the
    // answer going wrong on its own while the tab sits open, and every probe behind this query can do
    // exactly that: they are subprocesses, and `gh repo view` is a live call to api.github.com. On
    // 2026-08-11 the network to GitHub dropped for nine minutes, the answer flipped to inRepo:false, and
    // the icon stayed gone in an open tab long after the network came back — a stuck NO outlives its
    // cause, because nothing re-asks a question already answered. The server-side half of that outage
    // is fixed (gitGithubRemote in packages/server/src/github.ts); this is the half that makes any
    // future false negative — a `gh` that timed out on a loaded machine, a keychain that was briefly
    // locked — heal itself instead of needing a reload nobody knows to do.
    //
    // Only while the answer is NO, so the steady state costs nothing: a yes stops the interval, and the
    // whole feature being visible is the signal that it is right. 60s because it is a subprocess and the
    // cost of being wrong for another minute is one hidden icon, not a broken app.
    refetchInterval: (query) => {
      const status = query.state.data
      return status?.inRepo && status.authed ? false : 60_000
    },
  })
}

// Whether the GitHub trigger will render at all. Callers that RESERVE LAYOUT for the trigger (the
// Composer's `leftAction` slot shifts the paperclip over to make room) must gate on this and pass
// nothing when it's false — a `<GithubTrigger />` element is truthy even when it renders null, so
// passing it unconditionally reserves an empty hole where the icon would be.
export function useGithubTriggerVisible(): boolean {
  const status = useGithubStatus()
  // Signed-out counts: it opens the sign-in. Hidden while signed out until 2026-11-05, when Frizz
  // stopped borrowing `gh`'s sign-in and every install started signed out, so the button would have
  // vanished for everyone with nothing to say why.
  // Not on the Console: the picker it opens is one project's issues and PRs, mounted by the page.
  return Boolean(status.data?.inRepo) && !isConsolePath()
}

// The door into the GitHub picker — a small GitHub icon that sits just LEFT of the dispatch composer's
// send button (maintainer 2026-07-10: not a full-width pill). Renders in a GitHub repo, signed in or not;
// otherwise NOTHING. Signed out, the picker it opens is the sign-in (GithubPickerModal). `githubStatus` is
// shared with App's not-signed-in hint via the query cache (one fetch); detection is cached server-side,
// `authed` re-checked live, so a sign-in turns the sign-in into the picker where it stands.
// No profile gating: the picker carries its own model/effort selector, so an unloaded or unavailable
// saved pair is something to FIX in there, not a reason to refuse to open.
//
// `phoneChip` is the phone's new-thread tool row: the same door as a labelled chip, "Issue or PR" — on a
// phone the icon alone names nothing, and this is where you dispatch from an issue you just read.
export function GithubTrigger({ className = "", variant = "icon" }: { className?: string; variant?: "icon" | "phoneChip" }) {
  if (!useGithubTriggerVisible()) return null
  if (variant === "phoneChip") {
    return (
      <button
        type="button"
        data-phone-github-trigger
        onClick={openGithubPicker}
        onMouseDown={(e) => e.preventDefault()}
        title={GITHUB_PICKER_TITLE}
        // 32px of chip, 44px of target — the model chip's own box, so the two read as one row.
        className={`relative inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-full border border-border-strong bg-bg px-[11px] text-[13.5px] font-medium text-fg after:absolute after:inset-x-0 after:-inset-y-[6px] after:content-[''] active:bg-hover ${className}`}
      >
        <Github aria-hidden size={14} strokeWidth={1.9} className="shrink-0 text-muted" />
        Issue or PR
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={openGithubPicker}
      onMouseDown={(e) => e.preventDefault()}
      title={GITHUB_PICKER_TITLE}
      aria-label={GITHUB_PICKER_TITLE}
      className={`icon-focus-outline flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color] enabled:hover:bg-hover-strong enabled:hover:text-fg enabled:focus-visible:bg-hover-strong enabled:focus-visible:text-muted enabled:focus-visible:ring-1 enabled:focus-visible:ring-muted/80 enabled:focus-visible:ring-offset-1 enabled:focus-visible:ring-offset-bg enabled:active:bg-elevated enabled:active:text-muted disabled:bg-transparent disabled:text-muted-35 ${className}`}
    >
      <Github size={15} strokeWidth={2} />
    </button>
  )
}
