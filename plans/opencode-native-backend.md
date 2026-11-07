# A native OpenCode 2 backend

**Status:** design, 2026-11-06, written before the first line of code. Branch `opencode-v2`, not merged to `main` until the maintainer says so.

**Maintainer's brief (2026-11-06):** focus on OpenCode v2, and do all four steps: let OpenCode-only users in, fix the ACP path's defects, build a native backend for 2.x, and draft a listing on OpenCode's ecosystem page.

ACP stays as Frizz's generic path for every other agent and for OpenCode below the minimum version. Claude and Codex are untouched.

## What was measured

All against real servers, in sandboxed XDG directories, on free models. Scripts are in `~/Documents/scratch/opencode-probe/scripts/`; results and a raw event stream are in `.frizz/threads/8ae2e0b3-89da-4b8e-aa86-aaaa1670148d/` of the main checkout (`probe-results.json`, `probe-events.jsonl`, `v2027/`).

| Behavior | Result on 2.2.5 (and 2.0.27 unless noted) |
| --- | --- |
| Steer | `POST /api/session/:id/prompt {delivery:"steer"}` during a tool call was delivered at the next step boundary, in the same execution |
| Instruction entry | `PUT /api/experimental/session/:id/instructions/entries/:key` reached the model and survived `/compact`, where the same fact in a first prompt did not (2.2.5 for the compaction control) |
| Sub-agent | `session.created` with `parentID`, then the child's own full event stream |
| Question tool | `form.created` with `metadata.kind:"question"` and `fields`; `POST .../form/:id/reply {answer:{q0:"Alpha"}}` |
| Permission | `permission.asked {id,sessionID,action,resources,save,source}`; `POST .../permission/:id/reply {decision:"once"|"always"|"reject"}` |
| Per-session rules | `permissions:[{action,resource,effect}]` on create; `*`/`*`/`ask` asked for a shell command |
| Per-session cwd and env | `location.directory` on create, `PUT .../environment {variables}`; two concurrent sessions each saw their own |
| Second client | `opencode run --server <url> --session <id>` ran a turn on the session; the event stream saw it |
| Memory | one server 357-396 MB after about ten sessions; `opencode acp` 383-498 MB per thread |
| Restart, plain `serve` | not resumed: `restart.ts` says unregistered servers never sweep (2.2.5) |
| Restart, `serve --service` | resumed after SIGTERM and SIGKILL in about 1s, with a "server restarted" note; the killed command ran again (2.2.5) |
| Durable log | `/api/experimental/session/:id/log` returns only `log.synced`: `persist` is false outside Workers. Do not build on it. |

## Decisions

1. **A new `BackendKind`, `"opencode"`.** The `acp` kind means "generic protocol, nothing invented". This one has its own capabilities, so forks on `backend === "acp"` must not silently catch it. The seam list in `plans/acp-backend.md` is the checklist.
2. **Connect to the person's managed background service; never run a private one.** Only the managed service resumes turns, and it is what makes a Frizz thread reachable from their own `opencode`. Read the registration at `${XDG_STATE_HOME:-~/.local/state}/opencode/service.json` (`id, version, url, pid, password`; Basic auth, username `opencode`). When it is missing or unhealthy, run `opencode service start` and re-read within a bounded wait. Never run `service stop` or `service restart`. Never log the password or put it in a worker's environment.
3. **Minimum version 2.0.27**, the oldest version the probes passed on. Truth comes from `GET /api/info`. Below the minimum, including all of 1.x, OpenCode stays in the ACP catalogue as it is today. At or above it, the composer shows one OpenCode entry, native. `FRIZZ_OPENCODE_BIN` overrides the PATH lookup, as `FRIZZ_CLAUDE_BIN` does. OpenCode is PATH-resolved and never provisioned.
4. **Existing `acp:opencode` threads stay on ACP.** No migration.
5. **Hand-rolled HTTP and SSE client, no `@opencode/client`.** Same reasoning as ACP decision 1: the wire is small, and the bridge reads only the fields it needs, tolerating unknown events.
6. **One SSE subscription per service, demultiplexed.** `GET /api/event`, routed by `sessionID`, with a child-to-root map built from `session.created.parentID`. A slow consumer fails the stream by contract, so the reader buffers.
7. **A Frizz-written transcript, and reconcile on reconnect.** `<stateDir>/opencode/<frizz session id>.jsonl` holds a header then NormalizedEvents, so the tailer, board and delivery ledger work unchanged. Generalize the ACP writer and projector rather than copying them. The stream has no replay, so every `server.connected` (first connect, reconnect, a Frizz restart) reconciles each live thread from `session.active`, its messages, and its pending permissions and forms: missing items are appended keyed by message and tool id, a turn that ended in the gap gets its `turn-end`, and open cards are raised again. No daemon: the service already outlives Frizz, and reconcile is needed anyway for a service restart.
8. **The worker contract is an instruction entry** (`frizz.contract`), re-put on resume. If the route refuses, it falls back to the first prompt with the ACP re-send path. It gets its own `opencode` variant in `workerPrompt.ts`.
9. **Identity through per-session environment.** `frizzctl` finds its thread through the environment, so `PUT .../environment` carries `withFrizzCliOnPath(inheritWorkerEnvironment())` plus `frizzCliEnv` for that thread. The route replaces the whole environment. Verify a sub-agent's shell gets it and that it survives a service restart; set it on child sessions and on reconcile if not. No per-thread MCP: the API's MCP routes are location-scoped, and `frizzctl` carries Frizz's commands.
10. **Permission modes are real.** `bypassPermissions` is allow-all; `acceptEdits` allows edits and asks otherwise; `default` asks; `plan` switches to OpenCode's `plan` agent. `auto` is not offered, because OpenCode has no reviewer. Rules are set at create and with `PATCH /api/session/:id`. Verify action names and rule precedence against OpenCode's source and a live server. Cards use `provider.kind:"opencode"`, including a sub-agent's asks.
11. **Questions are cards.** A `form.created` whose `metadata.kind` is `question` becomes an `agent-question` interaction, using the `NOTES_FIELD_SUFFIX` pairing for `custom` fields; other forms use the closest existing kind. `form.cancelled` retires the card.
12. **Follow-ups use OpenCode's inbox.** The composer's steer sends `delivery:"steer"`, queue sends `delivery:"queue"`, with a stable message id for idempotency. `session.inbox.delivered` moves the ledger. Taking one back is `DELETE .../inbox/:id`. Send now promotes with `PATCH .../inbox/:id` and interrupts with `POST .../interrupt` where the delivery needs it.
13. **Sub-agents get real rows.** A child session appears as a `SubAgentView` with a drill-in transcript, `taskId` holding the child's session id so a worker can name it in `agents:`. Its text never joins the parent's message.
14. **Thread controls.** Model and variant use `POST .../model` (`variant` is the effort axis), from `GET /api/model` grouped by provider, reusing the ACP model dropdown. `/compact` uses `POST .../compact`. Stop uses `interrupt`. A Frizz title goes to `PATCH /api/session/:id`. Mark as done interrupts and releases; it never deletes the OpenCode session. Session `metadata` carries the Frizz session id.
15. **The service starts on demand**: at dispatch, at model listing with OpenCode selected, or at boot when live OpenCode threads exist. Never for a person who does not use OpenCode.
16. **Not in this effort:** Go quota chips (no signed-in account to verify against), adopting sessions started outside Frizz, a `/frizz` plugin command, and a terminal-attach control.

## Event mapping

| OpenCode event | NormalizedEvent |
| --- | --- |
| `session.execution.started` | `turn-start` |
| `session.execution.succeeded`, `.failed`, `.interrupted` | `turn-end`, `successful` true only on the first, `finalText` from the execution's last assistant text |
| `session.text.delta`, `.ended` | streamed `assistant-text` pieces with their `messageId` |
| `session.reasoning.*` | `reasoning` |
| `session.tool.called`, `.success`, `.failed` | `tool-call`, `tool-result` |
| `session.inbox.delivered` | `user-message` and the delivery ledger |
| `session.usage.updated` | `context-usage` |
| `session.compaction.ended` | `compaction` |
| `session.step.failed`, `session.execution.failed` errors | `provider-error`; `provider.auth` says to run `opencode auth login` |
| `session.retry.scheduled` | a transcript note |

Unknown event types are ignored, never thrown.

## Risks accepted

- A service restart kills running commands in every OpenCode thread, and the model runs them again. Execution is at-least-once. This is OpenCode's own behavior.
- The API moved 117 commits between 2.0.27 and 2.2.5. Tests pin the fields Frizz reads against a fake server, and a `_live_opencode_*.mts` probe runs against a real binary.
- Instruction entries are under `/api/experimental/`, which is why decision 8 has a fallback.

## Verification

- **Unit and contract:** a fake OpenCode server over real HTTP and SSE (the shape of `backend/acp.fixtures/fake-acp-agent.mjs`): event mapping, reconcile after a dropped stream, card round trips, steer and queue ledger, service discovery with a negative control. A recorded real stream from `probe-events.jsonl` folds to the expected state.
- **End to end:** a real sandbox stack with a real binary, through the browser, on 2.2.5 and 2.0.27: dispatch, tool rows with the command visible, sub-agent row and drill-in, steer mid-turn, queue, take back, stop, permission card in `default` mode, question card, model switch, compact, a Frizz restart mid-turn, a service restart mid-turn, and two projects at once. Every behavior is checked on the queue card, the drawer and the full page.
- **Gates:** `nub run typecheck` and `nub run test` on the merge commit.
