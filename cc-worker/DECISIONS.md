# cc-worker — design decisions

The **frizz** worker-side plugin (dir `cc-worker/`, manifest `name: "frizz"` since 2026-07-08) is
consumed by frizz worker sessions: one interactive top-level
`claude` per `.frizz/` thread, loaded via `claude --plugin-dir <repo>/cc-worker`. Each session is a
**worker bound to ONE thread** (slug in env `FRIZZ_THREAD` + a `THREAD:` line in its prompt). The
human + the frizz app are the orchestrator; the worker just drives its one thread. This records
what was ported from the orchestrator `cc/` plugin, what was dropped, and why.

## Shared source, bundled runtime closure

- **`scripts/frizz/config.mjs` and `scripts/frizz/agent-bindings.mjs` are THIN SHIMS** that
  `export *` from `../../../board/*.mjs`. cc-worker never copies config/vocab/binding
  logic — there is exactly one source of truth (cc's). This assumes cc is a sibling dir (`../../cc/`
  from the plugin root), the same assumption frizz's server makes (`ARCHITECTURE.md`: it imports
  the board logic from `../../board/*.mjs`).
- **`bin/frizz` and `bin/frizz-update`** are cc's exact shim pattern, resolving cc's real scripts at
  `../../board/{index,thread-update}.mjs` relative to the bin file (cwd-independent). They
  land on the worker's Bash PATH the way cc's do. `frizz-update` is the worker's primary tool for
  owning its one thread file; `frizz` lets it read/validate the board.
- **Portable artifact rule:** `src/artifacts.ts` copies the exact sibling
  `board/` module closure to `runtime/board/`, beside `runtime/cc-worker/`.
  The existing shims therefore resolve inside an immutable artifact when the source checkout is gone;
  both the worker and cc closure are hashed in `manifest.runtimeFiles` and required at read time.
- **`agents/*.md`** are copied UNCHANGED from `cc/agents/` (16 profiles) — a worker dispatches its
  own helpers at the same model/effort cells as the orchestrator.

## Hooks ported (all gated on `FRIZZ_THREAD` — inert if the plugin is loaded anywhere else)

| Hook | Event | Ported from | What it does for a worker |
| --- | --- | --- | --- |
| `session-seed.mjs` | SessionStart (startup/resume/clear/compact) | cc `session-seed.mjs` | Injects the single-thread worker contract + the bound slug + its file path; re-grounds on compact. Also writes cc's `off` sentinel defensively (see interplay). |
| `precompact-instructions.mjs` | PreCompact (auto/manual) | new — no cc equivalent | Steers WHAT SURVIVES compaction: emits an editorial brief asking the summarizer to preserve the high-level approach (plan, alternatives rejected, rationale) at high fidelity, plus a closing "Re-grounding before continuing:" section naming the thread's scratch-directory path and the files to re-read. **PLAIN STDOUT is the channel** — cc's usual `hookSpecificOutput` JSON would be handed to the summarizer as its literal instructions. Skips sub-agent contexts (the derived scratch-directory path is only guaranteed for the top-level worker). |
| `scratchpad.mjs` | SessionStart (startup/resume/clear/compact) + PreCompact (auto/manual) + UserPromptSubmit + PostToolUse | new — no cc equivalent | Keeps a worker aware of its per-thread scratch DIRECTORY (`.frizz/threads/<sid>/`). `--mode=session-start` NAMES the files in it on the context-losing sources (compact/resume/clear) — a listing, never their content — and otherwise teaches the arrangement (write a doc, then arm `post_compaction`); `--mode=precompact` (**plain stdout**) tells the summarizer those files exist so it carries their paths forward; `--mode=nudge` fires on BOTH UserPromptSubmit and PostToolUse (mid-turn — the one that matters for long autonomous turns) once context has grown past `STALE_TOKENS` since the last write. Both nudge channels share one state file, so mid-turn firing does not multiply reminders. NOT gated on `FRIZZ_THREAD`; `--via=project` marks the repo-local registration and defers to this one inside a frizz worker. |
| `agent-dispatch.mjs` | PreToolUse(Agent) | cc `agent-dispatch.mjs` | Enforces `run_in_background:true`, strips `name`/`team_name`, appends a worker-flavored orchestration epilogue. |
| `bash-background.mjs` | PreToolUse(Bash) | new | Denies a local shell job that escapes through `&` without a later `wait` or EXIT trap, including one hidden inside a command-position `bash -c '…'`. Shell job control bypasses Claude's task registry, so Frizz cannot track or wake it; self-contained probe concurrency, and a wrapper handed to another program (`ssh`/`docker run`/`limactl shell`), remain allowed. |
| `agent-bind.mjs` | PostToolUse(Agent) | cc `agent-bind.mjs` (verbatim behavior) | Records `agentId → thread` into `.frizz/.agent-bindings.jsonl` in cc's exact format, so a worker's THREAD-tagged helper renders on the frizz board's per-thread liveness. |
| `stop-flush.mjs` | Stop | cc `frizz-stop-reminder.mjs` (dirty-check idea only) | If the worker's ONE thread file wasn't edited since the last rest, nudges it to flush its state (mtime dirty-check, cooldown-limited, least-alarming `additionalContext` channel). |

## cc hooks DROPPED — one line each on why

- **`frizz-reminder.mjs` (UserPromptSubmit per-turn pulse)** — DROPPED. It nags the *orchestrator*
  about the whole board (pending-by-status, reconcile-stale, un-drained follow-ups, revalidate-due).
  A worker owns one thread and does not orchestrate a board; a per-turn board pulse is pure noise.
- **`frizz-stop-reminder.mjs` (board-wide Stop reconcile + pop-one decision queue)** — DROPPED as-is;
  only its per-thread dirty-check idea is reused in `stop-flush.mjs`. The rest (reconcile every
  rested agent, pop the next human-blocked thread and present it) is orchestrator decision-queue work
  the frizz app + human own, not the worker.
- **`frizz-notify-surface.mjs` (Stop) + `frizz-notify` bin/`notify.mjs`** — DROPPED. The durable
  WIN/DECISION/BLOCKER notification queue is an orchestrator surfacing channel; in frizz the UI
  surfaces "awaiting you" from thread `status: blocked` + `status_text` directly, so the worker needs
  no separate notify queue.
- **`frizz-subagent-rest.mjs` (SubagentStop recorder) + `frizz-rest-guard.mjs` (SubagentStop guard)**
  — DROPPED. These feed the orchestrator's board-wide "reconcile every rested dispatched agent"
  machinery (`.rested-agents.jsonl`, the `.dispatch-count` gate). A worker actively collects its own
  handful of helpers before resting (contract in SKILL.md); it does not need the board-scale
  rest-reconciliation guard. The worker-facing half of the rest-guard's lesson (run long ops inline,
  don't rest on a waiter) is carried in the dispatch epilogue instead.
- **`frizz-thread-edit-steer.mjs` (PostToolUse Edit/Write)** — DROPPED. It's an orchestrator
  convenience that steers an in-flight agent when the orchestrator hand-edits a thread; a worker edits
  its OWN thread and dispatches its OWN helpers, so there's nothing to cross-steer.
- **`session-end.mjs` (SessionEnd heartbeat clear)** — DROPPED. It clears the session-ownership
  HEARTBEAT so a dead orchestrator's threads orphan. Workers don't participate in cc's multi-session
  ownership model (no `owner_session` claims, no heartbeat) — the frizz app tracks which session
  drives which thread — so there's no heartbeat to clear.
- **The `.dispatch-ledger.jsonl` write + THREAD-existence DENY gate + `.dispatch-count` bump**
  (inside cc's `agent-dispatch.mjs`) — DROPPED from the worker's PreToolUse. The ledger is a
  compaction-durable orchestrator record of which-agent-serves-which-thread across MANY threads; the
  THREAD-existence gate enforces the orchestrator's "file the thread before dispatching" discipline;
  the count only gates the (dropped) SubagentStop recorder. A worker owns exactly one, already-created
  thread and its helpers own no thread, so none apply. The `.agent-bindings.jsonl` write — the piece
  that actually renders sub-agent liveness on the board — IS kept (via `agent-bind.mjs`).

## Interplay with the orchestrator `cc` plugin (double-hook analysis)

**Question:** if the user has `cc` (the frizz orchestrator plugin) enabled globally AND a frizz
worker session starts in the same repo, do both plugins' hooks fire (double-hook)?

**Finding — NO, not by default. cc is inert in a fresh worker session.** cc's every hook is gated on
`frizzActive(projectDir, sessionId)` (`board/config.mjs`). That gate is **opt-IN per
session**: it requires `.frizz/` to exist AND a per-session sentinel at
`.frizz/.session-state/<session_id>` containing `on` (written by `frizz on` / the orchestrator frizz
skill's Step 0). With no sentinel it returns **false** — the documented default:

```
// config.mjs frizzActive(), final line:
return false; // DEFAULT: OPT-IN — dormant until this session runs `frizz on`
```

A freshly-spawned frizz worker has a distinct `CLAUDE_CODE_SESSION_ID` and never runs `frizz on`, so
cc's `frizzActive()` is false for it → **all cc hooks are silent no-ops in the worker.** Meanwhile
cc-worker gates on the orthogonal `FRIZZ_THREAD` env, so the two plugins key off different signals
and do not both activate. No double-hook by default.

**Residual risk:** if, inside a worker session, someone runs `frizz on` or loads the orchestrator
`frizz` skill (whose Step 0 runs `frizz on`), cc's `frizzActive()` flips true AND cc-worker is active →
both fire (you'd get orchestrator board nags inside a worker — wrong).

**Mitigation implemented (cheap + safe + reversible):** `session-seed.mjs` writes cc's OWN per-session
`off` sentinel for the worker's session id via cc's shared `setSessionOverride(dir, sid, 'off')` on
every worker SessionStart. `frizzActive()` short-circuits to false on an `off` override
(`if (override === 'off') return false`), so cc is **guaranteed dormant** in a worker session even if
something later attempts to activate it — unless the human deliberately runs `frizz on` afterward
(which overwrites the sentinel), the explicit "I want this session to orchestrate too" escape hatch.
This uses cc's own public API (identical to what `frizz off` does), touches only gitignored runtime
state keyed on this worker's session id, and does NOT disable cc-worker (which gates on
`FRIZZ_THREAD`, not the sentinel). It's the safest cheap option: it neutralizes the other plugin
without a UI-side plugin-disable flag (Claude Code has no per-invocation "disable plugin X" flag), and
the worker SKILL.md additionally tells the worker not to run `frizz on` / load the orchestrator skill.

## plugin.json

`name: "frizz"` (renamed from `frizz-worker` on 2026-07-08 — see the follow-up note), `version: "0.1.2"`,
`license: "MIT"`. Hooks are auto-discovered from `hooks/hooks.json` (same as cc — plugin.json carries
no explicit hooks reference); every hook command is wired via `${CLAUDE_PLUGIN_ROOT}`.

## Claude settings-source isolation — deliberately deferred

The portable worker launch passes its per-session plugin with `--plugin-dir` on both spawn and
resume, and clears only `CLAUDE_CODE_SUBAGENT_MODEL` plus `CLAUDE_CODE_EFFORT_LEVEL`: those inherited
variables would silently defeat Frizz's selected worker/profile. It deliberately does **not** replace
`HOME`, `CLAUDE_CONFIG_DIR`, or Claude's settings sources. Doing so would also change authentication,
user-approved permissions, MCP configuration, and global plugin behavior; that is a product-policy
decision, not an artifact-portability implementation detail. A future isolation policy must specify
which settings/auth surfaces are preserved before adding `--settings`, a config-home override, or a
global-plugin disable mechanism.

**2026-08-16 — the SDK broker had drifted off this policy, and is back on it.** The tmux transport
spawned a plain `claude`, which reads all three settings scopes, so the policy above held by default.
The Agent-SDK broker takes an explicit `settingSources` and the SDK's own default is `[]` — nothing at
all — so when the broker became the default Claude transport it read no config whatsoever. The
2026-07-26 fix restored `project` + `local` (the repo's `CLAUDE.md` / `AGENTS.md` / `.claude/skills`)
and left `user` out, on a rationale written into the code — "the operator's personal `~/.claude` config
is theirs, not something a dispatched worker should silently inherit" — that this record had already
rejected. The gap was invisible because everything it withheld fails QUIETLY: the operator's `env`
block (which is where an API-proxy front-end writes its base-URL/token pair, so a broker session
authenticates differently from the CLI in the same shell), `autoCompactWindow` (so sessions compacted
at the default threshold, not the configured one), `permissions`, `hooks` and `enabledPlugins`.
Measured against the maintainer's real config, one variable, observed through a project-scope hook:
`--setting-sources=project,local` reported their `env` block UNSET, `user,project,local` reported it
applied, both sessions exiting 0 with empty stderr. The default is now all three scopes — the same
thing a plain `claude` in the same cwd reads. A frizz thread is the operator's own session on their own
machine, so the surprising behavior was the divergence, not the inheritance.

## 2026-07-02: Stop hook removed
stop-flush.mjs is no longer wired (script kept for reference). User call: under frizz the
tailer/board already surface worker state live, and the block-until-file-edited nag forced even
trivial workers into Read/Edit dances that render as noise in the chat UI. Thread-file discipline
remains a prompt-level contract (worker system prompt + SKILL), not a hook-enforced gate.

## 2026-07-08: Developer-experience port — doctrine, thread-type presets, dialectic
Goal: carry the old cc/ plugin's developer experience (minus the orchestrator machinery) into
frizz workers. What landed:
- **`skills/dialectic/SKILL.md`** — ported from `cc/skills/dialectic/` (self-contained dueling-
  sub-agents methodology; no board/reconcile dependency). Its model-tier references use this
  plugin's namespace (`frizz:opus-high`, etc. — see the naming note below).
- **`skills/worker/SKILL.md`** — added two sections: "Choosing a helper's model + effort" (the
  full Haiku/Sonnet/Opus tiering doctrine + effort ladder + bias-to-Opus corollary, adapted from
  `cc/skills/frizz/SKILL.md:218-234` for a worker dispatching its OWN helpers) and "Thread-type
  presets" (research / audit / implementation / planning — deliverable shape + "done" bar each,
  derived from that skill's `:92-150`/`:242-317`/`:463` framing). Also added a status-field
  discipline section (later split into `activity` + `status_text` — see the follow-up) and an
  "awaiting your OWN sub-agent is NOT blocked" clarification.
- **`packages/server/src/workerPrompt.ts`** (frizz system prompt, not in this plugin) — carries the terse version
  of the same three: a "Status discipline" block, the model/effort doctrine in the Sub-agents
  section, and a "Thread types" section. This is the maintainer's explicit ask that the preset
  vocabulary ride in the SYSTEM prompt passed to every worker. No dispatch.ts change, so no frizz
  server restart is needed — `loadWorkerPrompt()` re-reads the file per dispatch and each spawned
  `claude` rescans this plugin dir fresh.

### Naming: subagent_type is `frizz:<model>-<effort>` (plugin renamed to `frizz` on 2026-07-08)
The plugin's manifest `name` (`.claude-plugin/plugin.json`) drives the subagent-type NAMESPACE, and
each agent file's frontmatter `name` drives the agent name — verified empirically with a throwaway
plugin (`name:"frizz"` + agent `name:opus-high` → `frizz:opus-high`); the plugin DIRECTORY name does
not matter. So the profiles dispatch as `frizz:opus-high` / `frizz:sonnet-medium` / `frizz:haiku`, and
the skills as `frizz:worker` + `frizz:dialectic`. A BARE name (`opus-high`, `haiku`) does NOT resolve
— the Agent tool returns "Agent type '…' not found. Available agents: … frizz:haiku …" — so every
doctrine/dialectic reference uses the `frizz:`-prefixed form (confirmed end-to-end: `subagent_type:
frizz:haiku` returns PONG). See the follow-up note below for why the name is `frizz`, not `frizz-worker`.

## 2026-07-08 (follow-up): status split, validation hook, `frizz:` namespace rename
Three maintainer refinements landed on top of the port:

**1. `status_text` split into `activity` + `status_text`.** The single overloaded field became two:
`activity` = the form-constrained LIVE label the UI renders beside the spinner (single line, ≤100
chars, present-progressive gerund); `status_text` = the classic 1–2-sentence human gloss that also
doubles as THE ask on a human-`blocked` thread (queue cards headline it; no gerund constraint). The
gerund/≤100 discipline moved OFF `status_text` and ONTO `activity` in `packages/server/src/workerPrompt.ts` +
`skills/worker/SKILL.md`. (UI-side `activity` plumbing/rendering — board JSON → ThreadView → listing
row — is a SIBLING agent's scope; not touched here beyond `packages/server/src/workerPrompt.ts`.)

**2. New PostToolUse validation hook — `hooks/thread-frontmatter-validate.mjs`** (matcher
`Edit|Write|MultiEdit`, wired in `hooks/hooks.json`). Gated on FRIZZ_THREAD + a top-level
`.frizz/<slug>.md` path (dotfiles + `.findings/` sidecars skipped via the vendored `threadSlug`). On
every thread-file edit it re-reads + validates the frontmatter and, on a HARD violation, returns
`{"decision":"block","reason":…}` (PostToolUse block — the worker sees the quoted reason and
re-edits); soft issues warn via `systemMessage`; a clean edit is silent; ANY error fails OPEN
(exit 0). Rules (mirroring cc's board validator `index.mjs:302-335`): required `title`+`status`;
`status` ∈ the vocab (legacy aliases warn, not block); `activity` single-line/≤100/gerund-heuristic
(first word ends in "ing"); `blocked` ⇒ at most ONE of `blocking_threads`/`revalidate_at`, and
human-blocked (neither) ⇒ `status_text` required; `status_text` >240 chars warns. SELF-CONTAINED: it
VENDORS minimal copies of cc's frontmatter parser (`index.mjs:82`), path matcher
(`frizz-thread-edit-steer.mjs:67`), and vocab (`config.mjs:291`/`:301`) — cc-worker must not import cc
at runtime. Verified: 10 direct unit cases (pass/block/warn/inert) + a real headless worker whose bad
Write was blocked with the exact quoted reason.

**3. Plugin renamed `frizz-worker` → `frizz`; worker skill renamed `frizz-worker` → `worker`.** The
maintainer disliked the old worker-prefixed dispatch namespace. Renamed the manifest `name` to `frizz` and the 16 agent
files + their frontmatter from `frizz-<model>-<effort>` to `<model>-<effort>` (bare `haiku`), so
dispatches read `frizz:opus-high` etc. Renamed the worker skill dir + frontmatter `frizz-worker` →
`worker` (giving `frizz:worker`, not the stutter `frizz:frizz-worker`). The plugin DIRECTORY stays
`cc-worker/` (dispatch.ts points at that path — unchanged, no server restart). Every reference in
`packages/server/src/workerPrompt.ts`, both skills, the hooks, and this file was updated; a grep for the old prefix token is clean.

**Accepted name collision.** The old GLOBAL orchestrator plugin (`cc/`) is ALSO named `frizz`. This is
accepted as harmless: `cc/` is disabled in `~/.claude/settings.json` (`"frizz@frizz": false`) and, even
when enabled, loads only in ORCHESTRATOR sessions (a different process class) — never in a frizz
worker, which loads ONLY this plugin via `--plugin-dir cc-worker`. Verified: the headless worker env
(same settings.json) registers a clean `frizz:*` set with no `cc/` agents present. If a user ever
loaded BOTH plugins in one session, Claude Code would namespace-collide two `frizz` plugins — but that
combination does not occur on the worker path.

## 2026-07-08 (campaign): `needs-human` first-class status + interactive-prompt deny hooks
Part of the board-wide redesign (owned jointly with the frizz UI half): `needs-human` becomes a
first-class frizz status — the declared "awaiting a human" state and the queue's definition — while
`blocked` narrows to MACHINE-waits only. The vocab/parser/validator changes live in the shared cc/
scripts (`config.mjs` STATUS/STATUS_ALIASES + new `effectiveStatus()`, `index.mjs`, `decisions.mjs`,
`statusline-frizz.mjs`, `thread-update.mjs`, `frizz-reminder.mjs`) — consumed by frizz's readBoard
shell-out, so they take effect on the next board rebuild with NO server restart. cc-worker-side:

- **`hooks/thread-frontmatter-validate.mjs`** — vendored vocab bumped: `needs-human` is canonical,
  `needs-decision` aliases to it. New rules: a `needs-human` thread (incl. a legacy `blocked` with no
  machine field, which reads as needs-human via the inlined `effectiveStatus`) REQUIRES a
  `status_text` (hard BLOCK); a machine-`blocked` thread with no mechanism field is a WARN suggesting
  needs-human (not a block — legacy tolerance); >1 mechanism stays a block.
- **`skills/worker/SKILL.md` + `packages/server/src/workerPrompt.ts` + `hooks/session-seed.mjs`** — the worker status
  guidance rewritten to the new contract: an ask OR a result needing review → `status: needs-human`
  with a `status_text` ask ("Review: …"); `blocked` is machine-only; `done` means NOTHING is left for
  the human (Mark-as-done is the human's acknowledgment — never jump straight to `done` when review
  is pending).
- **`hooks/deny-ask.mjs`** (existing, PreToolUse `AskUserQuestion`) — deny reason re-pointed at
  `--status needs-human`. `AskUserQuestion` is a real tool → cleanly deniable via PreToolUse; verified
  by piping the hook its exact payload (deny + reason) and confirming inert when FRIZZ_THREAD unset.
- **`hooks/deny-plan.mjs`** (NEW, PermissionRequest `ExitPlanMode`) — denies the plan-approval prompt.
  MECHANISM (per the Claude Code hooks docs): `ExitPlanMode` is a PERMISSION surface, not a plain
  tool, so it is denied via a **PermissionRequest** hook (matcher exactly `ExitPlanMode`), NOT
  PreToolUse. The deny JSON is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":
  {"behavior":"deny"}}, "additionalContext":"<redirect>"}` — the instructive redirect rides
  **top-level `additionalContext`** (NOT `decision.message`), which Claude injects to the model as a
  plain-text system-reminder; exit 0 with the JSON on stdout (exit 2 makes Claude ignore it). CAVEAT:
  PermissionRequest hooks do NOT fire under `claude -p` (headless print mode), so the `-p` smoke test
  can't exercise it — but a frizz worker runs as an INTERACTIVE `claude` session inside its
  session-broker daemon, where they DO fire. Both deny hooks are FRIZZ_THREAD-gated and fail-open. (`AskUserQuestion` was not surfaced as
  an invokable tool in the `-p` harness either, so both hooks were verified by piping their exact hook
  payloads rather than by driving a live prompt.)

### `hooks/perm-policy.mjs` — the worker's permission policy (2026-07-25)

Replaces the observe-only `perm-observe.mjs`. Same registration (PermissionRequest, matcher `*`), but
it now DECIDES: allow / deny / defer, first match wins.

WHY IT DECIDES. frizz dispatches Claude workers at `--permission-mode auto`
(`WORKER_DISPATCH_PERMISSION`), and `auto` is **not** non-interactive — its classifier still raises a
prompt for anything it judges risky. With nobody at the keyboard that parks a thread invisibly; one sat
blocked on a `git push` for over a day. The blunt alternative was dispatching at `bypassPermissions`,
which was deliberately NOT chosen: bypass removes the decision POINT, so nothing can ever inspect a
request again. Keeping `auto` and deciding here preserves the seam — and Claude Code labels the outcome
in the pane ("Allowed by PermissionRequest hook"), so an auto-approval stays attributable rather than
being indistinguishable from bypass.

THE TABLE ships UNIVERSAL rules only; this plugin loads for every project frizz drives, so a rule that
is right for one repo is wrong for the next. `catastrophic-delete` and `raw-disk-write` deny outright
(strictly safer than bypass, which would have allowed both). `restrictive-mode` DEFERS whenever
`permission_mode` is anything but `auto` or `bypassPermissions`, which is what makes a genuine lower-permission mode usable: move a thread
to `default` with the live permission control and its prompts come back. (Until 2026-10-10 the test
was `!== "auto"`, which swept in `bypassPermissions` — the one mode MORE permissive than auto — so a
bypass thread was handed every prompt Claude Code still raises under bypass, as approval cards an auto
thread never showed. Bypass now falls through to `worker-autonomy`; any other or unknown mode still
defers.) `FRIZZ_PERM_POLICY=review`
defers everything. Fail-safe INVERTS the old observer's fail-open — for a hook that can APPROVE, any
error must fall back to asking, never to allowing.

PAYLOAD (verified live, correcting an earlier note that claimed otherwise): the PermissionRequest hook
input carries `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`,
`hook_event_name`, `tool_name`, `tool_input`, and `permission_suggestions`. That is enough for a real
per-tool/per-command policy. Allow JSON is
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":<tool_input>}}}`.

KNOWN LIMIT: an explicit `ask` RULE outranks this hook. `"permissions":{"ask":["Bash(git push:*)"]}`
raises a prompt an `allow` here does not override — Claude Code says so on the prompt itself. Isolated
against a hook that allows unconditionally (it prompted too), so this is Claude Code precedence, not a
defect, and arguably correct: an explicit human rule should beat a blanket policy. A repo carrying
`ask` rules can therefore still park a worker; the fix is that repo's settings.

MARKER: `<stateDir>/perm-requests/<slug>.json` now carries `decision` / `rule` / `reason` / `command`
alongside the original fields. The tailer treats ONLY a deferred request as a human block (an
auto-resolved one must never card as "Needs you"), and surfaces the last DENIAL as `permPolicy`.
A marker with no `decision` (an older plugin build) still blocks exactly as before.

APPROVALS ARE NOT SURFACED — reversed 2026-08-07. The tailer originally retained allows too, on the
reasoning that an approval leaves no other durable record (Claude Code renders "Allowed by
PermissionRequest hook" in the pane and writes nothing to the transcript), and Chat rendered them as
one quiet `Auto-approved <command> · rule <name>` line. The flaw was that `permPolicy` has no CLEAR:
the line stuck to the bottom of the thread permanently, so one routine `git status --short` read as
the thread's standing condition long after the turn that ran it (maintainer: *"This message just
showed up randomly, and now it's stuck showing up in the thread forever … it's fucking useless"*).
Nothing was blocked and nobody was waiting, so the visibility it bought was worth less than the
permanent noise. Denials keep the card: they are rare, they changed what the worker could do, and the
refusal also lands in the transcript, so the card is a pointer to something real rather than the only
copy of it. If approval visibility is ever wanted again it needs an EXPIRY (or a per-turn scope) —
re-adding the sticky line is not the fix.

AUTO MODE'S HAND-BACKS GO TO A PERSON (2026-11-06). Until then `worker-autonomy` approved everything that
reached this hook under `auto`, on the 2026-07-25 reasoning above: nobody was at the keyboard and an
unanswered prompt parked a thread forever. Both premises changed. An approval card now lapses into a denial
after 5m, so an unanswered one costs five minutes instead of a day. And `auto` became the default, so what
this hook does under `auto` is what every new thread gets. The Claude Code 2.1.318 source shows the problem
with approving here: a classifier refusal returns a denial with no hook, but after 3 refusals in a row or
20 in a session the same action falls back to a prompt, and that prompt reaches this hook. Approving it
turned a refusal into a retry count. So `auto-escalation` defers, ahead of `worker-autonomy`, and
`worker-autonomy` now serves bypass. The fallback was read from the source and not reproduced with a live
model: in about 12 attempts the classifier allowed most of the actions, or the model stopped first. An `ask`
rule is the deterministic way to exercise this path. In the same version, approving an `ask` rule's request
here produced a bare refusal and no card, which the KNOWN LIMIT above describes from the other side.

How often this matters: on the maintainer's board, 57 threads that ran in `auto` made 11,842 tool calls with
24 denials, and only 1 thread's last hook marker reached `worker-autonomy`. Cards should stay rare, and each
one is a request the classifier would not decide.

VERIFICATION: `scripts/verify-perm-marker.mjs` runs the REAL hook the way Claude Code does and
asserts every branch. The allow path was additionally driven against a REAL interactive `claude` (it
cannot be exercised under `claude -p`, where PermissionRequest hooks do not fire).

### The `--settings` permission floor — BUILT, verified, then deliberately REMOVED (2026-07-08)
A `--settings` permission FLOOR was added to `ui/dispatch.ts` (`WORKER_DENY_SETTINGS =
{"permissions":{"deny":["AskUserQuestion","ExitPlanMode"]}}`, both command builders) and verified to
work: `claude -p --settings '{deny:[AskUserQuestion,ExitPlanMode,Bash]}'` → the model reports
`Bash: No` (control — a bare-name deny removes a normally-present tool from context), `Read/Write:
Yes`, `AskUserQuestion/ExitPlanMode: No`. It was then **removed on the maintainer's call**, and the
reasoning is worth keeping (it corrects the earlier "floor first, hooks failover" story):

- A bare-name deny removes the tool from the tool LIST, but a model **knows `AskUserQuestion` /
  `ExitPlanMode` from TRAINING** and can still attempt them. With the floor in place, that attempt
  hits a generic "no such tool" permission error — NOT the hook's instructive `needs-human` redirect
  (a permission `deny` is evaluated regardless of hook output and takes precedence, so the model sees
  the generic denial). So the floor can actually **prevent the tool-block education process**.
- Therefore: **hooks-only enforcement.** The deny HOOKS are themselves a hard deny AND they teach on
  contact (their `needs-human` redirect reaches the model — verified: deny-ask emits a PreToolUse
  `permissionDecisionReason`, deny-plan a PermissionRequest top-level `additionalContext`). The floor
  is gone; `dispatch.ts` + `server.test.ts` are reverted to clean.

### Plan-mode softlock fix (2026-07-08)
A worker in plan mode that calls `ExitPlanMode` would be denied by deny-plan — but plan mode ALSO
blocks file edits, so the redirect ("write the plan into your thread") is impossible to follow: a
softlock. deny-plan does not branch on the session's mode, so it cannot pass plan mode through. Fixed
at the SOURCE instead: `ui/dispatch.ts` `workerPermissionMode()` coerces `--permission-mode plan` → `auto` inside
BOTH command builders (so dispatch, adopt, AND resume never spawn a worker in plan mode). Workers plan
by writing the plan into the thread + `status: needs-human` (the contract), which has no plan-mode
requirement — so nothing is lost. deny-plan then denies `ExitPlanMode` UNCONDITIONALLY when gated:
for a real frizz worker (never in plan mode) that is always a spurious call → deny + redirect is
correct. RESIDUAL GAP (accepted, documented): the deny could softlock only a FOREIGN session that is
simultaneously in plan mode AND running with FRIZZ_THREAD set AND this plugin loaded — a combination
frizz never produces. A normal plan-mode session outside frizz is untouched (deny-plan is inert
without FRIZZ_THREAD). Follow-up for UI honesty: `web/src/lib/options.ts` still offers "plan" in the
dispatch permission-mode dropdown (coerced to `auto` at spawn) — the sibling can drop it there.

### Malformed-thread one-click repair — read-side recovery (2026-07-09)
INCIDENT: a worker that spawned before the frontmatter-validation write-hook existed wrote
`nub/.frizz/sandbox-windows-backend.md` with its metadata in **bold prose** instead of YAML
frontmatter. The board banner correctly reported "sandbox-windows-backend.md: no YAML frontmatter",
but the thread was INVISIBLE to the queue/status system (the parser can't read its title/status →
`status: ?`) until the orchestrator hand-edited YAML. Maintainer directive: "make sure that doesn't
happen again."

TWO-SIDED DEFENSE:
- **Write-side (already existed):** the frontmatter-validation file-tool hook blocks a compliant
  worker from writing a thread `.md` with no frontmatter in the first place.
- **Read-side (this change):** RECOVERY for any straggler the write-hook can't catch — pre-hook
  files, hand edits, and (the residual, by design) **Bash-written files that bypass the file-tool
  hooks entirely**. The board now ships STRUCTURED, classified errors so the UI can offer one-click
  repair.

MECHANISM:
- `board/index.mjs` `--json` gains a parallel `errorItems: [{file, kind, message}]`
  (`kind: 'no-frontmatter'` = repairable, else `'other'`). The parser classifies — it knows exactly
  why it rejected the file. The legacy `errors: string[]` array is emitted UNCHANGED alongside it.
- `errorItems` flows through `readBoard`/`frizz.ts` → `board.ts assemble()` → `BoardSnapshot` +
  `BoardMeta` (so the repair affordance survives a board delta, not just the keyframe) → the
  TodosView banner, which renders a **Repair** button per `no-frontmatter` item.
- `repairThread({file})` RPC (`repair.ts`) validates the file is a real `.md` DIRECTLY under `.frizz/`
  (resolve + dirname===root guard; rejects `../`, `sub/`, absolute paths), refuses any file that
  already has a `---` block (repair is ONLY the missing-frontmatter case), then PREPENDS minimal
  frontmatter: `title` from the first `# H1` (else the filename slug), `status: active`, and a
  standing `status_text` flag that the status is unverified. Then a board rebuild.

CONSERVATIVE ON PURPOSE: repair NEVER infers status from prose. This morning's file said "DONE" in
bold — guessing wrong silently is worse than surfacing. `status: active` makes the thread visible;
if its agent is gone, the runtime crash-net cards it for human attention — the correct escalation.

RESIDUAL (accepted, documented): a Bash-written `.frizz/*.md` bypasses the file-tool hooks by design,
so the write-side can't prevent it — the read-side repair is the safety net that heals it in one
click.

## 2026-07-09: v2 worker contract — the session-first rebuild (fences + scratchpad; thread-file contract DELETED)
The maintainer settled frizz on a SESSION-FIRST model: threads ARE claude sessions and the human's
dashboard shows the session TRANSCRIPT. Queue membership is explicit: `question` hands off to the
human, `done` queues a checked completion, process-level blocks surface themselves, `awaiting`
excuses a machine wait, and bare rest stays quiet. The entire `.frizz/<slug>.md` ownership contract is
GONE: no thread files, no frontmatter, no `status`/`activity`/`status_text`, no `needs-human`, no
`blocked` machine fields, no `hasPlan`/`## Plan`, no `frizz-update`. Workers now SIGNAL through their
FINAL MESSAGE and PERSIST through a SCRATCHPAD. This is the cc-worker-side realignment.

**The new signal model (taught in `packages/server/src/workerPrompt.ts` §"End-of-turn signals" + `skills/worker/SKILL.md`):**
- **Bare rest is quiet** — a rested thread with no fence does NOT enter Needs-you and is not a human
  handoff. Human handoff is explicit via `question` (or a real process-level block).
- **` ```done `** — work complete + stands; body = 1–4 lines of what shipped + where. Renders a
  checked success card in the queue until explicit Archive; the fence MUTATES NOTHING
  (maintainer-settled), and a follow-up may still wake the worker.
- **` ```awaiting `** — waiting on a MACHINE (CI/PR/timer/session); body may lead with `kind: value`
  hint lines, kind ∈ pr|ci|timer|session. NEVER for a human wait.
- **` ```question `** — unchanged grammar (question / approval / multi / danger; trailing `- A. …`
  options + `Recommendation:`), now the ONLY handback-for-input; no status flip accompanies it.
- CONSISTENCY: the taught grammar matches the shared parser (`packages/shared/src/index.ts`
  `ThreadFence` kind ∈ done|awaiting, `AwaitingHint` kind ∈ pr|ci|timer|session). Opening line is
  exactly ` ```done `/` ```awaiting ` (nothing after the language word); exactly one fence, at the end.

**The scratchpad (`.frizz/threads/<session-id>/scratch.md`) — new §"Scratchpad" in both docs:** free-form
markdown, NO schema, NO validation. It is the worker's compaction-proof working memory (survive-
compaction to-do lists / work queues / Ralph-style epic checklists live here, not in ephemeral
context) AND the shared blackboard for parallel sub-agents (shared state is written into it; its PATH
is passed into every sub-agent prompt; helpers READ it, the worker folds their results back in). The
path is server-established convention already wired through `shared` (`scratchpadPath`), `router.ts`
(reads `.frizz/threads/<session_id>/scratch.md`), and `dispatch.ts`.

**Hooks changed:**
- **DELETED `hooks/thread-frontmatter-validate.mjs`** + its `hooks.json` PostToolUse `Edit|Write|
  MultiEdit` entry. It validated thread-file frontmatter (status vocab / gerund `activity` / machine
  fields) — a contract that no longer exists. Nothing left to validate on file edits.
- **DELETED `hooks/stop-flush.mjs`** (already UNWIRED since the 2026-07-02 Stop-hook removal; kept
  "for reference" then). Its sole job was nudging the worker to flush state into its thread FILE —
  dead with the thread-file contract gone. No `hooks.json` entry to remove (it was never re-wired).
- **`hooks/session-seed.mjs`** — reseeded to the v2 contract: signal via the final message (bare rest
  is quiet; done queues checked completion; awaiting excuses a machine wait; question asks) + the
  scratchpad, whose concrete path is derived from
  the SessionStart `session_id` (`currentSessionId(input.session_id)` → `.frizz/threads/<sid>/scratch.md`) and
  named in the seed. FRIZZ_THREAD gating + the cc double-hook `off`-sentinel defense KEPT verbatim;
  the compact re-grounding now points at the scratchpad, not a thread file.
- **`hooks/agent-dispatch.mjs`** — epilogue no longer says "don't edit `.frizz/` thread files or
  config.yml"; now "don't edit the dispatcher's scratchpad (`.frizz/threads/<session-id>/scratch.md`) — READ it for shared
  context if its path is in your prompt, report in your FINAL MESSAGE." Background/name-strip
  enforcement unchanged.
- **`hooks/deny-ask.mjs`** — redirect retargeted off `frizz-update … --status needs-human`: now "ask
  in your FINAL MESSAGE with ```question blocks, then rest; a question IS the handback (no extra
  fence)." Still PreToolUse(AskUserQuestion), FRIZZ_THREAD-gated, fail-open.
- **`hooks/deny-plan.mjs`** — redirect retargeted off "write the plan into your thread `.frizz/<slug>.md`
  + status: needs-human": now "write the plan into `.frizz/plans/<topic>.md` and/or the scratchpad;
  ask via a ```question approval block." PermissionRequest(ExitPlanMode) mechanism + the plan-mode
  softlock reasoning (dispatch.ts coerces plan→auto) unchanged.
- **`hooks/agent-bind.mjs`** — UNCHANGED (functionally). It records `agentId → thread` into
  `.frizz/.agent-bindings.jsonl` from a helper's `THREAD: <slug>` tag; that tag still rides the
  per-thread dispatch and references no dead status/frontmatter contract. NOTE for the server/tailer
  verticals: session-first sub-agent liveness is now TAILER-derived (`ThreadView.subAgents`), so the
  `.agent-bindings.jsonl` binding this hook writes may be VESTIGIAL. Left in place (harmless,
  fail-open, out of this vertical's delete scope) — a candidate for removal once the tailer path is
  confirmed to fully supersede board-side `bindingsByThread`.

**`skills/worker/SKILL.md`** — rewritten to the same pillars (version 0.2.0): the signal model
replaces the status-vocabulary sections; a scratchpad section replaces the "own ONE thread file"
sections; thread-type presets keep the research/audit/implementation/planning taxonomy but strip
every status reference (planning now delivers a `.frizz/plans/<topic>.md` artifact). The sub-agents
section adds "pass the scratchpad path into helper prompts." `skills/dialectic` untouched.

**`plugin.json`** description updated: no more "validate thread-file frontmatter"; now fence signals
+ scratchpad blackboard + sub-agent profiles + deny-ask/deny-plan.

**What the server/web verticals must know:** (a) FRIZZ_THREAD must keep being passed at spawn — every
hook still gates on it. (b) The scratchpad path convention is `.frizz/threads/<session-id>/scratch.md` where
`<session-id>` is the pinned `--session-id` (the same id the SessionStart hook sees as `session_id`);
the seed hook NAMES that concrete path to the worker, so dispatch must keep pinning `--session-id`.
(c) `packages/server/src/dispatch.ts` `composePrompt()` STILL emits the dead per-thread contract
("You own `.frizz/<slug>.md` … set `status: blocked` … Set `status: done`") — that is server-vertical
scope (not editable here), but it now CONTRADICTS the v2 WORKER_PROMPT and must be rewritten to the
fence/scratchpad model (or dropped) by the dispatch owner. Flagged to server-core.

## 2026-07-12: awaiting reversal — park only human/timestamp gates; keep automation active

The v2 rule above made `awaiting` a broad machine-wait bucket. In practice workers emitted a fence
for CI, bots, releases, and merge progression, then returned with no process actually owning the
next transition. The rail's hourglass therefore implied a watcher that often did not exist. The
contract is now narrower:

- `awaiting` is a deliberate PARK for either `human: <actor + exact external review/approval>` or
  `timer: <ISO-8601 instant>`. The dashboard operator's own decision remains `question`.
- CI, automated review, releases/deploys, merge queues, and already-authorized merge progression
  stay ACTIVE. Claude workers use a background `Bash` one-shot or `Monitor`; Codex workers keep a
  blocking exec session alive and poll it. Their completion/event re-invokes the worker.
- `pr:` / `ci:` / `session:` continue to parse so old transcripts do not break. The existing PR/CI
  waker remains a compatibility bridge, but workers must not create new waits with those hints.
  `timer:` remains the durable scheduler path across process/session restart. `human:` is descriptive
  and intentionally not auto-fired.
- Every follow-up clears the old fence. “Back to awaiting” requires a fresh check: re-emit a current
  human/timer fence, or re-arm automation and remain active.

Claude Code 2.1.207 was audited before teaching this. frizz does not pass `--tools`,
`--allowedTools`, or `--disallowedTools`, and its helper profiles only select model/effort, so wait
tools are available to top-level workers and helpers. `Monitor` defaults to 300,000 ms (maximum
3,600,000 ms); `persistent:true` runs until `TaskStop` or session end. Background Bash reports an
output path; `TaskOutput` exists but is deprecated, so workers should `Read` that path for diagnostics.
Both Monitor and background Bash are session/process-bound, which is why durable wall-clock checks
remain `timer:` fences. Helpers must not return a final handoff while they still own a live watcher;
the top-level worker owns long-lived CI/PR/merge progression.

## 2026-07-13: ordinary rest returns to Queue; human Snooze/Archive own triage

The quiet-bare-rest rule above was reversed after live use showed that an owned Frizz worker could
come to rest without choosing a fence and disappear from the only surface the operator routinely
triages. Queue membership is now server-derived from process rest, not dependent on perfect worker
signaling:

- Every owned, open session whose top-level turn is genuinely at rest enters Queue by default.
- A live child/Monitor still counts as in-flight work. A truthful external-human or future-timer
  `awaiting` fence remains dimmed in Held. Legacy CI/PR/session and hintless waits do not excuse rest.
- A human may durably Snooze an ordinary handoff (default one day, presets/custom exact instant) or
  Archive it. Due snoozes automatically re-enter Queue; Archive never does.
- Questions, permissions/native approvals, typed interactions, and crashes break through Snooze so a
  provider cannot be stranded behind an invisible hard gate. `done` remains the checked presentation,
  but it is still a resting handoff and can be snoozed.

The worker contract still teaches explicit `question`, `done`, and narrow `awaiting` fences because
they improve priority and presentation. A fence is no longer required merely to make a rested worker
discoverable.

## 2026-07-12: runtime release gate — real CDP evidence plus independent review

Major UI, server, and control-plane work may no longer reach `done` from unit/integration/mocked
evidence alone. The canonical `packages/server/src/workerPrompt.ts` contract now requires real Chrome CDP QA against
a disposable full stack, relevant active/idle/error/restart coverage, desktop+narrow screenshots,
console/network inspection, and an explicit correctness+aesthetics assessment. Chrome DevTools MCP is
preferred when it is available to the current provider; `agent-browser` or the repository Puppeteer
harness are explicit fallbacks. Mocked DOM/routes can supplement but cannot be the sole evidence.

Completion also requires two distinct review passes: the implementer's self-review of diff+evidence,
then an independent fresh-context adversarial review; confirmed findings are fixed and affected gates
rerun. The exception is proportional and narrow: trivial non-runtime docs-only or provably mechanical
changes may skip CDP/independent review, while uncertainty applies the gate. This rule is mirrored in
`skills/worker/SKILL.md` (v0.2.2) and the SessionStart seed; the backend-aware prompt contract test pins
all four delivered surfaces, and the Claude expansion golden changes intentionally. The Codex addendum
no longer mislabels an author's inline second read as independent review: use delegation when available,
or report the gate unmet.

## 2026-07-21: Plugin slim-down — one contract copy, gh is the only injected skill

The plugin stops shipping three of its four skills. `skills/worker` is DELETED: it was a second copy
of the worker contract whose single source is `packages/server/src/workerPrompt.ts` (the system
prompt, rebuilt on every dispatch/resume and compaction-immune) — every contract edit had to be made
twice, and the copies drifted. The session-seed pointer sentences that said "Load the `frizz:worker`
skill for the full contract" now point at the system-prompt contract only, and the contract tests pin
the two backend prompts (not a skill copy). `skills/dialectic` is dropped from the plugin (generic
methodology nobody wired into the seed or prompt; workers on other people's projects never asked for
it). `skills/adhoc-cdp` MOVED to the frizz repo's own `.agents/skills/adhoc-cdp` (agent-neutral; `.claude/skills/adhoc-cdp` is a symlink to it so Claude and Codex share one copy) — its content is
frizz-specific (adhoc-stack.mjs / shot.mjs), so it is a project skill, not global plugin cargo; the
generic "verify in a real browser" principle already lives in the prompt's runtime-gate section.
`skills/gh` remains the ONE injected skill: bulky, conditionally relevant, and its pointer is already
auth-gated in the seed — exactly the on-demand shape skills are for.

## 2026-07-22: The no-PR rule now also lives in AGENTS.md (docs, not a hook)

Root cause of "agents keep opening PRs despite FRIZZ.md": the worker contract + injected FRIZZ.md are a
SNAPSHOT frozen at session creation. The Codex worker that opened PR #17 and #18 (thread `862831cf`,
born 09:50 Jul 21) spawned minutes before FRIZZ.md injection first landed and hours before the no-PR
rule existed, so it never saw the rule and carried the base contract's "open a PR and report its URL"
on every turn. Editing FRIZZ.md does nothing for a session already in flight, and sub-agents never
receive FRIZZ.md at all.

Mitigation (docs only): the no-PR rule was added to `AGENTS.md` — the agent-neutral home Codex
re-reads FRESH every session and sub-agents load. That reaches NEW sessions of both backends without a
frozen snapshot. It does NOT retroactively reach an already-running frozen session; restart such a
session to pick up a rule change. A tool-layer enforcement hook (`deny-pr` PreToolUse) was built and
then deliberately reverted as overkill for a single-user repo — the doc reach is the intended fix.

## 2026-07-30: Carryover — a per-session brief the harness re-injects, so context survives compaction

The two existing mitigations for compaction loss both routed the context through a DECISION, and that
is where they leaked. The scratchpad survives on disk but only helps if the post-compaction turn
chooses to read it — a model decision, and it gets skipped. `precompact-instructions.mjs` steers the
summarizer, but the summary is a lossy retelling by a model that never saw the reasoning, and it is
regenerated from scratch every time. `carryover.mjs` removes the decision: whatever is in
`.frizz/threads/<sid>/carryover.md` is spliced into the context window by the harness, before the
model's first token. The model cannot forget to read it and the summarizer cannot paraphrase it away.

**The file is authored by the AGENT, not by the hook** — it is a plain markdown file written with the
Write tool. Rejected: a CLI (`frizz carryover set …`) and a dedicated MCP tool. Both add something to
learn and to keep installed, and neither buys anything over a file the agent already knows how to
write and a human can hand-edit mid-session (an edit is just an mtime change, which the nudge treats
exactly like an agent's write — pinned by a test).

**Keyed by session id**, taken from the hook's stdin `session_id` and falling back to
`CLAUDE_CODE_SESSION_ID` via the shared `currentSessionId`. Those two are equal (already relied on by
the activation sentinel), which is what lets the AGENT compute its own path from a Bash/Write call.
Stored beside the scratchpad rather than under `.frizz/.session-state/` because the agent is already
told the thread dir. `.frizz/` is gitignored in full, so a brief never reaches a commit, and nothing
enumerates `.frizz/threads/*` to build the board (threads come from the DB), so writing a directory
there for a non-frizz session cannot conjure a phantom thread card.

**Staleness is measured in context TOKENS, and as GROWTH, never an absolute.** The transcript's
newest usage record gives live context fill (`input + cache_creation + cache_read`); the hook reads
only the last 256 KB of the file, since transcripts reach tens of megabytes here. An absolute
threshold is unusable because the window is not knowable from a hook — a real compaction in this
project fired at preTokens 935,291 on a 1M-window session while a 200k session compacts near 160k.
Growth since the last write is window-independent and self-resetting. Wall clock and transcript BYTES
were both rejected: neither tracks context pressure (one large tool result adds megabytes to the file
without moving the window much).

**Why a nudge at all.** Without it the file is never written and the whole mechanism is decorative —
an agent that is never reminded does not stop to journal. It is the one part that is a heuristic, so
it is the one part with a cheap escape hatch: `FRIZZ_CARRYOVER_STALE_TOKENS` retunes it and
`FRIZZ_CARRYOVER=off` disables every mode.

**Registered twice, deduped deterministically.** The plugin registration ships to every frizz worker
everywhere. The repo's own `.claude/settings.json` carries the same three registrations with
`--via=project` so plain (non-frizz) `claude` sessions in this repo get the behavior too; that flag
exits when `FRIZZ_THREAD` is set, because such a session already loads the plugin and would
otherwise inject the brief twice. A flag plus an env check — no lock file, no race.

VERIFIED LIVE against cli 2.1.220, in an isolated `/tmp` project, not by proxy:
- `SessionStart:startup` fired (exit 0, 63 ms) and a real session quoted a sentinel that existed ONLY
  in the brief — with **zero tool calls** in the transcript, so it came from context, not a file read.
- A real `/compact` produced a `compact_boundary`, and `SessionStart:compact` then delivered a brief
  whose sentinel had been swapped to a value that had NEVER appeared in that session's context — so
  the post-compaction injection demonstrably re-reads the file rather than echoing the summary.
- `PreCompact:manual [carryover.mjs --mode=precompact] completed with status 0` in the hook debug log.
- The `UserPromptSubmit` nudge fired live and reported ~31k tokens computed from the real transcript,
  confirming the usage parser works against Claude Code's actual format and not just a fixture.

Regression net: `packages/server/src/carryover-hook.test.ts` executes the real script over its
wire contract (argv + stdin JSON + stdout) rather than asserting on its source.

## 2026-07-30 (same day, revised): carryover COLLAPSED into the scratchpad; the nudge moved mid-turn

The `carryover.md` brief shipped earlier today was redundant with the scratchpad and made the worker
maintain two overlapping documents (maintainer's call, and correct). ONE doc per thread is the rule.
`carryover.mjs` is DELETED and replaced by `scratchpad.mjs`, which does the same three things to
`scratch.md` — the pad the dispatcher already provisions, already names in the system prompt, and
already forbids sub-agents from writing.

Two behavior changes fell out of the retarget:

**Injection is scoped to the context-losing sources.** A brand-new `startup` has lost nothing, so it
gets the contract text only; `compact`/`resume`/`clear` get the pad's head injected verbatim PLUS an
explicit "re-read the full file" pointer. Injecting the head rather than only pointing at the file is
deliberate: a bare reminder routes recovery through a decision the model can skip, which is the exact
failure being fixed. The head is the floor; the pointer is the ceiling. The cap (12k chars, was 24k)
keeps that floor affordable now that the target is unbounded working memory rather than a bounded brief.

**"Present" no longer means "written".** frizz provisions scratch.md with a skeleton, so file-absence
is gone as the unwritten signal. `substanceLength()` strips headings, the provisioned orientation line
and empty task boxes, and measures what remains. It is a heuristic on purpose — it only decides
whether to NUDGE, so a wrong call costs one redundant reminder, never correctness.

**The nudge now also fires on PostToolUse, and that is the real fix.** UserPromptSubmit alone only
fires at turn boundaries, and a frizz worker runs enormous autonomous turns — dozens of tool calls
between human prompts — so a whole session's work could compact unpersisted without a single nudge.
PostToolUse `additionalContext` was verified live against cli 2.1.220 (a real session quoted a
sentinel injected after a Bash call, and through the plugin the model received the nudge mid-turn and
said it would update the pad). Both channels share one state file, so the interval is global: firing
per tool call makes the existing budget land SOONER and mid-turn, it does not multiply reminders.

### Researched: there is NO context-pressure hook, on either backend

Measured, so do not go looking again. Claude Code 2.1.220 exposes **31 hook events** and not one
signals an approaching context limit; **no hook input carries a token count at all**, and the docs say
plainly to poll the transcript yourself. Codex is the same. So the fill is computed here from the
transcript's newest usage record (`input + cache_creation + cache_read`), reading only the file's tail
because transcripts reach tens of megabytes. Growth-since-last-write remains the metric because the
window is not knowable from a hook.

Useful events noticed while enumerating, none wired yet: `PostToolBatch` (fires after a batch of
parallel tool calls resolves, before the next model call), `SubagentStart` (could carry the
read-only-pad rule structurally instead of via the dispatch epilogue's prose), `PostCompact`
(receives the summary), and `SessionStart`'s `initialUserMessage` output (injects a VISIBLE user
message rather than a system reminder) and `fork` matcher.

### Rejected: a blocking Stop gate

A Stop hook could refuse to let the worker rest until it writes. That was tried and removed on
2026-07-02 (maintainer's call): the block-until-file-edited nag forced even trivial workers into
Read/Edit dances that render as noise in the chat UI. This nudges; it never blocks.

### Verified feasible, NOT yet built: the background checkpoint fork

`claude -p --resume <sid> --fork-session` was tested end to end. The fork carries the FULL original
conversation (it reproduced a human quote that existed only in that transcript), it wrote to the
ORIGINAL thread's scratchpad when handed the absolute path, the original transcript was
**byte-identical before and after** (15,078 → 15,078 — the live session is never interrupted), the
original continued normally afterwards, and it is cheap because it HITS THE PROMPT CACHE (28,904
cache-read vs 413 cache-create). `SessionStart` has a `fork` matcher so hooks can tell they are in one.

Open problems before this could ship: the fork gets a NEW session id, so it must be handed the
ORIGINAL pad path explicitly (its own hooks would derive a different one); concurrent writes against
the live worker need an ownership rule; the spawn needs a single-flight lock so one threshold crossing
cannot fan out into many forks; and frizz's discover/tailer must not adopt the fork's transcript as a
board thread.

### Codex parity gap

Codex 0.144.6 (installed) HAS a hooks system with nearly the same schema — SessionStart, SessionEnd,
PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, PreCompact, PostCompact,
SubagentStart, SubagentStop — plus `additionalContext`, all confirmed present in the installed binary.
Config lives at `~/.codex/hooks.json` or `[hooks]` in config.toml, repo-level `.codex/hooks.json`, or
plugin-bundled. SessionStart distinguishes a `compact` source. Codex is BETTER in one respect: it lets
you SET the compaction threshold (`model_auto_compact_token_limit`, with
`model_auto_compact_token_limit_scope` = `total` | `body_after_prefix`), so compaction can be made
predictable with headroom rather than merely detected. Wrinkle: codex enforces hook TRUST
(`--dangerously-bypass-hook-trust` exists for automation). **frizz currently wires ZERO hooks for
codex**, so a codex worker has only prompt-level scratchpad discipline — the largest remaining gap.

## 2026-07-30 (third pass): reinforcement is OPT-IN, and the two backends are gated differently

> **SUPERSEDED the same day by the fourth pass below** — the opt-in gate was REMOVED. Re-grounding is
> unconditional now. The measured codex findings in this entry all still hold; only the gating does not.

Maintainer's call: the mechanism is opinionated, so it should be chosen rather than inherited. New
`scratchpadReinforcement` setting, **OFF by default** — the inverse of `runtimeGate` /
`autoResumeOnLimit`, which are opt-OUT. (Both of those settings were deleted on 2026-08-03 — see the
last entry in this file — so this comparison is historical.) Toggle sits in the Settings drawer under
"Auto-resume after usage limits". `scratchpad.mjs` inverted its kill switch into an opt-in gate:
absence means off.

**The two backends cannot be gated in the same place**, which is the whole design constraint here:

- **Claude → a worker ENV VAR.** `hooks.json` is static, so `FRIZZ_SCRATCHPAD_HOOK=on` is what decides
  whether the registered hooks do anything. Stamped on the tmux spawn, and on the broker/SDK path via
  a new per-fork `extraWorkerEnv` on `ClaudeAgentBrokerBridge` — evaluated per fork, so flipping the
  setting reaches the next dispatch or cold-resume without a server restart.
- **Codex → per-conversation CONFIG**, on the `config` override `CodexAppServerBridge` already
  supported, plus a `--enabled` flag. The env var is unusable there because the `codex app-server`
  daemon is SHARED per project and its environment cannot express a per-conversation decision;
  building the config at all already means the setting is on.

### Measured, so nobody re-derives it (codex-cli 0.144.6)

- **`codex exec` runs NO lifecycle hooks, from any discovery path** — not `<repo>/.codex/hooks.json`,
  not `$CODEX_HOME/hooks.json`, not `-c hooks.…`, with or without `bypass_hook_trust=true`, inside a
  git repo or outside one — even though the `hooks` feature flag reports as enabled. Probed with a
  marker file so "did the hook RUN" stayed separate from "did its output reach the model".
- **`codex app-server` DOES run them** when they arrive as config overrides. Verified through the real
  `CodexAppServerBridge` with the real `scratchpad.mjs`: SessionStart, UserPromptSubmit and Stop all
  fired. Probe kept at `backend/_live_codex_hooks.mts`.
- **`bypass_hook_trust` is required** — codex SILENTLY SKIPS untrusted hook definitions, so without it
  the config is delivered and ignored, which looks exactly like a broken feature.
- **Codex reports its OWN rollout session id to the hook** (e.g. `019fb427-…`, `transcript_path` under
  `~/.codex/sessions`), NOT frizz's thread id. Hence the mandatory `--session=<frizz sessionId>`:
  deriving the path would address a scratchpad that does not exist, and the worker would look
  unreinforced for a reason nobody could see. Codex does send `source` (`"startup"`), same field name
  as Claude, so the compact/resume branch works unchanged.
- **Codex has no PreCompact/PostCompact context-injection wire type** (only SessionStart /
  UserPromptSubmit / PostToolUse / PreToolUse / PermissionRequest / SubagentStart), so the
  summarizer-steering channel stays Claude-only.

### Known gap, deliberately not papered over

The codex NUDGE cannot fire yet: staleness is computed from Claude's transcript shape
(`message.usage`), and a codex rollout is a different format, so `contextTokens()` returns null and
the nudge degrades to SILENCE rather than to a wrong number — pinned by a test. Closing it needs a
rollout-aware token parser. The load-bearing channel (restoring the pad on SessionStart) works on both.

## 2026-07-30 (fourth pass): the gate comes OFF — the scratchpad is canonical, so re-grounding is not optional

Maintainer's correction, and it reverses the third pass's central decision: the thing that deserves an
opt-in is the FORK-based auto-updating (still unbuilt, and called "a little overkill"), NOT the
re-grounding. The scratchpad is the CANONICAL document for a thread, so reading it back after a
compaction is what makes the pad worth writing at all — a posture no project should have to opt into.

The bug this fixes is worse than a mis-scoped setting: `scratchpadReinforcement` defaulted to FALSE, so
the DEFAULT worker — every worker, in practice — got nothing back after a compaction. The mechanism was
shipped and inert. A feature that is off by default is a feature that does not exist.

Removed entirely: the `scratchpadReinforcement` setting (shared schema, server defaults, Settings
drawer toggle), the `FRIZZ_SCRATCHPAD_HOOK=on` env plumbing (`scratchpadHookEnv`, the tmux spawn stamp,
the broker bridge's `extraWorkerEnv` dep), and codex's `--enabled` flag. A dead toggle that gates
nothing is worse than no toggle; when the fork checkpointer is built it brings its own setting.

What survives: `--session=<frizz sessionId>` on the codex path stays MANDATORY (codex reports its own
rollout session id, so the derived path would address a scratchpad that does not exist), and
`bypass_hook_trust` stays required (codex silently skips untrusted hook definitions). The escape hatch
is now `FRIZZ_SCRATCHPAD_HOOK=off` — env only, and only an explicit off value disables, because it is
for a one-off session, not a project posture.

Behavior change beyond ungating: **an EMPTY pad now re-grounds too.** Previously a compaction with an
unwritten pad fell through to the generic contract text; now it says plainly that context was just
lost, that the pad is the canonical record, to re-read it NOW, and that it currently has nothing in it
so it must be written. "You lost your context and your pad is empty" is the most actionable thing the
next turn can hear, and staying quiet about it left the worker with nothing at the exact moment it had
nothing.

VERIFIED against a real `/compact` with NO env var and NO flag set anywhere: `SessionStart:compact`
exit 0, delivering the re-grounding lead plus the pad head carrying a sentinel from the file. 17 hook
tests; full suite 2419 pass / 0 fail; typecheck clean.

## 2026-07-30 (fifth pass): the worker CONTRACT now explains what the scratchpad is FOR

The hooks made the scratchpad load-bearing, but the shipped worker contract still described it as a
place that "survives compaction" and handed over a path. That undersells it in the way that matters:
a worker told "here is a file that survives compaction" writes a task list; a worker told "this is the
canonical record of the thread and your compaction-survival mechanism" writes the REASONING, which is
precisely what compaction destroys and what a summary cannot reconstruct.

Rewritten in all four places a worker meets the pad, so the framing is consistent wherever it lands:

- `workerPrompt.ts` `SCRATCHPAD` (both backends) — now headed "the canonical record of this thread",
  and says plainly WHY: compaction drops the reasoning first (the plan, the alternatives ruled out,
  why the human chose what they chose), a summary preserves what you did and not why, so write that
  here AS YOU GO and re-read the file after any compaction or resume. Enumerates what belongs in it.
  The claude variant keeps the sub-agent blackboard job and now states that helpers READ but never
  EDIT it — the one-scratchpad rule, said where the worker actually reads it.
- `dispatch.ts` `scratchpadOrientation()` (system-level, rebuilt on every resume) and the first
  user-message line — same framing, one sentence each.
- `dispatch.ts` `scratchpadContent()` — the provisioned skeleton's own orientation line.
- `cc-worker/hooks/session-seed.mjs` — the runtime `SCRATCHPAD:` line.

**Deliberately NOT promised: automatic re-injection.** The prompt says frizz "helps by feeding the head
of this file back into your context", and the IMPERATIVE it gives is unconditional — re-read the file
yourself after any compaction or resume. A contract that leans on a runtime guarantee degrades badly
wherever that channel is absent, and one such gap is known: codex's `thread/resume` does NOT re-send
the per-conversation `config`, so a COLD-resumed codex thread (frizz restart, app-server daemon death)
may lose its hooks. Unverified either way — flagged, not assumed.

Fallout fixed in the same change (the hook's own template detector): `substanceLength()` recognised the
provisioned skeleton by a `^(Your|SCRATCHPAD:)` prefix plus the old wording. The new orientation line
starts differently, so a freshly provisioned pad read as WRITTEN — which made an empty pad skip its
re-grounding branch and made the summarizer swallow a skeleton. It now matches on the concept
(`compaction-survival mechanism|compaction-proof working memory`), which is also backward compatible
with pads already on disk under the old wording.

Goldens regenerated (a deliberate contract change); the diff is the scratchpad section and nothing
else. Two `dispatch.test.ts` assertions re-anchored — they pin the claude-keeps/codex-drops blackboard
asymmetry and were using the retired phrase as their anchor; the behavior they check is unchanged.
Suite 2413 pass / 0 fail, typecheck clean.

## 2026-07-30 (sixth pass): keep the helper epilogue universal

`hooks/agent-dispatch.mjs` appends its epilogue to every Claude `Agent` helper launched by a frizz
worker, regardless of the repository or kind of task. That makes it the wrong layer for requirements
about compilation, shared build locks, build/test ownership, or how long-running operations should
be managed.

The epilogue keeps only universal coordination: return a useful handoff, do not mutate the owning
worker's `.frizz/` state unless explicitly assigned, and use the always-available `SendMessage`
upward channel when the dispatcher acting mid-flight could change the outcome. Task-specific
verification and process-lifecycle instructions belong in the dispatch prompt; repository-specific
ones belong in the repository's own guidance. Background dispatch enforcement and `name` /
`team_name` stripping are unchanged.

Correction during implementation: the first reduction also removed `SendMessage`. That was too
aggressive. Every helper receives the tool, and reaching the dispatcher before returning is
universally useful orchestration rather than repository policy. The restored wording treats it as
available directly and therefore drops the old deferred-tool / `ToolSearch` caveat.

## 2026-07-30 (sixth pass): the operator's Settings instructions move to the SYSTEM prompt

Question from the maintainer: is FRIZZ.md eagerly loaded, and did the Settings prompt get replaced by
it? Answer, from the code: **both exist, neither replaced the other** — and they were being treated
very differently.

- **FRIZZ.md** → `frizzConfigBlock(projectDir)` → `extraSystemPrompt` at EVERY site (claude dispatch,
  codex dispatch, adopt, resume, broker follow-up, router follow-up). System-level, so it already
  survives compaction and is rebuilt on every resume. Nothing to fix.
- **The Settings preamble** (drawer label "Subagent instructions", schema field `dispatchPreamble`) →
  `composePrompt()` → the **FIRST USER MESSAGE** only. Never re-applied on resume, and the first user
  message is exactly what compaction replaces with a summary. So the repo's conventions survived while
  the operator's own standing instructions quietly did not.

Fixed by giving it the same treatment as FRIZZ.md: new `operatorInstructionsBlock(preamble)`, added to
the system-prompt composition at all six sites, and REMOVED from `composePrompt` (which loses its
`customInstructions` parameter). Moved rather than duplicated — leaving it in both would carry a second
copy of a potentially long preamble in context for the whole pre-compaction window, and the block sits
ABOVE the task banner either way, so the visible chat bubble is unchanged.

Two things fall out for free: an edited setting now reaches a thread that is ALREADY RUNNING (the
system prompt is rebuilt on every resume), and the block states its relationship to FRIZZ.md — follow
both, prefer the more specific where they genuinely conflict — so a worker meeting two operator-authored
surfaces knows how to reconcile them.

VERIFIED with a real `/compact`: a sentinel placed in `--append-system-prompt` was still readable by the
model after the compaction boundary (`compact_boundary` present in the transcript, model returned
`SORREL-EGRET-4402`). That is the property the move depends on, tested rather than assumed.

One test needed real rework rather than a signature patch: `server.test.ts` asserted the preamble
appeared in the composed first message — the exact behavior being moved — so it now asserts the
opposite plus a dedicated `operatorInstructionsBlock` test. A second (`dispatch.test.ts`'s banner test)
used `PROJECT INSTRUCTIONS` as its above-the-banner anchor; on an ABSENT string `indexOf(...) < banner`
passes VACUOUSLY (-1 < banner), so it was re-anchored on the scratchpad line and given an explicit
`doesNotMatch` instead. Suite 2460 pass / 0 fail, typecheck clean.

## 2026-07-30 (seventh pass): converge on FRIZZ.md — the Settings preamble is GONE

Maintainer's call, one pass after making the preamble durable: rather than maintain two
operator-authored surfaces, keep the one that is already versioned with the repo. `dispatchPreamble`
(drawer label "Subagent instructions") is deleted outright — schema, server default, the drawer field
and its draft plumbing, `operatorInstructionsBlock` and all six of its call sites.

**FRIZZ.md is now the ONLY place project conventions live.** It was already the better surface and
needed no work: `frizzConfigBlock()` puts it in `extraSystemPrompt` at every site (claude dispatch,
codex dispatch, adopt, resume, broker follow-up, router follow-up), so it survives compaction and is
rebuilt on every resume. It is also reviewable in a diff, travels with a clone, and can differ per
branch — none of which a value in a local SQLite settings blob can do.

Checked before deleting rather than after: `DEFAULT_PREAMBLE` shipped as `""`, and a read of every
`~/.frizz/projects/*/ui.db` found no project with a non-empty `dispatchPreamble`. So there is nothing to
migrate and no operator text is silently dropped. `Settings` is a plain `z.object`, so an older blob
that still carries the key parses fine — zod strips the unknown field.

Fallout fixed in the same change, since it was this change that made them false: two dispatch.ts
header comments still described the preamble as the prompt's "orchestration wisdom", and
`SettingsDrawer.test.ts` iterated a help-key list containing `subagentInstructions`. The
`operatorInstructionsBlock` test added one pass earlier was removed with the function.

Suite 2419 pass / 0 fail (two timing-sensitive tests — `app-socket` coalescing and the tmux SIGKILL
buffer — flaked under parallel load and pass in isolation; neither touches this change), typecheck
clean, and the drawer was re-driven in a real browser: the field is gone, and the Prompts section
measures as exactly two children at the standard 24px `gap-6` with no orphaned container left behind.

## 2026-07-30 (eighth pass): native Codex children merge the shared scratchpad

An apparent post-compaction continuity failure in thread `9540edc3-4807-4bb0-8e36-5940f92b452b`
was not path loss and was not Claude's on-disk token broker. The affected thread was a Codex session.
At its first compaction the worker immediately read the correct exact path; at a later compaction it
again addressed the correct path and got `ENOENT`. The directory and sibling artifacts remained.

The missing file was child corruption. Native child `/root/auditstatus_prepare`, launched with
`fork_turns:"none"`, still inherited the parent's developer-level `SCRATCHPAD:` mandate. It reasoned
"Planning isolated scratch creation" and replaced the parent's exact pad with its own `# SEA corpus
preparation` notes. Two minutes later it noticed the mistake, reasoned "Reverting unauthorized root
scratch changes", and tried to remove its replacement. A shell `rm -f` was denied, but its fallback
`apply_patch` `*** Delete File` succeeded. It could not restore the content it had overwritten, so the
pad remained absent until the root compacted nearly an hour later. `fork_turns:"none"` removes
conversational turns; it does not remove the root worker's base/developer instructions.

The deliberately prompt-level fix preserves the useful part of that inheritance:

- The Codex worker contract, system orientation, and first task message now make the pad explicitly
  collaborative. Children may read it and persist their own progress, but every edit is a merge:
  re-read first, patch only a scoped agent/task section, and preserve all existing state. Every
  native-child dispatch restates that rule.
- Codex registers `scratchpad.mjs --mode=subagent-start` as a `SubagentStart` hook. It injects the
  child-only epilogue structurally on every native dispatch: the child may update its scoped progress,
  but may never delete, truncate, reinitialize, move, or replace the whole file — including as cleanup
  or rollback after a mistake. This fixes the observed failure without a filesystem guard or a
  single-writer restriction.
- Newly provisioned pads recommend a light structure rather than enforce a machine schema: Goal,
  Task list, Decisions, Shared context, per-agent progress, Verification, and Next action. A visible
  legend uses `[ ]` pending, `[/]` in progress, `[x]` complete, `[-]` cancelled, and `[?]` blocked.
  Frizz's Markdown renderer recognizes all five while the source stays readable in Obsidian/plain text.
- If a pad is unexpectedly absent or empty after compaction/resume, the re-grounding injection says
  the exact path is authoritative, forbids searching neighboring thread pads or broadly reloading repo
  docs, and tells the root to reconstruct from the retained summary plus directly named handoffs.

The root's apparently confused recovery is now explained too. The post-compaction hook correctly
reported that the pad had no substantive content, and the root's first call addressed the correct
exact path and got `ENOENT`. Only then did it search worktrees, list the surviving thread directory,
and read older handoffs to reconstruct state. Its "Writing initial scratch file" reasoning label was
model narration for recreating a currently absent file, not evidence that no pad had existed before.

## 2026-07-31: shared scratchpad updates are expected, not merely permitted

The collaborative contract above said children *may* update the shared scratchpad. A root worker then
treated batch file ownership and a dynamic-orchestrator mega-doc's single-writer rule as reasons to
centralize scratchpad writes and even make the pad immutable. That was the opposite of the intended
blackboard pattern.

The worker contract, dispatch orientation, Codex child hook, and Claude dispatch epilogue now say each
sub-agent should merge its own scoped progress as it works. Deliverable file ownership never includes
the Frizz scratchpad, and a root must reconcile concurrent scoped updates rather than act as sole
writer. The existing merge-safety rules remain unchanged: re-read first, preserve all other content,
and never delete, truncate, reinitialize, move, or replace the pad.

## 2026-07-31: the epilogue teaches a helper how to collect a helper of its OWN

A three-level dispatch tree read, on the board, as one job done three times — root "Improve server
logging…", child "Researching dev server readouts", grandchild "Survey dev server readouts". The
topology was actually sound: the root's task had five research prongs, the child kept four (Vite,
Next and wrangler source, repaint techniques, log-dir conventions, frizz's own state-dir convention)
and delegated only the pure-web prong. The grandchild's prompt was a strict subset, not a copy.

What was broken was COLLECTION. The child backgrounded its helper, then hand-rolled a wait loop over
`/private/tmp/claude-<uid>/<proj>/<session>/tasks/<agentId>.output`. That path is a **symlink** into
`~/.claude/projects/<proj>/<session>/subagents/agent-<id>.jsonl`, so `stat -f %z` without `-L`
returned the LINK's size — 153, the length of its target path — and `stat -f %m` returned the link's
frozen creation mtime. Its other predicate, `grep -c '"type":"result"'`, is a known false negative
because that record is not reliably written. Both halves false-negatived at once: a helper that was
195 records and 413,723 bytes deep read as `size=153 age=325s results=0`. The child concluded "the
helper's transcript is stale at only 153 bytes", discarded a live agent, and redid its work — which
is precisely why all three levels appeared to be doing the same thing.

The audience was the root cause. `workerPrompt.ts` does carry the rule ("keep fan-out shallow: a
rested sub-agent is not reliably re-woken by grandchildren"), but that contract reaches only the ROOT
worker — the one agent that does not spawn grandchildren — and the contract itself states children
inherit none of it. Into that silence an inherited user-level `CLAUDE.md` ("the parent stays awake and
polls the child's transcript inside its own turn") supplied the polling recipe, overriding the Agent
tool's own result text ("you will be notified automatically when it completes").

`hooks/agent-dispatch.mjs` is the fix's home because it fires at EVERY depth — verified against the
real transcripts: both the depth-1 and depth-2 children received the epilogue. It is the only seam
that reaches a nested dispatcher without depending on its parent remembering to restate the norm. The
new paragraph states that a helper's completion arrives automatically, forbids hand-rolled wait loops
over a transcript or `.output` path, names the symlink and `"type":"result"` failure modes concretely
enough that a model cannot rationalize its way back into polling, and asks a dispatcher to give its
helper a `description` naming the narrower slice so the tree stays readable.

This stays within the universal-coordination boundary set on 2026-07-30: it is agent-lifecycle
coordination, like the handoff contract and the `SendMessage` upward channel already in the epilogue,
and imposes no build, test, git, or repo-specific policy. Rejected: denying depth-2 dispatch in the
hook (too blunt — the decomposition was good, and this hook exists because a worker MAY spin up
helpers), and rewriting the deliberate "keep fan-out shallow" line in `workerPrompt.ts`.

`packages/server/src/agent-dispatch-hook.test.ts` is new — this hook had no test at all despite being
load-bearing. It spawns the real hook over the real stdin contract and pins the foreground denial,
`name`/`team_name` stripping, endsWith-idempotence (including the prompt that merely QUOTES the
marker), the nested-dispatch paragraph, the retained coordination text, the non-worker inert path,
and fail-open on bad input.

## 2026-07-31: REJECTED — a Stop hook that nudges a fenceless rest toward a ```question card

Built as `hooks/fence-stop.mjs`, landed, then ripped out the same day on the maintainer's call: the
approach is inelegant and they do not want it. Do not rebuild it. Recorded here only so the next agent
does not re-derive the same idea from the same symptom, and because one measurement is worth keeping.

THE MEASUREMENT STANDS, whatever is done about it. A scan of 532 real worker transcripts (session ids
cross-referenced against every `~/.frizz/projects/*/ui.db`), 4,709 rest turns:

  rest turn      #1    #2-3   #4-6   #7-10  #11-20  #21+
  ```question    23%    22%    20%     20%     16%    9%
  ```done        31%    23%    17%     13%     10%    2%
  no fence       45%    53%    58%     60%     68%   83%

Fence use decays with session DEPTH, not with compaction — turns before a compaction boundary are
already 82% fenceless, so the decay is complete before any summary is written, and compaction only
correlates because only long sessions reach it. 9.8% of fenceless rests close by handing a decision
back in prose ("your call", "want me to …?"), which renders as a card with nothing to click.

Two incidental findings worth keeping, since both cost a debugging cycle:
- The Stop payload carries `last_assistant_message` and `prompt_id` (cli 2.1.220). The transcript is
  written ASYNCHRONOUSLY, so at Stop time the message that just ended the turn is often not yet on
  disk — a hook that parses `transcript_path` to read the final message fired on only two of four
  live broker workers. Read the payload.
- Stop-hook feedback reaches the model but never the human: frizz drops `isMeta` user records
  (`packages/server/src/transcript.ts`), so a blocked rest shows the worker's original message
  followed by whatever it sends next, with no visible trace of the hook.

## 2026-08-03: the Runtime QA gate is DELETED, and the settings drawer stops duplicating the composer

Maintainer's call, verbatim: *"This is obviously something that should not be a global setting inside of frizz. This is extremely overfit to our specific requirements inside of this repo. Wipe it entirely."*

Three removals, one theme — Frizz's shipped worker contract states frizz MECHANICS, and everything else belongs to the repo or to the dispatch that starts the thread.

- **`runtimeGate` (setting) + `RUNTIME_GATE` (prompt module) — gone.** The browser-QA loop (drive it in Chrome, screenshot into the handoff, escalate to an adversarial reviewer) was frizz's own engineering norm shipped to every worker Frizz dispatches anywhere. That is what `FRIZZ.md` / `CLAUDE.md` are for: `frizzConfigBlock` already injects a repo's own conventions into every spawn/adopt/resume, and this repo keeps its full browser-QA section there. What remains in the shipped contract is the repo-agnostic line that was already in the Quality bar — *"Verify behavior end-to-end before calling anything done."* `VISUAL_EVIDENCE` **stays**: it documents Frizz's guarded local-image proxy, a platform capability, not a QA policy. `chrome-devtools` also stays always-mounted — giving a worker a browser is a capability, not an opinion about when to use it. **(Reversed 2026-08-26 — see the entry at the end of this file. The reasoning above survives one step further than it should have: mounting a browser is itself an opinion, and it was billed to every worker in tokens.)**
- **Model + Effort — removed from the settings drawer.** They are chosen per dispatch in the prompt box (`DispatchPreferences`, one profile per runtime); a second global copy only made it ambiguous which one applied. `Settings.model` / `Settings.effort` survive on the wire: `dispatch-preferences.ts` still seeds the composer's first-run profile from them and `dispatch.ts` still falls back to them for GitHub batch dispatch.
- **`autoResumeOnLimit` — gone; auto-resume is unconditional.** A thread cut off mid-turn by an exhausted subscription window always gets its own "continue" when the window rolls. `ThreadView.limitPause.autoResume` survives on the wire but is now purely a STALENESS verdict (`resolveLimitPause`): a fault old enough that the wake will never arrive stops promising one.

Both settings keys are simply absent from the `Settings` zod object now. The object is non-strict and `getSettings` re-parses `{...defaults, ...stored}`, so an old DB carrying either key has it stripped on read — no migration.

## 2026-08-04: a helper does NOT fan out again unless its prompt said to

Maintainer's call: the prompt a sub-agent receives should tell it to refrain from spinning up sub-agents of its own unless it was explicitly instructed to.

Nesting had never been *encouraged*, but nothing ever told a child not to. The Claude epilogue spoke about a helper's own helper only in the conditional — *"If you dispatch a helper of your own, its completion is delivered to you automatically…"* — which is collection advice that reads as neutral permission, and the 2026-07-31 entry above shows what a child does with permission: it decomposes again because it can. The root worker contract's *"keep fan-out shallow"* line does not help, because it reaches only the root.

The rule now LEADS both child-facing epilogues, with the collection paragraph kept for the case where a prompt does ask for a helper:

- **Claude — `hooks/agent-dispatch.mjs`.** The epilogue's last paragraph opens with *"Do the work yourself: do NOT dispatch sub-agents of your own unless your dispatch prompt explicitly tells you to"*, then names the cost (it splits the context the dispatcher assembled, buries the work further from the board, and leaves the child collecting a handoff instead of doing the task). The old paragraph follows, re-hinged on *"If your prompt DOES ask you to dispatch a helper"*. This hook fires at EVERY depth, so the rule reaches a depth-2 dispatcher without depending on its parent to restate it.
- **Codex — `hooks/scratchpad.mjs --mode=subagent-start`.** Same rule, named for `spawn_agent`, appended to the `SubagentStart` context as its own `⟦no fan-out of your own⟧` block so it does not blur into the scratchpad merge contract. `SubagentStart` is the only structural seam that reaches a native codex child, exactly as the dispatch epilogue is for Claude.

This is a PROMPT-level default, deliberately NOT the hook-level depth-2 DENY rejected on 2026-07-31 as too blunt: a dispatcher that genuinely wants a prong fanned out says so in the prompt and the child dispatches, unmodified. Also left alone: `workerPrompt.ts` — the root contract already authorizes fan-out *"when work genuinely decomposes"*, and the root is the one agent whose fan-out is wanted.

Pinned by a new test in `agent-dispatch-hook.test.ts` (the lead-with-the-default wording plus the re-hinged conditional) and one in `scratchpad-hook.test.ts` (the codex block).


## 2026-08-06: the canonical scratchpad is DELETED — a free scratch directory, and compaction recovery moves to the recurring prompt

Frizz provisioned one canonical `scratch.md` per thread and a `SessionStart` hook spliced its HEAD into
the context window after every compaction. The argument for the injection was sound and is worth
restating, because it is what any replacement has to answer: a bare "remember to read your scratchpad"
routes recovery through a decision the model can skip, which is exactly the failure the pad existed to
prevent.

It still lost, on three counts. It made a MAINTAINED FILE the price of admission for every worker,
including the ones whose whole task was one edit. It needed a merge-only contract per backend to stop
sub-agents clobbering the one document — an epilogue in `agent-dispatch.mjs`, a `--mode=subagent-start`
epilogue for codex, a legend line in every provisioned pad, and a paragraph of the worker contract, all
of it policing a hazard rather than removing it. And the injection was INVISIBLE to the operator, who
could neither see what their worker would be handed nor change it.

**What replaced it, maintainer's design:** the thread gets `.frizz/threads/<session-id>/` as a free-form
scratch DIRECTORY — nothing provisioned into it, no reserved filename, no format — and compaction
recovery moves to `mcp__frizz__recurring_prompt`'s new POST-COMPACTION trigger (scheduler SOURCE 7,
landed the same day). The worker writes whatever doc it likes and LINKS it in the prompt; frizz re-sends
that text the instant the context is summarized away. Durable in SQLite, visible and editable in the
thread footer, and the worker chooses what it gets back.

The sub-agent story falls out for free: **one file per writer**. There is nothing to merge, so there is
nothing to clobber, and the entire merge contract is deleted rather than reworded. Both child epilogues
now say "write your OWN file; never edit or delete a file another agent wrote". The delegated-authority
carve-out ("write only <path>" must not forbid the child's own coordination file) MOVED out of the
worker contract and into the two epilogues that actually reach a child — it is pinned in
`agent-dispatch-hook.test.ts` and `scratchpad-hook.test.ts` rather than in the contract goldens.

**The accepted cost, stated plainly rather than engineered around.** The maintainer chose this over a
hybrid that kept a canonical doc, knowing compaction recovery degrades from a guaranteed injection to a
pointer the model can skip. So the hook now NAMES the files in the directory and never their content
(`scratchpad-hook.test.ts` pins that a body written into a scratch file does not appear in the
injection). Re-growing that listing back into a content injection would restore exactly what was
removed. The guaranteed channel is the arming, and every surface that mentions the directory also
mentions `post_compaction: true`, because a folder nothing ever reads back is a folder of notes nobody
opens.

**Two migrations that cost nothing.** `discover.ts`'s transcript-recovery sentinel shortened from
`threads/<id>/scratch.md` to `threads/<id>/` — the new string is a PREFIX of the old one, so every
transcript written before today still matches and no live thread lost its recovery path (pinned by
`discover.test.ts`). And the Doc tab now renders the directory: files concatenated under a heading
each, newest first, dotfiles excluded (frizz's own `.scratchpad-state.json` is not the worker's notes),
binaries named rather than inlined, with per-file and total caps that say when they truncated. It is
gated on the directory being NON-EMPTY rather than merely present, since dispatch now creates it empty
and "exists" stopped meaning "the worker wrote something".

## 2026-08-25: the prompt box's model + effort profile is the MACHINE's, not the project's

Maintainer: *"Changing the model and effort in a prompt box. That should be remembered, that new setting, but it should also be applied globally across all projects."* It was remembered — `DispatchPreferences` has been durable since the composer grew the selector — but in the per-project SQLite `settings` row, so one server serving N projects showed N different profiles, and a choice made in one project was invisible in the next.

- **The record is now the `dispatchPreferences` entry of a machine-level key/value store** — `server/machine-config.ts`, one JSON object at `<data>/config.json` keyed by record name, each value validated by its owner's schema — resolved store → this project's stored row → the Settings-derived default. The context exposes `getDispatchPreferences`/`setDispatchPreference` closures over `home`, so the router never learns where the record is.
- **The store is the machine-level counterpart of a project database's `settings` table, and it has two tenants from day one.** It first landed as a file of its own, `dispatch-preferences.json`; the maintainer asked *"surely we have some general-purpose system for storing bits of persistent configuration like this?"* — there was none at machine level (`settings.json`, `registry.json` and `cloud.json` each hand-roll a reader and writer), so the answer was to build it and move the machine settings (`font`, `notifications`, `localFileOpener`, `projectRail`) into it as the `settings` record. The old `settings.json` is read as a fallback and never written again; a settings reset removes both. `registry.json` and `cloud.json` were left as they are — each has its own lifecycle and locking story, and neither was the question.
- **No migration.** A project that chose a profile before the file existed keeps showing it from its row; the next selection, made anywhere, writes the file and is what every project opens on from then on. Every write still mirrors into the row, so an older server reading that database sees the same choice.
- **The whole record moved, including the per-runtime `permissionMode` inside it.** That field is vestigial — no `SetDispatchPreferenceInput` variant can set it and the composer's resolver never reads it (dispatch permission is decided server-side from Settings) — so nothing per-project was given up. Settings' own `permissionMode` stays per project, as before.
- **The web cache treats `["dispatchPreferencesGet"]` as machine-wide** (`lib/queryKeyScope.ts`), so the composer's optimistic write on one project is what a client-side switch paints on the next, rather than that project's last-seen copy for the beat before a refetch.

Verified on a real two-project stack (launcher + tenant on one server): a profile chosen through the tenant's RPC is what the launcher reads, and back; a per-project `settingsSet` on the launcher stayed invisible to the tenant, which is the control that the two prefixes reach different projects.
## 2026-08-26: Frizz mounts NO browser — a `chrome-devtools` server is the project's to bring

Maintainer: *"Is the Chrome DevTool stuff something that frizz automatically injects? Why not just let the user bring that themselves? That's very confusing to me. I feel like there's a level of opinionation here that we don't really want."*

This reverses the 2026-08-03 line above (*"`chrome-devtools` also stays always-mounted — giving a worker a browser is a capability, not an opinion"*). The capability argument stopped holding once the bill was measured: the server's 29 tool schemas sat in the prefix of **every** worker session at **~6,400 tokens**, and most workers never open a page. A capability nobody asked for, charged per turn, is an opinion.

- **Both backends stopped injecting it.** Claude's inline `--mcp-config` (`claudeMcpConfig`, `dispatch.ts`) and codex's `-c mcp_servers.chrome-devtools=…` app-server override (`codex-mcp.ts`) now mount the unified `frizz` server and nothing else. Parity was the point of the original pairing and it is the point of the removal.
- **The lazy proxy went with it.** `cc-worker/bin/browser-mcp.mjs` and its committed schema snapshot `browser-mcp-tools.json` existed only to make the always-on mount affordable in MEMORY (159 MB → ~17 MB per worker, 2026-08-19). With no mount there is nothing to proxy, so they are deleted along with `chromeDevtoolsMcpSpec` / `chromeDevtoolsMcpMount` / `resolveBrowserMcpScript` / `CHROME_DEVTOOLS_MCP`, `scripts/harvest-browser-mcp-tools.mjs`, and the worker-plugin closure entries that required them. The memory win it bought is now the token win.
- **Nothing about a browser is banned — it is just not Frizz's to decide.** A project adds a `.mcp.json` (plus `enabledMcpjsonServers` in `.claude/settings.json`, so a headless worker is never blocked on the approval prompt); an operator runs `claude mcp add --scope user`. Frizz's `--mcp-config` ADDS to whatever the CLI discovered rather than replacing it (frizz never passes `--strict-mcp-config`), so both paths reach a dispatched worker untouched.
- **This repo does exactly that, and that is the whole demonstration.** Frizz's own skills drive Chrome headless, so the repo root carries the `.mcp.json` that used to be injected — pinned `chrome-devtools-mcp@1.7.0 --experimentalPageIdRouting --headless --isolated --no-usage-statistics`, the same argv the deleted spec rendered. Verified end-to-end on a disposable stack: a worker dispatched in a scratch project with no config reported `frizz` tools and no browser; a worker dispatched in this repo reported the full `mcp__chrome-devtools__*` set with no permission prompt.
- **What deliberately stayed.** The orphan reaper still reaps `chrome-devtools-mcp` processes by name (a browser the USER brought leaks exactly the same way), and the transcript still renders a `take_screenshot` image result. Neither depends on who mounted the server.

## 2026-08-26: Sub-agent profiles are effort-only, and the dispatch epilogue carries mechanics, not a handoff format

Follow-on to the browser decision above, from the same audit of what Frizz registers into a worker that the worker did not ask for. The maintainer's frame — *"a level of opinionation here that we don't really want"* — applied to two more registrations, and the frizz Goal had this thread decide them itself.

- **16 `frizz:<model>-<effort>` profiles → 5 `frizz:<effort>` ones.** The model×effort grid existed because the Agent tool once had no way to pin either; today its own `model` parameter overrides a profile's model, so the only knob a profile still has to carry is `effort`. The grid cost ~1,340 tokens of agent descriptions on every session, and those descriptions doubled as a routing doctrine ("Opus matches Fable and costs less", "Haiku for scripted harvest only") that no project asked for. `low` … `max` carry no model and inherit the worker's; Haiku, which takes no effort setting, is dispatched with `model: "haiku"` and no profile. The worker contract's Sub-agents section now states the two knobs and nothing about which tier deserves which task.
- **The dispatch-hook epilogue kept only what a helper cannot discover.** Its first paragraph prescribed the shape of a helper's final message (status, files, SHA, evidence, caveats, next action); that is a handoff format, and it is gone — one sentence remains saying the final message is what the dispatcher reads. The rest stayed because each line is a mechanic learned from a real failure: the `SendMessage({to: "main"})` upward channel, the own-file rule for the scratch directory, no fan-out of its own unless asked, and the symlinked-`.output` wait-loop trap.
- **Verified** by the live harness (`_live_broker_workerenv.mts`, now dispatching `frizz:low`): a real broker worker through the real server dispatched the profile and it ran.

## 2026-08-26: three more worker registrations deleted — the waits skill, the pre-compaction brief, and the toon nudge

Third pass of the same audit that removed the browser mount and the model×effort profile grid above, and the same test: does Frizz register this into every worker because the worker needs it, or because Frizz has an opinion?

- **`skills/waits` is DELETED.** Maintainer: *"I feel like the waits skill is being replaced now. I don't think we need that. We have our own system now for registering watchers and whatnot as tools."* The skill's whole job was teaching a worker how to hold a wait open without falling out of the board's Active band, and the durable half of that is now TOOLS — `mcp__frizz__watch_pr`, `mcp__frizz__timer`, `mcp__frizz__recurring_prompt` — which carry their own descriptions and need no playbook. What remains (a sub-agent owns the wait, `run_in_background` does not hold a rest, never fake a wait with a foreground sleep) is already stated once in the system-prompt contract, which is where a mechanical rule belongs.
- **The portable monitors STAYED.** `skills/gh/scripts/{ci-watch,github-watch,review-watch}.mjs` are generated byte-for-byte from `monitors/` and are load-bearing for two other readers: the codex worker prompt names their absolute directory (`monitorScriptsDir()`, `dispatch.ts`, pinned by `dispatch.test.ts`), and `skills/gh` documents them as its declared-tooling fallback. Only the skill went.
- **`hooks/precompact-instructions.mjs` is DELETED**, with both its `PreCompact` registrations. Maintainer: *"the pre-compaction instructions are probably too opinionated, entirely too opinionated."* It handed the summarizer an editorial brief about WHAT to preserve — plan, alternatives rejected, rationale, at high fidelity — which is a prescription about how someone else's work should be remembered. `scratchpad.mjs --mode=precompact` keeps both matchers: it only says the worker's scratch files exist and names their paths, which is mechanics.
- **The `toon` bullet is gone from the seed's `⟦gh available⟧` block and from `skills/gh`.** Maintainer: *"It seems pretty opinionated to tell it to pipe through toon, given that toon is probably not installed on most machines. That might be over the line."* The original reasoning (`plans/github-integration.md` §9: worker-side yes, server-side no) was measured against THIS machine's toolchain; a `command -v toon` guard makes the advice safe but not less opinionated, and it spent prompt tokens on every authed session to describe a binary almost no repo has. The one raw-API recipe that piped through it now uses `--jq`, which ships with `gh`.

## 2026-08-28: the worker's tool is `goal`, and the scratch directory is offered rather than pushed

Two corrections from one maintainer thread, both about Frizz telling the worker what to do instead of what it can do.

- **`recurring_prompt` is renamed `goal`.** The board panel, the footer mark and the delivered trailer have all said "Goal" since 2026-08-11; only the MCP tool still carried the mechanism's name. Maintainer: *"I don't think the tool is even called Recurring Prompt anymore, is it?"* — then *"Rename it."* Only the TOOL name and the worker-facing wording changed: the RPC procedures (`setOwnThreadRecurringPrompt`, `getOwnThreadRecurringPrompt`) and the `session.recurring_*` columns keep their names, because renaming the procedure is exactly what stranded every in-flight worker the last time (see the legacy aliases in `@frizz/shared`). No alias tool is listed for the old name — Claude Code rejects a tool name it has not listed, so an alias would have to be a visible second tool forever — and the new tool's description names its former name once, for a resumed worker whose summary still says `recurring_prompt`.
- **Every surface that mentions the scratch directory stopped prescribing the notes-plus-arming arrangement.** The 2026-08-06 entry above set the rule "every surface that mentions the directory also mentions `post_compaction: true`", and it produced the effect the maintainer noticed: workers armed the post-compaction goal constantly, 49 of the 65 armed prompts in the live db copying the contract's template sentence verbatim. Maintainer: *"this is a very opinionated thing, and I don't think we should be pushing it as the thing to do. We should just be saying that the scratch directory is available to it if it wants it. We can also be saying that it can set these goal hooks."* The contract's scratch sections, the dispatch preamble, `scratchpadOrientation`, the five `scratchpad.mjs` hook texts and the tool's own `post_compaction` wording now say the directory and the goal hooks EXIST and leave the choice to the worker. The literal `post_compaction: true` stays on each surface so the capability is still discoverable; the nudge hook keeps its ~60k-token cadence with the informational wording.

## 2026-09-03: a worker mounts ONLY what its project declares — `--strict-mcp-config`, with the project's `.mcp.json` carried inline

Maintainer, the evening of two memory crashes (a jetsam spiral into a watchdog panic at 19:50, a forced power-off at 20:52): *"Very weird that Frizz eagerly spawns Chrome DevTools."* It was not Frizz. It was the CLI's own discovery doing exactly what the 2026-08-26 entry above asked of it — in every worker at once.

Measured on the maintainer's machine 2026-09-02, nine live workers: the user-scope `chrome-real` (`claude mcp add --scope user`, an npx chrome-devtools-mcp) and each project's `chrome-devtools` (`.mcp.json`) both booted in EVERY worker — 18 browser servers, 36 processes, 4.2 GB, and 61 thirty-second MCP connection timeouts inside the crash window. The 2026-08-26 line *"Frizz's `--mcp-config` ADDS to whatever the CLI discovered rather than replacing it (frizz never passes `--strict-mcp-config`)"* was written so a project and an operator could each bring a browser. It also meant a fleet multiplied the operator's personal servers by N.

- **Every worker now launches under `--strict-mcp-config`** (`strictMcpConfig: true` on the SDK path, the flag on the argv path) and is handed its whole MCP surface inline, lowest precedence first: the operator's REMOTE user-scope servers (`type: http`/`sse` in `~/.claude.json` — a URL costs no process), the project's `.mcp.json` filtered by the same approval the CLI applies (`enableAllProjectMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers`, every layer unioned), then the `frizz` server, which wins a name collision. `packages/server/src/backend/project-mcp-servers.ts` is the rule and the reasons; the daemon reads it at every fork, so a `.mcp.json` edit reaches the next dispatch as it reaches the next plain `claude`.
- **User-scope STDIO servers are the one thing a worker no longer inherits.** `claude mcp add --scope user` still reaches the operator's own sessions. A project that wants one in its fleet declares it in its `.mcp.json` — the scope that means "this repo's sessions".
- **Nothing about settings changed.** `settingSources` stays `user,project,local` (the 2026-08-16 entry): auth, permissions, hooks, plugins and `CLAUDE.md` all still reach a worker. Only MCP discovery is replaced, and only with what discovery would have produced minus the operator's local processes.
- **What this does not fix.** Twelve threads restarted at once are still ~9 processes and ~1 GB each before any of them runs a build; the crash was the aggregate, and this removes its largest avoidable term. A dispatch-time back-pressure check is the follow-up.

## 2026-09-05: the dispatch epilogue finally carries the lesson it has been credited with — nothing can wake a helper

The "cc hooks DROPPED" table above has claimed since the `SubagentStop` hooks were dropped that *"the worker-facing half of the rest-guard's lesson (run long ops inline, don't rest on a waiter) is carried in the dispatch epilogue instead."* It was not. The epilogue carried the handoff contract, the own-file rule, the `SendMessage` upward channel, the default-off nesting rule and the nested-collection paragraph — and nothing at all about the child's own lifecycle. The rule existed only in a sentence describing where it had gone.

A Fable helper on `nubjs/nub` ("Investigate Node SEA as container", 118 tool calls, 393,805 tokens) found the gap four times in one effort. It backgrounded ten Bash shells across its turns and ended each turn waiting for them, returning the same sentence: *"Three background jobs are outstanding … I am waiting for their completion notifications before writing."* Claude's own task-notification states the mechanism from the other side — **"a task-notification fires each time this agent stops with no live background children of its own"** — so the completion goes to the DISPATCHER and the helper is never resumed to read it. Its entire investigation lived only in transient return messages until the dispatcher captured them to a file by hand and resumed it a fourth time with "your first and only action this turn is the Write tool".

- **The epilogue's second paragraph is now the lifecycle rule**, placed directly under the handoff sentence because it is the same subject: the turn is the unit. It states that ending a turn IS returning, that a backgrounded job reports to the dispatcher and never to the child, and that a turn ending on a waiter hands back unfinished work. It then gives the three things to do instead — run long commands in the foreground; where one would outrun the foreground limit, make the command itself loop to its own terminal condition; and if something was backgrounded, collect it in the same turn.
- **It also closes the second half of the same failure**: write anything you would not want to lose into your own scratch file AS YOU GO. The findings were nearly lost not because the helper stopped, but because it had written nothing down when it did.
- **`agent-dispatch.mjs` is the home for the same reason the 2026-07-31 entry gives**: it fires at every depth and is the only seam that reaches a helper, whose dispatch prompt is otherwise whatever its parent thought to write. The root worker contract carries no equivalent — it reaches the one agent that cannot be stranded this way.
- **The same change CORRECTED the nested-collection sentence**, which had promised since 2026-07-31 that a helper's *"completion is delivered to you automatically"*. It is not, and the experiment is one dispatch: a child told to dispatch one helper and stop the instant the Agent tool returned came back `DISPATCHED: yes / SAW_HELPER_REPLY: no`, and was never resumed to read the reply. That sentence sat four paragraphs below the new rule and is exactly what a helper told not to wait would reason its way back to, so it now reads *"a helper cannot wake you either: a dispatcher that stops is never resumed to read the reply"*. The anti-polling instruction the 2026-07-31 entry wrote it to carry — the `.output` symlink, the unreliable `"type":"result"` record — is untouched; only its false premise is. It also strengthens the 2026-08-04 default-off rule with a mechanism rather than a preference: a child that fans out cannot collect what it dispatched.
- **Rejected: denying `run_in_background:true` from a sub-agent in `bash-background.mjs`.** The hook input does identify a child (`agent_id`, which `scratchpad.mjs` already reads), so it is available — but a helper launching several builds and collecting them inside one turn is legitimate, and the foreground cap makes a blanket denial actively worse. Same call as the depth-2 DENY rejected on 2026-07-31: too blunt for a hook that exists because helpers are allowed.

## 2026-10-09: agents steer each other — `mcp__frizz__steer` between threads, `SendMessage` by agent id inside one

The maintainer, after a worker asked to send an audit's results to a resting thread spent sixteen tool calls finding the board's `followUp` route, the slug and the session id, and then curled it: *"We need to educate and encourage sub-agents to steer each other. And provide better mechanisms for doing so."*

- **Between threads: `steer`, a frizz MCP tool over a new `steerThread` RPC.** Claude Code's cross-session `SendMessage` reaches only a session whose process is live, so a resting thread had no channel at all short of the board's own RPC. `steerThread` is the operator's follow-up delivery (one shared `deliverFollowUp` in `router.ts`), so it wakes a resting thread, queues into a running one, and reopens a done one. The server reads the target's current session itself and stamps the sender's name from its own row; the shim takes the sender from its env. The body arrives wrapped in `<thread-message from-thread=… from-title=…>` with a guidance line naming the sender's slug, and the chat draws it as the existing "Message from «thread»" hairline. Same project only, as `spawn_thread` is.
- **`spawn_thread` now names the spawner at the end of the child's prompt**, so a spawned thread asked for results can `steer` them back. Its "results NEVER come back to you" premise was true only because nothing could carry them; the doctrine (last resort, do-or-ask first) is unchanged.
- **Inside one session: measured, then taught.** Measured live on Claude Code 2.1.295 (2026-10-09, headless `claude -p` sessions, read off the sub-agent transcripts and token files each recipient wrote): a parent's `SendMessage` to a RUNNING child's full agent id is delivered when the child's current tool call returns; a child's `SendMessage` to a running sibling's id is delivered the same way, and to a finished sibling's id resumes it. Only the full id resolves — a prefix, the description or the `subagent_type` answers `No agent named '<x>' is reachable`. Children have no `ListAgents`, so a sibling is reachable only by an id someone hands it, or by replying to the `from=` of a message it received. The epilogue gains one sentence for the sideways channels; the worker contract gains one paragraph under Sub-agents and a short section for `steer`.
- **Rejected: a separate tag under the `<frizz-…>` prefix.** That prefix is Frizz's plumbing (`NOISE_PREFIXES`), which the transcript drops whole; the first draft's `<frizz-thread-message>` vanished from the chat entirely.

## 2026-10-11: the plugin is loaded through a path that moves — so a hook now runs under daemons older than itself

The maintainer, looking at the Reload plugins button on a thread: *"Do we need the reload plugins button? Shouldn't this be happening automatically?"* It should, and it could not: a worker was launched against its server generation's own `runtime/cc-worker`, which never changes, so the button re-read the same bytes on every installed Frizz and a live thread kept the previous version's plugin until it restarted. `stable-plugin-path.ts` had been written for this on 2026-07-31 and never wired (`plans/live-worker-updates.md`).

- **A worker is launched against `<cache>/current/cc-worker`**, a link the running server repoints at a staged copy of its own plugin (`workerPluginDir()` in `packages/server/src/dispatch.ts`). The frizz MCP shim's path is the exception and stays the generation's own: a reload does not re-spawn an MCP server, so a moving path would buy it nothing.
- **Each worker's daemon re-reads the plugin closure by itself, between turns**, when its fingerprint changed (`packages/server/src/backend/claude-plugin-sync.ts`). The button, its phone row and the `reloadThreadPlugins` RPC are deleted.
- **The closure it watches includes the operator's own**: `skills/<name>/SKILL.md`, `agents/**/*.md`, `commands/**/*.md`, the `enabledPlugins` of the settings files and `plugins/installed_plugins.json`, under both the project's `.claude` and the operator's. The button was covering this too, and not incidentally — measured on claude 2.1.296, a project skill written after a session started was NOT invocable a turn later, and a reload picked up a new skill, agent and command alike (40–85ms each). The fingerprint is stats, 1–4ms on the maintainer's machine; settings files are read for that one key rather than stat'ed, because Claude Code rewrites `settings.local.json` on every permission grant.
- **THE CONTRACT THIS CHANGES FOR EVERY FILE IN THIS DIRECTORY.** A hook script used to run only under the daemon that was forked beside it, by the same version, with the environment that version composed. It now runs under whatever daemon is alive: `${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` resolves through the link at each run, so the moment a new Frizz boots, its hook scripts execute inside sessions an OLDER Frizz forked, with the older worker environment (`FRIZZ_THREAD`, `FRIZZ_PERM_DIR`, `FRIZZ_NATIVE_ASK` and whatever came after) and, until that session's next turn boundary, the older `hooks.json` registrations. So a hook that starts reading a new environment variable must behave sensibly when it is absent, and a hook must not assume a sibling registration added in the same release is already armed. The reverse skew is gone in exchange: a live worker no longer runs last month's hook against this month's server.
- **Measured against real claude 2.1.296** (`_live_plugin_sync.mts`, and its `--control` with the sync off): after a repoint the next prompt's hook ran the NEW script in both runs, which is the link alone; a `Stop` registration and a skill that exist only in the new version were live only with the sync on. Claude Code does not re-read a `--plugin-dir` plugin by itself.
- **What a reload costs a conversation, since every live worker now does it unasked: no prompt-cache miss.** Read off the same two runs' transcripts, request by request: the first request after each reload read exactly the cached prefix the control's did (12,763 tokens, then 25,607 against the control's 19,964 a turn later, the difference being what the earlier reload had added) and WROTE about 5,500 more — the skill listing, re-announced as an attachment at the end of the conversation rather than changed in place at its head. So a reload is one listing's worth of cache write per live thread, once per change. The one thing that would invalidate the head is a changed MCP tool list, which a reload does not touch.
- **Rejected: staging a source checkout too.** A dev server's `cc-worker/` is edited where it stands, so a worker launched against it already sees every script edit, and the daemon's fingerprint (size and mtime of every file) picks up the rest at the next turn boundary. A staged copy would only be a stale snapshot between the editor and the worker.
- **Rejected: having the server ask.** The plan had the server reload every idle thread after an update. The server's reading of "idle" is the board's, a beat behind the session; the daemon's is exact, and it lets an input wait behind a reload instead of racing it.

## 2026-10-11: a Codex thread's hooks ride every resume — so SessionStart(resume) fires there, and must say nothing

The same question, asked of Codex: *"We need to make sure that it works on Claude Code and Codex."* It did not, and the reason was older than the question. A Codex thread has no plugin; its hooks are per-thread config, and Codex rebuilds a thread from the config of whichever request loads it. Frizz sent the hooks with `thread/start` alone, so the first `thread/resume` after any Frizz restart rebuilt the thread with an MCP mount and nothing else: no scratch-directory nudge, no `bash-background` guard, no SubagentStart epilogue, for the rest of the thread's life and with no error anywhere.

- **The bridge sends them now, with the start and every resume** (`codexWorkerThreadConfig`, handed to the bridge as `workerConfig`). `ARCHITECTURE.md` § Stable server updates has the rule for when a resume rebuilds a thread and how Frizz makes it happen between turns.
- **So `SessionStart` now fires with `source: "resume"` on Codex, which it never could.** `scratchpad.mjs` treats a resume as lost context and says so: *"Context was just lost…"*. On Codex that is false every time. A resumed thread is rebuilt from its rollout with the whole conversation in it (measured 2026-10-11 on codex 0.161.0: the request after two rebuilds still carried every earlier turn), and Frizz resumes a thread routinely, at its first message after each restart and again when a newer Frizz hands it new hooks.
- **The Codex registration says so with a flag, `--resume-keeps-context`, and the hook exits silently for it.** A compaction still re-orients on Codex as anywhere, and a fresh start is still told the directory exists. Claude's registration does not carry the flag: a Claude resume is a cold start of the process, and it keeps the wording.
- **Rejected: leaving `SessionStart` out of the bag a resume carries.** The bag replaces the thread's config whole, so a resume without the registration is a thread with no `SessionStart(compact)` either, which is the one channel that re-orients a Codex worker after a compaction.
- **Rejected: teaching the hook that the caller is Codex by some other sign** (the `--session` flag, a transcript path under `~/.codex`). Those say who is calling, not what a resume means there. A flag that names the property survives the day a second backend has the same one.

## 2026-10-11: a worker reaches Frizz through `frizzctl`, a command line, and no longer through MCP tools

The sixteen worker capabilities (`ask`, `unask`, `secret`, `done`, `activity`, `watch`, `unwatch`, `watch-pr`, `watch-issue`, `timer`, `goal`, `title`, `link`, `unlink`, `steer`, `spawn-thread`) were MCP tools, `mcp__frizz__<name>`. They cost about 12k tokens of schema that each provider loads its own way, could not be composed with anything, and had to be mounted three different ways (a `--mcp-config` file for Claude, `-c mcp_servers.…` for Codex, `session/new` for ACP). Each is now a subcommand of `bin/frizzctl`, which a worker runs from its own shell on every backend. The reasoning is in the header of `bin/frizzctl.mjs`.

- **One registry, two front-ends.** `lib/frizz-tools.mjs` holds each command's definition, its long description, its handler and how its arguments are spelled. `bin/frizzctl` is the command line over it, and `bin/frizz-mcp.mjs` is the same registry over MCP stdio, kept only for a thread that was started under the old contract.
- **Every text a worker reads names the command.** The contract (`packages/server/src/workerPrompt.ts`), the hook messages here, the `frizz:gh` skill and every wake, bump and refusal the server composes say `frizzctl <command>`. Dated entries above this one keep the `mcp__frizz__*` names they were written with.
- **The contract states the rule and the command's own `--help` carries the detail.** `frizzctl --help` is a short index; `frizzctl <command> --help` prints the description that used to be that tool's MCP description. A worker reads the long text of the command it is about to run and of no other.
- **Prose goes through a file or a quoted heredoc.** A handoff body is full of backticked paths and commands, and inside a double-quoted argument the shell would run them. Every text argument takes `--<name>-file <path|->`, and the contract teaches `<<'EOF'`.
- **The caller is the environment's.** A handler reads `FRIZZ_THREAD` (or the explicit `FRIZZ_THREAD_SLUG` stamp) and never an argument, so a command line cannot name another thread. A sub-agent's shell inherits it and acts as its parent's thread.
- **Exit 2 is a refusal, not a failure.** `frizzctl done` with a question open or a watch armed prints what blocks it and exits 2; a fault or a misuse exits 1.
- **A worker's own command never becomes an approval card.** Dispatch pre-approves `Bash(frizzctl:*)`, the promise the MCP server's own pre-approval made: on a thread a human moved to `default`, the worker can still ask, register and sign off unasked. Measured against a real worker on Claude Code 2.1.296, the rule carries every form the contract teaches except a quoted heredoc whose body is a JSON object, which Claude Code's own command checks send to a prompt — and that is the form `frizzctl ask` needs. `hooks/perm-policy.mjs` approves exactly that shape itself (`own-frizzctl`: `frizzctl`, words the shell does not interpret, `<<'WORD'`, a literal body, nothing after the terminator) and nothing wider.
- **Which threads still get the MCP server.** A Claude worker is handed the contract at every fork, so a daemon forked now never gets it. A Codex thread's contract is its base instructions and an ACP thread's is its first prompt, both fixed when the thread started, so the session row records which surface the thread was taught (`worker_surface`) and only a thread taught MCP is still handed the server, on its own thread config. Every thread, old or new, gets `frizzctl` on its shell's PATH.

## 2026-11-04: the gh pointer has two tiers — signed-in `gh`, or `gh` through Keyward

GitHub CLI access on the maintainer's Mac moved behind Keyward: `keyward --reason "…" -- gh …` hands `gh` his token in `GH_TOKEN` for that run, one Touch ID covers a repository's runs for 10 minutes, and the keychain token is logged out. Plain `gh auth status --active` then fails, so the old gate would have stopped teaching `gh` at all, on exactly the machine Frizz is built on.

- **`hooks/session-seed.mjs` checks two tiers, in order.** A signed-in plain `gh` still gets `⟦gh available⟧`: that is every other Frizz user, who has no Keyward, and this machine until the logout. Otherwise a `keyward` executable on PATH gets `⟦gh available through Keyward⟧`, which teaches the prefix, batching reads under one touch, and stopping on `keyward: not released:` without a retry (a locked screen does not clear by asking again, and a decline was the human's answer). Neither gets nothing, as before, and the gate still fails closed and never throws.
- **Keyward is found by walking PATH for the file, never by running it.** Any `keyward` invocation that releases raises a Touch ID sheet, and a SessionStart hook fires on every start, resume, clear and compact.
- **Waits moved to the server in both modes.** `frizzctl watch-pr add` / `watch-issue add` run on Frizz's own read-only GitHub credential, unattended and while the screen is locked, so both blocks, the `frizz:gh` skill and the Codex contract name them first. The bundled `ci-watch.mjs` / `review-watch.mjs` stay as the in-turn fallback where plain `gh` is signed in: Keyward releases to `gh` alone, so a script that runs `gh` itself gets no token under it.
- **Rejected: running `keyward` to learn whether a release would work.** It is the one check that is accurate, and the one that puts a sheet on the screen at every session start.

## 2026-11-04, later the same day: a worker's plain `gh` reads with Frizz's credential

Colin's decision (question `gh-reads` on the Keyward thread): an agent's GitHub reads use Frizz's read-only credential, with no Touch ID and through a locked screen, and anything that writes goes through `keyward --reason "…" -- gh …`. That replaces the routing above, which sent every read through a Touch ID.

- **No shim. The worker's environment does it.** `frizzGithubWorkerEnv` points `GH_CONFIG_DIR` at a folder Frizz owns, whose `hosts.yml` holds the token and is rewritten on every renewal. A file rather than `GH_TOKEN`, so a worker outliving an 8-hour token gets the fresh one and an `env` in a transcript cannot print it. `keyward -- gh` sets `GH_TOKEN` for its run, and `gh` prefers that to `hosts.yml` (checked with `gh` 2.102.0), so a write goes out on the operator's token.
- **Only with Keyward installed and Frizz signed in.** Elsewhere a worker's `gh` is its operator's own sign-in, which may be able to write, and a read-only override would leave no path for a write. So the two tiers above still stand for those machines, and the read-only block is a third, checked first.
- **The hook and the scripts read a marker file, `frizz-read-only`, beside `hosts.yml`.** A `FRIZZ_` variable would not do: Codex's environment drops that whole prefix.
- **The bundled monitors keep working in read-only mode.** They run plain `gh`, which can read.
- **The App reads widely and holds no write permission (Colin, 2026-11-04).** It started on issues, pull requests, checks, statuses and Actions, without Contents, and that failed on the first private repo: GitHub refuses a commit's data there without Contents, which took out the watchers' PR query, a bare `gh pr view`, `gh pr checks` and `gh pr diff` (measured on pullfrog/app#1648). Colin's call: *"It's better to over-ask right now and subtract later. But it should definitely not require any write permissions."* Subtracting is one click, while adding means every install's owner has to accept again. So it also asks for read on what a thread may plausibly want next. It still leaves out the permissions whose reads expose secrets or their names: secret scanning alerts, secrets, Dependabot secrets and webhooks.
- **The credential is an encrypted file, with a random per-machine key in the keychain (Colin, 2026-11-05).** `github-credential-seal.ts`. It stops token scanners, accidental reads into a transcript, and a copied file or backup leaving the machine. It does not stop a program running as the same user, because any process can run `security`: a dummy item saved by `security` read back with no prompt from an unrelated process. Rejected: a key baked into Frizz, since Frizz is open source; a plain keychain item, whose 8-hourly rewrites risk the "Keychain Not Found" dialog (the key here is written once); a signed helper, since Frizz has no native code or release signing; and an in-memory keeper, which needs a new device code after every reboot. A worker's `hosts.yml` still holds the 8-hour access token in the clear, because `gh` reads it. The refresh token stays in the encrypted file.
- **Contents read can post commit comments, and Colin kept it (2026-11-05).** GitHub files `POST /repos/{owner}/{repo}/commits/{sha}/comments` under Contents read. Measured with the App's token on `colinhacks/ci-testing`: an empty request came back 422 for the missing body, where the same request to issues and to file contents came back 403. No narrower permission gives commit data on a private repo, so the exposure is accepted and stated in Settings and the README. Forks and template repos are also filed under Contents read, but they need Administration write too.
- **No organization permissions and no Administration, so a repo admin can install it.** GitHub lets a repository admin install an App on the repos they administer only if it requests neither (Colin, 2026-11-05: an org owner should not be a prerequisite for a repo-scoped install). Adding either one back turns every such install into a request to an org owner. Reads lost: classic branch protection and team member lists. Rulesets stay readable through Metadata.

## 2026-11-06: a worker on a machine with no Keyward and no `gh` sign-in reads with Frizz's credential too

Colin, on whether agents can read their own CI logs: *"Perhaps we should be providing a GitHub token to the agents, or providing a way for them to access the GitHub app token inside of their runs automatically (if they're signed in and if they're not signed into the GitHub CLI)."* The 2026-11-04 rule only moved `GH_CONFIG_DIR` where Keyward could take the writes, so that machine's worker had no GitHub at all while the server itself was signed in.

- **`frizzGithubWorkerEnv` now asks whether the move costs a write.** Keyward on PATH: it doesn't. No Keyward and a sign-in of the operator's own: it would, so the worker keeps that sign-in, as before. No Keyward and no sign-in: there is no write to lose.
- **Whether `gh` has a sign-in comes from its token variables and `hosts.yml`, never from running it.** This runs on every worker start. `hosts.yml` names a keychain-held sign-in as well, so nothing here can raise a keychain prompt. A sign-in to any host counts, because the move would hide it just the same, and an expired one counts, which leaves that machine as it was.
- **The hook's read-only block has a second form for this machine.** It tells the worker to hand a write to the human as steps. The first form names a `keyward` that isn't there.

## 2026-11-10: a Claude worker's system prompt names no session, so threads share its cache

Claude Code sends the appended system prompt as one cached block, and a block is read from the cache only when every byte matches. The scratch line (`SCRATCH DIRECTORY: .frizz/threads/<session id>/ …`) sat between the contract and `FRIZZ.md`, so one line of the block differed per thread and every thread's first call wrote the whole block again.

- **`claudeWorkerSystemPrompt` is the contract and `FRIZZ.md`, and takes no session id.** Measured with two real Haiku workers dispatched one after the other on a throwaway project: with the line, both read 12,807 tokens and wrote 53,237 on their first call; without it the second read 43,924 and wrote 21,928.
- **The path reaches a Claude worker from three other places.** The first user message, and `session-seed.mjs` and `scratchpad.mjs` on every SessionStart: a startup, a resume, a clear and a compaction. On a cold resume of a real worker both hooks ran and named it. The contract's own sentence already sends the worker there ("exact path in your session-start context").
- **Codex, ACP and OpenCode keep the line.** They have no hook that runs when a session starts.
- **It reaches new threads only.** Claude Code keeps a thread's first system prompt across a resume.

## 2026-11-10, later: a worker is not offered Claude Code's own schedulers

The contract told every worker that `CronCreate` and `ScheduleWakeup` "cannot fire in the runtime frizz runs you in" (their gate stays shut while any background task of the session is outstanding), and both help texts repeated it. A tool a worker has to be warned off is better not offered.

- **The broker passes `disallowedTools`: `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`** (`BROKER_DISALLOWED_TOOLS`). Measured on a real Haiku worker: 1,705 fewer tokens in every request, and the names are gone from the request's tools and from the deferred list.
- **The warning is now two lines of the contract, and gone from `frizzctl goal --help` and `timer --help`.**
- **`/loop` is built on those tools and its skill is still listed.** The contract says to arm one of Frizz's own (`frizzctl goal`, `frizzctl timer`) when the human asks for a loop. Sent `/loop 1m …`, a real worker armed `frizzctl goal start --heartbeat-seconds 60`.
- **The tool list no longer matches the prefix Claude Code shares between all its users** (12,807 tokens here), so the first Frizz thread of an hour writes it and the rest read that copy.
- **`AskUserQuestion`, `Workflow` and `ReportFindings` stay.** The first is drawn as a card, and a person can ask for the other two.
