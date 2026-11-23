/**
 * THE R MENU OVER HTTP — the wire between the `frizz` shell's terminal and the server that draws the menu.
 *
 * The menu that sets up remote access (claiming a frizz.sh name, a tunnel, Tailscale, who is signed in)
 * lived in the shell until 2026-11-23, so a change to its copy, its rows or the claim behind it needed a
 * shell release (plans/shell-release-cadence.md). The server draws it now (remote-setup/), and the shell
 * only forwards keys and writes the screens it is sent. What still happens in the shell is what only the
 * shell can do, asked for as an EFFECT the shell runs and answers: switching the transport the board is
 * served through, minting a sign-in link, and signing devices out, since the sessions, the relay and the
 * public listener are all the shell's.
 *
 * The shell bundles this file, so it holds the route's name and types and nothing that runs: the parsing
 * on each side belongs to that side (remote-setup/route.ts, src/remote-setup-client.ts). A change here is
 * a protocol change, and `REMOTE_SETUP_PROTOCOL` moves with it.
 */

export const REMOTE_SETUP_PROTOCOL = 1

/** Under `/_frizz`, beside the launch route, and gated by the same owner token (launch-routing.ts). */
export const REMOTE_SETUP_PATH = "/control/remote-setup"

/** How a board is reached from outside: what `cloud.json` holds (src/cloud.ts has the meaning of each field). */
export interface RemoteSetupConfig {
  hostname: string
  tunnel?: string
  config?: string
  claim?: string
  serve?: "relay" | "tunnel" | "external"
  provider?: "tailscale" | "other"
  relayAccess?: "full" | "read-and-answer"
}

/** A device signed in to this board, as the Devices section lists it. */
export interface RemoteSetupDevice {
  id: string
  label: string
  createdAt: number
}

/** What only the shell knows, sent with every request, so the menu always draws what is true now. */
export interface RemoteSetupContext {
  /** The board's port, which the tunnel and proxy instructions name. */
  port: number
  /** The terminal's size: the screen is fitted to it and never scrolls. */
  columns: number
  rows: number
  /** The setup in force, or null while the board is on localhost only. */
  current: RemoteSetupConfig | null
  devices: RemoteSetupDevice[]
  /** A `--sandbox` launch, where a claim is still real and the menu says so. */
  sandbox: boolean
}

export type RemoteSetupEvent =
  /** R was pressed: start a menu. The answer names the session every later event carries. */
  | { type: "open" }
  /** One key, raw from the terminal. ^C never arrives: the shell's pane host keeps it. */
  | { type: "key"; key: string }
  /** Answer once the screen is newer than `after`, or after a while with the same one. */
  | { type: "wait"; after: number }
  /** The outcome of an effect the shell ran. */
  | { type: "effect"; id: number; ok: true; value?: unknown }
  | { type: "effect"; id: number; ok: false; error: string }
  /** The shell took the menu down. */
  | { type: "close" }

export interface RemoteSetupRequest {
  protocol: typeof REMOTE_SETUP_PROTOCOL
  /** Absent on `open` alone. */
  session?: string
  event: RemoteSetupEvent
  context: RemoteSetupContext
}

/**
 * What the server asks the shell to do. Each is run once, by id, and answered with an `effect` event:
 * `issue-link` with the link or null, `sign-out` with whether the device was still signed in, and
 * `sign-out-all` with how many were.
 */
export type RemoteSetupEffect =
  /** Serve `config`, or go back to localhost only with null. `justClaimed` skips the renewal a fresh claim just made. */
  | { id: number; kind: "apply"; config: RemoteSetupConfig | null; justClaimed?: boolean }
  /** What a device signed in through the relay may do. */
  | { id: number; kind: "relay-access"; access: "full" | "read-and-answer" }
  | { id: number; kind: "issue-link" }
  | { id: number; kind: "sign-out"; device: string }
  | { id: number; kind: "sign-out-all" }
  /** A name was claimed afresh: sign out the devices signed in under it before (src/cloud.ts, onFreshClaim). */
  | { id: number; kind: "forget-sessions"; hostname: string }

export interface RemoteSetupAnswer {
  protocol: typeof REMOTE_SETUP_PROTOCOL
  session: string
  /** Counts up with every change, so the shell draws only a screen newer than the one it shows. */
  frame: number
  /** The whole screen, fitted to the terminal: the shell clears and writes it. */
  screen: string
  /** The menu is done with the terminal: the shell hands it back to the readout. */
  close?: true
  /** An act for the shell, repeated in every answer until the shell answers it. */
  effect?: RemoteSetupEffect
}
