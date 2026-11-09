import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ATTACHMENT_MAX_BASE64_CHARS, isAllowedAttachmentName } from "@frizz/shared"

// ATTACHMENT INTAKE: a dropped, pasted or picked file (images AND every document, office, data and archive
// format in @frizz/shared ATTACHMENT_EXTENSIONS) lands on DISK, outside the repo, under the project's state
// dir, and the client inserts the returned absolute path into the message text. Workers open it with their
// Read/file tool; the chat renders images via /local-image and non-image files as an openable chip (both
// roots include the attachments dir). JSON base64 keeps the route dependency-free. The extension allowlist +
// the char cap are the only trust gates; the file keeps the name it was uploaded under, in a folder of its own.
//
// Two callers, one intake. The launcher answers a browser's upload itself (restart-supervisor.ts), so it never
// waits on the child's thread, which stalls for seconds at a time under load; the child's own /attach route
// (app.ts) still answers what the launcher passes on, and every upload from a launcher older than this file.

/** What may arrive on the wire around the base64 itself: the JSON's keys and the file name, every byte escaped. */
const ATTACHMENT_ENVELOPE_BYTES = 64 * 1024
/** The largest request body that can hold an acceptable attachment. Anything past it is refused unparsed. */
export const ATTACHMENT_MAX_BODY_BYTES = ATTACHMENT_MAX_BASE64_CHARS + ATTACHMENT_ENVELOPE_BYTES

export const ATTACHMENT_BAD_PAYLOAD = "bad payload"
export const ATTACHMENT_INVALID_JSON = "invalid json"

export type AttachmentIntake =
  | { status: 200; path: string }
  | { status: 400; error: string }

// The name an attachment is stored under: the one it was uploaded with, so the prompt box's chip, the
// transcript's bubble and the path a worker opens all read the same as the file that was dropped. Only
// what a path, or the line the path rides on in the message, cannot carry is changed:
// - every kind of whitespace becomes a plain space. The transcript's path grammar (web lib/imagePaths)
//   takes a plain space and no other, and macOS puts a NARROW NO-BREAK space before "AM" in every
//   screenshot it names, which would otherwise leave the path as dead text instead of a picture;
// - a control character or a backtick becomes `-`: the first can break the line, and the grammar ends
//   a path at the second;
// - on Windows, the characters its filesystem refuses (`<>:"|?*`) become `-` too;
// - only the last path segment is kept, so a hand-written request cannot name a file outside its folder;
// - the name is cut to 255 bytes, the per-name limit of APFS and ext4, keeping its extension.
function attachmentFileName(name: string): string {
  let clean = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\s/g, " ")
    .replace(/[\u0000-\u001f\u007f`]/g, "-")
    .trim()
  if (process.platform === "win32") clean = clean.replace(/[<>:"|?*]/g, "-")
  const dot = clean.lastIndexOf(".")
  const ext = clean.slice(dot) // the allowlist below admitted the extension, so there is always a dot
  const stem = [...clean.slice(0, dot)]
  while (stem.length > 0 && Buffer.byteLength(stem.join("") + ext) > 255) stem.pop()
  return `${stem.join("") || "file"}${ext}`
}

/**
 * Judge one parsed upload body and write it under `stateDir`. A refusal is an answer; a filesystem failure
 * throws, and the caller answers 500. The disk calls are the async ones on purpose: on either caller's thread,
 * a synchronous write holds up every other request for as long as the disk takes.
 */
export async function storeAttachment(stateDir: string, body: unknown): Promise<AttachmentIntake> {
  const { name, data } = (body && typeof body === "object" ? body : {}) as { name?: unknown; data?: unknown }
  if (typeof name !== "string" || !isAllowedAttachmentName(name)) return { status: 400, error: "unsupported file type" }
  if (typeof data !== "string" || data.length > ATTACHMENT_MAX_BASE64_CHARS) return { status: 400, error: ATTACHMENT_BAD_PAYLOAD }
  const buf = Buffer.from(data, "base64")
  // The FOLDER is unique, so the file inside it need not be: two same-named files dropped in the same
  // millisecond still land at two paths (the second would otherwise overwrite the first, and the
  // message would carry a duplicate path). The uniqueness used to be a `<ms>-<hex>-` prefix on the
  // file itself, so the chip and the transcript showed a name nobody had uploaded (maintainer
  // 2026-10-15: "I would like it if the file names remained consistent").
  const dir = join(stateDir, "attachments", `${Date.now()}-${randomUUID().slice(0, 8)}`)
  await mkdir(dir, { recursive: true })
  const path = join(dir, attachmentFileName(name))
  await writeFile(path, buf)
  return { status: 200, path }
}
