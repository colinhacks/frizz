import { z } from "zod"

// The slice of the Agent Client Protocol (ACP, v1 — https://agentclientprotocol.com) that Frizz READS.
//
// Every schema here is deliberately OPEN: `.passthrough()` on objects, a catch-all on every union, and
// nothing required beyond what the spec marks required. ACP is additive by policy (the SDK's own schema
// grew from 5 documented `session/update` variants to 15 without a version bump), 34 agents implement it
// with varying fidelity, and a field Frizz does not render must never be the reason a turn is dropped.
// An unknown update is skipped, never thrown — see `parseSessionUpdate`.
//
// Plan and measurements: plans/acp-backend.md. The wire facts (what `opencode acp` actually sends) are
// recorded there; the SDK's full type surface is in the effort's scratch notes.

export const ACP_PROTOCOL_VERSION = 1

// ---- JSON-RPC 2.0 envelopes ---------------------------------------------------------------------

export const JsonRpcId = z.union([z.string(), z.number()])
export type JsonRpcId = z.infer<typeof JsonRpcId>

export const JsonRpcError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough()
export type JsonRpcError = z.infer<typeof JsonRpcError>

/** One inbound frame, classified. A frame with `id` and `result`/`error` is a response to us; with `id`
 *  and `method` it is the agent asking US something; with only `method` it is a notification. */
export const JsonRpcInbound = z.union([
  z.object({ jsonrpc: z.literal("2.0").optional(), id: JsonRpcId, result: z.unknown() }).passthrough(),
  z.object({ jsonrpc: z.literal("2.0").optional(), id: JsonRpcId, error: JsonRpcError }).passthrough(),
  z.object({ jsonrpc: z.literal("2.0").optional(), id: JsonRpcId, method: z.string(), params: z.unknown().optional() }).passthrough(),
  z.object({ jsonrpc: z.literal("2.0").optional(), method: z.string(), params: z.unknown().optional() }).passthrough(),
])
export type JsonRpcInbound = z.infer<typeof JsonRpcInbound>

// Error codes the client has to recognize. `-32000` is the one that matters operationally: 21 of 34
// registry agents return it on `session/new` until the operator has logged in with the agent's own CLI.
export const ACP_ERROR_AUTH_REQUIRED = -32000
export const ACP_ERROR_REQUEST_CANCELLED = -32800
export const ACP_ERROR_METHOD_NOT_FOUND = -32601
export const ACP_ERROR_INTERNAL = -32603

// ---- initialize ------------------------------------------------------------------------------

export const AcpAuthMethod = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  // Absent = "agent" (call `authenticate {methodId}`); "terminal" = relaunch the same program
  // interactively with `args`/`env` — which Frizz does not do; it tells the operator instead.
  type: z.string().optional(),
}).passthrough()
export type AcpAuthMethod = z.infer<typeof AcpAuthMethod>

export const AcpAgentCapabilities = z.object({
  loadSession: z.boolean().optional(),
  promptCapabilities: z.object({ image: z.boolean().optional(), audio: z.boolean().optional(), embeddedContext: z.boolean().optional() }).passthrough().optional(),
  mcpCapabilities: z.object({ http: z.boolean().optional(), sse: z.boolean().optional() }).passthrough().optional(),
  // Object markers: `{}` present = supported, absent = not.
  sessionCapabilities: z.object({
    list: z.unknown().optional(), resume: z.unknown().optional(), close: z.unknown().optional(), fork: z.unknown().optional(), delete: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough()
export type AcpAgentCapabilities = z.infer<typeof AcpAgentCapabilities>

export const AcpInitializeResult = z.object({
  protocolVersion: z.number(),
  agentCapabilities: AcpAgentCapabilities.optional(),
  authMethods: z.array(AcpAuthMethod).optional(),
  agentInfo: z.object({ name: z.string().optional(), title: z.string().optional(), version: z.string().optional() }).passthrough().optional(),
}).passthrough()
export type AcpInitializeResult = z.infer<typeof AcpInitializeResult>

// ---- session/new, session/load -------------------------------------------------------------------

/** A stdio MCP server as ACP spells it: the variant with NO `type`, `args` and `env` REQUIRED, and `env`
 *  an ARRAY of name/value pairs (an object here is the single most common shape mistake). */
export const AcpMcpServerStdio = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.array(z.object({ name: z.string(), value: z.string() })),
})
export type AcpMcpServerStdio = z.infer<typeof AcpMcpServerStdio>

export const AcpConfigOption = z.object({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  currentValue: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), name: z.string().optional() }).passthrough()).optional(),
}).passthrough()
export type AcpConfigOption = z.infer<typeof AcpConfigOption>

export const AcpNewSessionResult = z.object({
  sessionId: z.string().min(1),
  configOptions: z.array(AcpConfigOption).nullish(),
  modes: z.unknown().optional(),
}).passthrough()
export type AcpNewSessionResult = z.infer<typeof AcpNewSessionResult>

/** `session/set_config_option` answers with the COMPLETE option list, so dependent changes show at once. */
export const AcpSetConfigOptionResult = z.object({ configOptions: z.array(AcpConfigOption).nullish() }).passthrough()

/** `session/load` replays history as updates and only then responds `{}` (possibly with config). */
export const AcpLoadSessionResult = z.object({
  configOptions: z.array(AcpConfigOption).nullish(),
  modes: z.unknown().optional(),
}).passthrough()

// ---- content, tool calls, updates ----------------------------------------------------------------

export const AcpContentBlock = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("resource_link"), uri: z.string(), name: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("resource"), resource: z.object({ uri: z.string(), text: z.string().optional() }).passthrough() }).passthrough(),
  z.object({ type: z.literal("image"), mimeType: z.string().optional(), data: z.string().optional() }).passthrough(),
  z.object({ type: z.string() }).passthrough(),
])
export type AcpContentBlock = z.infer<typeof AcpContentBlock>

export const AcpToolKind = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"])
export const AcpToolCallStatus = z.enum(["pending", "in_progress", "completed", "failed"])

export const AcpToolCallContent = z.union([
  z.object({ type: z.literal("content"), content: AcpContentBlock }).passthrough(),
  z.object({ type: z.literal("diff"), path: z.string(), oldText: z.string().nullish(), newText: z.string() }).passthrough(),
  z.object({ type: z.literal("terminal"), terminalId: z.string() }).passthrough(),
  z.object({ type: z.string() }).passthrough(),
])
export type AcpToolCallContent = z.infer<typeof AcpToolCallContent>

export const AcpToolCallLocation = z.object({ path: z.string(), line: z.number().nullish() }).passthrough()

// The fields both `tool_call` and `tool_call_update` may carry. Only `toolCallId` is ever required — a
// permission prompt can legitimately arrive with nothing else (spec issue #1979), so every reader of a
// tool call renders defensively.
const ToolCallFields = {
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  content: z.array(AcpToolCallContent).nullish(),
  locations: z.array(AcpToolCallLocation).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
}
export const AcpToolCallUpdate = z.object(ToolCallFields).passthrough()
export type AcpToolCallUpdate = z.infer<typeof AcpToolCallUpdate>

export const AcpPlanEntry = z.object({ content: z.string(), priority: z.string().optional(), status: z.string().optional() }).passthrough()

// Every variant Frizz renders, each parsed on its own so one malformed field never poisons the rest.
export const AcpSessionUpdateKnown = z.discriminatedUnion("sessionUpdate", [
  z.object({ sessionUpdate: z.literal("user_message_chunk"), content: AcpContentBlock, messageId: z.string().optional() }).passthrough(),
  z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: AcpContentBlock, messageId: z.string().optional() }).passthrough(),
  z.object({ sessionUpdate: z.literal("agent_thought_chunk"), content: AcpContentBlock, messageId: z.string().optional() }).passthrough(),
  z.object({ sessionUpdate: z.literal("tool_call"), ...ToolCallFields }).passthrough(),
  z.object({ sessionUpdate: z.literal("tool_call_update"), ...ToolCallFields }).passthrough(),
  z.object({ sessionUpdate: z.literal("plan"), entries: z.array(AcpPlanEntry) }).passthrough(),
  z.object({ sessionUpdate: z.literal("usage_update"), used: z.number(), size: z.number(), cost: z.unknown().optional() }).passthrough(),
  z.object({ sessionUpdate: z.literal("session_info_update"), title: z.string().nullish(), updatedAt: z.string().nullish() }).passthrough(),
  z.object({ sessionUpdate: z.literal("config_option_update"), configOptions: z.array(AcpConfigOption) }).passthrough(),
  z.object({ sessionUpdate: z.literal("compaction_update"), compactionId: z.string().optional(), status: z.string().optional() }).passthrough(),
  // The summary streaming in while a compaction runs — sent only to a client that advertised
  // `session.compaction`, which the bridge does. The `completed` update is the one that matters.
  z.object({ sessionUpdate: z.literal("compaction_summary_chunk"), compactionId: z.string().optional() }).passthrough(),
])
export type AcpSessionUpdateKnown = z.infer<typeof AcpSessionUpdateKnown>

export type AcpSessionUpdate = AcpSessionUpdateKnown | { sessionUpdate: "unknown"; raw: unknown }

/** Classify one `session/update` payload. A variant Frizz does not know (`available_commands_update`,
 *  `current_mode_update`, `plan_update`, anything v2 adds) or a known one with a field that fails to
 *  parse comes back as `unknown` — the caller logs it at debug and moves on. */
export function parseSessionUpdate(raw: unknown): AcpSessionUpdate {
  const parsed = AcpSessionUpdateKnown.safeParse(raw)
  return parsed.success ? parsed.data : { sessionUpdate: "unknown", raw }
}

/** `_meta["opencode/child-session"]`: this update belongs to a sub-agent's session, forwarded on the
 *  parent's id (cli/src/acp/child.ts `project`, seen on 2.0.27 and 2.2.5). No other agent marks one yet. */
export function isAcpChildUpdate(update: unknown): boolean {
  const meta = (update as { _meta?: Record<string, unknown> } | undefined)?._meta
  return meta !== null && typeof meta === "object" && meta["opencode/child-session"] != null
}

export const AcpSessionNotification = z.object({ sessionId: z.string(), update: z.unknown() }).passthrough()

// ---- session/prompt ---------------------------------------------------------------------------

export const AcpStopReason = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
export type AcpStopReason = z.infer<typeof AcpStopReason>

export const AcpPromptResult = z.object({
  // A string, not the enum: a future reason must not turn a finished turn into a parse failure.
  stopReason: z.string(),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional() }).passthrough().nullish(),
}).passthrough()
export type AcpPromptResult = z.infer<typeof AcpPromptResult>

// ---- session/request_permission (the agent asks US) -----------------------------------------------

export const AcpPermissionOptionKind = z.enum(["allow_once", "allow_always", "reject_once", "reject_always"])
export type AcpPermissionOptionKind = z.infer<typeof AcpPermissionOptionKind>

export const AcpPermissionOption = z.object({
  optionId: z.string(),
  name: z.string().optional(),
  // A string: an unknown kind renders as an opaque choice rather than failing the whole request.
  kind: z.string().optional(),
}).passthrough()
export type AcpPermissionOption = z.infer<typeof AcpPermissionOption>

export const AcpRequestPermissionParams = z.object({
  sessionId: z.string(),
  toolCall: AcpToolCallUpdate,
  options: z.array(AcpPermissionOption),
}).passthrough()
export type AcpRequestPermissionParams = z.infer<typeof AcpRequestPermissionParams>

export type AcpRequestPermissionResult =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } }

// ---- helpers ------------------------------------------------------------------------------------

/** The text of a content block, or nothing for a block that has none (an image, a link). */
export function contentText(block: AcpContentBlock | undefined): string | undefined {
  if (!block) return undefined
  if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") return (block as { text: string }).text
  if (block.type === "resource") {
    const r = (block as { resource?: { text?: unknown } }).resource
    return typeof r?.text === "string" ? r.text : undefined
  }
  return undefined
}
