import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { openGithubPicker } from "../store.ts"

// THE one query definition every gh-gated surface shares (this trigger, App's sign-in hint, the
// picker) so their options can't drift apart.
//
// It deliberately overrides the app-wide `refetchOnWindowFocus: false` (main.tsx). This is the one
// query whose answer changes OUTSIDE the app: the user leaves for a terminal, runs `gh auth login`,
// and comes back. Nothing else re-asks — App's observer stays mounted for the life of the page, so
// the cache entry never goes inactive — and with focus-refetch off the Prompt Box kept the page-load
// answer FOREVER. Measured 2026-08-04 against a live stack: server flipped to authed:true, the icon
// stayed absent for 15s and through focus/visibility events, and only a reload brought it back.
// `staleTime` throttles the refetch so a burst of tab switches can't spawn a `gh` per switch.
// (Signing in from frizz's OWN terminal never blurs the window — that one still needs a reload.)
export function useGithubStatus() {
  return useQuery({
    queryKey: ["githubStatus"],
    queryFn: () => rpc.githubStatus(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // A NO IS NEVER FINAL — re-ask on a slow interval until it turns yes, then stop.
    //
    // Focus-refetch above covers "the user left, ran `gh auth login`, came back". It does NOT cover the
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
  return Boolean(status.data?.inRepo && status.data.authed)
}

// The auth-gated door into the GitHub picker — a small GitHub icon that sits just LEFT of the dispatch
// composer's send button (maintainer 2026-07-10: not a full-width pill). Renders ONLY when gh is authed
// AND the project is a gh-resolvable GitHub repo — otherwise NOTHING (a hidden feature, not a disabled
// control). `githubStatus` is shared with App's not-signed-in hint via the query cache (one fetch);
// detection is cached server-side, `authed` re-checked live, so a later `gh auth login` surfaces it.
// No profile gating: the picker carries its own model/effort selector, so an unloaded or unavailable
// saved pair is something to FIX in there, not a reason to refuse to open.
export function GithubTrigger({ className = "" }: { className?: string }) {
  if (!useGithubTriggerVisible()) return null
  return (
    <button
      type="button"
      onClick={openGithubPicker}
      onMouseDown={(e) => e.preventDefault()}
      title="Investigate this issue and make recommendations"
      aria-label="Investigate this issue and make recommendations"
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color,box-shadow] enabled:hover:bg-panel-2/70 enabled:hover:text-fg enabled:focus-visible:bg-panel-2/70 enabled:focus-visible:text-muted enabled:focus-visible:ring-1 enabled:focus-visible:ring-muted/80 enabled:focus-visible:ring-offset-1 enabled:focus-visible:ring-offset-bg enabled:active:bg-elevated enabled:active:text-muted disabled:bg-transparent disabled:text-muted-35 ${className}`}
    >
      <Github size={15} strokeWidth={2} />
    </button>
  )
}
