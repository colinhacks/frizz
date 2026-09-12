import { useMutation } from "@tanstack/react-query"
import { Loader2, RotateCw } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { aiRenameAvailability } from "../lib/threadTitle.ts"
import { Tooltip } from "./Tooltip.tsx"

// RE-TITLE THIS THREAD FROM ITS OPENING REQUEST — the small refresh mark that appears to the right of
// a thread's title when you point at it. Rendered by the thread header (ChatView) and by the queue
// card's header (TodosView) from this ONE component, so the two surfaces cannot drift; the queue used
// to have no rename affordance at all (maintainer 2026-08-26: "it should show up in the cue card, in
// addition to showing up in the drawer").
//
// A RELOAD MARK, NOT SPARKLES, and REVEALED ON HOVER rather than always drawn (same maintainer, same
// day: "it should be a reload icon, not the sparkles icon for refreshing the title… it should not
// always be visible"). The sparkle said "AI did something here", which is not the question the operator
// has — they want the title recomputed, and that is a refresh. `RotateCw` rather than the `RefreshCw`
// the Restart worker verb wears: the two now sit in the same header bar, and one glyph must not mean
// both "regenerate this name" and "replace this process".
//
// `opacity`, never `hidden`: a control removed from the layout cannot be tabbed to, and it would also
// make the title jump sideways as the pointer arrives. It stays revealed while the request is in
// flight and while an error is still being shown, so the spinner and the failure do not vanish the
// instant the pointer leaves.
//
// EVERY CLICK ANSWERS. Where the verb genuinely cannot run — no live daemon to ask — the click says so
// in a toast instead of doing nothing at all, which is what the old gate did on every running thread.
export function AiRenameButton({ thread, hidden = false }: { thread: ThreadView; hidden?: boolean }) {
  const rename = useMutation({
    mutationFn: () => rpc.aiRenameThread({ slug: thread.id }),
    onSuccess: ({ title }) => showToast(`Renamed to “${title}”`),
    onError: (error) => showToast(error instanceof Error ? error.message : "Could not rename with Claude", { duration: 7000 }),
  })
  const availability = aiRenameAvailability(thread)
  if (!availability.show || hidden) return null
  const label = rename.isPending
    ? "Claude is generating a title…"
    : rename.error instanceof Error
      ? rename.error.message
      : availability.label
  // Revealed by the hover of whichever ancestor claims the title row — `group/thread-title` in
  // ChatView's header and in the queue card's. Named, because both of those rows sit inside other
  // groups that mean other things.
  const revealed = rename.isPending || !!rename.error
  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-ai-rename
        aria-label={rename.isPending ? "Renaming with Claude" : availability.label}
        aria-busy={rename.isPending}
        // aria-disabled, not the native attribute: the reason has to stay focusable and hoverable, and
        // the click below is what states it.
        aria-disabled={!availability.enabled}
        // Focus must not leave a card's composer, exactly as every other icon verb here.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (rename.isPending) return
          if (!availability.enabled) {
            showToast(availability.label)
            return
          }
          rename.reset()
          rename.mutate()
        }}
        // `-mx-[7px]` is the ink trim, and it is what makes the row's `gap-2` mean 8px of INK rather
        // than 8px of box: `RotateCw` paints 10 of the 12 box px it draws at, inside a 24px hover
        // square, so this mark carries 7px of dead space a side. Untrimmed, `gap-1` measured 11.22px
        // of clear space to the title — wide enough that the mark floated free of the name it belongs
        // to, which is the failure the transcript chevron was fixed for (lib/transcriptMetaLabels.ts).
        // Trimmed, it reads as the title's own handle at 8.22px, the distance that pairing already
        // uses. The trim overlaps the hover square 7px into the title's box; only one of the two can
        // paint a fill at a time and this element is later in the DOM, so it wins the pointer there.
        //
        // `title-refresh-offset` is the vertical half — a font-keyed nudge, because this mark rides
        // 0.72px HIGH under system-ui and 1.29px LOW under the mono stack (styles.css has the readings).
        //
        // `-my-3` is the vertical trim, and it is what keeps the 24px hover square from GROWING the
        // title row it rides on: a margin box of zero height contributes nothing to the row, and
        // `items-center` still centres the square on the title's own line box. Without it the row was
        // 24px tall against a 15px title's 18.75px line (leading-tight) — which pushed the "Last active"
        // line 2.6px down in the thread header and made that header 52.75px beside a 48px file viewer
        // (2026-09-03, "headers should have consistent height"), and grew the queue card's title row by
        // 3.4px the same way. The square now overhangs the line by ~2.6px a side, into empty band.
        className={`title-refresh-offset -mx-[7px] -my-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-[color,background-color,opacity] focus-visible:opacity-100 group-hover/thread-title:opacity-100 ${
          revealed ? "opacity-100" : "opacity-0"
        } ${
          rename.error
            ? "text-danger hover:bg-danger-fill/10"
            : availability.enabled
              ? "text-muted hover:bg-panel-2 hover:text-fg"
              : "cursor-not-allowed text-muted-50 hover:bg-panel-2"
        }`}
      >
        {rename.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
      </button>
    </Tooltip>
  )
}
