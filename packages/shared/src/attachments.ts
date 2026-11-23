// What a dropped, pasted or picked file may be. Its own module, apart from the shared index, so the
// launcher's upload intake (restart-supervisor.ts) reads it without bundling the index's schemas.

// ---- Attachment intake (drag/drop, paste, file picker) ----
// What a worker can actually GET AT. A format qualifies two ways: an agent's Read/file tool consumes
// it with no conversion step (images, PDF, text, code), or its bytes are a documented container the
// agent cracks with a tool it installs in one command — openpyxl/pandas for a spreadsheet, python-docx
// and python-pptx for a document, duckdb/pyarrow for a columnar dump, the sqlite3 CLI for a database,
// unzip/tar for an archive, and pandoc or LibreOffice (often already on the machine) for most of the
// rest. Office, columnar and archive formats were REFUSED until 2026-08-27 on the theory that they'd
// reach the agent as opaque zip/XML garbage; that underrates the agent, and the cost of the refusal
// landed on the person, who had to convert the file by hand before Frizz would take it. A dropped file
// lands on disk and its absolute path — inserted as plain text into the message — is what the worker
// opens; nothing here is parsed, rendered or extracted by Frizz itself.
//
// Widening this list widens NOTHING else. /local-image serves only its own content-type map (which
// mirrors ATTACHMENT_IMAGE_EXTENSIONS), and the desktop-open action gates on trusted ROOTS rather than
// on extension (local-file.ts). What the list decides is exactly: what /attach writes to disk, what the
// file picker offers, and which standalone path lines become openable chips (web lib/imagePaths.ts).

// Inline-renderable raster images: served back to the chat via the gated /local-image proxy and seen
// visually by the agent. SVG is DELIBERATELY not here — it is an XSS vector when served as an image
// (which is why the server's /local-image content-type map omits it), so an attached .svg is treated
// as a document (an openable chip + the agent reads its XML), never rendered inline.
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const
// Read straight as text by both backends — or, for PDF, rendered natively by Claude's Read.
export const ATTACHMENT_TEXT_EXTENSIONS = [
  "pdf", "svg", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sql",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php", "swift", "lua", "r",
] as const
// Office and open-document formats. Each is a zip of XML (or, for the pre-2007 binaries, a documented
// OLE container) that one install reads: openpyxl, python-docx, python-pptx, odfpy, striprtf.
export const ATTACHMENT_OFFICE_EXTENSIONS = [
  "xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
] as const
// Analytical dumps. duckdb and pyarrow read the whole columnar set; the sqlite3 CLI ships with macOS
// and most Linux; .ipynb is JSON, which Claude's Read renders as cells and NotebookEdit writes back.
export const ATTACHMENT_DATA_EXTENSIONS = [
  "parquet", "avro", "orc", "arrow", "feather", "ipynb", "db", "sqlite", "sqlite3",
] as const
// Archives. `unzip` and `tar` are on every machine an agent runs on, and refusing a .zip while
// accepting .docx — which IS a zip — was never coherent. Frizz never extracts one: the file sits on
// disk and the worker unpacks it deliberately, or does not.
export const ATTACHMENT_ARCHIVE_EXTENSIONS = ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z"] as const
// Everything that is NOT rendered inline as an image: the chip set, and the alternation behind the
// chat's standalone-path detection.
export const ATTACHMENT_DOC_EXTENSIONS = [
  ...ATTACHMENT_TEXT_EXTENSIONS,
  ...ATTACHMENT_OFFICE_EXTENSIONS,
  ...ATTACHMENT_DATA_EXTENSIONS,
  ...ATTACHMENT_ARCHIVE_EXTENSIONS,
] as const
export const ATTACHMENT_EXTENSIONS = [...ATTACHMENT_IMAGE_EXTENSIONS, ...ATTACHMENT_DOC_EXTENSIONS] as const

// Cap on the /attach base64 payload (~chars). A screenshot is small; a PDF can be larger, so the cap
// is generous but bounded — base64 is ~4/3 the byte size, so this is ~18MB of binary.
export const ATTACHMENT_MAX_BASE64_CHARS = 25_000_000
// The equivalent RAW-byte budget (base64 inflates ~4/3), for a client-side pre-check that rejects an
// oversized file with a clear message before it spends time encoding a doomed upload.
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_MAX_BASE64_CHARS / 4) * 3

const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTENSIONS)
// Lowercased extension (no dot) of a filename, or "" when it has none.
export function attachmentExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}
export function isAllowedAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(attachmentExtension(name))
}
// The <input accept> value for the file picker: every allowed extension as `.ext`.
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")
