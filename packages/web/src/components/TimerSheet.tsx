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
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

/**
 * A TIMER'S DRAWER (2026-11-12). Its row opened nothing until then, while a shell's and a monitor's each
 * opened theirs (maintainer: "Seems weird that you can open up a shell but not a monitor"), so the one
 * place to read a timer was a tooltip holding its whole prompt.
 *
 * The title is the worker's description — the few words `frizzctl timer set --description` asks for —
 * because the prompt is written to the worker's future self, not to the human. The prompt follows under
 * it, rendered, since it is what the worker will be sent, word for word, when the timer fires.
 *
 * Read from the timer's own row (router `threadTimer`), not the board, so the drawer still reads once the
 * timer has fired or been cancelled: the board lists only armed timers. Read-only, unlike a monitor's
 * drawer: nothing would tell the worker its timer was cancelled under it.
 */
export function TimerSheet({
  id,
  slug,
  timerId,
  label,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  timerId: string
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
  const title = timer?.description || timer?.prompt.split("\n")[0]?.trim() || label
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
            title={title}
            icon={<Clock aria-hidden size={14} className="shrink-0 text-muted-60" />}
            meta={stateLabel ? <span data-timer-state className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-60">{stateLabel}</span> : undefined}
            onClose={close}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">This timer is no longer available.</div>
            ) : (
              <div className="flex flex-col gap-5">
                <section>
                  <h2 className="petite-caps mb-2 text-[10px] text-muted-65">When</h2>
                  <dl data-timer-when className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                    {timer ? (
                      <>
                        <dt className="text-muted-60">{timer.state === "fired" ? "Fired" : timer.state === "cancelled" ? "Was due" : "Fires"}</dt>
                        <dd className="text-fg/85">
                          {clockTime(fireMs, now)}
                          {timer.state === "armed" && fireMs > now ? <span className="text-muted-60"> · in {formatCompactElapsed(fireMs - now)}</span> : null}
                        </dd>
                        <dt className="text-muted-60">Set</dt>
                        <dd className="text-fg/85">{formatAgo(timer.createdAt, now)}</dd>
                        {timer.state === "cancelled" && timer.settledAt ? (
                          <>
                            <dt className="text-muted-60">Cancelled</dt>
                            <dd className="text-fg/85">{formatAgo(timer.settledAt, now)}</dd>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <dd className="col-span-2 text-muted-60">{query.isLoading ? "Loading…" : ""}</dd>
                    )}
                  </dl>
                </section>
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="petite-caps text-[10px] text-muted-65">Prompt</h2>
                    {timer && (
                      <button type="button" onClick={copyPrompt} className="button-outline flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                        <Copy aria-hidden size={11} /> Copy
                      </button>
                    )}
                  </div>
                  <p className="mb-2 text-[11.5px] text-muted-60">
                    {timer?.state === "fired" ? "What the worker was sent when it fired." : "What the worker is sent, word for word, when it fires."}
                  </p>
                  {timer ? (
                    <div data-timer-prompt className={`md-body ${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[13px]`} dangerouslySetInnerHTML={inner} />
                  ) : (
                    <div data-timer-prompt className={`${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[12px] text-muted-60`}>{query.isLoading ? "Loading…" : ""}</div>
                  )}
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}

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
