import { claimNameIsValid, isAnonymousClaimName } from "@frizz/shared/claim"
import { githubCredentialStatus } from "../github-credential.ts"
import type { RemoteSetupConfig } from "../remote-setup-protocol.ts"

/**
 * What the R menu needs to know about a setup, the server's copy.
 *
 * The shell keeps its own (src/cloud.ts, src/github-claim-identity.ts) for what it still does itself —
 * serving a setup, renewing a claim's lease — and for the menu it draws when the server is older than
 * the remote-setup route. Those are frozen as far as the menu goes; a change to what the menu says or
 * offers is made here, and ships in a server release.
 */

export type CloudConfig = RemoteSetupConfig

/** The zone Frizz's own registrar hands names out in. */
export const CLAIM_ZONE = "frizz.sh"

/** A config Frizz serves by knowing the origin alone — nothing to start, nothing to renew. */
export function isExternalConfig(config: CloudConfig): boolean {
  return config.serve === "external"
}

/** A claimed name; its presence is what marks a registrar-issued name. */
export function isClaimedConfig(config: CloudConfig): boolean {
  return typeof config.claim === "string" && config.claim.length > 0
}

/** Served through the relay rather than a tunnel of its own. */
export function isRelayConfig(config: CloudConfig): boolean {
  return isClaimedConfig(config) && config.serve === "relay"
}

/** The readout's name for how a board is reached, next to its public address. */
export function describeCloudConfig(config: CloudConfig): string {
  if (isClaimedConfig(config)) return "frizz.sh"
  if (isExternalConfig(config)) return config.provider === "tailscale" ? "Tailscale" : "your proxy"
  return "Cloudflare Tunnel"
}

/**
 * Are custom names (`colinhacks.frizz.sh`, bound to a GitHub account) offered? Yes since 2026-11-12;
 * src/cloud.ts's CUSTOM_NAMES_OFFERED has the history. `FRIZZ_CUSTOM_NAMES=0` withdraws them for one
 * process and `FRIZZ_CUSTOM_NAMES=1` offers them.
 */
export const CUSTOM_NAMES_OFFERED = true

export function customNamesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FRIZZ_CUSTOM_NAMES === "0") return false
  return CUSTOM_NAMES_OFFERED || env.FRIZZ_CUSTOM_NAMES === "1"
}

/** Why a word is refused while custom names are withdrawn. */
export const CUSTOM_NAMES_PAUSED =
  "custom frizz.sh subdomains are paused for now — choose a random subdomain (no account needed), or a tunnel you run"

/** Strip a scheme, path or trailing dot someone pastes in, so `https://x.dev/` and `x.dev` both work. */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "")
  if (!trimmed || !trimmed.includes(".")) {
    throw new Error(`invalid hostname: ${raw} (expected something like colin.frizz.sh)`)
  }
  return trimmed.toLowerCase()
}

/**
 * The GitHub login of Frizz's App sign-in, or null. Null too for a pasted token or the
 * FRIZZ_GITHUB_TOKEN override, which cannot claim a name, so the menu never offers one. Local, no network.
 */
export function frizzGithubLogin(): string | null {
  const status = githubCredentialStatus()
  return status.signedIn && status.source === "app" ? status.login : null
}

/**
 * That login as a frizz.sh name, when it makes one: lowercased, and null where it is not a usable name
 * (too short, reserved) or has the random-name shape, which would claim with no account at all.
 */
export function claimNameForLogin(login: string | null): string | null {
  if (!login) return null
  const name = login.toLowerCase()
  return claimNameIsValid(name) && !isAnonymousClaimName(name) ? name : null
}
