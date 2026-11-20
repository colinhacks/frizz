# A dedicated Antigravity backend

**Status:** built and on `main`, 2026-11-20, and revised the same day after a stress run and a review (§ Stress run). Measured against `agy` 1.5.12 and 1.5.13 on a free-tier Google account, and on Google AI Pro from 2026-11-20.

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
| Thinking levels | present only on a model that has them, and read per model: low to high on Gemini 3.8 Flash, low to `xhigh` on Gemini 4 Neon and Hydrogen, none on the orchestrators and GPT-OSS; a model switch resets the level |
| Steer | a second `session/prompt` mid-turn joins the turn; the first prompt's response returns at once and the last one's ends the turn |
| Self-started work | a background command or a sub-agent reporting back sends updates with no prompt outstanding and no end marker: text, then `usage_update`, then silence |
| Sub-agents | `invoke_subagent` returns in milliseconds, and the report arrives later as self-started work; the child's own tool calls are not on the stream |
| Permission | `session/request_permission` with `allow` and `deny`, once each; there is no allow-always |
| Questions | with the client capability `elicitation:{form:{}}`, `ask_question` sends `elicitation/create` with a JSON schema per question |
| Frame order in a step | a step's `usage_update` has arrived both before and after its `agent_message_chunk`, so the bridge relies on neither |
| Cancel | `session/cancel` fails the running tool and the prompt returns `stopReason:"cancelled"`, within 2s and once within 20ms |
| Compaction | `/compact` sent as a prompt returns `end_turn` with no frames; the appended system prompt survives it |
| Sandbox | in `auto` mode the shell cannot reach loopback or Frizz's state directory, and no permission request is raised |
| Bypass | `agy acp --dangerously-skip-permissions` is a launch flag; with it no call asks and no shell is sandboxed |
| Quota | `agy -p "/usage" --output-format json` prints one group per family of models sharing a limit, with no session and no tokens, in about 3s |
| Quota on a paid plan | each family has a 5h and a weekly limit, and Gemini 4 Argon's allowance is a group of its own that lists no models |

The account's plan decides the models.

| Plan | Models |
| --- | --- |
| Free | Gemini 3.8 Flash, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B |
| Google AI Pro | Gemini 4 Neon, Argon and Hydrogen, Orchestrator (Neon) and (Argon), Gemini 3.8 Flash, Claude Opus 5.5 and Sonnet 5.5, GPT-OSS 120B |

Gemini 4 Neon has run every live scenario at the low level and the dispatch and resume ones at `xhigh`. No model on either plan offers `max`.

## Decisions

1. **A new `BackendKind`, `"antigravity"`.** A fork on `backend === "acp"` must not catch a backend with its own turn model, the reasoning OpenCode's decision 1 gives. `backendUsesAcpTransport` in `@frizz/shared` names what the two do share.
2. **The bridge is a sibling of the ACP bridge, not a subclass.** `backend/antigravity-bridge.ts` reuses the JSON-RPC client, the detached per-thread daemon and the transcript writer, and owns the turn.
3. **The model slug is `antigravity:<model id>`,** and the bare `antigravity:` is the CLI's configured model. The prefix is needed because Antigravity also serves Claude and GPT models, so a bare id cannot name the backend.
4. **The thinking level rides the profile's `effort`.** A model with no levels stores none. The row records what the agent kept, so asking for a level on a model without one stores an empty effort.
5. **The worker contract is the system prompt.** It is appended at `session/new` and Antigravity keeps it across a resume and a compaction, so nothing re-sends it.
6. **Reopen with `session/resume`,** then set model, level and mode again, in that order. A session that cannot be resumed starts fresh with a note on the thread.
7. **A turn ends when its last outstanding prompt returns.** A message sent mid-turn is another `session/prompt` (`BACKEND_FOLLOW_UPS.antigravity = { steer: true, interrupt: false }`: `agy` has no preempt other than `session/cancel`). The earlier prompt's return is where the agent has read the new words, so text streamed before it is commentary and not the turn's final text.
8. **Self-started work opens a turn of its own.** The bridge writes a synthetic message ("Antigravity carried on by itself…") and a `turn-start`. The turn closes after 2s of silence once a `usage_update` has ended a model step and no tool call has started since; text arriving in that window restarts the 2s. It does not close while a card is open or one of its own foreground calls is still running, and 5m of silence with neither is the last resort.
9. **New threads start in Bypass.** It is the only setting in which the agent's shell reaches `frizzctl`, the Codex precedent. Ask, Accept edits, Auto and Plan are session modes; a move to or from Bypass restarts the agent once its turn is over.
10. **One plain `frizzctl` call is approved without a card** in the asking modes. The check refuses any shell metacharacter, an unquoted heredoc, and any blank other than a space or a tab: a shell reads a form feed or a no-break space beside a heredoc's delimiter as part of the delimiter. A test runs every command the check approves in `sh`, `bash` and `zsh`. In `auto` the sandbox cuts `frizzctl` off, and the contract says so.
11. **Tool calls are written in Frizz's vocabulary** (`run_command` → Bash, `write_file` → Write, `edit_file` → Edit, `read_file` → Read, `search_web` → WebSearch, `invoke_subagent` → Agent, `ask_question` → AskUserQuestion), so the existing cards draw them.
12. **Questions are cards.** An `elicitation/create` becomes an `agent-question` interaction, and its answer goes back as the form's content.
13. **The model list is read from a throwaway session.** There is no other way to ask, and selecting each model in turn to read its levels costs no tokens. It is held for ten minutes and read only when Antigravity is the chosen profile or its list is opened.
14. **Quota is the CLI's own usage report,** read only by a gauge standing on an Antigravity model and held for five minutes. It runs only after the model list has answered over ACP, which fails cleanly for a signed-out account.
    - A window lists the models it meters. A group says so in its description, or is named for the one model it meters ("Gemini 4 Argon"). An orchestrator no group names is metered with the model it is called after, as the report files Orchestrator (Neon) beside Neon.
    - With several limits in a family, the panel heads the family once and each row is its span, since "Claude and GPT, weekly" does not fit beside a percentage and a reset time.
    - The gauge reads the selected model's 5h window, and a weekly one only once it is low, as it does for Claude.
15. **Sign-in is the person's own.** Frizz reads no Antigravity credential; a signed-out dispatch says to run `agy` and sign in.
16. **A Frizz restart adopts the running agent as it is.** The daemon keeps the agent and its turn. The next runtime takes over every prompt still in flight, and a turn whose prompt returned meanwhile closes on the quiet rule once the daemon's replay is read.
    - Tool calls already in the transcript are not announced again: a call that spans the restart gets its result on the row it has.
    - The message the transcript was in the middle of is carried on, so the answer stays one message and the turn's final text is all of it.
    - The launch flag is read from the daemon's record (`args`), not from the thread's mode, so a move to or from Bypass made before the restart is still owed one.
    - Model, level and mode are set again from the thread's row.
    - A card is journaled under the tool call's id plus a mark of the attachment. The store keeps one record per id, and the previous runtime cancelled its own on the way out.
    - A turn left open by an agent that did not survive (a reboot) is closed at boot.
17. **Stop is `session/cancel`, and the agent is ended if it does not act on it** within 15s. Closing the connection would only detach from the daemon. A message sent while a turn is being stopped waits for the stop and starts a turn of its own.
18. **A reading that fails is held too:** the model list for 30s and the quota for 2m, so a gauge standing on a signed-out account does not start `agy` at every poll. The gauge's click and an explicit refresh skip the hold.
19. **Not in this effort:** sub-agent rows with a drill-in transcript (the stream carries no child events), adopting sessions started outside Frizz, the `fs/*` and `terminal/*` client methods, and Antigravity's own `/goal` and `/schedule` beyond the turns they start.

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
- `backend/_live_antigravity.mts` runs the real bridge against the real CLI: models, contract, tools, steer, self-started work, resume, question, permission, profile and cancel, then the restart and race cases (`restart`, `restart-card`, `stop-send`, `crash`, `steers`, `parallel`).
- A live run needs the real `HOME` (`scripts/adhoc-stack.mjs --home=$HOME --project=<throwaway>`), because `agy` keeps its sign-in in the system keychain.

## Stress run

2026-11-20, against the fake `agy` unless a row says otherwise. The driver is `backend/_stress_antigravity.mts`, and it kept a transcript to its own rules after every scenario: no turn opened inside another, no ending without a start, no tool call or result written twice, no agent text outside a turn.

| Scenario | Result |
| --- | --- |
| 200 turns on one session | every turn's final text its own; nothing held per call afterwards |
| 25 sessions at once, and 8 through the daemon | no transcript holds another session's text |
| 10 concurrent steers, then a stop word | one turn, 12 prompts delivered |
| Stop pressed 5 times with a message sent during it | **fixed:** the message joined the turn being cancelled and was never answered |
| 86 races of ending a session against a follow-up | the follow-up always reached a new agent and was answered |
| Agent killed mid-turn, with a card open, and in a turn it started | turn closed as unsuccessful, card withdrawn, next message resumes the session |
| Junk lines, unknown updates, wrong types, a 3MB message, unknown ids and methods | turn completes; an unknown request gets `-32601` |
| Restart with the prompt still running | **fixed:** the tool call was written twice, leaving a row that never settles |
| Restart, prompt returns while Frizz is away | **fixed:** the turn stayed open until the 5m last resort |
| Restart with an approval card open | **fixed:** the card was never raised again and the turn hung |
| Restart while the agent writes its answer | **fixed:** the turn's final text was only the part written after the restart |
| Restart after leaving Bypass mid-turn | **fixed:** the agent kept running without asking |
| Reboot with a turn open | **fixed:** the thread read as in flight until its next message |
| Agent that ignores `session/cancel` | **fixed:** Stop detached from the daemon, and the next message joined the old turn |
| A silent command longer than the last resort, in a self-started turn | **fixed:** the turn was split in two |
| Profile change, and shutdown, during an open | **fixed:** the change was dropped; the closed bridge kept the session |
| Real `agy`: both restart cases, a card across a restart, Stop then a message, a killed agent, three steers, three threads at once | all pass; each `agy` process holds about 185MB |

The generic ACP bridge had the same restart defects, and they are fixed there the same way (`acp-bridge.ts`, pinned in `acp-bridge.test.ts`):

- a card open across a restart was never raised again;
- a tool call open across a restart was written twice;
- a turn whose agent did not survive a reboot stayed open;
- the final text of a turn adopted mid-answer was cut at the restart;
- a prompt that returned while Frizz was away left its turn open for good, since that bridge has no quiet rule. It now closes the turn with the answer the daemon replays.
