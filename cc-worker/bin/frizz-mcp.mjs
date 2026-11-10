#!/usr/bin/env node
// @ts-check
/**
 * frizz-mcp — the worker registry (../lib/frizz-tools.mjs) over MCP stdio, mounted as `frizz` so its
 * tools are `mcp__frizz__<tool>`. The command line (`frizzctl`, beside this file) is the worker
 * surface; this front-end answers the same sixteen commands for a client that speaks MCP.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification. Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs (no build/bundle/resolution concerns), and it matches this repo's own hand-rolled-RPC
 * aesthetic. The server NEVER crashes on a bad tool call: failures come back as an isError tool
 * result so the worker sees a message instead of a dead tool.
 */
import { HANDLERS, Refused, ServerRefusal, TOOLS } from "../lib/frizz-tools.mjs"

const PROTOCOL_FALLBACK = "2025-06-18"

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
/** @param {string|number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}
/** @param {string|number} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}
/** @param {string|number} id @param {string} text @param {boolean} [isError] */
function replyTool(id, text, isError) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "frizz", version: "0.1.0" },
      })
      return
    }
    case "notifications/initialized":
    case "initialized":
      return // notification — no reply
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: TOOLS })
      return
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : ""
      const handler = HANDLERS[name]
      if (!handler) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        // A refusal is an ordinary answer here, exactly as it was before the command line gave it an
        // exit code of its own: a gate doing its job, not a fault.
        const answer = await handler(params?.arguments ?? {})
        replyTool(id, answer instanceof Refused ? answer.text : answer)
      } catch (err) {
        // The server's own "no" (an unknown thread, a dead handle) is a gate that held as well.
        if (err instanceof ServerRefusal) replyTool(id, `\`${name}\` was refused: ${err.message}`)
        else replyTool(id, `\`${name}\` failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
      return
  }
}

// NDJSON reader: buffer stdin, dispatch each complete line. Messages never contain raw newlines.
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore unparseable lines
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
