# A dedicated Antigravity backend

**Status:** built and on `main`, 2026-11-20. Measured against `agy` 1.5.12 and 1.5.13 on a free-tier Google account.

**Maintainer's brief (2026-11-20):** a dedicated backend on `agy acp`, at the depth of the Codex one. The Python SDK and its `localharness` binary are ruled out. Google publishes no TypeScript or Go SDK.

Antigravity's CLI speaks the Agent Client Protocol with its own additions, and those additions change the shape of a turn. The generic ACP backend stays as it is for every other agent.

## What was measured

Every row is a frame read off the real CLI's stdio with a scratch JSON-RPC driver (`~/Documents/scratch/agy-probe/scripts/`), on Gemini 3.8 Flash at the low thinking level.

| Behavior | Result |
| --- | --- |
| Handshake | `initialize` answers protocol 1 with `sessionCapabilities {resume, close, load, list}` and `_meta.antigravity {tier, systemPrompt:{append}}` |
| Signed out | `session/new` fails `-32000 Authentication required`; nothing opens a browser |
| System prompt | `session/new {_meta:{antigravity:{systemPrompt:{append}}}}` reached the model, and a control without it did not |
| Resume | `session/resume` restores history with no replay and keeps the appended system prompt; `session/load` replays every message |
| Config options | `model`, `thought_level` and `mode` are set with `session/set_config_option`, and none survives a resume |
| Thinking levels | present only on a model that has them: low, medium and high on Gemini 3.8 Flash, none on the Claude and GPT models; a model switch resets the level |
| Steer | a second `session/prompt` mid-turn joins the turn; the first prompt's response returns at once and the last one's ends the turn |
| Self-started work | a background command or a sub-agent reporting back sends updates with no prompt outstanding and no end marker: text, then `usage_update`, then silence |
| Sub-agents | `invoke_subagent` returns in milliseconds, and the report arrives later as self-started work; the child's own tool calls are not on the stream |
| Permission | `session/request_permission` with `allow` and `deny`, once each; there is no allow-always |
| Questions | with the client capability `elicitation:{form:{}}`, `ask_question` sends `elicitation/create` with a JSON schema per question |
| Cancel | `session/cancel` fails the running tool and the prompt returns `stopReason:"cancelled"` about 2s later |
| Compaction | `/compact` sent as a prompt returns `end_turn` with no frames; the appended system prompt survives it |
| Sandbox | in `auto` mode the shell cannot reach loopback or Frizz's state directory, and no permission request is raised |
| Bypass | `agy acp --dangerously-skip-permissions` is a launch flag; with it no call asks and no shell is sandboxed |
| Quota | `agy -p "/usage" --output-format json` prints one group per family of models sharing a weekly limit, with no session and no tokens, in about 3s |

The account's plan decides the models. The free tier lists Gemini 3.8 Flash, Claude Sonnet 4.6, Claude Opus 4.6 and GPT-OSS 120B, so no Gemini 4 model and no `xhigh` or `max` level has been run.

## Decisions

1. **A new `BackendKind`, `"antigravity"`.** A fork on `backend === "acp"` must not catch a backend with its own turn model, the reasoning OpenCode's decision 1 gives. `backendUsesAcpTransport` in `@frizz/shared` names what the two do share.
2. **The bridge is a sibling of the ACP bridge, not a subclass.** `backend/antigravity-bridge.ts` reuses the JSON-RPC client, the detached per-thread daemon and the transcript writer, and owns the turn.
3. **The model slug is `antigravity:<model id>`,** and the bare `antigravity:` is the CLI's configured model. The prefix is needed because Antigravity also serves Claude and GPT models, so a bare id cannot name the backend.
4. **The thinking level rides the profile's `effort`.** A model with no levels stores none. The row records what the agent kept, so asking for a level on a model without one stores an empty effort.
5. **The worker contract is the system prompt.** It is appended at `session/new` and Antigravity keeps it across a resume and a compaction, so nothing re-sends it.
6. **Reopen with `session/resume`,** then set model, level and mode again, in that order. A session that cannot be resumed starts fresh with a note on the thread.
7. **A turn ends when its last outstanding prompt returns.** A message sent mid-turn is another `session/prompt` (`BACKEND_FOLLOW_UPS.antigravity = { steer: true, interrupt: true }`).
8. **Self-started work opens a turn of its own.** The bridge writes a synthetic message ("Antigravity carried on by itself…") and a `turn-start`, and closes the turn on a `usage_update` followed by 2s of silence, or after 5m of silence with no card open.
9. **New threads start in Bypass.** It is the only setting in which the agent's shell reaches `frizzctl`, the Codex precedent. Ask, Accept edits, Auto and Plan are session modes; a move to or from Bypass restarts the agent once its turn is over.
10. **One plain `frizzctl` call is approved without a card** in the asking modes. The check refuses any shell metacharacter and an unquoted heredoc. In `auto` the sandbox cuts `frizzctl` off, and the contract says so.
11. **Tool calls are written in Frizz's vocabulary** (`run_command` → Bash, `write_file` → Write, `edit_file` → Edit, `read_file` → Read, `search_web` → WebSearch, `invoke_subagent` → Agent, `ask_question` → AskUserQuestion), so the existing cards draw them.
12. **Questions are cards.** An `elicitation/create` becomes an `agent-question` interaction, and its answer goes back as the form's content.
13. **The model list is read from a throwaway session.** There is no other way to ask, and selecting each model in turn to read its levels costs no tokens. It is held for ten minutes and read only when Antigravity is the chosen profile or its list is opened.
14. **Quota is the CLI's own usage report,** read only by a gauge standing on an Antigravity model and held for five minutes. It runs only after the model list has answered over ACP, which fails cleanly for a signed-out account.
15. **Sign-in is the person's own.** Frizz reads no Antigravity credential; a signed-out dispatch says to run `agy` and sign in.
16. **Not in this effort:** sub-agent rows with a drill-in transcript (the stream carries no child events), adopting sessions started outside Frizz, the `fs/*` and `terminal/*` client methods, and Antigravity's own `/goal` and `/schedule` beyond the turns they start.

## Event mapping

| Antigravity frame | NormalizedEvent |
| --- | --- |
| first `session/prompt` of a turn | `user-message`, `turn-start` |
| `agent_message_chunk` | `assistant-text`, flushed in pieces |
| `agent_thought_chunk` | `reasoning` |
| `tool_call`, `tool_call_update` | `tool-call`, `tool-result` with `failed`, `cancelled` or `answers` |
| `usage_update` | `context-usage` |
| last prompt response | `turn-end`, `successful` unless `stopReason` is `cancelled` or `refusal` |
| any of the above with no prompt outstanding | the synthetic `user-message` and `turn-start` first |
| `session_info_update` | `title` |

## Verification

- `backend/antigravity.fixtures/fake-agy.mjs` is a fake `agy` in the measured dialect over real stdio. It drives `antigravity-bridge.test.ts`, through the real detached daemon where a test says so.
- `backend/_live_antigravity.mts` runs the real bridge against the real CLI: models, contract, tools, steer, self-started work, resume, question, permission, profile and cancel.
- A live run needs the real `HOME` (`scripts/adhoc-stack.mjs --home=$HOME --project=<throwaway>`), because `agy` keeps its sign-in in the system keychain.
