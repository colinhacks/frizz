import { useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { Check, ChevronLeft, ChevronRight, CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Github, Inbox, Loader2, MessageSquare } from "lucide-react"
import type { DispatchInput, DispatchProfileSnapshot, GithubBatchInput, GithubItem } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Overlay } from "./NewThreadModal.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z } from "../lib/overlaySurface.ts"
import { buildGithubBatchInput, dispatchProfileError } from "../lib/githubDispatch.ts"
import { useGithubStatus } from "./GithubTrigger.tsx"
import { applyRowSelection } from "../lib/rowRangeSelection.ts"
import { PRIMER } from "../lib/primer.ts"
import { githubLabelColors } from "../lib/githubLabelColors.ts"
import { compactAge } from "../lib/activityTime.ts"

type Kind = "issues" | "prs"
type Sort = "recent" | "reactions"

// Rows per page. The server takes this verbatim (`perPage`) and answers with the matching page plus
// the totals the pager below renders; there is NO cap on how many pages a selection may span.
const PAGE_SIZE = 30

// THE GitHub picker: a wider anywhere-modal (reusing NewThreadModal's Overlay) that lists the repo's
// Issues or PRs (tabs), sortable by recency or reactions, with multi-select checkboxes and the
// ordinary model/effort selector in its bottom-left corner. "Dispatch N thread(s)" spins up one frizz
// thread per checked item
// (each ISSUE an investigate/reproduce/recommend thread, each PR a review thread) via
// rpc.githubDispatchBatch — the server hydrates + templates each fresh, reusing the normal dispatch
// flow; the new sidebar rows paint via the board SSE. The trigger that opens this is auth-gated, so
// the RPCs are guaranteed serviceable when it's mounted.
export function GithubPickerModal({ onClose }: { onClose: () => void }) {
  const status = useGithubStatus()
  // The batch dispatches with the SAME durable new-thread profile the prompt box uses — the selector
  // below writes it, so choosing here also becomes the composer's next default (one profile, not a
  // picker-local copy that silently diverges). A Codex cache refresh can invalidate the saved pair
  // while the picker is open; the final revalidation below then fails closed rather than downgrading.
  const { resolved, codexList, loadError, saveProfile } = useDispatchProfile()

  const [kind, setKind] = useState<Kind>("issues")
  const [sort, setSort] = useState<Sort>("recent")
  // 1-based page into the repo's issues/PRs. Switching tab or sort resets it — the ordering the page
  // number indexes into is a property of {kind, sort}, so carrying it across would land the human at
  // an arbitrary offset in a list they've never seen.
  const [page, setPage] = useState(1)
  // Selection is a Set<number> scoped to the CURRENT tab — switching tabs CLEARS it (simplest, and it
  // dodges the issue#N-vs-pr#N number collision a shared set would hit). Documented choice per plan §6.
  // It deliberately SURVIVES paging: batches are uncapped, so picking a dozen issues off page 1 and a
  // dozen more off page 3 is the flow this UI exists for. The footer keeps that honest by counting
  // everything checked, on-page or not, and offering a one-click clear.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  // The shift-click anchor: the last PLAINLY clicked row's number (see lib/rowRangeSelection.ts).
  const [anchor, setAnchor] = useState<number | null>(null)

  // Server order is AUTHORITATIVE (the search sort) — render items exactly as returned, never re-sort
  // client-side. The query re-keys on {kind, sort, page}, so a tab/sort/page flip refetches;
  // keepPreviousData holds the outgoing page on screen through the next one's fetch, so paging dims
  // rather than collapsing the list to a skeleton and jumping the modal's height.
  const list = useQuery({
    queryKey: ["githubList", kind, sort, page],
    queryFn: () => rpc.githubList({ kind, sort, page, perPage: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  const items = list.data?.items ?? []
  // The server reports the page it ACTUALLY served (it clamps into GitHub's servable window), so the
  // pager reads off that rather than local state — a page that no longer exists self-corrects.
  const servedPage = list.data?.page ?? page
  const pageCount = list.data?.pageCount ?? 1
  const total = list.data?.total ?? 0

  // A new page starts at the top; without this the list keeps the previous page's scroll offset and
  // the first rows are already scrolled past.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [page, kind, sort])

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
    setPage(1)
    setSelected(new Set())
    setAnchor(null)
  }
  function switchSort(s: Sort) {
    if (s === sort) return
    setSort(s)
    setPage(1)
    // Clear on sort-switch, same as tab-switch: the whole ordering changes underneath, so the pages a
    // selection was made across no longer mean anything. (Paging WITHIN one order keeps it — same
    // list, different window.)
    setSelected(new Set())
    setAnchor(null)
  }
  // One entry point for every row activation (click, Enter, Space). Shift paints the whole
  // anchor→row range with the anchor's state; a plain click toggles and re-anchors. `keys` is this
  // PAGE's rows — a range is a span of adjacent visible rows — while `selected` spans every page.
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

  const nameWithOwner = status.data?.nameWithOwner ?? "this repo"
  const n = selected.size
  // Stable identity: ProfileGridSelector memoizes off `groups`, and this modal re-renders on every
  // row toggle.
  const profileGroups = useMemo(() => dispatchProfileGroups(codexList), [codexList])
  const profile: DispatchProfileSnapshot | undefined = resolved
    ? { backend: resolved.backend, model: resolved.model, effort: resolved.effort as DispatchProfileSnapshot["effort"] }
    : undefined
  // Two levels, deliberately: `profileError` is a real fault worth a red line under the selector (a
  // saved model/effort the catalogue no longer offers, or a catalogue that failed to load), while
  // `dispatchBlocked` also covers the merely-not-loaded-yet case — the selector's own "Profile
  // loading…" placeholder already says that, so it must not paint red.
  const profileError = profile
    ? dispatchProfileError(profile, codexList)
    : loadError
      ? "Could not load the model catalogue — reopen once it loads"
      : undefined
  const dispatchBlocked = profileError ?? (profile ? undefined : "Loading the model catalogue…")

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
        className="flex max-h-[85vh] w-[720px] max-w-[90vw] flex-col rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {/* Header */}
        <h2 className="mb-4 flex items-center gap-2 text-[14px] font-medium">
          <Github size={15} className="text-muted" />
          <span>Investigate this issue and make recommendations</span>
          <span className="text-muted-40">—</span>
          <span className="font-mono-keep text-[12.5px] text-muted">{nameWithOwner}</span>
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
            <span className="petite-caps text-[11px] text-muted-70">Sort</span>
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
          {list.isLoading ? (
            <ListSkeleton />
          ) : list.isError ? (
            <Centered>
              <span className="text-[12.5px] text-muted-80">Couldn't load {kind === "issues" ? "issues" : "pull requests"}.</span>
              <span className="max-w-[80%] text-center text-[11px] text-muted-45">{(list.error as Error).message.slice(0, 140)}</span>
            </Centered>
          ) : items.length === 0 ? (
            <Centered>
              <Inbox size={28} strokeWidth={1.25} className="text-muted-30" />
              <span className="text-[12.5px] text-muted-60">No open {kind === "issues" ? "issues" : "pull requests"}</span>
            </Centered>
          ) : (
            items.map((it) => (
              <Row key={it.number} item={it} checked={selected.has(it.number)} onActivate={(shiftKey) => activate(it.number, shiftKey)} />
            ))
          )}
        </div>

        {/* Pager: the running selection on the left (it spans pages, so this is the only place the
            full count is visible), the page controls on the right. The totals line is always worth
            showing; the page controls appear only once there IS a second page, so a small repo
            doesn't carry a dead "Page 1 of 1" and two disabled chevrons. */}
        {!list.isLoading && !list.isError && (
          // whitespace-nowrap throughout: left to wrap, this row folds into three lines at a narrow
          // width and the totals collide with the prev-page button. The running-selection cluster and
          // the page controls hold their size; only the repo total (the least actionable number here)
          // truncates when the modal is squeezed.
          <div className="mt-2.5 flex items-center justify-between gap-3 whitespace-nowrap text-[11.5px] text-muted-60">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate tabular-nums">
                {total} open {kind === "issues" ? (total === 1 ? "issue" : "issues") : total === 1 ? "pull request" : "pull requests"}
              </span>
              {n > 0 && (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-muted-30">·</span>
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
            {pageCount > 1 && (
            <div className="flex shrink-0 items-center gap-1">
              <PagerButton label="Previous page" disabled={servedPage <= 1} onClick={() => setPage(Math.max(1, servedPage - 1))}>
                <ChevronLeft size={14} />
              </PagerButton>
              {/* The label reserves the width of its WIDEST form and paints the live one over it, so
                  stepping 9 → 10 on a 198-page repo doesn't shove the chevrons sideways. tabular-nums
                  makes every digit the same width, which is what lets `pageCount` stand in for the
                  longest page number. */}
              <span className="relative px-2 text-center tabular-nums">
                <span aria-hidden className="invisible">Page {pageCount} of {pageCount}</span>
                <span className="absolute inset-0">
                  Page {servedPage} of {pageCount}
                </span>
              </span>
              <PagerButton label="Next page" disabled={servedPage >= pageCount} onClick={() => setPage(Math.min(pageCount, servedPage + 1))}>
                <ChevronRight size={14} />
              </PagerButton>
            </div>
            )}
          </div>
        )}

        {/* Footer: the ordinary model/effort selector (bottom-left) + the batch-dispatch button. The
            selector is the SAME control the prompt box carries and writes the same durable
            preference, so the profile every dispatched thread gets is editable right here. Opens
            UPWARD (side="top") — the footer sits on the modal's bottom edge. */}
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <ProfileGridSelector
              groups={profileGroups}
              value={resolved ? { provider: resolved.backend, model: resolved.model, effort: resolved.effort } : undefined}
              onValueChange={(selection) => saveProfile({
                field: "profile",
                backend: selection.provider as DispatchProfileSnapshot["backend"],
                model: selection.model,
                effort: selection.effort as DispatchInput["effort"] & string,
              })}
              placeholder={loadError ? "Profile unavailable" : "Profile loading…"}
              ariaLabel="Model and effort"
              title={dispatchBlocked ?? "Model and reasoning effort for every thread this batch starts"}
              disabled={!resolved}
              side="top"
              // The picker's Overlay is z-[200]; the default z-[110] portal would paint the menu
              // beneath its frosted backdrop.
              menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z}
              className="max-w-[min(21rem,60vw)]"
            />
            {profileError && <p className="mt-1 max-w-[430px] text-[10.5px] text-danger">{profileError}</p>}
          </div>
          <div className="flex items-center gap-3">
            <button
              disabled={n === 0 || dispatch.isPending || !!dispatchBlocked}
              onClick={startDispatch}
              onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-2 rounded-md bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
            >
              {dispatch.isPending && <Loader2 size={13} className="animate-spin" />}
              {/* The count is on the button because the batch is now unbounded and can span pages —
                  "Start 47 investigations" is the last chance to notice it says 47, not 4. */}
              {n <= 1 ? "Start investigation" : `Start ${n} investigations`}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// A prev/next step in the pager — a quiet bordered square that reads as an affordance only on hover,
// so the page controls never compete with the dispatch button for the eye. `title`+`aria-label` carry
// the meaning the chevron alone doesn't.
function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-border/70 text-muted-70 outline-none transition-colors hover:border-border hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
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
          onMouseDown={(e) => e.preventDefault()}
          className={`rounded-md px-3 py-1 text-[12px] font-medium outline-none transition-colors ${
            value === o.value ? "bg-elevated text-fg shadow-sm shadow-black/20" : "text-muted hover:text-fg"
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


// The shared label treatment protects contrast while retaining the API hue in the tint and border.
function LabelChip({ name, color }: { name: string; color: string }) {
  const label = githubLabelColors(color)
  return (
    <span
      className="max-w-[130px] shrink-0 truncate rounded-full border px-1.5 py-px text-[9.5px] leading-[13px]"
      style={{ color: label.foreground, backgroundColor: label.background, borderColor: label.border }}
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
