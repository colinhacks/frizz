// What a restart, an update or an update's download is doing, as the launcher's status carries it to
// the recovery page and to the board (`progress` on /_frizz/control/status). The launcher derives it
// (packages/server/src/boot-view.ts); every surface only lays it out, so the words and numbers on the
// recovery page, the restart overlay and the update button are always the same ones.

/** `start` is a launcher's first boot; `prepare` an update downloading while the old release serves. */
export type BootViewKind = "start" | "restart" | "update" | "prepare"

export interface BootViewStep {
  key: string
  label: string
  /** Set in mono beside the label: "2.1.325". */
  version?: string
  state: "done" | "live" | "stalled" | "todo"
  /** The short reading at the right: "1s", "61%", "on this Mac", "1,240 of 4,880". */
  note?: string
  /** 0..1 when the step has a bar. */
  fraction?: number
  /** The line under the bar: "212 of 348 MB · 480 KB/s · about 5m left". */
  meta?: string
}

export interface BootView {
  kind: BootViewKind
  title: string
  /** How long this restart, update or download has run, measured by the launcher's clock. */
  elapsedMs: number
  steps: BootViewStep[]
  /** Offer "Open Frizz now": a download is slow or stalled and this boot can stop waiting on it. */
  openNow: boolean
  /** Why it is offered, for the copy beside the button. */
  hint?: "slow" | "stalled"
  /** The request was made and the boot has not picked it up yet. */
  opening?: boolean
  /** The runtimes still downloading, by name ("Codex"). */
  downloading?: string[]
  /**
   * The words beside "Open Frizz now", or while the request is being picked up: a bold `lead` and the
   * sentence after it. Composed by the launcher so the recovery page and the board say the same thing.
   */
  callout?: { lead?: string; text: string }
}

/**
 * A runtime still downloading after the board opened without it ("Open Frizz now"), as the status row's
 * chip draws it: the name, the share done, and a short reading ("64% · 3m"); `detail` is the full line
 * for the chip's tooltip.
 */
export interface RuntimeDownloadChip {
  backend: "claude" | "codex"
  name: string
  state: "live" | "stalled"
  /** 0..1 once the download's size is known. */
  fraction?: number
  reading: string
  detail: string
}
