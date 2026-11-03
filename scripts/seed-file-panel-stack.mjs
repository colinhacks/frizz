// A simulated transcript plus real files for filePanelStack.e2e.test.ts. No provider is dispatched.
// Usage: nub scripts/seed-file-panel-stack.mjs --home=<adhoc-stack HOME>
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const home = process.argv.find((a) => a.startsWith("--home="))?.slice(7)
if (!home) throw new Error("Pass --home=<disposable adhoc-stack HOME>")
const project = process.cwd()
const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const docs = join(home, "file-stack-docs")
mkdirSync(docs, { recursive: true })
writeFileSync(join(docs, "first.md"), [
  "# First document", "", "[Read the second document](second.md)", "",
  ...Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: the first document keeps its reading position.\n`),
  "[Continue to the second document](second.md)",
].join("\n"))
writeFileSync(join(docs, "second.md"), "# Second document\n\n[Revisit the first document](first.md)\n\n[Read the source file](example.ts)\n\nSelect this passage for the chat.\n")
writeFileSync(join(docs, "example.ts"), "export const stacked = true\n")
// One file of every kind a click routes differently (lib/local-file-links.ts openLocalPath): a PDF the
// reader shows in the browser's viewer, a binary it cannot show, a picture for the lightbox, text, and
// an HTML page.
writeFileSync(join(docs, "report.pdf"), minimalPdf())
writeFileSync(join(docs, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
writeFileSync(join(docs, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
writeFileSync(join(docs, "notes.txt"), "plain notes, shown as source\n")
// A self-contained page, which goes to the browser at every width and opens as source only on a phone.
writeFileSync(join(docs, "options.html"), "<!doctype html><title>Options</title><p>page source, shown only on a phone</p>\n")
const slug = "file-panel-stack"
const sessionId = randomUUID()
const now = new Date().toISOString()
const jsonlDir = join(home, ".claude", "projects", project.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const records = [
  { type: "user", message: { role: "user", content: "Read the linked documents" } },
  { type: "assistant", message: { model: "claude-opus-5", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: `[Read the first document](${join(docs, "first.md")})` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 20 } } },
  { type: "user", message: { role: "user", content: "And the other files?" } },
  { type: "assistant", message: { model: "claude-opus-5", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: ["report.pdf", "bundle.zip", "shot.png", "notes.txt", "options.html"].map((name) => `- [${name}](${join(docs, name)})`).join("\n") }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 20 } } },
].map((r) => ({ ...r, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: now, session_id: sessionId, cwd: project }))
writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
  VALUES (${vals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now}', 'File preview stack', 'claude', 'opus', 'high', 'default', '${now}')`])
console.log(JSON.stringify({ slug, docs }))

// A one-page PDF with a correct xref table, so a real PDF viewer opens it without repairing it.
function minimalPdf() {
  const text = "BT /F1 36 Tf 72 700 Td (Frizz PDF fixture) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets = objects.map((object, i) => {
    const at = body.length
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
    return at
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}
