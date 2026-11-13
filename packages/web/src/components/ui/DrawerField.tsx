import type { ReactElement, ReactNode } from "react"

/** THE ONE LABEL STYLE of a read-only drawer's fields — a timer's Description, Fires and Prompt, a shell's
 *  Command and Output. Sentence case at 12px, medium weight, muted. Until 2026-11-13 these drawers mixed a
 *  10px petite-caps section heading ("WHEN", "PROMPT") with plain muted row labels ("Fires", "Set") under
 *  it, two styles for one job, and petite caps that small read as too small (maintainer: "you should just
 *  have a single style of label … Just have consistency", and "those small cap labels are weirdly too
 *  small"). Change the label here and every drawer follows. */
export const DRAWER_FIELD_LABEL_CLASS = "text-[12px] font-medium text-muted-70"

/** One field: its label, an optional control or reading on the label's line (a Copy button, a check's
 *  "exited 1 · 3m ago"), and the value under it. The label's line is one fixed height whether or not it
 *  carries a control, so every label sits the same distance over its value; a 22px Copy button overhangs
 *  it by a pixel either side rather than pushing its own field's value down. */
export function DrawerField({
  label,
  aside,
  asideAlign = "end",
  children,
  ...rest
}: {
  label: string
  /** Drawn on the label's line: at its far end (a Copy button), or right after it (a reading). */
  aside?: ReactNode
  asideAlign?: "end" | "inline"
  children: ReactNode
} & { [key: `data-${string}`]: string | undefined }): ReactElement {
  return (
    <section {...rest}>
      <div className={`mb-1.5 flex h-5 items-center gap-2 ${asideAlign === "end" ? "justify-between gap-3" : ""}`}>
        <h2 className={DRAWER_FIELD_LABEL_CLASS}>{label}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}
