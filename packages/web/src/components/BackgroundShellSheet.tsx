import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Copy, TerminalSquare } from "lucide-react"
import { showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBackgroundShellOutput } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { elapsedSince } from "../lib/durationLabels.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"
import { CodeBody } from "./CodeBody.tsx"

// Shared by the command block and its no-command fallback so the two cannot drift apart.
const commandBlockClass = `font-mono-keep overflow-x-auto whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-bg/75 px-4 py-2.5 text-[12px] leading-relaxed text-fg/85`

export function BackgroundShellSheet({
  id,
  slug,
  shellId,
  label,
  startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  shellId: string
  label: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const query = useBackgroundShellOutput(slug, shellId)
  const state = query.data?.state
  const command = query.data?.command
  const output = query.data?.output ?? ""
  const [stopping, setStopping] = useState(false)
  const qc = useQueryClient()

  // Follow live output only while the reader remains close to the bottom; inspecting earlier lines
  // must not be interrupted by the next 1.5s poll.
  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 160) element.scrollTop = element.scrollHeight
  }, [output])

  const age = elapsedSince(startedAt)
  const stateLabel = state === "running" ? `running${age ? ` ${age}` : ""}` : state === "done" ? "finished" : state === "gone" ? "unavailable" : ""
  const unavailable = query.isError || state === "gone"

  // KILL THE SHELL FROM THE DRAWER — the surface where a wedged watcher is actually diagnosed. The ops
  // strip's × does the same thing in one click, but you only know a shell is stuck AFTER reading its
  // output, and having to close the drawer to act on what you just read is the gap this closes.
  //
  // `subAgentStop`, not `stopBackgroundOp`: the drawer must not force-retire the row it is rendering.
  // The provider's own terminal task event clears it moments later (measured in
  // server/backend/_live_shell_stop.mts), so the state readout in this header updates on its own.
  function stop() {
    if (stopping) return
    setStopping(true)
    rpc.subAgentStop({ slug, id: shellId })
      .then(({ note }) => {
        // A shell has no subtree, so `note` can only carry the one failure that is specific to it: the
        // process is dead but the WORKER could not be told, and is still waiting on it.
        if (note) showToast(`Background shell stopped. ${note}`, { duration: 7000 })
        else showToast("Background shell stopped — the worker was told")
        void qc.invalidateQueries({ queryKey: ["backgroundShellOutput", slug, shellId] })
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not stop this background shell")
      })
      .finally(() => setStopping(false))
  }

  async function copyCommand() {
    if (!command) return
    try {
      await copyTextToClipboard(command)
      showToast("Command copied")
    } catch {
      showToast("Could not copy command")
    }
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader
            title={label}
            icon={<TerminalSquare aria-hidden size={14} className="shrink-0 text-muted-60" />}
            meta={stateLabel ? <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-60">{stateLabel}</span> : undefined}
            onClose={close}
          />

          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">Background shell output is no longer available.</div>
            ) : (
              // The drawer body is NEVER gated behind a full-height spinner: a slow first fetch (HTTP pool
              // contention on a busy instance) then reads as "stuck rendering forever" behind a context-free
              // spinner, when the truth is simply "no output has arrived yet". Render the structure up front and
              // state the real situation in the output pane — the <pre> itself lays out a full 512 KB in <35ms,
              // so nothing here is slow to render; the wait is always for the data, and we say so.
              <div className="flex flex-col gap-5">
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="petite-caps text-[10px] text-muted-65">Command</h2>
                    {command && (
                      <button type="button" onClick={copyCommand} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                        <Copy aria-hidden size={11} /> Copy
                      </button>
                    )}
                  </div>
                  {/* Highlighted only when there IS a command: the fallbacks below are prose, and
                      painting "Command unavailable for this background operation." in shell grammar
                      would colour a sentence as though it were a script. */}
                  {command ? (
                    <CodeBody data-background-shell-command text={command} language="bash" className={commandBlockClass} />
                  ) : (
                    <pre data-background-shell-command className={commandBlockClass}>{query.isLoading ? "Loading…" : "Command unavailable for this background operation."}</pre>
                  )}
                </section>
                <section>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="petite-caps text-[10px] text-muted-65">Output</h2>
                    {state === "running" && <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="shell-drawer" />}
                    {query.data?.truncated && <span className="text-[10.5px] text-muted-50">Showing latest 512 KB</span>}
                  </div>
                  {output ? (
                    <pre data-background-shell-output className={`font-mono-keep min-h-40 whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[12px] leading-relaxed text-fg/85`}>{output}</pre>
                  ) : (
                    <div data-background-shell-output className={`flex min-h-40 items-center justify-center ${BLOCK_RADIUS} border border-border bg-inset px-4 text-center text-[12px] text-muted-60`}>
                      {state === "done" ? "No output was captured." : "No output yet."}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>

          {/* The lifecycle footer, mirroring SubAgentSheet's exactly — same chrome, same danger-hover,
              same disabled-while-in-flight. It renders only for a shell frizz can really end; a RUNNING
              shell it cannot reach states why instead, because "no control and no explanation" is what
              sent the maintainer looking for this button in the first place. A finished shell carries
              neither (its state readout already says "finished") and keeps the bare bottom edge. */}
          {!unavailable && query.data?.stoppable && (
            <footer
              aria-label="Background shell lifecycle actions"
              data-background-shell-lifecycle-footer
              className="flex min-h-10 w-full shrink-0 items-center justify-end gap-1.5 border-t border-border/70 bg-panel/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[12px] backdrop-blur-sm"
            >
              <button
                type="button"
                data-stop-background-shell
                disabled={stopping}
                onClick={stop}
                className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft disabled:opacity-50"
              >
                {stopping ? "Stopping…" : "Stop shell"}
              </button>
            </footer>
          )}
          {!unavailable && !query.data?.stoppable && state === "running" && query.data?.stopNote && (
            <footer
              data-background-shell-stop-note
              className="w-full shrink-0 border-t border-border/70 bg-panel/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-70"
            >
              {query.data.stopNote}
            </footer>
          )}
        </>
      )}
    </Sheet>
  )
}
