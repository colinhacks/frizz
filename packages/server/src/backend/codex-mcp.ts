import { FRIZZ_MCP, frizzMcpEnv, type FrizzMcp } from "./types.ts"

// ---- Codex MCP injection -------------------------------------------------------------------------
// The codex twin of dispatch.ts's `claudeMcpFlags`. Claude mounts frizz's MCP server via one inline
// `--mcp-config` JSON on the worker's argv; codex has no such flag, so it rides a `-c` TOML override
// on the APP-SERVER's argv instead.
//
// WHY THE APP-SERVER'S ARGV. On codex-cli 0.146.0 it was the ONLY channel that worked: putting
// `mcp_servers` in `thread/start`'s untyped `config` bag mounted nothing, and the model answered the
// literal word `NOTOOL` — its own report that the tool was not in its registry. That measurement is
// reproducible via `packages/server/src/backend/_live_codex_mcp_inject.mts`.
//
// THAT IS NO LONGER TRUE, and this file now uses BOTH channels. Re-measured against codex-cli 0.153.2,
// the per-thread override works and gives each thread its own MCP child with its own env — which is
// the only way to tell the server WHO IS CALLING. See `codexThreadMcpConfig` below for what that
// unblocks and why the argv mount is still here.
//
// The app-server is PER-PROJECT (its socket key is sha256(stateDir + projectId)), so one process-level
// mount serves every codex thread in that project with the right FRIZZ_STATE_DIR. Note the app-server
// is long-lived: a change here only reaches NEWLY spawned ones.
//
// `default_tools_approval_mode="approve"` is not optional. Under a restrictive approval policy with no
// approval channel, a mounted MCP call is CANCELLED rather than missing — the log reads
// `mcp: <server>/<tool> started` then `(failed)` + "user cancelled MCP tool call". A headless worker
// has nobody to click that, so without this the tools mount and then fail at the moment of use, which
// is strictly worse than not mounting them.

/** TOML basic-string quoting. JSON's string grammar is a subset of TOML's for these values. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** `key={a="…",b=["…"]}` — one inline table per server, the shape `codex -c` parses. */
function inlineTable(entries: [string, string][]): string {
  return `{${entries.map(([k, v]) => `${k}=${v}`).join(",")}}`
}

function serverTable(command: string, args: readonly string[], env?: Record<string, string>): string {
  const entries: [string, string][] = [
    ["command", tomlString(command)],
    ["args", `[${args.map(tomlString).join(",")}]`],
  ]
  if (env && Object.keys(env).length > 0) {
    entries.push(["env", inlineTable(Object.entries(env).map(([k, v]) => [k, tomlString(v)]))])
  }
  return inlineTable(entries)
}

/**
 * The `-c` overrides that mount frizz's MCP server into a codex app-server.
 *
 * The unified `frizz` server is the ONLY server frizz mounts, and only when its descriptor resolved;
 * absent ⇒ the worker simply lacks those tools, exactly as on the claude side. Frizz injects no
 * browser on EITHER backend (see types.ts) — a `chrome-devtools` mount rode every app-server until
 * 2026-08-26. Whatever the operator configured themselves in `~/.codex/config.toml` still loads: these
 * are overrides layered ON the config, not a replacement for it.
 *
 * Returns a flat argv fragment: ["-c", "…", "-c", "…"]. Pure and exported so a regression cannot
 * silently stop mounting it — the shape is unit-pinned rather than only observable by running codex.
 */
export function codexMcpConfigArgs(frizzMcp?: FrizzMcp, nodeBin: string = process.execPath): string[] {
  const args: string[] = []
  if (frizzMcp) {
    // The ABSOLUTE node path, never bare "node": the app-server spawns this itself and its PATH varies
    // by launch context (a GUI-launched app, a login-shell difference). The claude side pins the same
    // thing for the same reason — a bare "node" that is not on PATH makes the server silently never
    // start, so the tool merely never appears.
    args.push(
      "-c",
      `mcp_servers.${FRIZZ_MCP.name}=${serverTable(nodeBin, [frizzMcp.scriptPath], frizzMcpEnv(frizzMcp))}`,
    )
  }
  // Headless workers cannot answer an approval prompt, and an unapproved MCP call is cancelled at the
  // moment of use rather than never offered. See the header.
  args.push("-c", `default_tools_approval_mode=${tomlString("approve")}`)
  return args
}

/**
 * The PER-THREAD `mcp_servers` override for one thread's `thread/start` (and `thread/resume`) config —
 * the same mount as the argv one above, plus the one thing the argv can never carry: WHO IS CALLING.
 *
 * WHY THIS EXISTS AT ALL. The app-server is per-PROJECT and serves every codex thread in it, so the
 * argv mount's env is shared by all of them and cannot name a thread. `FRIZZ_THREAD_SLUG` was therefore
 * simply absent on codex, and every frizz tool that acts on the CALLER'S OWN thread — `title`, `ask`,
 * `done`, `watch`, `watch_pr`, `unask`, `unwatch`, `timer`, `goal`, `activity`, ten call sites through
 * `threadSlug()` in cc-worker/bin/frizz-mcp.mjs — failed at the moment of use with "this frizz MCP
 * server was not told which thread it belongs to". Only `spawn_thread` worked. That is most of the
 * worker contract: a codex worker could not name its own thread, register a question, or sign off, and
 * one of them said so in its own final message ("Frizz's completion registration also failed because
 * the server lacked FRIZZ_THREAD_SLUG; the fence below is the sign-off").
 *
 * WHY IT WORKS NOW AND DID NOT BEFORE. The header above says a per-conversation `mcp_servers` override
 * "does not work: MCP servers are PROCESS-level". That was measured on codex-cli 0.146.0 and it was
 * true then. It is FALSE on 0.153.2, re-measured against the real binary: `thread/start` accepts the
 * override, codex spawns one MCP process per (server × thread), and the child gets that thread's env —
 * two threads started with different slugs produced two children each reporting its own. It also merges
 * with `~/.codex/config.toml` rather than replacing it.
 *
 * THE ARGV MOUNT STAYS. It is what a thread with no per-thread config still gets — a resume handled by
 * the app-server that already holds the thread cannot retarget its MCP child, and an adopted or
 * pre-upgrade thread never had one. Those degrade to exactly today's behaviour (tools present, no
 * identity) instead of losing the tools outright.
 *
 * `default_tools_approval_mode` is repeated ON THE ENTRY, not inherited from the top-level argv key:
 * it is a member of codex's per-server config, and on 0.153.2 a server entry without it was refused
 * with "MCP tool call requires approval, but approval policy is never" under the identical argv that
 * approved the entry carrying it.
 */
export function codexThreadMcpConfig(frizzMcp: FrizzMcp | undefined, slug: string, nodeBin: string = process.execPath): Record<string, unknown> {
  if (!frizzMcp) return {}
  return {
    mcp_servers: {
      [FRIZZ_MCP.name]: {
        // The ABSOLUTE node path, for the same reason the argv mount pins it — see codexMcpConfigArgs.
        command: nodeBin,
        args: [frizzMcp.scriptPath],
        env: frizzMcpEnv({ ...frizzMcp, slug }),
        default_tools_approval_mode: "approve",
      },
    },
  }
}

/**
 * The app-server's full argv for a transport.
 *
 * ONE builder for every spawn site — the native listener, the forked daemon, and both `--stdio`
 * fallbacks. MCP servers mount PROCESS-wide (see codex-mcp.ts), so a site that forgets the overrides
 * produces an app-server whose threads silently have no tools, and nothing reports it. Keeping the
 * argv in one place is what stops the transports from drifting apart.
 */
export function codexAppServerArgv(
  transport: readonly string[],
  frizzMcp?: FrizzMcp,
): string[] {
  return ["app-server", ...codexMcpConfigArgs(frizzMcp), ...transport]
}
