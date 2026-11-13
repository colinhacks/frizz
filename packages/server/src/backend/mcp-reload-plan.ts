// What an MCP reload hands a LIVE Claude session, worked out against what that session already holds.
//
// A thread's MCP surface is the project's configuration as it read when the session started
// (project-mcp-servers.ts). `frizzctl mcp reload` and the plug menu's Reload re-read it, and the broker
// daemon makes the live session match through the SDK's `setMcpServers()`. This module is the pure half:
// which servers are new, changed, gone or untouched, and what to send for each.
//
// AN UNCHANGED SERVER IS SENT EXACTLY AS IT WAS MOUNTED. A project stdio server reaches the CLI as a
// lazy-host URL (lazy-mcp-host.ts), and every `mount()` mints a fresh one — so re-mounting an untouched
// server would hand the CLI a different config, which it treats as a replacement and reconnects. Reusing
// the session's own mount is what makes a reload that changed nothing a true no-op: measured against
// claude 2.1.323, a server re-sent with its launch config keeps its process and its connection.
import type { RemoteMcpServer, WorkerMcpServer, WorkerMcpServers } from "./project-mcp-servers.ts"

/** What a session holds: each server's definition as the project declares it, and what the CLI was
 *  handed for it (the definition itself, or the lazy host's URL that stands in for a stdio server). */
export interface McpSurface {
  definitions: WorkerMcpServers
  mounts: WorkerMcpServers
}

export interface McpReloadPlan {
  /** The whole set to send. */
  mounts: WorkerMcpServers
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: number
  /** Lazy mounts this plan minted: released if the reload fails, so no slot outlives a failed call. */
  minted: RemoteMcpServer[]
  /** Mounts the session held that the new set no longer sends: released once the reload has landed. */
  stale: WorkerMcpServer[]
}

/** A definition's identity, independent of key order in the file it came from. */
export function mcpDefinitionKey(server: WorkerMcpServer): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
    }
    return value
  }
  return JSON.stringify(sorted(server))
}

/**
 * The reload of `previous` to `next`. `mountStdio` is the lazy host's mount for one server (absent ⇒ stdio
 * servers are sent as themselves, the form a session without a lazy host was launched with).
 */
export function planMcpReload(
  previous: McpSurface,
  next: WorkerMcpServers,
  mountStdio?: (name: string, server: WorkerMcpServer) => RemoteMcpServer,
): McpReloadPlan {
  const mounts: WorkerMcpServers = {}
  const added: string[] = []
  const changed: string[] = []
  const minted: RemoteMcpServer[] = []
  let unchanged = 0
  for (const [name, definition] of Object.entries(next)) {
    const before = previous.definitions[name]
    const heldMount = previous.mounts[name]
    if (before && heldMount && mcpDefinitionKey(before) === mcpDefinitionKey(definition)) {
      mounts[name] = heldMount
      unchanged += 1
      continue
    }
    if (before) changed.push(name)
    else added.push(name)
    if (mountStdio && (definition.type === undefined || definition.type === "stdio")) {
      const mounted = mountStdio(name, definition)
      minted.push(mounted)
      mounts[name] = mounted
    } else {
      mounts[name] = definition
    }
  }
  const removed = Object.keys(previous.definitions).filter((name) => !(name in next))
  const stale = Object.entries(previous.mounts).filter(([name, mount]) => mounts[name] !== mount).map(([, mount]) => mount)
  return { mounts, added, removed, changed, unchanged, minted, stale }
}
