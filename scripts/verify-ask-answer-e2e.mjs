// Dispatches a REAL claude worker that asks a native question, then waits for the card so a browser
// can be pointed at the thread and the answer clicked through.
//
//   nub scripts/verify-ask-answer-e2e.mjs <port> dispatch   → prints {slug, sessionId, url}
//   nub scripts/verify-ask-answer-e2e.mjs <port> verify <sessionId>
//       → asserts the model received the operator's CHOSEN LABEL, which is the whole answer contract:
//         claude's result mapper keys `answers` by the full question text and only reports the question
//         as answered when the value is exactly an advertised option label.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createRpcClient } from "./lib/rpc-client.mjs"

const [port = "4956", mode = "dispatch", arg] = process.argv.slice(2)
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const board = await api.query("board")
const cwdSlug = board.projectDir.replaceAll("/", "-")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const transcriptFor = (sessionId) => join(homedir(), ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
const read = (sessionId) => {
  const p = transcriptFor(sessionId)
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

if (mode === "dispatch") {
  const PROMPT = [
    "Use the AskUserQuestion tool RIGHT NOW as your very first action, and do nothing else first.",
    "Ask exactly one question: \"Which colour should the banner be?\" with two options,",
    "Red (description: warm and loud) and Blue (description: calm and cool).",
    "After you get the answer, reply with exactly: CHOSE=<the option label you were given>.",
  ].join("\n")
  const { slug, sessionId } = await api.mutate("dispatch", { prompt: PROMPT, backend: "claude", model: "sonnet", effort: "low" })
  const deadline = Date.now() + 240_000
  for (;;) {
    const { interactions } = await api.query("pendingInteractions", { slug, sessionId })
    if (interactions.some((i) => i.payload.kind === "agent-question")) break
    if (Date.now() > deadline) throw new Error("TIMEOUT: no question card appeared")
    await sleep(3_000)
  }
  console.log(JSON.stringify({ slug, sessionId, url: `http://127.0.0.1:${port}/thread/${slug}` }))
} else {
  const sessionId = arg
  if (!sessionId) throw new Error("usage: verify <sessionId>")
  const deadline = Date.now() + 240_000
  let text = ""
  for (;;) {
    text = read(sessionId).filter((r) => r.type === "assistant")
      .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
      .filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    if (/CHOSE=/.test(text)) break
    if (Date.now() > deadline) { console.log("TIMEOUT waiting for the model to report its answer"); break }
    await sleep(3_000)
  }
  const match = text.match(/CHOSE=\s*"?([A-Za-z]+)/)
  console.log(`the model reports: ${match ? match[0] : "(nothing)"}`)
  const pass = match?.[1] === "Red"
  console.log(pass
    ? "PASS: the operator's clicked option reached the model as its exact advertised label"
    : "FAIL: the model did not receive the chosen label")
  if (!pass) process.exitCode = 1
}
