import { createHash } from "node:crypto"
import { isIP } from "node:net"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

// Frizz deliberately binds its control plane to loopback. These are the only browser authorities the
// product serves; DNS names that merely begin with "localhost" and alternate 127/8 spellings are not
// equivalent trust identities. Browser Origin serialization is canonical, so requiring the exact
// serialized origin also rejects paths, credentials, trailing dots, and numeric-IP tricks.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])
/** Every header by which some upstream hop can assert a request's authority. Never trusted as one. */
export const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const

type HeaderValue = string | string[] | undefined

export interface LocalRequestHeaders {
  host?: HeaderValue
  origin?: HeaderValue
  forwarded?: HeaderValue
  "x-forwarded-for"?: HeaderValue
  "x-forwarded-host"?: HeaderValue
  "x-forwarded-port"?: HeaderValue
  "x-forwarded-proto"?: HeaderValue
}

export interface ParsedLocalAuthority {
  /** Loopback by default; an IP literal or an allowed name once the operator exposes the port. */
  hostname: string
  port: number
  authority: string
  /** The scheme a browser reached this authority over. `https` only via `--public-origin`. */
  scheme: "http" | "https"
}

/**
 * Which browser authorities this server answers to.
 *
 * Omitted (or `exposed: false`) is Frizz's historical and default posture: loopback only, because the
 * port is bound to 127.0.0.1 and nothing else can reach it. `--host` deliberately breaks that
 * assumption, so an exposed server has to decide what a legitimate authority looks like without the
 * kernel deciding for it.
 *
 * The rule is Vite's `allowedHosts` rule, and for the same reason: the attack a non-loopback bind
 * newly enables is DNS rebinding, where an attacker's DOMAIN is made to resolve to this machine so a
 * victim's browser treats an attacker page as same-origin with Frizz. That requires a NAME. An IP
 * literal cannot be rebound — the browser never asks a resolver — so every IP literal is accepted and
 * every DNS name must be named explicitly, except the ones this machine is itself known by (see
 * machineHostNames), which the launcher lists on the operator's behalf.
 */
export interface LocalAuthorityPolicy {
  /** True once the bind address is not loopback, which is the only thing that widens the rule. */
  exposed?: boolean
  /** DNS names accepted as this server's authority. `*` accepts any name (opt-in, never a default). */
  allowedHosts?: readonly string[]
  /**
   * The exact serialized origin a reverse proxy fronts this server with (`--public-origin`).
   *
   * This is the ONE thing that admits an `https` authority and a port that is not this server's own,
   * because a proxy terminates TLS on 443 and forwards to a loopback port the browser never sees. It
   * is also the only thing that tolerates `X-Forwarded-*`: those headers are somebody else's claim
   * about who called, and Frizz refuses them until the operator names the somebody.
   */
  publicOrigin?: string
}

/**
 * What every document Frizz serves says about being put inside someone else's page: no.
 *
 * The board is one click from starting work, and it answers on a name a visitor is signed in to. Framed
 * under an invisible page, a tap on what looks like something else lands on the board's own controls,
 * with the visitor's own session (`/?add=` is a prefilled form away from a new project). Both headers,
 * because they cover different browsers and neither costs anything.
 */
export const FRAME_REFUSED_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
} as const

/**
 * The policy a BUILT dashboard document is served with: frames refused as above, and scripts only from
 * this origin plus the document's own inline ones, each named by its hash.
 *
 * Everything an agent, a pull request or a web page writes is drawn in this document, behind one
 * hand-written sanitizer, and script in this origin is `dispatch`: code on the machine. One gap in that
 * sanitizer was found and closed on 2026-11-09 (lib/markdown.ts); this is what stands behind the next
 * one. An inline handler, a `javascript:` URL, an injected `<script>` and `eval` do not run here, and
 * each attempt is a `securitypolicyviolation` the browser reports instead.
 *
 * Scripts and nothing else, on purpose. The built app loads one module graph from `/assets`, writes no
 * inline script but the theme bootstrap in index.html, calls no `eval` and starts no worker, so this
 * costs it nothing. Styles, images, frames and connections are left as they were: Mermaid and the
 * highlighter write inline styles, and how a browser matches a WebSocket against `'self'` has differed
 * between them. Not sent by the Vite dev server, whose own inline scripts change with every edit.
 */
export function documentScriptPolicy(html: string): string {
  const inline: string[] = []
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(script[1]!)) continue
    // The parser hands the browser CR LF as LF, and the hash is of what it was handed.
    inline.push(`'sha256-${createHash("sha256").update(script[2]!.replace(/\r\n?/g, "\n")).digest("base64")}'`)
  }
  return [
    FRAME_REFUSED_HEADERS["content-security-policy"],
    ["script-src 'self'", ...inline].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ")
}

/** The authority `policy.publicOrigin` describes, or null when the operator declared none. */
function publicAuthority(policy: LocalAuthorityPolicy | undefined): ParsedLocalAuthority | null {
  const raw = policy?.publicOrigin
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.origin !== raw) return null
  return {
    hostname: normalizedHostname(url.hostname),
    port: explicitPort(url),
    authority: url.host.toLowerCase(),
    scheme: url.protocol === "https:" ? "https" : "http",
  }
}

/**
 * Would a browser have attached `Sec-Fetch-*` to a request naming this authority?
 *
 * Chrome sends Fetch Metadata only to a POTENTIALLY TRUSTWORTHY origin. `http://127.0.0.1` and
 * `http://localhost` qualify by definition; `http://192.168.1.5` does not. So the moment `--host`
 * puts the board on a LAN address, the whole Sec-Fetch signal silently vanishes — and every route
 * whose missing-Origin rule leans on `Sec-Fetch-Site: same-origin` starts refusing the app's own
 * reads. Measured in Chrome 151: a same-origin `GET /rpc/board` from the LAN page carried neither an
 * `origin` nor a `sec-fetch-site` header, while the identical page on loopback carried both.
 */
export function authoritySendsFetchMetadata(authority: ParsedLocalAuthority): boolean {
  // A proxy that terminates TLS hands the browser a genuinely secure origin, so the signal comes back.
  return LOCAL_HOSTNAMES.has(authority.hostname) || authority.scheme === "https"
}

function acceptsHostname(hostname: string, policy: LocalAuthorityPolicy | undefined): boolean {
  if (LOCAL_HOSTNAMES.has(hostname)) return true
  if (!policy?.exposed) return false
  // An IP literal is unrebindable, so the numeric address of any interface this server is bound to
  // (and, harmlessly, any other) is a legitimate authority the moment the operator exposes the port.
  if (isIP(hostname) !== 0) return true
  return (policy.allowedHosts ?? []).some((allowed) => allowed === "*" || allowed.toLowerCase() === hostname)
}

function oneHeader(value: HeaderValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower
}

function explicitPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

function validExpectedPort(port: number | undefined): port is number {
  return Number.isInteger(port) && port! >= 1 && port! <= 65_535
}

/** Parse the browser's serialized Origin, accepting only authorities `policy` admits for this port. */
export function parseLocalHttpOrigin(
  value: HeaderValue,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim()) return null
  // The declared proxy origin is matched whole, against the string the operator configured. That
  // exact comparison is the entire check: it is already a serialized origin, so nothing about its
  // scheme, port, or spelling is inferred here.
  const declared = publicAuthority(policy)
  if (declared && raw === policy?.publicOrigin) return declared
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // Origin is defined as a serialized origin, not an arbitrary URL. This exact comparison rejects a
  // trailing slash/path, case-normalization trick, userinfo, an explicit default port, or IP shorthand.
  if (url.protocol !== "http:" || url.origin !== raw) return null
  const hostname = normalizedHostname(url.hostname)
  if (!acceptsHostname(hostname, policy) || explicitPort(url) !== expectedPort) return null
  return { hostname, port: expectedPort, authority: url.host, scheme: "http" }
}

/** Parse an HTTP Host authority independently of Origin; forwarded headers are never authority here. */
export function parseLocalHost(
  value: HeaderValue,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim() || raw.includes(",")) return null
  let url: URL
  try {
    url = new URL(`http://${raw}`)
  } catch {
    return null
  }
  // Host is an authority only. URL parsing plus the exact host comparison prevents userinfo, paths,
  // encoded separators and canonicalized numeric aliases from becoming a trusted local host.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
  if (url.host.toLowerCase() !== raw.toLowerCase()) return null
  const hostname = normalizedHostname(url.hostname)
  // A proxied request names the PROXY's authority, not this server's. `expectedPort` is meaningless
  // for it — the browser reached 443 and cloudflared forwards the original Host verbatim, so the
  // port is either absent (the scheme default) or the proxy's own. Never this server's loopback port.
  const declared = publicAuthority(policy)
  if (declared && hostname === declared.hostname) {
    return url.port === "" || Number(url.port) === declared.port ? declared : null
  }
  if (!acceptsHostname(hostname, policy) || explicitPort(url) !== expectedPort) return null
  return { hostname, port: expectedPort, authority: url.host.toLowerCase(), scheme: "http" }
}

/**
 * The DNS name a refused Host was asking for, when that name is the ONLY thing wrong with it.
 *
 * `--host` puts the board on the LAN, the operator opens it by the machine's name, and what came back
 * was a bare 403 — nothing said the name is refused on purpose or that `--allowed-host` exists, so
 * they fell back to the IP and guessed ("it seems to filter by hostname?", reported 2026-08-24). This
 * is what lets the refusal say so. Narrow on purpose: null unless the board is exposed and the Host is
 * well formed, on this server's port, and a name that merely is not listed. A loopback-only board, an
 * IP literal, a port alias or any other malformation keeps the wordless refusal — none of those is an
 * operator typing a hostname, and the explanation would only tell a probe what lives here.
 */
export function unlistedHostName(
  value: HeaderValue,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): string | null {
  if (!policy?.exposed || parseLocalHost(value, expectedPort, policy)) return null
  const asIfAllowed = parseLocalHost(value, expectedPort, { ...policy, allowedHosts: ["*"] })
  return asIfAllowed && isIP(asIfAllowed.hostname) === 0 ? asIfAllowed.hostname : null
}

function hasForwardedAuthority(headers: LocalRequestHeaders): boolean {
  return FORWARDED_HEADERS.some((name) => headers[name] !== undefined)
}

/**
 * May this request carry `X-Forwarded-*` at all?
 *
 * Those headers are someone else's assertion about who called, and Frizz's default answer is no —
 * it does not run behind a trusted proxy, so their presence is a laundering attempt. `--public-origin`
 * changes the answer for exactly the requests that ARRIVED as that origin. A caller who reaches the
 * loopback port directly and merely *claims* the proxy's authority still fails the Host check above,
 * so naming a proxy never lets an unproxied request forge one.
 */
function forwardedAuthorityAllowed(
  headers: LocalRequestHeaders,
  host: ParsedLocalAuthority,
  policy: LocalAuthorityPolicy | undefined,
): boolean {
  if (!hasForwardedAuthority(headers)) return true
  const declared = publicAuthority(policy)
  return !!declared && declared.hostname === host.hostname
}

/**
 * HTTP policy: Host must be this exact loopback server and any PRESENT Origin must name the SAME
 * canonical loopback hostname + actual port. Treating localhost, 127.0.0.1, and ::1 as interchangeable
 * would let an unrelated service bound to another loopback family on the same numeric port become an
 * authorized browser origin. Callers must explicitly opt a route/request into missing Origin compatibility
 * (the app does so for the read-only CLI health probe and browser-forbidden `Sec-Fetch-Site: same-origin`
 * requests); it is never accepted by the WebSocket policy below.
 */
export function isTrustedLocalHttpRequest(
  headers: LocalRequestHeaders,
  expectedPort: number,
  allowMissingOrigin = false,
  policy?: LocalAuthorityPolicy,
): boolean {
  const host = parseLocalHost(headers.host, expectedPort, policy)
  if (!host) return false
  if (!forwardedAuthorityAllowed(headers, host, policy)) return false
  if (headers.origin === undefined) return allowMissingOrigin
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort, policy)
  return !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Return the exact origin for CORS reflection, or undefined for every non-local/prefix/port trick. */
export function allowedLocalCorsOrigin(
  origin: string,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): string | undefined {
  return parseLocalHttpOrigin(origin, expectedPort, policy) ? origin : undefined
}

/**
 * Browser WebSockets are privileged control channels, so they require an Origin and it must be the
 * SAME canonical loopback host+port as the actual Host header. The socket's local port is authoritative;
 * Host and all forwarded claims are untrusted input. There is intentionally no production no-Origin
 * exception—non-browser test/CLI clients must send the same explicit Origin a browser would.
 */
export function isTrustedLocalWebSocketRequest(
  req: IncomingMessage,
  expectedPort = req.socket.localPort,
  policy?: LocalAuthorityPolicy,
): boolean {
  if (!validExpectedPort(expectedPort)) return false
  const headers = req.headers as LocalRequestHeaders
  const host = parseLocalHost(headers.host, expectedPort, policy)
  if (!host || !forwardedAuthorityAllowed(headers, host, policy)) return false
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort, policy)
  return !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Frizz's default bind address. Nothing off this machine can reach a port bound here. */
export const LOOPBACK_BIND_HOST = "127.0.0.1"
/** What a bare `--host` means, matching Vite, Next, and every other dev server: every interface. */
export const ALL_INTERFACES_BIND_HOST = "0.0.0.0"

// Bind addresses that are still private to this machine. `::` and `0.0.0.0` are wildcards and are
// emphatically NOT here — a wildcard bind reaches every interface, which is the whole point of --host.
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"])

/**
 * Validate an operator-supplied `--host` / `FRIZZ_HOST` value and canonicalize it for `listen()`.
 *
 * Deliberately narrow: an IP literal or one of the loopback spellings. A DNS name is rejected rather
 * than resolved, because `listen()` would silently pick one A record and the operator would have no
 * way to see which interface they actually exposed.
 */
export function normalizeBindHost(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("--host requires an address")
  const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const lower = bare.toLowerCase()
  if (lower === "localhost") return LOOPBACK_BIND_HOST
  if (isIP(bare) === 0) {
    throw new Error(`invalid --host address: ${value} (use an IP address such as 0.0.0.0, :: or 127.0.0.1)`)
  }
  return bare
}

/** Does binding here put Frizz on a network any other machine can reach? */
export function bindHostIsExposed(host: string): boolean {
  return !LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase())
}

/**
 * Validate an operator-supplied `--public-origin` / `FRIZZ_PUBLIC_ORIGIN` value and canonicalize it.
 *
 * Deliberately an ORIGIN and not a URL. A path, a query, or a trailing slash means the operator has
 * pasted something the browser will never send as `Origin`, and the failure that produces is a blanket
 * 403 with no explanation — far better to reject it at launch, where the message can say why.
 */
export function normalizePublicOrigin(value: string): string {
  const trimmed = value.trim()
  const invalid = (why: string) => new Error(`invalid --public-origin: ${value} (${why})`)
  if (!trimmed) throw new Error("--public-origin requires a URL")
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw invalid("use a full URL such as https://frizz.example.com")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("only http and https are supported")
  if (url.username || url.password) throw invalid("an origin carries no credentials")
  if (url.pathname !== "/" || url.search || url.hash) throw invalid("an origin is a scheme and host only, with no path")
  if (!url.hostname) throw invalid("no hostname")
  return url.origin
}

/**
 * The names this machine is itself known by, which an exposed board accepts without being told.
 *
 * `--host` and then `http://pupper:9393/` is what a person expects to work, and until 2026-08-24 it
 * did not: the machine's own hostname was refused like any other DNS name, and the operator fell back
 * to the IP and guessed. It is safe to accept because the rebinding threat needs a name the ATTACKER
 * controls, and nobody outside this network controls these: a single-label hostname and an mDNS
 * `.local` name are answered by the LAN's own resolver, never by public DNS, and whoever runs that
 * resolver is already on the network the board is open to by IP. What stays out, deliberately: any
 * SUFFIX of the hostname (`pupper.evil.com` is the attacker's name), and any name that merely
 * resolves to one of our interfaces (that is exactly the state a rebinding attack creates).
 *
 * From `os.hostname()`, which is `pupper` on a typical Linux box and `Colins-MacBook-Pro.local` on a
 * Mac: the name as given, its first label, and that label under `.local` — deduped, lowercased.
 */
export function machineHostNames(hostname: string): string[] {
  const full = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!full || full === "localhost" || isIP(full) !== 0) return []
  const short = full.split(".")[0]!
  return [...new Set([full, short, `${short}.local`])].filter((name) => name !== "localhost" && name !== "localhost.local")
}

/** Parse `--allowed-host a --allowed-host b` / `FRIZZ_ALLOWED_HOSTS=a,b` into a deduped lowercase list. */
export function normalizeAllowedHosts(values: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    for (const entry of value.split(",")) {
      const host = entry.trim().toLowerCase()
      if (host) seen.add(host)
    }
  }
  return [...seen]
}

/** Claim a sensitive upgrade with a small explicit denial instead of letting another WS router try it. */
export function rejectWebSocketUpgrade(socket: Duplex, status = 403, reason = "Forbidden"): void {
  const body = `${reason}\n`
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n")
  try {
    socket.end(response)
  } catch {
    try {
      socket.destroy()
    } catch {
      // The peer already disappeared while the policy rejected it.
    }
  }
}
