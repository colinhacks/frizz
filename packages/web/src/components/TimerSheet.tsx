import { Clock, Copy } from "lucide-react"
import { showToast } from "../store.ts"
import { useThreadTimer } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { formatAgo, formatCompactElapsed } from "../lib/durationLabels.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { DrawerField } from "./ui/DrawerField.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

/**
 * A TIMER'S DRAWER (2026-11-12). Its row opened nothing until then, while a shell's and a monitor's each
 * opened theirs (maintainer: "Seems weird that you can open up a shell but not a monitor"), so the one
 * place to read a timer was a tooltip holding its whole prompt.
 *
 * One field after another, each under the same label (ui/DrawerField): the worker's Description first —
 * the few words `frizzctl timer set --description` asks for, written for the human — then when it Fires
 * and was Set, then the Prompt, rendered, which is written to the worker's future self and sent to it
 * word for word. The header names the kind and reads the countdown, so the description is not drawn
 * twice (maintainer 2026-11-13, of a header-titled first version: "Description should probably be first").
 *
 * Read from the timer's own row (router `threadTimer`), not the board, so the drawer still reads once the
 * timer has fired or been cancelled: the board lists only armed timers. Read-only, unlike a monitor's
 * drawer: nothing would tell the worker its timer was cancelled under it.
 */
export function TimerSheet({
  id,
  slug,
  timerId,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  timerId: string
  /** The row's label, kept by the drawer stack to name the drawer; the body reads the timer itself. */
  label: string
  depth: number
  widthDepth: number
}) {
  const query = useThreadTimer(slug, timerId)
  const timer = query.data
  const now = useNowMs()
  const html = useMarkdownHtml(timer?.prompt ?? "")
  const inner = useInnerHtml(html)

  const fireMs = Date.parse(timer?.fireAt ?? "")
  const stateLabel = !timer
    ? ""
    : timer.state === "armed"
      ? fireMs > now ? `in ${formatCompactElapsed(fireMs - now)}` : "firing…"
      : timer.state === "fired"
        ? `fired ${formatAgo(timer.settledAt ?? timer.fireAt, now)}`
        : "cancelled"
  const unavailable = query.isError || timer === null

  async function copyPrompt() {
    if (!timer) return
    try {
      await copyTextToClipboard(timer.prompt)
      showToast("Prompt copied")
    } catch {
      showToast("Could not copy the prompt")
    }
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader
            title="Timer"
            icon={<Clock aria-hidden size={14} className="shrink-0 text-muted-60" />}
            meta={stateLabel ? <span data-timer-state className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-60">{stateLabel}</span> : undefined}
            onClose={close}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">This timer is no longer available.</div>
            ) : (
              <div className="flex flex-col gap-6">
                {timer?.description && (
                  <DrawerField label="Description">
                    <p data-timer-description className="text-[14px] leading-relaxed text-fg">{timer.description}</p>
                  </DrawerField>
                )}
                <div data-timer-when className="flex flex-wrap gap-x-12 gap-y-6">
                  {timer ? (
                    <>
                      <DrawerField label={timer.state === "fired" ? "Fired" : timer.state === "cancelled" ? "Was due" : "Fires"}>
                        <p className={READING_CLASS}>{clockTime(fireMs, now)}</p>
                      </DrawerField>
                      <DrawerField label="Set">
                        <p className={READING_CLASS}>{formatAgo(timer.createdAt, now)}</p>
                      </DrawerField>
                      {timer.state === "cancelled" && timer.settledAt ? (
                        <DrawerField label="Cancelled">
                          <p className={READING_CLASS}>{formatAgo(timer.settledAt, now)}</p>
                        </DrawerField>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[13px] text-muted-60">{query.isLoading ? "Loading…" : ""}</p>
                  )}
                </div>
                <DrawerField
                  label="Prompt"
                  aside={timer && (
                    <button type="button" onClick={copyPrompt} className="button-outline flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                      <Copy aria-hidden size={11} /> Copy
                    </button>
                  )}
                >
                  {timer ? (
                    <div data-timer-prompt className={`md-body ${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[13px]`} dangerouslySetInnerHTML={inner} />
                  ) : (
                    <div data-timer-prompt className={`${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[12px] text-muted-60`}>{query.isLoading ? "Loading…" : ""}</div>
                  )}
                </DrawerField>
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}

// A reading under a field label: when it fires, when it was set.
const READING_CLASS = "text-[13px] text-fg/85"

/** "3:45 PM" today, "Fri 3:45 PM" within the week, "Nov 20, 3:45 PM" past that — in the reader's locale. */
function clockTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return ""
  const at = new Date(ms)
  const sameDay = at.toDateString() === new Date(now).toDateString()
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (sameDay) return `today at ${time}`
  if (Math.abs(ms - now) < 6 * 24 * 60 * 60_000) return `${at.toLocaleDateString(undefined, { weekday: "short" })} at ${time}`
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`
}
