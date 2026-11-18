import type { OutgoingHttpHeader, ServerResponse } from "node:http"

/**
 * Mark every answer `res` gives `Cache-Control: no-transform`, whichever handler writes it.
 *
 * A board reached through a CDN is otherwise the CDN's to rewrite. Cloudflare's Web Analytics, switched on
 * for the frizz.sh zone on 2026-08-15, injected its beacon into every page under it; the board's script
 * policy refused the beacon, and a boot watchdog that read the refusal as a failed load reloaded the board
 * every two seconds for as long as it was open (2026-11-18). Cloudflare leaves the body of a response that
 * says `no-transform` alone ("Cloudflare proxy will not be able to modify the original payload",
 * developers.cloudflare.com/web-analytics/faq), as RFC 9111 § 5.2.2.6 asks of every intermediary. It costs
 * the board no compression: the board brotli-encodes its own pages, and the relay passes that through.
 *
 * Installed on the response before any handler runs, so an answer added later cannot leave it out. An
 * answer with no explicit `writeHead` still gets it: Node writes implicit headers through `writeHead`.
 */
export function refuseTransforms(res: ServerResponse): void {
  const writeHead = res.writeHead as (...args: unknown[]) => ServerResponse
  res.writeHead = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    // writeHead(status, headers?) or writeHead(status, statusMessage, headers?)
    const at = typeof args[1] === "string" ? 2 : 1
    const headers = args[at]
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const name = Object.keys(headers).find((key) => key.toLowerCase() === "cache-control")
      if (name !== undefined) {
        const given = headers as Record<string, OutgoingHttpHeader | undefined>
        args[at] = { ...given, [name]: withNoTransform(given[name]) }
        return writeHead.apply(this, args)
      }
    }
    this.setHeader("cache-control", withNoTransform(this.getHeader("cache-control")))
    return writeHead.apply(this, args)
  } as ServerResponse["writeHead"]
}

/** A Cache-Control value that says `no-transform`, keeping every directive it already had. */
export function withNoTransform(value: OutgoingHttpHeader | undefined): string {
  const text = value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value)
  if (/(^|,)\s*no-transform\s*(,|$)/i.test(text)) return text
  return text.trim() === "" ? "no-transform" : `${text}, no-transform`
}
