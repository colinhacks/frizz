import { createHash } from "node:crypto"
import { brotliCompressSync, gzipSync, constants } from "node:zlib"

/**
 * Response compression for the RPC surface.
 *
 * Measured on this project's real board payload (472 threads, 780 KB of JSON), which is what every
 * page load fetches and what made a remote board feel slow — the server answered in 11 ms and then
 * pushed 780 KB up a home connection through the tunnel:
 *
 *   gzip  q6   159 KB    8.6 ms   4.9x
 *   br    q4   150 KB    5.6 ms   5.2x     <- chosen
 *   br    q11  124 KB   940.1 ms  6.3x     <- better ratio, absurd for a per-request path
 *
 * Brotli at q4 beats gzip q6 on BOTH size and time, so it is preferred when the client accepts it.
 * q11 is the trap: the extra 26 KB costs almost a second of CPU on every request.
 *
 * Deliberately NOT applied to the SSE stream. Compressing a long-lived event stream buffers frames
 * until the compressor decides to flush, which turns a live board into a stuttering one — the exact
 * failure this is supposed to fix, moved somewhere worse.
 */

/** Below this, framing and CPU cost more than the bytes saved. */
export const MIN_COMPRESS_BYTES = 1024

export type ContentEncoding = "br" | "gzip"

/**
 * Which encoding to use, honouring the client's list and its `q=0` refusals.
 *
 * `identity;q=0` and `*;q=0` are real things a client can say, and ignoring them means sending an
 * encoding that was explicitly refused.
 */
export function negotiateEncoding(acceptEncoding: string | undefined | null): ContentEncoding | null {
  if (!acceptEncoding) return null
  const offers = new Map<string, number>()
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";")
    if (!name) continue
    const q = params
      .map((p) => /^\s*q=([0-9.]+)\s*$/i.exec(p))
      .find(Boolean)
    offers.set(name.trim().toLowerCase(), q ? Number(q[1]) : 1)
  }
  const wildcard = offers.get("*")
  const accepted = (name: ContentEncoding): boolean => {
    const explicit = offers.get(name)
    if (explicit !== undefined) return explicit > 0
    return wildcard !== undefined && wildcard > 0
  }
  if (accepted("br")) return "br"
  if (accepted("gzip")) return "gzip"
  return null
}

/** Compress at the measured sweet spot for each encoding. */
export function compress(body: Uint8Array, encoding: ContentEncoding): Uint8Array<ArrayBuffer> {
  const out = encoding === "br"
    ? brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 4,
          // Telling brotli the input size lets it size its window instead of guessing.
          [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
        },
      })
    : gzipSync(body, { level: 6 })
  // Copy out of Node's Buffer (whose ArrayBufferLike is not a plain ArrayBuffer) so this is a valid
  // BodyInit for the web Response the middleware builds.
  return Uint8Array.from(out)
}

/** Is this response worth compressing, and safe to? */
export function shouldCompress(headers: Headers, byteLength: number): boolean {
  if (byteLength < MIN_COMPRESS_BYTES) return false
  // Never double-encode something already encoded upstream.
  if (headers.has("content-encoding")) return false
  const type = headers.get("content-type") ?? ""
  // Event streams are excluded by path too, but a belt-and-braces check keeps a future route from
  // silently acquiring a buffering compressor.
  if (type.includes("text/event-stream")) return false
  return /json|text\/|javascript|xml|svg/i.test(type)
}

/**
 * An RPC answer's validator: weak, over the UNCOMPRESSED body, so a br and a gzip copy of one answer
 * revalidate alike. SHA-1 for speed (~1 GB/s here, 2 ms on a 2 MB board against ~13 ms of brotli it
 * saves on a match); it is a cache key on the caller's own data, not a security boundary.
 */
export function rpcEtag(body: Uint8Array): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`
}

/** `If-None-Match` names this tag (weak comparison, as RFC 9110 has for that header), or `*`. */
export function etagMatches(ifNoneMatch: string | undefined | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  const bare = (tag: string) => tag.trim().replace(/^W\//, "")
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag))
}

/** Store it, but ask the server every time: an answer is never served from cache unchecked. */
export const RPC_CACHE_CONTROL = "private, no-cache"
