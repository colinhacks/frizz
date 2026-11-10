import { useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import { keepPreviousData, useInfiniteQuery, useIsMutating, useMutation } from "@tanstack/react-query"
import { ArrowUpRight, Check, CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Github, Inbox, Loader2, MessageSquare } from "lucide-react"
import { acpModelSlug, type DispatchInput, type DispatchProfileSnapshot, type GithubBatchInput, type GithubItem } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Overlay } from "./NewThreadModal.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { AcpModelSelect } from "./AcpModelSelect.tsx"
import { ExperimentalChip } from "./ui/ExperimentalChip.tsx"
import { GithubPromptPopover } from "./GithubPromptPopover.tsx"
import { SETTINGS_WRITE_KEY } from "../hooks/useSettingsAutosave.tsx"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { dispatchProfileGroups, dispatchProfileUpdate, dispatchProfileValue } from "../lib/dispatchPreferences.ts"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z, OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z } from "../lib/overlaySurface.ts"
import { buildGithubBatchInput, dispatchProfileError } from "../lib/githubDispatch.ts"
import { GITHUB_PICKER_TITLE, useGithubStatus } from "./GithubTrigger.tsx"
import { GithubSignInSheet } from "./GithubSignInSheet.tsx"
import { applyRowSelection } from "../lib/rowRangeSelection.ts"
import { githubLabelColors } from "../lib/githubLabelColors.ts"
import { PRIMER } from "../lib/primer.ts"
import { compactAge } from "../lib/activityTime.ts"

type Kind = "issues" | "prs"
type Sort = "recent" | "reactions"

// Rows per fetch. The list loads as it scrolls (maintainer 2026-11-07: "lazy-loaded scrolling instead of
// pagination"): the server still answers one page at a time (`perPage`), and the next is asked for as the
// bottom of the list comes within PREFETCH_MARGIN of view, so a steady scroll rarely meets the spinner.
const PAGE_SIZE = 30
const PREFETCH_MARGIN = "0px 0px 360px 0px"
// GitHub's search serves the first 1,000 results of any query and refuses a page past them, so the server
// stops offering pages there (`pageCountFor`). A bigger repo's list ends with a line that says so, rather
// than at a row that looks like the last open issue.
const SEARCH_WINDOW = 1000

// THE GitHub picker: a wider anywhere-modal (reusing NewThreadModal's Overlay) that lists the repo's
// Issues or PRs (tabs), sortable by recency or reactions, with multi-select checkboxes, and the
// ordinary model/effort selector in the settings panel behind its footer gear. "Dispatch N thread(s)"
// spins up one frizz thread per checked item
// (each ISSUE an investigate/reproduce/recommend thread, each PR a review thread) via
// rpc.githubDispatchBatch — the server hydrates + templates each fresh, reusing the normal dispatch
// flow; the new sidebar rows paint via the board SSE. The trigger that opens this is auth-gated, so
// the RPCs are guaranteed serviceable when it's mounted.

// Signed out, the picker has nothing to list, so its button opens the sign-in instead, and the sign-in
// becomes the picker in place: useGithubSignIn invalidates `githubStatus` when it lands. On a phone
// this is the only way in, since Settings there has no GitHub row.
export function GithubPickerModal({ onClose }: { onClose: () => void }) {
  const status = useGithubStatus()
  if (status.data && !status.data.authed) return <GithubSignInSheet onClose={onClose} />
  return <GithubPicker onClose={onClose} />
}

function GithubPicker({ onClose }: { onClose: () => void }) {
  const status = useGithubStatus()
  // The batch dispatches with the SAME durable new-thread profile the prompt box uses — the selector
  // below writes it, so choosing here also becomes the composer's next default (one profile, not a
  // picker-local copy that silently diverges). A Codex cache refresh can invalidate the saved pair
  // while the picker is open; the final revalidation below then fails closed rather than downgrading.
  const { resolved, codexList, claudeList, acpList, firstGroup, opencode, loadError, saveProfile } = useDispatchProfile()
  // A settings write still in flight — the triage prompt just edited in the settings panel, a
  // compaction window picked in the selector — must land before a batch that would read it.
  const savingSettings = useIsMutating({ mutationKey: [...SETTINGS_WRITE_KEY] }) > 0

  const [kind, setKind] = useState<Kind>("issues")
  const [sort, setSort] = useState<Sort>("recent")
  // Selection is a Set<number> scoped to the CURRENT tab — switching tabs CLEARS it (simplest, and it
  // dodges the issue#N-vs-pr#N number collision a shared set would hit). Documented choice per plan §6.
  // Batches are uncapped, so checking a dozen issues near the top and a dozen more a few hundred rows
  // down is the flow this UI exists for. The footer keeps that honest by counting everything checked,
  // scrolled out of view or not, and offering a one-click clear.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  // The shift-click anchor: the last PLAINLY clicked row's number (see lib/rowRangeSelection.ts).
  const [anchor, setAnchor] = useState<number | null>(null)

  // Server order is AUTHORITATIVE (the search sort) — render items exactly as returned, never re-sort
  // client-side. The query re-keys on {kind, sort}, so a tab/sort flip starts a fresh list;
  // keepPreviousData holds the outgoing list on screen, dimmed, through the new one's first fetch, so
  // the switch doesn't collapse the list to a skeleton and jump the modal's height.
  const list = useInfiniteQuery({
    queryKey: ["githubList", kind, sort],
    queryFn: ({ pageParam }) => rpc.githubList({ kind, sort, page: pageParam, perPage: PAGE_SIZE }),
    initialPageParam: 1,
    // The server reports the page it ACTUALLY served and how many it can serve (clamped to GitHub's
    // search window), so the list stops where GitHub would refuse rather than asking past it.
    getNextPageParam: (last) => (last.page < last.pageCount ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
    // Dropped the moment nothing shows it. A cached infinite list refetches EVERY page it holds when it
    // is next mounted, one GitHub search call each, and search allows about 30 a minute: reopening the
    // picker after scrolling fifteen pages would spend half that at once. Reopened, it starts at the top.
    gcTime: 0,
  })
  const pages = list.data?.pages
  // One row per number. The pages are fetched minutes apart, and an issue opened in between shifts every
  // later page of the "recent" order down by one, so the row at a page's end can come round again at the
  // top of the next. The first copy keeps its place.
  const items = useMemo(() => {
    const seen = new Set<number>()
    const rows: GithubItem[] = []
    for (const p of pages ?? []) {
      for (const it of p.items) {
        if (seen.has(it.number)) continue
        seen.add(it.number)
        rows.push(it)
      }
    }
    return rows
  }, [pages])
  // The newest page's count, so a repo that gained an issue while the list was scrolled reads it.
  const total = pages?.at(-1)?.total ?? 0

  // A new list starts at the top; without this a tab or sort flip keeps the old list's scroll offset
  // and the new list's first rows are already scrolled past.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [kind, sort])

  // The loader row at the list's end is the sentinel: once it comes within PREFETCH_MARGIN of the list's
  // visible bottom, the next page is fetched. The observer is rebuilt after every page lands, because a
  // fresh observer reports the sentinel's CURRENT state at once: a page too short to push the sentinel
  // out of view (a tall window, or rows the de-duplication dropped) asks for the next one straight away
  // instead of waiting for a scroll that can't happen. Nothing fetches past a failed page until Retry,
  // and nothing fetches for the outgoing list a tab switch is still showing.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage } = list
  useEffect(() => {
    const root = listRef.current
    const target = sentinelRef.current
    if (!root || !target || !hasNextPage || isFetchingNextPage || isFetchNextPageError || isPlaceholderData) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchNextPage()
    }, { root, rootMargin: PREFETCH_MARGIN })
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage, items.length])

  const dispatch = useMutation({
    mutationFn: (input: GithubBatchInput) => rpc.githubDispatchBatch(input),
    onMutate: (input) => showToast(`Starting ${input.items.length} thread${input.items.length === 1 ? "" : "s"}…`, { spinner: true, sticky: true }),
    onSuccess: (res) => {
      const ok = res.dispatched.length
      const failed = res.failed.length
      showToast(`Started ${ok} thread${ok === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`)
      onClose()
    },
    onError: (e) => showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`),
  })

  function switchKind(k: Kind) {
    if (k === kind) return
    setKind(k)
    setSelected(new Set())
    setAnchor(null)
  }
  function switchSort(s: Sort) {
    if (s === sort) return
    setSort(s)
    // Clear on sort-switch, same as tab-switch: the whole ordering changes underneath, so a range
    // shift-clicked in the old order means nothing in the new one.
    setSelected(new Set())
    setAnchor(null)
  }
  // One entry point for every row activation (click, Enter, Space). Shift paints the whole
  // anchor→row range with the anchor's state; a plain click toggles and re-anchors. `keys` is every
  // row loaded so far, in list order, so a range runs across the seams between fetched pages.
  function activate(n: number, shiftKey: boolean) {
    const result = applyRowSelection({
      keys: items.map((it) => it.number),
      key: n,
      shiftKey,
      anchor,
      selected,
    })
    setSelected(result.selected)
    setAnchor(result.anchor)
  }
  function clearSelection() {
    setSelected(new Set())
    setAnchor(null)
  }

  const n = selected.size
  // Stable identity: ProfileGridSelector memoizes off `groups`, and this modal re-renders on every
  // row toggle.
  const profileGroups = useMemo(() => dispatchProfileGroups(codexList, acpList, claudeList, firstGroup, opencode), [codexList, acpList, claudeList, firstGroup, opencode])
  const acpAgent = resolved?.acpAgentId ? acpList.find((agent) => agent.id === resolved.acpAgentId) : undefined
  const profile: DispatchProfileSnapshot | undefined = resolved
    ? { backend: resolved.backend, model: resolved.model, effort: (resolved.effort || undefined) as DispatchProfileSnapshot["effort"] }
    : undefined
  // Two levels, deliberately: `profileError` is a real fault worth a red line under the selector (a
  // saved model/effort the catalogue no longer offers, or a catalogue that failed to load), while
  // `dispatchBlocked` also covers the merely-not-loaded-yet case — the selector's own "Profile
  // loading…" placeholder already says that, so it must not paint red.
  const profileError = profile
    ? dispatchProfileError(profile, codexList, acpList)
    : loadError
      ? "Could not load the model catalogue — reopen once it loads"
      : undefined
  const dispatchBlocked = profileError ?? (savingSettings ? "Saving settings…" : profile ? undefined : "Loading the model catalogue…")

  function startDispatch() {
    if (!profile || dispatchBlocked) {
      showToast(dispatchBlocked ?? "Choose a model and reasoning level")
      return
    }
    dispatch.mutate(buildGithubBatchInput(
      profile,
      [...selected].map((number) => ({ kind: kind === "issues" ? "issue" : "pr", number })),
    ))
  }

  return (
    <Overlay onClose={onClose}>
      <div
        className="flex max-h-[85vh] w-[720px] max-w-[90vw] flex-col rounded-xl border border-border bg-panel px-5 pb-3 pt-5 shadow-2xl shadow-shadow-ink/50"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {/* Header: the title left, and the repo slug RIGHT-justified as a link out to github.com. The
            slug was an em-dashed suffix of the title until 2026-09-19; as a link in the far corner it
            is the picker's one way OUT to the repo.
            The title says what the picker DOES. It read "Investigate this issue and make
            recommendations" until 2026-10-26 — the lead line of the prompt each issue thread is sent,
            heading a list of many issues and PRs (maintainer: "this title doesnt make sense").
            The rule under it, and its twin above the footer, run edge to edge in the tone of the app's
            other panel rules (maintainer 2026-11-09: "a little more Frizz-like"): a heading, a body, and
            what the body starts. */}
        {/* `items-baseline`, not `items-center`: the link's two glyphs are each put on its CAP BAND by a
            browser-computed translate — half the glyph's box minus half the resolved cap height — which
            needs a shared baseline to work from (measured 2026-09-19: 0.0px residual in both type
            families). `-mt-1.5` centres the title's INK between the modal's top edge and the rule, 21.1px
            above its capitals and 21.8px below its baseline: the line box's own leading stood it 27.1px
            down on the modal's `p-5` alone. */}
        <h2 className="-mx-5 -mt-1.5 mb-4 flex items-baseline gap-2 border-b border-border/60 px-5 pb-4 text-[14px] font-medium">
          <span className="min-w-0 truncate">{GITHUB_PICKER_TITLE}</span>
          {status.data?.nameWithOwner && (
            <span className="ml-auto flex shrink-0 items-baseline">
              <RepoLink nameWithOwner={status.data.nameWithOwner} />
            </span>
          )}
        </h2>

        {/* Controls: tabs (Issues | PRs) left, sort (Recent | Reactions) right */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <Segmented
            value={kind}
            onChange={(v) => switchKind(v)}
            options={[
              { value: "issues", label: "Issues" },
              { value: "prs", label: "PRs" },
            ]}
          />
          <div className="flex items-center gap-2">
            {/* Gone on a narrow screen, where the two controls and this label overran the row by 7px at 390. */}
            <span className="petite-caps text-[11px] text-muted-70 max-sm:hidden">Sort</span>
            <Segmented
              value={sort}
              onChange={switchSort}
              options={[
                { value: "recent", label: "Recent" },
                { value: "reactions", label: "Reactions" },
              ]}
            />
          </div>
        </div>

        {/* List */}
        <div
          ref={listRef}
          className={`min-h-[240px] flex-1 overflow-y-auto rounded-lg border border-border/70 bg-bg/40 transition-opacity ${
            list.isPlaceholderData ? "opacity-40" : ""
          }`}
        >
          {/* The whole-list error is for a list with NOTHING loaded. A failed later page, or a background
              refetch that fails, also sets `isError`, and must not take the rows already on screen with it:
              the failed page says so at the list's end instead. */}
          {list.isLoading ? (
            <ListSkeleton />
          ) : !pages ? (
            <Centered>
              <span className="text-[12.5px] text-muted-80">Couldn't load {kind === "issues" ? "issues" : "pull requests"}.</span>
              <span className="max-w-[80%] text-center text-[11px] text-muted-45">{list.error?.message.slice(0, 140)}</span>
            </Centered>
          ) : items.length === 0 ? (
            <Centered>
              <Inbox size={28} strokeWidth={1.25} className="text-muted-30" />
              <span className="text-[12.5px] text-muted-60">No open {kind === "issues" ? "issues" : "pull requests"}</span>
            </Centered>
          ) : (
            <>
              {items.map((it) => (
                <Row key={it.number} item={it} checked={selected.has(it.number)} onActivate={(shiftKey) => activate(it.number, shiftKey)} />
              ))}
              {/* Drawn only while there is more to load, so the list's last row keeps `last:border-b-0`
                  once it truly is the last. */}
              {hasNextPage && (
                <div ref={sentinelRef} data-github-list-more="" className="flex h-11 items-center justify-center gap-2 text-[11.5px] text-muted-60">
                  {isFetchNextPageError ? (
                    <>
                      <span>Couldn't load more.</span>
                      <button
                        type="button"
                        onClick={() => void fetchNextPage()}
                        onMouseDown={(e) => e.preventDefault()}
                        className="rounded text-fg/80 underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:underline"
                      >
                        Retry
                      </button>
                    </>
                  ) : (
                    <Loader2 aria-label="Loading more" size={14} className="animate-spin text-muted-45" />
                  )}
                </div>
              )}
              {!hasNextPage && total > SEARCH_WINDOW && (
                <div className="px-3 py-3 text-center text-[11.5px] text-muted-55">
                  GitHub's search lists the first {SEARCH_WINDOW.toLocaleString()} of these
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: the running selection on the left, and on the right the gear and the Start button. One
            row: the totals line, the model chip and the button were three bands of chrome under the list
            (maintainer 2026-11-09: "It still feels kind of insane. Let's just combine the model and effort
            selector inside of the settings popover and just have a single settings icon immediately to
            the left of the Start Investigation button").
            12px above and below, like the app's other panel footers. The bottom 12 is the modal's own
            `pb-3`, so a model error under this row keeps its margin.
            whitespace-nowrap: the running-selection cluster holds its size, and only the repo total (the
            least actionable number here, and the one that goes on a phone once anything is checked)
            gives way. Checked rows can be scrolled far out of view, so this is the only place the full
            count is always visible. */}
        <div className="-mx-5 mt-3 flex items-center gap-3 border-t border-border/60 px-5 pt-3">
          {pages && (
            <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-60">
              <span className={`truncate tabular-nums ${n > 0 ? "max-sm:hidden" : ""}`}>
                {total.toLocaleString()} open {kind === "issues" ? (total === 1 ? "issue" : "issues") : total === 1 ? "pull request" : "pull requests"}
              </span>
              {n > 0 && (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-muted-30 max-sm:hidden">·</span>
                  <span className="tabular-nums text-fg/70">{n} selected</span>
                  <button
                    onClick={clearSelection}
                    onMouseDown={(e) => e.preventDefault()}
                    className="rounded py-0.5 text-muted-60 underline-offset-2 outline-none transition-colors hover:text-fg hover:underline"
                  >
                    Clear
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* What every thread this batch starts will be: the model and effort, and the prompt. The
                selector is the SAME control the prompt box carries and writes the same durable preference.
                The picker keeps its state, because the batch dispatches with it; only the control moved. */}
            <GithubPromptPopover>
              <ProfileGridSelector
                groups={profileGroups}
                agentSettings
                value={resolved ? dispatchProfileValue(resolved) : undefined}
                onValueChange={(selection) => saveProfile(dispatchProfileUpdate(selection))}
                placeholder={loadError ? "Profile unavailable" : "Profile loading…"}
                ariaLabel="Model and effort"
                title={dispatchBlocked ?? "Model and reasoning effort for every thread this batch starts"}
                disabled={!resolved}
                // The popover layer, the one the panel holding it is on, and not the selector-in-popover
                // layer above: each runtime's gear in this menu opens a panel on the popover layer, which
                // has to land over the menu. On one layer the later-opened paints on top, and these only
                // ever open in that order (githubPromptPopover.e2e pins all three).
                menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z}
                className="max-w-[min(21rem,60vw)]"
              />
              {resolved?.backend === "opencode" && <ExperimentalChip className="shrink-0" />}
              {acpAgent && (
                <AcpModelSelect
                  agentId={acpAgent.id}
                  agentLabel={acpAgent.label}
                  modelId={resolved?.acpModelId}
                  onValueChange={(modelId) => saveProfile({ field: "model", backend: "acp", value: acpModelSlug(acpAgent.id, modelId) })}
                  menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z}
                  className="max-w-[min(14rem,30vw)]"
                />
              )}
            </GithubPromptPopover>
            <button
              disabled={n === 0 || dispatch.isPending || !!dispatchBlocked}
              onClick={startDispatch}
              onMouseDown={(e) => e.preventDefault()}
              className="button-outline flex shrink-0 items-center gap-2 rounded-md bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
            >
              {dispatch.isPending && <Loader2 size={13} className="animate-spin" />}
              {/* The count is on the button because the batch is unbounded and can run far past the rows
                  in view — "Start 47 investigations" is the last chance to notice it says 47, not 4. */}
              {n <= 1 ? "Start investigation" : `Start ${n} investigations`}
            </button>
          </div>
        </div>
        {profileError && <p className="mt-1 max-w-[430px] text-[10.5px] text-danger">{profileError}</p>}
      </div>
    </Overlay>
  )
}

// The repo as a link OUT to github.com, in the picker header's far corner: the GitHub mark, the slug and
// lucide's arrow-up-right, the "opens elsewhere" mark GitHub itself uses beside external links, at the
// slug's own `1em` so the three read as one link.
//
// TEXT, NOT A BUTTON, on purpose. As muted text it read as a caption (maintainer 2026-11-07: "make the link
// out to the repo a little more prominent"), and as a bordered chip, 2026-11-07 to 2026-11-09, it was one
// box stacked on the sort control's (maintainer: "I really don't like the repo button in such close
// proximity to the tab switcher"). The fg tone and the mark carry the prominence, and the header's rule
// keeps it from reading as part of the controls.
//
// Each glyph goes on the slug's cap band by the documented translate, half its box minus half the cap
// height. The arrow's ink is centred in its box (7..17 of 24) and paints 10 of 24 units, 0.29em of dead
// space a side, so `-mx-[0.29em]` collapses the box onto its ink: the `gap-1` is 4px of INK from the slug
// to the arrow, and the arrow's tip stands on the right edge the sort control and the list end on.
function RepoLink({ nameWithOwner }: { nameWithOwner: string }) {
  return (
    <a
      href={`https://github.com/${nameWithOwner}`}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${nameWithOwner} on GitHub`}
      className="github-repo-link group inline-flex min-w-0 items-baseline gap-1 rounded-sm text-[12.5px] font-normal text-fg/85 outline-none transition-colors hover:text-fg focus-visible:text-fg"
    >
      <Github aria-hidden="true" className="mr-0.5 size-[13px] shrink-0 self-baseline translate-y-[calc(6.5px_-_0.5cap)]" />
      <span className="truncate underline-offset-2 group-hover:underline group-focus-visible:underline">{nameWithOwner}</span>
      <ArrowUpRight aria-hidden="true" className="-mx-[0.29em] size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />
    </a>
  )
}

// A binary/ternary segmented control in the app's rounded-rect / panel-2 idiom — the selected pill
// lifts to `elevated` with the fg text; the rest read muted until hover. Used for the tabs and sort.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          onMouseDown={(e) => e.preventDefault()}
          className={`rounded-md px-3 py-1 text-[12px] font-medium outline-none transition-colors ${
            value === o.value ? "bg-elevated text-fg shadow-sm shadow-shadow-ink/20" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// GitHub's own issue/PR state glyph — green open-dot for an open issue, purple merge for a merged PR,
// etc. Mirrors github.com so the row reads the same at a glance. Defaults to the open glyph if state
// is absent (the picker lists OPEN items, so that's the common case).
//
// The colours are GITHUB'S, from `lib/primer.ts`, not Tailwind's nearest hue — this list is read
// beside the hovercard that renders the same PRs, and `emerald-500`/`purple-400` are 32°/10° of hue
// away from the Primer values that card is drawn in. A bare glyph takes the `fg*` family; the
// `bg*Emphasis` fills are for the hovercard's solid pills.
function StateIcon({ item }: { item: GithubItem }) {
  const st = (item.state ?? "OPEN").toUpperCase()
  if (item.kind === "pr") {
    if (st === "MERGED") return <GitMerge size={15} className="shrink-0" style={{ color: PRIMER.fgDone }} />
    if (st === "CLOSED") return <GitPullRequestClosed size={15} className="shrink-0" style={{ color: PRIMER.fgDanger }} />
    if (item.isDraft) return <GitPullRequestDraft size={15} className="shrink-0" style={{ color: PRIMER.fgNeutral }} />
    return <GitPullRequest size={15} className="shrink-0" style={{ color: PRIMER.fgSuccess }} />
  }
  if (st === "CLOSED") return <CircleCheck size={15} className="shrink-0" style={{ color: PRIMER.fgDone }} />
  return <CircleDot size={15} className="shrink-0" style={{ color: PRIMER.fgSuccess }} />
}


// External label hues share the hovercard's readable light/dark treatment.
function LabelChip({ name, color }: { name: string; color: string }) {
  const label = githubLabelColors(color)
  return (
    <span
      className="max-w-[130px] shrink-0 truncate rounded-full border px-1.5 py-px text-[9.5px] leading-[13px]"
      style={{ borderColor: label.border, color: label.foreground, backgroundColor: label.background }}
      title={name}
    >
      {name}
    </span>
  )
}

// One issue/PR row, mirroring github.com: the select checkbox, the state glyph, the title (a LINK OUT)
// with its label chips, a metadata line "#N · author opened <ago>", and the linked-PR / comment /
// reaction badges on the right. Clicking the row toggles selection, SHIFT-clicking extends from the last clicked row
// through every row in between; clicking the title or the #number opens GitHub.
function Row({ item, checked, onActivate }: { item: GithubItem; checked: boolean; onActivate: (shiftKey: boolean) => void }) {
  const opened = compactAge(item.createdAt) ?? ""
  const meta = [item.author, opened ? `opened ${opened}` : ""].filter(Boolean).join(" ")
  return (
    <div
      role="button"
      tabIndex={0}
      data-row-number={item.number}
      aria-pressed={checked}
      onClick={(e) => onActivate(e.shiftKey)}
      // Shift+click natively drags a text selection across the rows it spans; the range select is the
      // only meaning shift has here, so suppress the browser's before it paints over the list.
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate(e.shiftKey)
        }
      }}
      className="group flex w-full cursor-pointer items-start gap-2.5 border-b border-border/40 px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-hover"
    >
      <span className="mt-px shrink-0">
        <Checkbox checked={checked} />
      </span>
      <span className="mt-px">
        <StateIcon item={item} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            title={item.title}
            className="min-w-0 truncate text-[13px] font-medium text-fg/90 hover:underline"
          >
            {item.title}
          </a>
          {item.labels.slice(0, 4).map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-55">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 tabular-nums hover:text-muted hover:underline"
          >
            #{item.number}
          </a>
          {meta ? <span className="truncate">· {meta}</span> : null}
        </span>
      </span>
      <span className="mt-px flex shrink-0 items-center gap-2.5 text-[11.5px] text-muted-70">
        {item.linkedPrs ? <LinkedPrBadge prs={item.linkedPrs} /> : null}
        {item.comments ? <Badge icon={MessageSquare} n={item.comments} label="comments" /> : null}
        {item.reactions ? <Badge emoji="👍" n={item.reactions} label="reactions" /> : null}
      </span>
    </div>
  )
}

// The shared rounded-rect checkbox — same 15px rounded-[4px] box family as Sidebar's StatusBox. Checked
// fills with `fg` (the app's primary-action color, e.g. "Send answers") + a dark check; unchecked is a
// quiet muted outline that brightens on row hover. Deliberately NOT the accent — yellow is reserved for
// the "needs you" rail signal, not selection.
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex h-[15px] w-[15px] items-center justify-center rounded-[4px] border transition-colors ${
        checked ? "border-fg bg-fg" : "border-muted/45 group-hover:border-muted/80"
      }`}
    >
      {checked && <Check size={11} strokeWidth={3} className="text-bg" />}
    </span>
  )
}

// Optical alignment for the count badges. `items-center` centers each glyph's BOX on the flex line,
// but the eye aligns INK — and a digit has no descender, so its ink rides HIGH in the line box while
// an icon's ink sits wherever its path falls inside its viewBox. Centering the boxes therefore leaves
// every glyph sitting low by a different amount. Measured in the browser at this exact size (each
// glyph's ink bbox against the digit's, via canvas metrics plus an inline-block baseline probe):
//   octicon        ink 10.8px — 1.16px low
//   lucide stroke  ink  9.0px — 1.29px low
//   emoji          ink 16.0px — 0.26px, already aligned, and a nudge would only disturb it
// Expressed in em so the correction tracks the font size instead of pinning to today's 11.5px.
const GLYPH_INK_LIFT = { octicon: "-0.1em", stroke: "-0.112em" } as const

// GitHub's own `git-pull-request` octicon, path verbatim from github.com. Lucide's git-pull-request
// is a STROKE glyph and renders as a thin squiggle at badge size; the octicon is a filled 16-viewBox
// path built for exactly this, which is why the row badge uses it instead of the lucide family the
// rest of this file draws from. `currentColor` so it inherits the cluster's muted tone.
function GitPullRequestOcticon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      className={className}
      style={{ transform: `translateY(${GLYPH_INK_LIFT.octicon})` }}
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  )
}

// The "someone already opened a PR for this" badge, mirroring github.com's issue list exactly: the
// pull-request octicon + the COUNT of linked PRs, in the same muted tone and size as the comment
// badge beside it (measured on github.com — the row glyph is monochrome rgb(145,152,161), NOT the
// green/purple state coloring that StateIcon uses; GitHub reserves color for the item's OWN state).
// Sits first in the cluster, where GitHub puts it. Links to the primary PR, naming it in the tooltip
// — stopPropagation so opening it doesn't also toggle the row.
function LinkedPrBadge({ prs }: { prs: NonNullable<GithubItem["linkedPrs"]> }) {
  const merged = prs.state.toUpperCase() === "MERGED"
  const what = prs.count > 1 ? `${prs.count} linked pull requests — ` : ""
  const primary = merged ? `#${prs.number} merged` : prs.isDraft ? `#${prs.number} open (draft)` : `#${prs.number} open`
  return (
    <a
      href={prs.url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      title={`${what}${primary}`}
      className="inline-flex items-center gap-1 tabular-nums hover:text-fg/90"
    >
      <GitPullRequestOcticon size={12} />
      {prs.count}
    </a>
  )
}

// A count badge (comments / reactions). Comments use a monochrome message glyph (mirrors github.com);
// reactions use the literal 👍 emoji (maintainer 2026-07-10 — not the old triangle). `title` names it.
function Badge({
  icon: Icon,
  emoji,
  n,
  label,
}: {
  icon?: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>
  emoji?: string
  n: number
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${n} ${label}`}>
      {emoji ? (
        <span aria-hidden className="text-[11px] leading-none">{emoji}</span>
      ) : Icon ? (
        <span className="inline-flex" style={{ transform: `translateY(${GLYPH_INK_LIFT.stroke})` }}>
          <Icon size={12} strokeWidth={2} />
        </span>
      ) : null}
      {n}
    </span>
  )
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0">
          <span className="h-[15px] w-[15px] shrink-0 rounded-[4px] bg-muted/20" />
          <span className="h-3 w-8 shrink-0 rounded bg-muted/20" />
          <span className="h-3 flex-1 rounded bg-muted/15" style={{ maxWidth: `${55 + ((i * 7) % 35)}%` }} />
        </div>
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1.5">{children}</div>
}
