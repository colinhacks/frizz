import * as RadixDialog from "@radix-ui/react-dialog"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useNavigate } from "react-router"
import { rpc } from "../api/rpc.ts"
import { projectHref } from "../lib/base-path.ts"
import { Z_DIALOG } from "../lib/layers.ts"

/**
 * ADD A PROJECT BY TYPING ITS FOLDER. The fallback, not the front door: it opens when the machine has
 * no folder picker, when the picker failed and said why, when the page is on another machine than the
 * picker would open on (server router `pickerOnAnotherScreen`), or when the launcher proposes a folder.
 *
 * One dialog for both places that add a project, the grid's tile and the rail's dotted square. The rail
 * used to send its operator to the grid instead, which showed nothing there: the grid opens this only
 * for its own click, and with the Console kept as home the grid was not even where they landed.
 */
export function AddProjectDialog({
  reason,
  proposed,
  onClose,
}: {
  reason?: string
  /** A directory `frizz` was just run in. Pre-filled, never pre-registered. */
  proposed?: string
  onClose: () => void
}) {
  const [path, setPath] = useState(proposed ?? "")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const add = useMutation({
    mutationFn: (input: string) => rpc.projectAdd({ path: input }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // Adding a project is only ever a step towards opening it. `navigate`, not location.assign:
      // the rail is already showing and must not be torn down to open what was just added.
      navigate(projectHref(project.slug))
      // The grid goes with the navigation and takes this with it. The rail stays, so it is told.
      onClose()
    },
  })
  const error = add.error instanceof Error ? add.error.message : add.error ? String(add.error) : null

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open && !add.isPending) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={`fixed inset-0 ${Z_DIALOG} bg-scrim-30 backdrop-blur-md backdrop-saturate-150`} />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 ${Z_DIALOG} w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none`}
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">
            {proposed ? "Add this folder as a project?" : "Add a project"}
          </RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            {proposed
              ? "You ran Frizz here and it is not a project yet. Nothing has been written — adding it is what creates its board."
              : reason
                ? `${reason}. Paste the folder instead — Frizz walks up to the repository root, the same way it does when you run it in a terminal.`
                : "Paste the folder you want a board for. Frizz walks up to the repository root, the same way it does when you run it in a terminal."}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!add.isPending) add.mutate(path)
            }}
          >
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="~/code/my-project"
              spellCheck={false}
              className={`w-full rounded-md border bg-bg px-2.5 py-2 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
                error ? "border-danger-fill/60" : "border-border-strong"
              }`}
            />
            {error ? <p className="mt-1.5 text-[11.5px] text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={add.isPending}
                className="rounded-md border border-border-strong bg-elevated px-3 py-1.5 text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
              >
                {proposed ? "Not now" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={add.isPending || path.trim().length === 0}
                className="rounded-md border border-accent bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
              >
                {add.isPending ? "Adding…" : proposed ? "Add it" : "Add project"}
              </button>
            </div>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
