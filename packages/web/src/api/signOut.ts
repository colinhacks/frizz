import type { FrizzSupervisorStatus } from "./restart.ts"
import { navigate } from "../lib/navigation.ts"

// ── "Sign out this device" ─────────────────────────────────────────────────────────────────────────────
// Ends the remote-access session of the browser that asks, and no other. The supervisor reads the id
// out of this request's own session cookie, so there is nothing here to name another device with — and
// there must not be: signing out OTHER devices is `frizz --sign-out` on the host, loopback only, so a
// stolen phone cannot evict the laptop (docs/remote-access.md).

export const SIGN_OUT_THIS_DEVICE_PATH = "/_frizz/control/sign-out"

/** Mirrors SignOutThisDeviceResult in packages/server/src/restart-supervisor.ts. */
export type SignOutThisDeviceResult =
  | { protocol: 1; result: "signed-out"; id: string }
  | { protocol: 1; result: "cookie-cleared" }
  | { protocol: 1; result: "no-remote-session" }

/**
 * Is this page on a remote session it could sign out? Strict, like isDevFrizzBuild: an unreachable
 * supervisor, one that predates the field, and the operator's own loopback tab all read "no".
 */
export function isRemoteSession(status: FrizzSupervisorStatus | null | undefined): boolean {
  return status?.remoteSession === true
}

/**
 * Has this browser stopped holding a session, so the next navigation lands on the sign-in page?
 *
 * `no-remote-session` from the TUNNEL (401) means the cookie was already dead — signed out from another
 * tab, or with `--sign-out` — which is the state the row was asking for. From loopback (200) it means
 * there never was one, and a caller that expected to end a session should say so rather than navigate.
 */
export function signedOutOutcome(status: number, body: SignOutThisDeviceResult): boolean {
  if (body.result === "signed-out" || body.result === "cookie-cleared") return true
  return status === 401
}

export async function signOutThisDevice(fetcher: typeof fetch = fetch): Promise<{ signedOut: boolean; result: SignOutThisDeviceResult }> {
  const response = await fetcher(SIGN_OUT_THIS_DEVICE_PATH, {
    method: "POST",
    headers: { "cache-control": "no-store" },
    // Explicit, though same-origin is fetch's default: the Set-Cookie that clears the session must be
    // honoured, and the request must carry the cookie it is ending.
    credentials: "same-origin",
  })
  let body: SignOutThisDeviceResult | undefined
  try {
    body = await response.json() as SignOutThisDeviceResult
  } catch {
    // An older supervisor, or `pnpm dev` with none, answers HTML or 404.
  }
  const known = body?.protocol === 1
    && (body.result === "signed-out" || body.result === "cookie-cleared" || body.result === "no-remote-session")
  if (!known || !body) throw new Error("This Frizz cannot sign a device out from the browser")
  return { signedOut: signedOutOutcome(response.status, body), result: body }
}

/**
 * Where a signed-out browser goes: the root, which the supervisor now answers with the same
 * "needs a current access link" page any visitor without a session gets. `replace`, so Back cannot
 * return to a board this browser can no longer load.
 */
export function leaveAfterSignOut(go: typeof navigate = navigate): void {
  go("/", { replace: true, reason: "this device signed out" })
}
