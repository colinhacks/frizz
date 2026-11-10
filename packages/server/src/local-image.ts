import { createReadStream, realpathSync, statSync, type ReadStream } from "node:fs"
import { extname, isAbsolute } from "node:path"
import { normalizeLocalPath } from "./local-path.ts"

const IMAGE_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

// The videos a ```lightbox gallery plays (web lib/markdownTargets PROXIED_VIDEO_PATH must match): what a
// worker's screen recording comes out as — puppeteer and Playwright write WebM, macOS writes QuickTime,
// ffmpeg writes MP4. Every browser plays MP4 and WebM; Chrome plays an H.264 `.mov` too, and Safari plays
// all of them.
const VIDEO_CONTENT_TYPE: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
}

const CONTENT_TYPE: Record<string, string> = { ...IMAGE_CONTENT_TYPE, ...VIDEO_CONTENT_TYPE }

/**
 * What `/local-image` answers. `start`/`end` are the INCLUSIVE byte span to send: the whole file for a
 * 200, the requested range for a 206. A 416 carries the size its `content-range` must name.
 */
export type LocalImageResult =
  | { status: 400 }
  | { status: 404 }
  | { status: 416; size: number }
  | LocalImageFile

export interface LocalImageFile {
  status: 200 | 206
  contentType: string
  file: string
  size: number
  start: number
  end: number
}

// Screenshot paths in agent markdown can live anywhere on disk. This resolver is deliberately
// unconfined: the HTTP callers apply Frizz's loopback/origin gate before reaching it, while the
// extension allowlist, realpath, and regular-file check keep the response limited to image and video
// bytes.
//
// A video needs BYTE RANGES, which is why this answers a span rather than a buffer. A `<video>` asks for
// `bytes=0-` and then seeks with further ranges, and Safari plays nothing from a server that cannot
// answer them. Both HTTP callers stream that span off disk rather than reading the file into memory —
// a screen recording runs to hundreds of megabytes, and the element abandons most of what it asks for.
//
// `restore` is asked about a path that names nothing, once: a picture Frizz decoded out of a transcript
// lives in a small cache that drops its oldest files, and the server knows how to write one back
// (transcript.ts restoreToolImage). True means the file is there now.
export function resolveLocalImage(rawPath: string | undefined, range?: string | null, restore?: (path: string) => boolean): LocalImageResult {
  if (rawPath) rawPath = normalizeLocalPath(rawPath)
  if (!rawPath || !isAbsolute(rawPath)) return { status: 400 }

  const contentType = CONTENT_TYPE[extname(rawPath).toLowerCase()]
  if (!contentType) return { status: 400 }

  let real: string
  try {
    real = realpathSync(rawPath)
  } catch {
    if (!restore?.(rawPath)) return { status: 404 }
    try {
      real = realpathSync(rawPath)
    } catch {
      return { status: 404 }
    }
  }

  let size: number
  try {
    const stat = statSync(real)
    if (!stat.isFile()) return { status: 404 }
    size = stat.size
  } catch {
    return { status: 404 }
  }

  const span = range ? byteRange(range, size) : null
  if (span === "unsatisfiable") return { status: 416, size }
  if (span) return { status: 206, contentType, file: real, size, start: span.start, end: span.end }
  return { status: 200, contentType, file: real, size, start: 0, end: size - 1 }
}

/**
 * One `Range: bytes=…` header against a file of `size` bytes (RFC 9110 §14.1.2): `a-b`, `a-` or the
 * suffix `-n`, an end past the file clamped to its last byte. Null means "ignore the header and send the
 * whole file" — which the RFC allows for anything this does not parse, a unit other than bytes, and a
 * request for SEVERAL ranges (a multipart answer buys a media element nothing). A range that starts
 * past the end, or an empty suffix, is unsatisfiable.
 */
export function byteRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, first, last] = match
  if (first === "" && last === "") return null
  if (first === "") {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(size - suffix, 0), end: size - 1 }
  }
  const start = Number(first)
  if (last !== "" && Number(last) < start) return null
  if (start >= size) return "unsatisfiable"
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) }
}

/** The headers every answer that carries bytes sends, from either HTTP caller. */
export function localImageHeaders(result: LocalImageFile): Record<string, string> {
  return {
    "content-type": result.contentType,
    "content-length": String(result.end - result.start + 1),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=60",
    ...(result.status === 206 ? { "content-range": `bytes ${result.start}-${result.end}/${result.size}` } : {}),
  }
}

/** The span's bytes, off disk. Null for an empty file, which `createReadStream` cannot express as a span. */
export function localImageStream(result: LocalImageFile): ReadStream | null {
  if (result.end < result.start) return null
  return createReadStream(result.file, { start: result.start, end: result.end })
}
