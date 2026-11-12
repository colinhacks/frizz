/**
 * What crosses the relay between a visitor and a board, beyond the bytes themselves.
 *
 * A NAME CAN CHANGE HANDS, AND THE BROWSER DOES NOT KNOW. `ada.frizz.sh` is one origin to a phone whoever's
 * board serves it, so anything the phone keeps for that origin outlives the board that gave it: a cached
 * script, a validator, a cookie scoped wider than the name. The security review of 2026-11-11 (finding 2b)
 * ran the attack in the headless shell: a board that held a name for a while served `/assets/index-<hash>.js`
 * with its own script and a year's `immutable`, the name moved to another key, the real board's page asked
 * for that file, and the browser ran the first board's copy beside a live session. The file name is public
 * (it is in the npm tarball), and so is the ETag Frizz gives it (size and mtime), so a revalidation alone
 * would have been answered 304 and kept the copy. `Clear-Site-Data: "cache"` did not evict it.
 *
 * The relay sees every board's answers, so it is the one place this can be fixed for every board at once:
 *
 * - Every answer is revalidated before use: `cache-control: no-cache`, unless the board said `no-store`.
 * - Every validator is the answering board's KEY'S: an ETag goes out prefixed with a tag of the key, and an
 *   `If-None-Match` comes back to the board only for tags of the key now serving. A copy cached from
 *   another key is never revalidated, so the board answers it in full and it is replaced.
 * - Dates are no validator: `Last-Modified` goes, and so does every `If-Modified-Since`, which a previous
 *   holder could have pinned in the future.
 * - Nothing reaches past the name: a cookie's `Domain` goes (frizz.sh is not on the Public Suffix List, so a
 *   `Domain=frizz.sh` cookie rode to every board, and six large ones locked a visitor out of all of them with
 *   431s), and so does `Clear-Site-Data` for cookies, which clears the whole registrable domain.
 *
 * What it costs: a reload asks the board once per asset, through the relay, and is answered 304 with no body.
 */

/** The request and response header names the relay sets between the Worker and the Durable Object. Never a visitor's. */
export const OWNER_HEADER = "x-frizz-relay-owner"
export const ISSUED_HEADER = "x-frizz-relay-issued"

/** A short, stable tag of a key: enough that two keys never share one, and valid inside an ETag. */
export function keyTagOf(pubkey: string): string {
  return pubkey.slice(0, 16)
}

const CONDITIONAL_BY_DATE = new Set(["if-modified-since", "if-unmodified-since", "if-range"])
const INTERNAL = new Set([OWNER_HEADER, ISSUED_HEADER])

/** A visitor's request headers as the board should see them. */
export function headersForBoard(headers: Array<[string, string]>, keyTag: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (INTERNAL.has(lower) || CONDITIONAL_BY_DATE.has(lower)) continue
    if (lower === "if-none-match" || lower === "if-match") {
      const kept = unwrapTags(value, keyTag)
      if (kept) out.push([name, kept])
      continue
    }
    out.push([name, value])
  }
  return out
}

/** A board's response headers as the visitor should see them. */
export function headersForVisitor(headers: Array<[string, string]>, keyTag: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let cacheControl: string | null = null
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (lower === "cache-control") {
      cacheControl = cacheControl === null ? value : `${cacheControl}, ${value}`
      continue
    }
    if (lower === "expires" || lower === "last-modified" || lower === "service-worker-allowed") continue
    if (lower === "etag") {
      const tagged = wrapTag(value, keyTag)
      if (tagged) out.push([name, tagged])
      continue
    }
    if (lower === "set-cookie") {
      out.push([name, withoutDomain(value)])
      continue
    }
    if (lower === "clear-site-data") {
      const kept = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !/^"(cookies|\*)"$/i.test(part))
      if (kept.length) out.push([name, kept.join(", ")])
      continue
    }
    out.push([name, value])
  }
  out.push(["cache-control", cacheControl !== null && /(^|[,\s])no-store([,\s]|$)/i.test(cacheControl) ? cacheControl : "no-cache"])
  return out
}

/** `"abc"` → `"<tag>.abc"`, keeping `W/`. Null for something that is not an entity tag. */
function wrapTag(value: string, keyTag: string): string | null {
  const match = /^\s*(W\/)?"([^"]*)"\s*$/.exec(value)
  if (!match) return null
  return `${match[1] ?? ""}"${keyTag}.${match[2]}"`
}

/** The tags in an `If-None-Match` list that this key wrapped, unwrapped; `*` stays. Empty when none is left. */
function unwrapTags(value: string, keyTag: string): string {
  if (value.trim() === "*") return "*"
  const kept: string[] = []
  for (const match of value.matchAll(/(W\/)?"([^"]*)"/g)) {
    const inner = match[2]!
    if (inner.startsWith(`${keyTag}.`)) kept.push(`${match[1] ?? ""}"${inner.slice(keyTag.length + 1)}"`)
  }
  return kept.join(", ")
}

/** A `Set-Cookie` with any `Domain` attribute removed, so the cookie stays on this one name. */
function withoutDomain(value: string): string {
  return value
    .split(";")
    .filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
    .join(";")
}
