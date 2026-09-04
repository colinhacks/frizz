#!/usr/bin/env node
// @ts-check
/**
 * frizz-mcp — THE frizz MCP server: one unified, dependency-free MCP stdio server (mounted as `frizz`,
 * so its tools are `mcp__frizz__<tool>`) carrying every capability frizz hands its own WORKERS:
 *
 *   spawn_thread     — dispatch a brand-new TOP-LEVEL frizz board thread (its own session + scratchpad +
 *                      independent drive — NOT an in-session Agent/Task helper).
 *   goal — arm ONE piece of text frizz re-sends the caller, at every rest and/or on a clock
 *                      and/or after every compaction; and READ BACK what is currently armed.
 *   timer            — arm a ONE-OFF prompt for a single instant; a thread may hold many at once.
 *
 * Future worker-facing frizz tools join the TOOLS registry below rather than mounting a second server:
 * one server keeps the worker's tool namespace coherent and the server-level pre-approval single.
 *
 * spawn_thread wraps frizz's own dispatch RPC: it reads the running server's port from a server.lock
 * and POSTs `/_frizz/<project>/rpc/dispatch`. That surface has no token auth — only a loopback-origin
 * CSRF gate — so a headerless local POST with `sec-fetch-site: same-origin` (undici sends no Origin)
 * satisfies it.
 *
 * Mounted by the server (dispatch.ts) into the Claude backend via `--mcp-config`, and into codex via
 * `-c mcp_servers.frizz` (codex-mcp.ts). Both hand this process the same env, built once in
 * frizzMcpEnv: FRIZZ_SERVER_LOCK, FRIZZ_PROJECT_ID and FRIZZ_STATE_DIR.
 *
 * BUT NOTHING HERE DEPENDS ON THAT ENV STAYING TRUE. This process lives inside a DETACHED worker
 * daemon that outlives frizz restart after restart, so anything frozen into it at spawn is a bug
 * waiting for the next "Update & Restart" to move the port. Both facts we need are therefore resolved
 * PER CALL, from files: the server's address (serverLockPort — the env hint, then the machine-wide
 * `<frizz root>/server.lock`, then any live project lock, skipping any whose pid is gone) and our own
 * project (projectSegment — the stamp, else `.frizz/.id` walked up from our cwd). The env is a hint
 * that saves a lookup; the filesystem is the truth.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification. Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs next to bin/frizz (no build/bundle/resolution concerns), and it matches this repo's own
 * hand-rolled-RPC aesthetic. The server NEVER crashes on a bad tool call: failures come back as an
 * isError tool result so the worker sees a message instead of a dead tool.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

const PROTOCOL_FALLBACK = "2025-06-18"
// Comfortably above a codex dispatch's bounded rollout-discovery wait (~15s) so a legitimate slow
// dispatch is never aborted client-side (which would make the worker think it failed and retry,
// double-spawning). The server completes regardless; this is only the client's patience.
const DISPATCH_TIMEOUT_MS = 30_000

const SPAWN_THREAD = {
  name: "spawn_thread",
  description:
    "LAST RESORT — try the two cheaper exits FIRST. Follow-up work you discovered is not a reason to spawn: " +
    "if you could DO it (dispatching an in-session sub-agent, whose result comes back to you, so the work " +
    "lands on YOUR card under one review), do that instead; if the human should choose, ASK instead. " +
    "Spawn a brand-new, separate top-level frizz thread — its own board card, session, and scratchpad, " +
    "driving INDEPENDENTLY. This is FIRE-AND-FORGET: the new thread reports to the HUMAN on the board via " +
    "its own final message, and its results NEVER come back to you, the caller. It is NOT an in-session " +
    "sub-agent. It returns only the new thread's slug and a ready-to-paste markdown link " +
    "`[title](/thread/<slug>)` that opens the thread in the frizz drawer — put that link in your handoff. " +
    "USE IT ONLY for a distinct, self-contained effort that belongs on the board in its own right and whose " +
    "output you do NOT need to read. Do NOT use it for a helper whose result you must COLLECT and fold into " +
    "your own work — a self-review, a verification pass, a research prong, a critic, any collect-back helper: " +
    "those are in-session sub-agents (Claude: the Agent tool with `run_in_background`; Codex: native " +
    "delegation), which return their findings to you. Spawning such a helper here STRANDS it — its work lands " +
    "on another card and never reaches you, so you gain nothing. " +
    "Because nothing it learns ever returns to you OR to its siblings, a chain of spawned threads re-derives " +
    "the same facts in parallel and nobody notices — measured here: one thread spawned four, three of those " +
    "spawned more, and three descendants independently rediscovered the same root cause over twenty hours. " +
    "Spawn only when the work genuinely cannot ride on your own card: a different repo, a different long-lived " +
    "runtime, an effort that must outlive yours. Never spawn merely to clear your own `done` fence. " +
    "You MUST deliberately choose `model` and `effort` to match the NEW thread's task complexity — they are " +
    "required, there is NO default. Do not reflexively pick the cheapest; a hard task on a weak model/effort " +
    "wastes the whole thread.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The full task/prompt for the new thread's worker. Be self-contained — the new thread starts with empty context.",
      },
      model: {
        type: "string",
        description:
          "REQUIRED — pick by the NEW task's complexity; there is no default. For the `claude` backend: " +
          "`opus` (the TOP tier — hardest reasoning, architecture, subtle correctness/security, adversarial " +
          "review, the fix that must land), `sonnet` (ordinary substantive implementation/research), `haiku` " +
          "(simple, fully-specified mechanical work). Do NOT pick `fable`: Opus 5 is just as good and cheaper, " +
          "so a high-intensity task takes `opus` at a higher `effort`, not a different model — `fable` only " +
          "when the human explicitly asks for it. For " +
          "the `codex` backend use a codex model id instead (e.g. `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`). " +
          "Match the model to the backend you choose. Bias toward Opus/a strong model when the task is " +
          "non-trivial or its outcome is load-bearing.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "REQUIRED — reasoning effort, pick by complexity; no default. `low` only for trivial tasks; " +
          "`medium` for routine work; `high` for ordinary substantive work; `xhigh` for hard coding/agentic " +
          "work; `max` for the single hardest problems. (Codex also accepts `ultra`.)",
      },
      backend: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional agent backend (default `claude`). If `codex`, `model` must be a codex model id.",
      },
      title: { type: "string", description: "Optional short title for the new thread (else derived from the prompt)." },
    },
    required: ["prompt", "model", "effort"],
  },
}

const GOAL = {
  name: "goal",
  description:
    "Arm a GOAL on YOUR OWN thread: one piece of text that frizz re-sends you, on any or all of three " +
    "triggers, for as long as it is armed. The board shows it as the thread's Goal. (This tool was " +
    "named `goal` until 2026-08-28 — a summary or note that says so means this one.)\n\n" +
    "  stop_hook          — every time you come to REST. Use it to keep a long autonomous effort moving " +
    "without the human driving every step, and to rescue yourself from a wait that may never resolve.\n" +
    "  heartbeat_seconds  — on a CLOCK, whatever you are doing. This one reaches you MID-TURN: it arrives as " +
    "a queued message you read at your next tool boundary rather than waiting for you to stop, and it " +
    "never aborts what you are running. Use it for something that must be revisited on a schedule no " +
    "matter what you happen to believe at the time.\n" +
    "  post_compaction    — every time your CONTEXT IS COMPACTED, delivered into the emptied window. If " +
    "you keep notes in your scratch directory, a prompt that LINKS them comes back at the exact moment " +
    "you have lost everything else. Also mid-turn — a compaction happens while you are working.\n\n" +
    "Set at least one; any combination is fine.\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime frizz runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "frizz itself and is unaffected.\n\n" +
    "READ IT BACK WITH `action: \"get\"` — and do that BEFORE any `start` that is not a fresh arming. A " +
    "thread has AT MOST ONE goal, so a `start` REPLACES whatever is there, triggers and all, " +
    "and the text you are about to destroy may not be yours: the HUMAN can edit it in the thread footer, " +
    "and a compaction can take your own memory of arming it. `get` answers with the exact text currently " +
    "armed, which triggers are on, the cadence, and when each trigger last fired. Reach for it whenever " +
    "you are about to change one trigger and keep the rest, whenever you are unsure whether you are armed " +
    "at all, and after a compaction. (A `start` also reports what it replaced, so a blind overwrite is at " +
    "least a visible one.)\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self. At most one scheduled delivery is ever outstanding and its clock runs from the last one " +
    "DELIVERED, so you can never be handed a backlog at once.\n\n" +
    "STOP IT when the work it drives is done (`action: \"stop\"`) — one left armed on a finished thread " +
    "wakes it forever. The human sees it in the thread footer and can edit or switch it off there. " +
    "Signing off with a ```done fence stops it too, every trigger at once — but only when the work is " +
    "genuinely finished, because that files the thread away and a thread nobody is watching does not " +
    "restart itself.\n\n" +
    "You can only ever arm your OWN thread — there is no parameter for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "get"],
        description:
          "`start` arms (or replaces) this thread's goal; `stop` disarms it; `get` reads back " +
          "what is armed right now — the text, the triggers, the cadence and each trigger's last delivery " +
          "— without changing anything. `get` takes no other argument.",
      },
      prompt: {
        type: "string",
        description:
          "Required for `start`. The text delivered to you on every trigger, verbatim, as a user turn. " +
          "Make it self-contained and ACTIONABLE — say what to do and what would make it right to stop " +
          "— because you may receive it with none of the context you have right now.",
      },
      stop_hook: {
        type: "boolean",
        description:
          "Send it every time you come to rest. Defaults to true when neither `heartbeat_seconds` nor " +
          "`post_compaction` is given, so a `start` that names no mechanism still does the obvious thing.",
      },
      heartbeat_seconds: {
        type: "integer",
        description:
          "Also send it on this clock, in seconds (minimum 60, maximum 86400). Omit for no heartbeat. A " +
          "delivery is read at your next tool boundary, so a sub-minute cadence buys no promptness and " +
          "only talks over your own work.",
      },
      post_compaction: {
        type: "boolean",
        description:
          "Also send it every time your context is compacted, into the emptied window — useful when the " +
          "prompt links notes you keep in your scratch directory.",
      },
    },
    required: ["action"],
  },
}

// The ONE-OFF TIMER's bounds, mirrored from @frizz/shared (this file is dependency-free by design and
// ships as a loose .mjs, so it cannot import them). The server validates the same numbers; these exist so
// a wrong delay is refused HERE, with an explanation, instead of coming back as an HTTP 400.
const TIMER_MIN_DELAY_SECONDS = 10
const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60

const TIMER = {
  name: "timer",
  description:
    "Set a ONE-OFF timer on YOUR OWN thread: a piece of text frizz hands back to you at ONE instant, " +
    "ONCE. Your own alarm clock.\n\n" +
    "It is `goal`'s heartbeat with the repetition taken out, and it shares the property that " +
    "matters: the delivery reaches you MID-TURN — a queued message you read at your next tool boundary — " +
    "so it arrives when you asked for it whether or not you have stopped, and it never aborts what you " +
    "are running. Unlike a goal it fires exactly once and then is gone, so there is nothing " +
    "to switch off afterwards and nothing to sign off from.\n\n" +
    "You may have MANY armed at the same time, each with its own instant and its own text — they are " +
    "independent, unlike the single goal this thread can hold.\n\n" +
    "USE IT for anything you want to come back to at a specific time: re-check a deploy in ten minutes, " +
    "re-read a slow log at the top of the hour, revisit a decision after a build finishes. USE " +
    "`goal` instead when the thing must repeat, and remember that Claude Code's own " +
    "`CronCreate`/`ScheduleWakeup` cannot fire in the runtime frizz runs you in.\n\n" +
    "IT IS NOT A WAY TO POLL SOMETHING YOU COULD WAIT ON. If a background shell, a sub-agent or a " +
    "monitor can tell you the moment a thing happens, use that — an alarm every N seconds asking \"is it " +
    "done yet\" is strictly worse than being woken when it is.\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self — self-contained and actionable, because you may receive it with none of the context you have " +
    "now. Give exactly one of `in_seconds` or `at`. You can only ever set a timer on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "cancel", "list"],
        description:
          "`set` arms a new one-off timer (it never replaces an existing one); `cancel` withdraws one by " +
          "`id`; `list` returns the timers currently armed on this thread. Every action answers with the " +
          "resulting armed list.",
      },
      prompt: {
        type: "string",
        description: "Required for `set`. The text delivered to you when it fires, verbatim, as a user turn.",
      },
      in_seconds: {
        type: "integer",
        description:
          `For \`set\`: fire this many seconds from now (minimum ${TIMER_MIN_DELAY_SECONDS}, maximum ` +
          `${TIMER_MAX_DELAY_SECONDS} — thirty days). Give this OR \`at\`, not both. Sub-minute precision ` +
          "is not real: the delivery is read at your next tool boundary.",
      },
      at: {
        type: "string",
        description:
          "For `set`: fire at this exact instant, as an ISO-8601 timestamp (e.g. `2026-08-04T15:00:00Z`). " +
          "Give this OR `in_seconds`, not both. Must be in the future and within thirty days.",
      },
      id: {
        type: "string",
        description: "Required for `cancel`. The timer id returned by `set` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}


const WATCH_PR = {
  name: "watch_pr",
  description:
    "REGISTER A PULL REQUEST and frizz brings you back whenever something happens on it — CI turning " +
    "green or red, and every later review, approval or comment, from a human or a bot alike. Register " +
    "it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, unlike a timer. One registration covers the whole life of the PR: CI goes " +
    "red, you push a fix, CI goes green, a reviewer comments — that is four wakes from one call, and you " +
    "never have to re-register between them. It settles itself when the PR merges or closes, because " +
    "there is then nothing left to report.\n\n" +
    "REGISTER IT THE MOMENT YOU OPEN OR PUSH A PR. Nothing else watches for you: your runtime knows " +
    "nothing about GitHub, and an ```awaiting fence STATES what you are waiting on without creating any " +
    "wait at all. This tool is the wait.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, and it is a different job: it is how you come to REST " +
    "without frizz asking you for a handoff, and how the human sees what you are waiting for. Register " +
    "the watcher with this tool, then name the same PR in your fence's `prs:` list — and give the fence " +
    "the same long `for:` you gave the watcher, or the fence expires first and bumps you anyway.\n\n" +
    "GIVE AN EXTERNAL PR A LONG `for` — MONTHS, up to a year. A pull request into a repo nobody here " +
    "controls moves on its maintainers' clock, not yours, and a short watcher on one expires against a " +
    "PR that has not changed: a wake with nothing in it, and a re-arm. Long costs nothing — real " +
    "activity still wakes you the instant it lands, and the human snoozes or archives the thread if " +
    "they want it off the board.\n\n" +
    "REGISTERING IS IDEMPOTENT per pull request: asking twice returns the SAME id and tells you it was " +
    "already armed, so re-registering after a compaction is safe and is the right instinct. Use `list` " +
    "when you want to know what you are holding without changing anything — it answers with each PR's " +
    "current check state too.\n\n" +
    "You can only ever watch a PR on your OWN thread — there is no parameter for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per PR); `drop` withdraws one by id; `list` reads back " +
          "everything armed on this thread, with each PR's latest check state, without changing " +
          "anything. Every action answers with the full armed set.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The pull request, as `owner/repo#123` or a GitHub PR URL. A ref that " +
          "cannot be parsed, or a PR the server's own `gh` cannot read, is REFUSED rather than stored — " +
          "a watcher that can never fire is worse than no watcher, because you would come to rest " +
          "believing you were covered. A refusal names the reason; a transient one is worth one retry.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you, and you re-register if you still care.\n\n" +
          "MATCH IT TO WHOSE PR IT IS, and the two cases are far apart. Your own PR, waiting on CI or on " +
          "a review you expect today: hours. A PULL REQUEST IN A REPO NOBODY HERE CONTROLS — an upstream " +
          "project, someone else's maintainers — takes as long as it takes, so give it MONTHS (`90d`, " +
          "`180d`, `365d`). A short `for` on one of those does not make it get reviewed sooner; it just " +
          "expires against a PR nothing has touched, wakes you for nothing, and costs a re-arm. That is " +
          "not hypothetical — a watcher on an external PR re-armed at the old 24h ceiling four days " +
          "running, with zero maintainer activity in between. Long is FREE here: real activity wakes you " +
          "the moment it happens either way, and the human can snooze or archive the thread whenever " +
          "they want it gone.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The watcher id returned by `add` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}

// The registry that replaces a ```awaiting fence's `shells:` line: a wait the worker CREATES rather
// than one it restates at every rest. Two tools rather than one action-switch, because they are two
// verbs and a worker reaching for `unwatch` should find `unwatch`. See plans/rest-by-registration.md.
const WATCH = {
  name: "watch",
  description:
    "REGISTER A WAIT on something this thread already has running — a background shell, a sub-agent — " +
    "and frizz holds your thread out of the queue until it finishes, then brings you back.\n\n" +
    "IT IS THE WAIT, NOT A STATEMENT ABOUT ONE. A ```awaiting fence NAMES what you are waiting on and " +
    "has the lifetime of the message carrying it, so it has to be rewritten at every single rest and is " +
    "wrong the moment anything changes. This creates a ROW: it survives your turn ending, a compaction " +
    "and a frizz restart, and it keeps holding your thread whatever you say next.\n\n" +
    "`for` IS REQUIRED and it is a DURATION, never an instant. When it runs out the row is CANCELLED " +
    "and you are woken to re-decide — that is deliberate, and it is what stops a wait outliving the " +
    "reason you made it. Register again if you still mean it.\n\n" +
    "THE TARGET IS CHECKED AGAINST WHAT IS ACTUALLY RUNNING, not against its shape. A handle nothing " +
    "live answers to is REFUSED rather than stored, and so is a `kind` that disagrees with what frizz " +
    "can see — a sub-agent registered as a shell is refused and told what it actually is. If you have " +
    "lost an id (a compaction, a long turn), call `activity` rather than guessing.\n\n" +
    "A SUB-AGENT ALREADY HOLDS YOUR THREAD without any registration, so the case this exists for is a " +
    "background SHELL: frizz cannot tell a build you are waiting on from a dev server you started and " +
    "moved on from, and only you know which it is.\n\n" +
    "NEVER WATCH SOMETHING YOU INTEND TO OUTLIVE. A dev server, a log tail, a file watcher — those are " +
    "things you started, not things you are waiting for, and registering one parks your thread on work " +
    "that will never finish.\n\n" +
    "REGISTERING IS IDEMPOTENT per (kind, target): asking twice returns the SAME id, says it was " +
    "already armed, and leaves the original expiry alone — so re-registering after a compaction is safe " +
    "and is the right instinct. Use `unwatch` to withdraw one. A PULL REQUEST is `watch_pr`, not this: " +
    "that one polls GitHub and reports repeatedly.\n\n" +
    "You can only ever watch work on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["shell", "agent"],
        description:
          "What the target IS. Checked against live telemetry, not taken on trust — the two kinds of " +
          "handle are both opaque runtime strings and look identical, so frizz answers this exactly " +
          "rather than guessing, and refuses a mismatch by name.",
      },
      target: {
        type: "string",
        description:
          "The handle you were shown. For a shell that is the runtime's own background-task id " +
          "(\"Command running in background with ID: bzvtnt3ig\"); its launch tool_use id and its " +
          "command label are accepted too. For a sub-agent it is the dispatch id or its description. " +
          "`activity` prints all of them.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED. How long to hold the wait, as a DURATION — `30m`, `2h`, `3d` (max 24h). Never an " +
          "instant, and there is no default: choose it for THIS wait. When it elapses the row is " +
          "cancelled and you are woken to re-decide, so an over-long guess costs a wait that outlives " +
          "its reason and a too-short one costs one extra turn. The ceiling is a DAY here, unlike " +
          "`watch_pr`'s year: a shell or a sub-agent dies with this session, so a wait on one that has " +
          "stood for a day is a wait on something already gone.",
      },
    },
    required: ["kind", "target", "for"],
  },
}

const UNWATCH = {
  name: "unwatch",
  description:
    "WITHDRAW A WATCH you registered with `watch`, by its id. It stops holding your thread out of the " +
    "queue and it will not wake you.\n\n" +
    "Use it the moment a wait stops mattering — you decided not to wait for that build after all, or " +
    "you are about to end the thread. A watch you no longer care about still parks you, and a thread " +
    "parked on a wait nobody is waiting for is invisible to the human.\n\n" +
    "You do NOT need this when the work simply finishes: frizz settles the row itself and wakes you. " +
    "`activity` prints the id of everything you hold.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The watch id `watch` returned (or that `activity` lists). Only your own thread's.",
      },
    },
    required: ["id"],
  },
}

// ---- `ask` / `unask`: a question the human owes an answer to, as a ROW ------------------------------

// The question tree, generated rather than written three times over. MCP tool schemas are JSON Schema,
// and a `$ref` cycle is the natural way to express a recursive shape — but client support for one is
// uneven, and a schema a client silently drops is a tool a worker cannot call. ASK_MAX_DEPTH is 3, so
// the nesting is INLINED to exactly that depth: `followUps` simply does not exist on the deepest level,
// which makes the limit visible in the schema instead of being a refusal the worker meets at runtime.
const ASK_MAX_DEPTH = 3
/** @param {number} depth 1 = the root question. @returns {Record<string, unknown>} */
function questionSchema(depth) {
  const option = {
    type: "object",
    properties: {
      label: { type: "string", description: "The choice itself, short — this is what the answer hands back to you." },
      description: {
        type: "string",
        description:
          "The trade-off, or the evidence — and it renders INSIDE the option, always visible, so this " +
          "is where the human learns what they are choosing BEFORE they pick anything. ONE LINE is the " +
          "default and it is right most of the time: name the trade-off and stop. Earn more than that " +
          "and spend it on a shape they can SCAN — a short list, a table, a code block, the diff the " +
          "option would produce, the exact message that would be posted. Never on a RUN OF " +
          "ONE-SENTENCE PARAGRAPHS: four single sentences stacked with blank lines between them is the " +
          "shape that keeps arriving, and it is the least readable one in a card this narrow. An " +
          "option with no trade-off makes the human reconstruct your reasoning before they can choose; " +
          "an option with four paragraphs makes them read an essay to answer one question.",
      },
      recommended: {
        type: "boolean",
        description:
          "Mark the ONE option you would take, and put it first. At most one per question — a " +
          "recommendation on two of three choices says nothing. IF YOU CAN MARK ONE, ASK YOURSELF WHY " +
          "YOU ARE ASKING: you already know the answer, so implement it and say which way you went. " +
          "This is for the fork you genuinely cannot take yourself.",
      },
      // `preview` (markdown revealed under the option once picked) is RETIRED from this schema
      // (2026-09-01): detail that decides a choice must be visible before the choice, so it belongs in
      // a rich `description` now. The server still ACCEPTS the field — an in-flight worker dispatched
      // against the old schema keeps working, and the card folds it into the same always-visible body.
      ...(depth < ASK_MAX_DEPTH
        ? {
            // No `maxItems` here either (four until 2026-09-03): the tree is bounded by its DEPTH, not
            // by how many branches hang off one option.
            followUps: {
              type: "array",
              description:
                "Questions that become live ONLY if the human picks this option — the conditional " +
                "branch. A branch nobody takes is never asked and never answered, so this is how you " +
                "ask \"and if so, which?\" without asking it of somebody who said no. A `multi` " +
                "question cannot carry these (several picked options would open several branches at " +
                "once) and neither can a free-text one (there is no answer to branch on).",
              items: questionSchema(depth + 1),
            },
          }
        : {}),
    },
    required: ["label"],
  }
  return {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "THE QUESTION, on one line, in the human's own vocabulary. They have their original prompt " +
          "and nothing else — not your plan, not your notes, not the names you coined while working. " +
          "Lead with the behaviour, not the identifier. NO \"I\" AND NO \"you\": clicking an option is " +
          "the HUMAN speaking, so first and second person flip between writer and reader. Name the " +
          "actor outright instead.",
      },
      header: { type: "string", description: "A very short chip label for the card, 12 characters or so — \"Auth method\", \"Storage\"." },
      kind: {
        type: "string",
        enum: ["question", "multi"],
        description:
          "`question` = pick ONE. `multi` = pick SEVERAL, for choices that are not mutually exclusive. " +
          "A question with NO options at all is a free-text box, which is the right shape when you need " +
          "a name, a value or a sentence rather than a decision between things you have enumerated.",
      },
      danger: {
        type: "boolean",
        description:
          "The DESTRUCTIVE gate, and nothing softer: a force-push, a deletion, a history rewrite, a " +
          "production rollback. It changes two things — the card wears the risk tone, and the human's " +
          "x cannot dismiss it, because a generic close icon is not consent for something irreversible. " +
          "Declining must therefore be one of your own options.",
      },
      // No `maxItems`: the count is the worker's to choose (maintainer 2026-09-03 — "allow arbitrary
      // numbers of options"). A `multi` over a long list is a real shape, and the card letters past 26.
      options: {
        type: "array",
        description:
          "As many as the choice actually has — a fork of two, or a `multi` over twenty findings. " +
          "Omit entirely for a free-text question.",
        items: option,
      },
    },
    required: ["question", "kind"],
  }
}

const ASK = {
  name: "ask",
  description:
    "ASK THE HUMAN SOMETHING YOU CANNOT DECIDE, as a ROW they still owe an answer to — not a fence in a " +
    "message. It renders as an answerable card on the board and in the thread, and it STAYS there: it " +
    "survives your turn ending, a compaction, a restart, and the transcript scrolling past. A fence has " +
    "the lifetime of the message carrying it, which is why a question written into one is unanswerable " +
    "an hour later.\n\n" +
    "YOUR DEFAULT IS TO DECIDE, AND THIS TOOL DOES NOT CHANGE THAT. A reversible call costs minutes to " +
    "redo; a round-trip to the human costs hours with the whole effort idle. Anything derivable from " +
    "the code, the conventions or ordinary engineering judgement is yours: make it, say which way you " +
    "went, and keep moving. THE TEST THAT CATCHES ALMOST EVERY BAD QUESTION: if you are about to mark " +
    "one option `recommended`, you already know the answer — so implement it instead of asking.\n\n" +
    "ASK WHEN A WRONG GUESS WOULD BE BOTH COSTLY AND HARD TO UNDO — something destructive or " +
    "irreversible, an external-facing commitment, a security posture with real exposure, product or UX " +
    "direction that is genuinely the human's taste to set. And ask when you KNOW the answer but cannot " +
    "ACT on it: a merge, a publish, a spend, a comment that goes out under their name. Then the " +
    "recommendation is the point, and it goes first.\n\n" +
    "ASKING DOES NOT END YOUR TURN. A question waits on a person, so it carries no timeout and expires " +
    "never — but you keep working. Do everything that does NOT depend on the answer first, and register " +
    "the question at the moment you find it rather than saving it for the end.\n\n" +
    "AND WHEN YOU DO STOP, THE OPEN QUESTION IS YOUR SIGN-OFF — rest normally. Frizz draws every open " +
    "question at the rest you stopped at whether you mention it or not, so nothing you write can hide " +
    "one. The card draws itself at the rest the question was asked — never write the question into " +
    "your handoff, because a fence that names or restates a registered question draws nothing (one " +
    "question, one card).\n\n" +
    "SEVERAL AT ONCE IS ONE CALL. The card sends every answer as a unit, so a second `ask` for a second " +
    "question just makes the human send twice. Register them together.\n\n" +
    "The answer comes back to you as its own wake, restating what was asked. Withdraw one you no longer " +
    "need with `unask` — a question you have since answered yourself, still sitting on the human's " +
    "board, is worse than never having asked it.\n\n" +
    "ON AN AUTONOMOUS THREAD THIS REFUSES, and tells you the standing instruction you are working " +
    "under. A thread carrying a rest Goal has already been told to keep going and decide for itself, " +
    "so the refusal is that instruction arriving at the moment it matters. Decide, and say which way " +
    "you went in your write-up. If the call is genuinely the human's — destructive, irreversible, or " +
    "an act you are not permitted to take — put it in your FINAL MESSAGE instead of here; autonomous " +
    "does not mean nobody is reading.",
  inputSchema: {
    type: "object",
    properties: {
      // No `maxItems` (four until 2026-09-03): "several at once is one call" above, and a cap here told
      // a worker with six to batch them and then refused the batch.
      questions: {
        type: "array",
        minItems: 1,
        description: "The questions to register, together. Each becomes its own card and its own row.",
        items: questionSchema(1),
      },
    },
    required: ["questions"],
  },
}

const UNASK = {
  name: "unask",
  description:
    "WITHDRAW A QUESTION you registered with `ask`, by its id. Its card disappears and the human is " +
    "never asked.\n\n" +
    "Use it the moment the question stops mattering: you worked out the answer yourself, the code moved " +
    "and the fork is gone, or you are about to finish. A stale question on someone's board is worse " +
    "than no question — they answer it, and the answer is about a decision that no longer exists.\n\n" +
    "You do NOT need this for a question that gets answered; that settles itself and wakes you. " +
    "Withdrawing is YOUR move and is never reported back to you as news.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The question id `ask` returned, or that `activity` lists. Only your own thread's." },
    },
    required: ["id"],
  },
}

const DONE = {
  name: "done",
  description:
    "DECLARE THIS EFFORT FINISHED, with the write-up the human reads. Your thread cards as a checked " +
    "success in their queue and stays there until they archive it — marking done is not dismissal, and " +
    "it does not close, archive or hide anything.\n\n" +
    "FRIZZ CAN REFUSE THIS, which is the whole reason it is a tool rather than a fence. An OPEN " +
    "QUESTION or an ARMED REGISTRATION blocks it, and the refusal names each one by id: a question " +
    "nobody answered dies with the card, and a live wait means the thing you were waiting for has not " +
    "happened yet. Resolve them for real — answer it yourself and `unask`, or `unwatch` the wait you no " +
    "longer need — then call again. There is no force parameter and there will not be one.\n\n" +
    "IT ONLY COUNTS WHAT IS REGISTERED. A background shell or a sub-agent you never registered does " +
    "not block this, because frizz cannot tell a build you are waiting on from a dev server you walked " +
    "away from. That judgement is yours, and registering it is how you make it.\n\n" +
    "DONE MEANS THE WORK LANDED, NOT THAT YOU STOPPED. Code committed to the project's mainline; a " +
    "plan, doc or commissioned report written INTO A FILE. An open pull request is not done — the " +
    "merge is. An investigation headed for a fix is not done — the fix is. And a verdict that ends in " +
    "SOMEBODY SHOULD NOW DO SOMETHING (merge it, post this, pick one of these) is not done either: " +
    "that is an `ask`, carrying your recommendation as the first option.\n\n" +
    "THE TEST IS NEVER \"HAVE I STOPPED WORKING\". It is: WHAT IS LOST IF NOBODY EVER OPENS THIS " +
    "THREAD AGAIN? Name one thing and you are not done. Uncertain is not done.",
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description:
          "THE CARD, as markdown. One to three sentences, then a bullet per deliverable, each opening " +
          "with a bolded verb phrase naming what shipped and where. Backtick every path, identifier and " +
          "command, and make file references real links. It is a LEDGER, not a summary: reasoning, " +
          "caveats and anything the human must do belong in your final message instead, because a " +
          "sentence that would read the same in both places belongs in exactly one of them. Nothing " +
          "here may point vaguely forward — no \"a follow-up could…\". Do it, ask about it, or drop it.",
      },
    },
    required: ["body"],
  },
}

const TITLE = {
  name: "title",
  description:
    "NAME THIS THREAD on the human's board, once you actually know what the work is.\n\n" +
    "WHY IT EXISTS: the name your thread is wearing right now was minted the instant you were " +
    "dispatched, from the raw text of the prompt, before you had read a single file. It can only ever " +
    "paraphrase what the operator typed — so it inherits their shorthand, their ambiguity and their " +
    "typos. One zod thread went onto the board as \"Zon4.5 features and z.properties documentation " +
    "audit\" because the operator typed \"Zon4.5\" and nothing in the session yet knew the product is " +
    "called Zod. You know. That is the entire point of this tool.\n\n" +
    "WHEN TO CALL IT: after you have oriented — read the issue, opened the code, found the bug — and " +
    "can name the actual work in your own words. Not on arrival: a name you register before you " +
    "understand the task is the same guess the board already has. Once is normally enough; call it " +
    "again only if the work turns out to be genuinely something else.\n\n" +
    "NAME THE WORK, NOT THE PROMPT. \"Is this true? We should probably…\" is what the human said, not " +
    "what you are doing. A good name is the thing a reader picking one card out of thirty needs: the " +
    "subject and the verb.\n\n" +
    "A HUMAN RENAME OUTRANKS YOU, always. If the human has already named this thread, frizz refuses " +
    "this and tells you so — that is a correct answer, not a failure, and you should not retry it.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The thread's name: 3-8 words, SENTENCE case (capitalize only the first word and proper " +
          "nouns — \"Fix queue focus\", never \"Fix Queue Focus\"). No trailing period, no ticks, no " +
          "issue-body quoting. Spell every product, file and identifier the way the PROJECT spells it, " +
          "not the way the prompt did.",
      },
    },
    required: ["title"],
  },
}

// The unified server's tool registry: `tools/list` returns these and `tools/call` routes by name.
// Adding a worker-facing frizz tool = one entry here + one handler in `HANDLERS` — never a second
// MCP server, so every frizz tool stays under the same `mcp__frizz__*` namespace and the same
// server-level pre-approval the dispatch layer already grants.
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60

const ACTIVITY = {
  name: "activity",
  description:
    "EVERYTHING YOU CURRENTLY HAVE OUT, with the id each one is named by — your background shells, your " +
    "sub-agents, your armed timers, the pull requests you registered, the `wch_…` of every watch holding " +
    "one of them, and every QUESTION still owed an answer.\n\n" +
    "WHY YOU NEED IT: an ```awaiting fence names what you are waiting on BY ID, and frizz checks every " +
    "one against what is actually live. A name that matches nothing is not a park — you are bumped and " +
    "your thread queues. The same goes for the ids `unwatch` and `unask` take, and for the id you put in " +
    "a ```question fence to PLACE a registered question in your handoff. So if you have lost one (a " +
    "compaction, a long turn, a wake you did not expect), call this rather than guessing. Guessing is " +
    "the failure this tool exists to remove — and it is the only way to read your open questions " +
    "WITHOUT registering or withdrawing one.\n\n" +
    "It takes nothing and changes nothing. You can only ever read your OWN thread.",
  inputSchema: { type: "object", properties: {}, required: [] },
}

const TOOLS = [SPAWN_THREAD, GOAL, TIMER, WATCH_PR, WATCH, UNWATCH, ASK, UNASK, DONE, TITLE, ACTIVITY]

/** @type {Record<string, (args: Record<string, unknown>) => Promise<string>>} */
const HANDLERS = {
  [SPAWN_THREAD.name]: spawnThread,
  [GOAL.name]: goal,
  [TIMER.name]: timer,
  [WATCH_PR.name]: watchPr,
  [WATCH.name]: watch,
  [ASK.name]: ask,
  [UNASK.name]: unask,
  [DONE.name]: done,
  [TITLE.name]: title,
  [UNWATCH.name]: unwatch,
  [ACTIVITY.name]: activity,
}

/** The `title` handler: register this thread's considered name.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function title(args) {
  const slug = threadSlug()
  const wanted = typeof args.title === "string" ? args.title.trim() : ""
  if (!wanted) throw new Error("`title` is required — 3-8 words naming the work, in sentence case")
  const result = (await callRpc("setOwnThreadTitle", { slug, title: wanted }))?.result
  if (result?.accepted) return `This thread is now named "${result.title}" on the board.`
  // The refusal is REPORTED, never thrown: a human who renamed the thread owns its name, and a worker
  // told "error" would retry a call that can only ever fail again.
  if (result?.lockedByHuman) {
    return (
      `Not renamed — the human has named this thread "${result.title}" themselves, and their name ` +
      "outranks yours. Leave it; do not call this again for this thread."
    )
  }
  return `Not renamed — frizz did not accept the write. This thread still reads "${result?.title ?? slug}".`
}

/** Read out every background thing this thread has running, in the shape an awaiting fence names them.
 * @returns {Promise<string>} */
async function activity() {
  const result = (await callRpc("listOwnThreadActivity", { slug: threadSlug() }))?.result
  const items = Array.isArray(result?.activity) ? result.activity : []
  const questions = Array.isArray(result?.questions) ? result.questions : []
  // THE QUESTIONS ARE NOT PART OF THE FENCE, so they are printed in their own section and never fed to
  // the fence builder below. A question waits on a person; there is no `questions:` key to write it into.
  const askedBlock = questions.length === 0 ? "" : (
    `\n\n${questions.length} question${questions.length === 1 ? "" : "s"} still owed an answer:\n\n` +
    questions.map((q) => `  question: ${q.id}\n    ${String(q?.spec?.question ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n") +
    "\n\nEach one blocks `done` until it is answered or withdrawn, and draws its own card at the rest " +
    "it was asked — never write it into a handoff. `unask` the ones since decided. A question is never " +
    "named in an ```awaiting fence."
  )
  if (!items.length) {
    if (questions.length > 0) {
      return (
        "Nothing is RUNNING on this thread — no background shells, no sub-agents, no armed timers, no " +
        "registered PRs. So an ```awaiting fence would have nothing to name, and a fence naming nothing " +
        "is not a park." + askedBlock
      )
    }
    return (
      "Nothing is running on this thread — no background shells, no sub-agents, no armed timers, no " +
      "registered PRs, and no open questions.\n\nSo there is nothing to wait on: an ```awaiting fence " +
      "would have nothing to name, and a fence naming nothing is not a park. End with ```done, or with " +
      "a ```question if you need the human."
    )
  }
  const lines = items.map((i) => {
    const when = i.until ? `  (fires ${i.until})` : i.since ? `  (since ${i.since})` : ""
    // The `wch_…` id of the watch holding this item, where one is armed — this readout exists to hand a
    // worker back the ids it lost, and that includes the one `unwatch` takes.
    const held = i.watchId ? `  [watched as ${i.watchId}]` : ""
    return `  ${i.kind}: ${i.id}${when}${held}\n    ${i.label}`
  })
  // A READY-TO-PASTE FENCE, not a description of one. The frontmatter is YAML since 2026-08-24 and its
  // keys are PLURAL sequences, so an id printed on its own line is no longer something a worker can copy
  // into a fence — it has to see the shape. This tool is where the contract sends a worker that has lost
  // an id, so printing the retired one-line-per-item form would teach the very grammar frizz refuses.
  const byKind = { shell: [], agent: [], timer: [], pr: [] }
  for (const i of items) if (byKind[i.kind] && i.id) byKind[i.kind].push(i.id)
  const block = Object.entries({ shells: byKind.shell, agents: byKind.agent, timers: byKind.timer, prs: byKind.pr })
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => `  ${key}: [${ids.join(", ")}]`)
  return (
    `${items.length} thing${items.length === 1 ? "" : "s"} running on this thread:\n\n${lines.join("\n")}\n\n` +
    "Name the ones you are ACTUALLY waiting on in your ```awaiting fence. The frontmatter is YAML — one " +
    "PLURAL key per kind, taking a list — plus a required `for:` duration, and your handoff prose BELOW " +
    "the `---` (there is no `reason:` key).\n\nEverything above, as a fence:\n\n```awaiting\n" +
    `${block.join("\n")}\n  for: 2h\n  ---\n  <what you are waiting for, and what you will do when it lands>\n` +
    "```\n\nDrop the lines you are not actually waiting on — a dev server you left running is not a wait." +
    "\n\nBETTER THAN NAMING A SHELL IN THE FENCE: `watch` REGISTERS the wait, so it survives your turn " +
    "ending and you never restate it. Anything already marked `[watched as …]` above needs no fence line." +
    askedBlock
  )
}

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

/**
 * Whether a pid is running. EPERM means someone else's live process, which is still ALIVE.
 *
 * A lock with NO pid reads as alive: absence of evidence is not evidence of death, and discarding a
 * record written by an older or foreign publisher would turn a working server into "none found".
 */
function pidAlive(pid) {
  if (pid === undefined || pid === null) return true
  if (!Number.isInteger(pid)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

/** A lock file's `{port, pid}`, or undefined if it is missing, malformed, or names a DEAD process. */
function liveLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!Number.isInteger(parsed?.port)) return undefined
    if (!pidAlive(parsed?.pid)) return undefined
    return { port: parsed.port, path }
  } catch {
    return undefined
  }
}

/**
 * FIND THE RUNNING FRIZZ — every call, never cached, never frozen at spawn.
 *
 * This process is spawned once, inside a DETACHED worker daemon that outlives restart after restart.
 * An address handed to it in its env is therefore true exactly until the next "Update & Restart", and
 * a worker whose only address was stale simply lost every frizz tool it had — with no way back short of
 * restarting the worker itself, which is not what an update button should mean.
 *
 * So the env is a HINT and the file is the truth, in this order:
 *   1. FRIZZ_SERVER_LOCK  — the lock this server published when it spawned us. Right almost always.
 *   2. `<frizz root>/server.lock` — the MACHINE address (frizz-paths.ts `serverAddressPath`), rewritten
 *      by every boot whatever project launched it. This is what makes a live worker survive an update.
 *   3. `<state dir>/server.lock` — our own project's, for a server that only ever serves one project.
 *   4. any live `<frizz root>/projects/*​/server.lock` — last resort, since one machine runs one frizz.
 *
 * A candidate whose PID IS DEAD IS SKIPPED, which is the difference between a legible failure and the
 * one that cost an afternoon: a stale lock from a long-dead per-project server sent every call at a port
 * nothing was listening on, and the tool reported only "fetch failed".
 *
 * The frizz root is `../..` from the state dir rather than computed: this file is dependency-free and
 * the real root is platform-dependent (XDG, `~/Library/Application Support`, a legacy `~/.frizz`).
 */
function serverLockPort() {
  const stateDir = process.env.FRIZZ_STATE_DIR
  const root = stateDir ? dirname(dirname(stateDir)) : undefined
  const candidates = [
    process.env.FRIZZ_SERVER_LOCK,
    root ? join(root, "server.lock") : undefined,
    stateDir ? join(stateDir, "server.lock") : undefined,
  ].filter(Boolean)
  for (const path of candidates) {
    const live = liveLock(path)
    if (live) return live.port
  }
  // Nothing we were told about is alive. One machine runs one frizz, so any project's live lock names
  // it — and addressing by project id (rpcPath) means a server that does not serve us answers 404
  // rather than acting on the wrong board.
  if (root) {
    let entries = []
    try { entries = readdirSync(join(root, "projects")) } catch {}
    for (const entry of entries) {
      const live = liveLock(join(root, "projects", entry, "server.lock"))
      if (live) return live.port
    }
  }
  if (candidates.length === 0) throw new Error("FRIZZ_STATE_DIR / FRIZZ_SERVER_LOCK not set — cannot locate the frizz server")
  // SAY THAT NOTHING WAS SAVED, and say to retry. A worker reads "is frizz running?" as a fact about the
  // world rather than as a fact about ITS OWN call, and moves on — so whatever it was arming is silently
  // gone. Measured 2026-08-17: a worker's `recurring_prompt start` hit a restart window, got this error,
  // carried on, and its Goal — the thing keeping a long autonomous effort alive — never existed. The
  // window is ordinary (frizz restarts, and this process outlives every one of them), so the recovery has
  // to be ordinary too: try again.
  throw new Error(
    `no running frizz server found (looked at ${candidates.join(", ")} and every project lock under ` +
    `${root ? join(root, "projects") : "the frizz root"}; each was missing, malformed, or written by a process that is gone). ` +
    `NOTHING WAS SAVED — this call had no effect. frizz is probably mid-restart, which is ordinary and ` +
    `brief; RETRY this exact call before you do anything else, and do not come to rest assuming it took.`,
  )
}

/**
 * The RPC base for OUR project.
 *
 * One frizz serves every project on the machine, and an unprefixed `/_frizz/rpc/…` is the project it
 * was LAUNCHED from — so without the prefix a worker in any other project acted on the launcher's
 * board (spawn_thread put its new thread there; the thread-scoped tools looked for a slug that lives
 * in a different registry). FRIZZ_PROJECT_ID is the immutable registry id rather than the slug,
 * because the value is handed over once at spawn and then held for the life of a detached daemon,
 * and a project can be renamed under it. Unset ⇒ unprefixed, which is what a server that only ever
 * serves one project passes, and what the launching project's own workers get.
 * @param {string} procedure
 */
function rpcPath(procedure) {
  const project = projectSegment()
  return `${project ? `/_frizz/${encodeURIComponent(project)}` : "/_frizz"}/rpc/${procedure}`
}

/**
 * WHICH PROJECT WE ACT ON — always the one this worker is actually running in.
 *
 * There is deliberately no tool parameter for it and no way to name another project: the id comes from
 * the server's stamp, or failing that from the tree we are standing in (`<root>/.frizz/.id`, the same
 * file project-root.ts treats as identity). Spawning a thread onto somebody else's board is therefore
 * not something a model can express, rather than something it is asked not to do.
 *
 * The walk-up is what makes this work for a worker spawned by a server that predates the stamp, and it
 * is the honest source anyway: a worker's project is wherever its cwd is, and that cannot go stale.
 */
function projectSegment() {
  const stamped = process.env.FRIZZ_PROJECT_ID
  if (stamped) return stamped
  let dir = process.cwd()
  for (;;) {
    try {
      const id = readFileSync(join(dir, ".frizz", ".id"), "utf8").trim()
      if (id) return id
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The `spawn_thread` handler: POST /_frizz/rpc/dispatch, return the worker-facing result text.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function spawnThread(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string")
  // model + effort are REQUIRED (no default) so the caller must choose by task complexity — a defaulted
  // model (e.g. the project's cheap default) is exactly the bug this guards. Enforced server-side too,
  // not only in the tool schema, so a lenient client can't skip the decision.
  const model = typeof args.model === "string" ? args.model.trim() : ""
  if (!model) throw new Error("`model` is required — choose one by the new task's complexity (claude: opus/sonnet/haiku, opus being the top tier; codex: a gpt-5.6 model id). There is no default.")
  const effort = typeof args.effort === "string" ? args.effort.trim() : ""
  if (!effort) throw new Error("`effort` is required — choose one by complexity (low/medium/high/xhigh/max). There is no default.")

  /** @type {Record<string, unknown>} */
  const body = { prompt, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend

  const port = serverLockPort()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${rpcPath("dispatch")}`, {
      method: "POST",
      // No Origin header (undici omits it for non-browser fetch); `sec-fetch-site: same-origin`
      // satisfies the server's loopback-origin gate (app.ts isTrustedLocalHttpRequest).
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`dispatch request failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`dispatch returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  const payload = await res.json().catch(() => null)
  const slug = payload?.result?.slug
  if (typeof slug !== "string" || !slug) throw new Error(`dispatch response missing a slug: ${JSON.stringify(payload)?.slice(0, 300)}`)
  const label = typeof body.title === "string" ? body.title : slug
  return (
    `Spawned a new frizz thread \`${slug}\`. It is now on the board driving independently — it reports ` +
    `to the human via its own final message, NOT back to you, so do not wait on a result from it.\n\n` +
    `Paste this link to let the human open it in the drawer:\n\n[${label}](/thread/${slug})`
  )
}

/** POST a frizz RPC procedure and return its parsed payload. Shares spawn_thread's transport rules:
 * the port comes from server.lock and `sec-fetch-site: same-origin` satisfies the loopback gate.
 * @param {string} procedure @param {Record<string, unknown>} body @returns {Promise<any>} */
// HOW LONG A RESTART WINDOW IS ALLOWED TO BE INVISIBLE. frizz replaces its own server routinely
// ("Update & Restart", a dev rebuild), and this process is deliberately still here across every one of
// them — so a call landing in that gap is ORDINARY, and failing it is the shim reporting frizz's
// housekeeping as the worker's problem. Measured 2026-08-17: a `recurring_prompt start` landed in one,
// failed, and the Goal that was keeping a long autonomous effort alive silently never existed.
//
// Telling the model to retry (which the error also does) is strictly weaker than retrying, because it
// only works if the model complies. Bounded and short: a genuinely-down frizz still fails, promptly,
// with the same message — this only covers the seconds where a new server is coming up.
const LOCK_RETRY_MS = 6_000
const LOCK_RETRY_INTERVAL_MS = 400

/** The port, waiting out a brief restart window rather than failing into one. Rethrows the real
 *  "no running frizz server" error once the budget is spent, so a frizz that is actually down still
 *  says so — and says it with the retry guidance attached. */
async function serverLockPortWaiting() {
  const deadline = Date.now() + LOCK_RETRY_MS
  for (;;) {
    try {
      return serverLockPort()
    } catch (err) {
      if (Date.now() >= deadline) throw err
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS))
    }
  }
}

async function callRpc(procedure, body) {
  const port = await serverLockPortWaiting()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${rpcPath(procedure)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`${procedure} request failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`${procedure} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  return await res.json().catch(() => null)
}

/** Which thread this MCP server belongs to. Stamped into our env at spawn (the broker bridge, on the
 * Claude SDK path) because the MCP protocol carries no caller identity.
 * FRIZZ_THREAD is the fallback: every frizz worker process is tagged with it, so it is right
 * whenever the env is inherited — but it is not relied upon, hence the explicit var first.
 *
 * This is also the reason a model can never point `goal` at someone else's thread: the slug is
 * read from HERE, never from the tool arguments. */
function threadSlug() {
  const slug = process.env.FRIZZ_THREAD_SLUG || process.env.FRIZZ_THREAD
  if (!slug) {
    // Ten tools resolve their caller through here, so the message must not name one of them. It said
    // "so it cannot arm a goal for it" for every single one — which read as a bug in `goal` no matter
    // which tool the worker had actually called, and sent at least one worker off debugging the wrong
    // thing after `title` failed on a codex thread.
    throw new Error(
      "this frizz MCP server was not told which thread it belongs to (no FRIZZ_THREAD_SLUG), so it cannot " +
      "act on the caller's own thread. This is a frizz bug — report it rather than working around it.",
    )
  }
  return slug
}

/** How a heartbeat cadence reads back to the worker. ONE formatter, because `start` and `get` describe
 * the same stored number and a worker that saw "every 15m" armed must not read "every 900s" back.
 *
 * The house duration grammar (`packages/web/src/lib/durationLabels.ts`), matching the trailer
 * `formatIntervalLabel` writes into the delivery itself — a worker reads both.
 * @param {number|undefined} seconds */
function cadenceLabel(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined
  if (seconds % 60 !== 0) return `${seconds}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes}m`
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`
}

/** Render an armed goal for the worker to read: which triggers are live, the cadence, when
 * each last fired, and the text VERBATIM (never truncated — reading back a summary of your own
 * instruction is exactly as blind as not reading it).
 * @param {{ prompt: string, stopHook: boolean, heartbeat: boolean, postCompaction: boolean,
 *           intervalSeconds?: number, armedAt: string, lastRestFiredAt?: string,
 *           lastScheduleFiredAt?: string, lastCompactFiredAt?: string }} rp */
function goalReport(rp) {
  const fired = (/** @type {string|undefined} */ at) => (at ? `last fired ${at}` : "never fired yet")
  const triggers = [
    rp.stopHook ? `  stop_hook — every time you come to rest (${fired(rp.lastRestFiredAt)})` : null,
    rp.heartbeat
      // The SAME cadence form `start` reports (cadenceLabel), or the two readings of one row disagree
      // about the number they are describing — "every 15 min" armed, "every 900s" read back.
      ? `  heartbeat — every ${cadenceLabel(rp.intervalSeconds) ?? "?"} (${fired(rp.lastScheduleFiredAt)})`
      : null,
    rp.postCompaction ? `  post_compaction — every compaction (${fired(rp.lastCompactFiredAt)})` : null,
  ].filter(Boolean)
  // EVERY trigger off is a real, reachable state — the human can switch them off in the footer without
  // clearing the words — and it is the one a worker would otherwise misread as "armed and running".
  const head = triggers.length
    ? `Armed since ${rp.armedAt}, on:\n${triggers.join("\n")}`
    : `Text is parked (armed ${rp.armedAt}) but EVERY TRIGGER IS OFF — nothing will fire until one is switched back on.`
  return `${head}\n\nThe text, verbatim:\n\n${rp.prompt}`
}

/** The `goal` handler: arm, disarm, or READ BACK this thread's re-prompt.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function goal(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "start" && action !== "stop" && action !== "get") {
    throw new Error("`action` must be one of \"start\", \"stop\" or \"get\"")
  }

  if (action === "get") {
    // A frizz server older than this tool has no such procedure and answers 404. Say what that means,
    // rather than leaving a worker to read a bare HTTP status as "nothing is armed" — the two answers
    // could not be further apart.
    let payload
    try {
      payload = await callRpc("getOwnThreadRecurringPrompt", { slug })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(message)) {
        throw new Error(
          "this frizz server predates the read action, so it cannot tell you what is armed. Treat the " +
          "armed state as UNKNOWN — do not assume it is empty — and check the thread footer instead.",
        )
      }
      throw err
    }
    const rp = payload?.result?.recurringPrompt
    if (!rp) return "No goal is armed on this thread. Nothing will re-prompt you."
    return goalReport(rp)
  }

  if (action === "stop") {
    await callRpc("setOwnThreadRecurringPrompt", { slug, prompt: null, stopHook: false, heartbeat: false, postCompaction: false })
    return "Goal disarmed and cleared. No trigger will fire — not the stop hook, not the heartbeat, not the post-compaction one — and the text is gone from the thread footer."
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) {
    throw new Error("`prompt` is required to start a goal — it is the text you will be sent on every trigger")
  }

  const hasHeartbeat = args.heartbeat_seconds !== undefined && args.heartbeat_seconds !== null
  let interval
  if (hasHeartbeat) {
    interval = typeof args.heartbeat_seconds === "number" ? Math.round(args.heartbeat_seconds) : NaN
    if (!Number.isFinite(interval)) throw new Error("`heartbeat_seconds` must be a number of seconds")
    if (interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
      throw new Error(`\`heartbeat_seconds\` must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`)
    }
  }
  const postCompaction = args.post_compaction === true
  // DEFAULTED, not required: a `start` that names no trigger at all is a model asking to be re-prompted
  // and leaving the mechanism to us, and the rest trigger is the safe reading of that — it cannot talk
  // over a running turn, and it cannot fire on a thread that has stopped needing it.
  const stopHook = typeof args.stop_hook === "boolean" ? args.stop_hook : !hasHeartbeat && !postCompaction
  const heartbeat = hasHeartbeat
  if (!stopHook && !heartbeat && !postCompaction) {
    throw new Error("at least one is required: set `stop_hook: true`, give `heartbeat_seconds`, set `post_compaction: true`, or any combination")
  }

  const written = await callRpc("setOwnThreadRecurringPrompt", {
    slug,
    prompt,
    stopHook,
    heartbeat,
    postCompaction,
    ...(heartbeat ? { intervalSeconds: interval } : {}),
  })
  // `replaced` is absent against a server that predates it, which is indistinguishable from "there was
  // nothing" — so the clause only ever appears when the row genuinely carried something.
  const replaced = written?.result?.replaced

  const every = heartbeat ? cadenceLabel(interval) : null
  // One clause per armed trigger, joined — with three of them the old nested ternary could no longer say
  // what was actually armed, and a worker that misreads which trigger it holds waits for a delivery that
  // is never coming.
  const clauses = [
    stopHook ? "every time you come to rest" : null,
    every ? `every ${every} (the heartbeat reaches you mid-turn)` : null,
    postCompaction ? "every time your context is compacted, delivered into the emptied window" : null,
  ].filter(Boolean)
  const when = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(", ")} AND ${clauses[clauses.length - 1]}`
  // Spelled out in full, not summarized: if this overwrote the human's own edit, the words themselves
  // are the only way the worker can put them back.
  const superseded = replaced
    ? `\n\nIT REPLACED an existing goal — check that discarding it was intended, and restore ` +
      `it with another \`start\` if it was not:\n\n${goalReport(replaced)}\n`
    : ""
  // NO QUESTION HOLD ANY MORE (2026-08-16). Every trigger fires while you are waiting on the human, and
  // the at-rest one fires over your own unanswered ```question fence — the delivery says so, and expects
  // you to decide the question yourself rather than re-ask it. A ```done fence, and an ```awaiting on a
  // wait frizz itself will deliver, still stop the at-rest trigger.
  return (
    `Goal armed — frizz will send you this ${when}.${superseded}\n\n` +
    "Call this tool again with `action: \"stop\"` once the work it drives is finished — one left armed on " +
    "a finished thread wakes it forever. The human can also edit or switch it off in the thread footer. " +
    "Signing off with a ```done fence stops it too, but only when there is genuinely nothing left: it " +
    "files the thread away until the human sends more work."
  )
}

/** How a timer reads back to the worker: its id, when it fires, and enough of its text to tell two apart.
 * @param {{ id: string, fireAt: string, prompt: string }} t */
function timerLine(t) {
  const words = t.prompt.replace(/\s+/g, " ").trim()
  return `  ${t.id} — ${t.fireAt} — ${words.length > 72 ? `${words.slice(0, 72)}…` : words}`
}

/** @param {{ timers?: { id: string, fireAt: string, prompt: string }[] }|null} payload */
function armedList(payload) {
  const timers = payload?.timers ?? []
  if (!timers.length) return "No timers are armed on this thread."
  return `Armed timers (${timers.length}):\n${timers.map(timerLine).join("\n")}`
}

/** The `timer` handler: set / cancel / list this thread's ONE-OFF timers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function timer(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "set" && action !== "cancel" && action !== "list") {
    throw new Error("`action` must be one of \"set\", \"cancel\" or \"list\"")
  }

  if (action === "list") {
    return armedList((await callRpc("listOwnThreadTimers", { slug }))?.result)
  }

  if (action === "cancel") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to cancel a timer — take it from `set`'s reply or from `action: \"list\"`")
    const result = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = result?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(result)}`
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required to set a timer — it is the text you will be sent when it fires")

  // Exactly one of the two ways to name the instant. Accepting both would mean silently preferring one,
  // and a worker that gave two different times meant something by each of them.
  const hasIn = args.in_seconds !== undefined && args.in_seconds !== null
  const hasAt = typeof args.at === "string" && args.at.trim() !== ""
  if (hasIn && hasAt) throw new Error("give `in_seconds` OR `at`, not both")
  if (!hasIn && !hasAt) throw new Error("give either `in_seconds` (fire N seconds from now) or `at` (an ISO-8601 instant)")

  const nowMs = Date.now()
  let fireMs
  if (hasIn) {
    const seconds = typeof args.in_seconds === "number" ? Math.round(args.in_seconds) : NaN
    if (!Number.isFinite(seconds)) throw new Error("`in_seconds` must be a number of seconds")
    if (seconds < TIMER_MIN_DELAY_SECONDS || seconds > TIMER_MAX_DELAY_SECONDS) {
      throw new Error(`\`in_seconds\` must be between ${TIMER_MIN_DELAY_SECONDS} and ${TIMER_MAX_DELAY_SECONDS} (thirty days)`)
    }
    fireMs = nowMs + seconds * 1000
  } else {
    fireMs = Date.parse(String(args.at))
    if (!Number.isFinite(fireMs)) throw new Error("`at` must be an ISO-8601 instant, e.g. `2026-08-04T15:00:00Z`")
    const delta = Math.round((fireMs - nowMs) / 1000)
    if (delta < TIMER_MIN_DELAY_SECONDS) {
      throw new Error(`\`at\` must be at least ${TIMER_MIN_DELAY_SECONDS}s in the future (it reads as ${delta}s from now)`)
    }
    if (delta > TIMER_MAX_DELAY_SECONDS) throw new Error("`at` must be within thirty days")
  }

  // ONE representation crosses the wire — the exact UTC instant — so the stored row, the trailer on the
  // delivered message and this reply all name the same string.
  const fireAt = new Date(fireMs).toISOString()
  const result = (await callRpc("setOwnThreadTimer", { slug, prompt, fireAt }))?.result
  const id = result?.id ?? "(unknown)"
  return (
    `Timer ${id} set for ${fireAt} (${Math.round((fireMs - nowMs) / 1000)}s from now). It fires ONCE and ` +
    "then is gone — it may reach you mid-turn, so receiving it does not mean you had stopped. Cancel it " +
    `with \`action: "cancel", id: "${id}"\` if it stops being useful.\n\n${armedList(result)}`
  )
}


/** How the armed PR-watcher set reads back, on every action, so a worker never needs a second call.
 * @param {{ watches?: Array<{id: string, target: string, github?: {checks: string, running: number, passed: number, failed: number, failing: string[], merge: string, state: string}}> }|undefined} result */
function armedPrWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No pull requests are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const g = w.github
    // The CHECK STATE rides the read-back because it is the reason a worker is listing at all: "where do
    // my PRs stand" is one call, not one per PR through `gh`.
    const state = !g
      ? "not polled yet"
      : g.state !== "open"
        ? g.state
        : g.checks === "passing" ? `checks green (${g.passed})`
        : g.checks === "failing" ? `checks FAILING${g.failing.length ? `: ${g.failing.join(", ")}` : ""}`
        : g.checks === "running" ? `checks running (${g.running} left)`
        : "no checks"
    return `  ${w.id}  ${w.target}  —  ${state}${g && g.state === "open" && g.merge === "mergeable" ? ", mergeable" : ""}`
  })
  return `Watched on this thread now:\n${lines.join("\n")}`
}

/** The armed watches on this thread, as the read-back prints them. */
function armedWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No watches are armed on this thread — nothing here is holding it out of the queue."
  const lines = watches.map((w) => {
    const what = w.kind === "agent" ? "sub-agent" : "shell"
    // The LABEL is frizz's live reading, not a copy stored at registration — so it names the work as it
    // stands, and its ABSENCE means the target no longer resolves to anything running.
    const name = w.label ? `${w.label} (${w.target})` : w.target
    return `  ${w.id}  ${what}: ${name}  —  expires ${w.expiresAt}`
  })
  return `Armed on this thread now:\n${lines.join("\n")}`
}

/** The `watch` handler: register a wait on this thread's own running work.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watch(args) {
  const slug = threadSlug()
  const kind = typeof args.kind === "string" ? args.kind.trim() : ""
  if (kind !== "shell" && kind !== "agent") throw new Error("`kind` must be \"shell\" or \"agent\"")
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the handle you were shown; `activity` prints them all")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `30m`, `2h` or `3d` (max 24h), never an instant")
  const result = (await callRpc("addOwnWatch", { slug, kind, target, for: forValue }))?.result
  const id = result?.id ?? "(unknown)"
  const head = result?.alreadyArmed
    ? `Already watching \`${target}\` as ${id} — nothing new was registered, and its original expiry stands.`
    : `Watching \`${target}\` as ${id}. Your thread is held out of the queue until it finishes, and the ` +
      "registration survives your turn ending, a compaction and a frizz restart."
  // A clamp is news here for the same reason it is on `watch_pr` — see that handler.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`for: ${result.clampedFrom}\` WAS CAPPED at the 24h ceiling for a shell or a sub-agent — ` +
      "the expiry listed below is what you actually hold."
    : ""
  return (
    `${head}${clamped}\n\nWHEN \`for\` RUNS OUT the row is CANCELLED and you are woken to re-decide — register ` +
    `again if you still mean it.\n\nDROP IT the moment it stops mattering (\`unwatch\`, id \`${id}\`); ` +
    `you do NOT need to when the work simply finishes.\n\n${armedWatchList(result)}`
  )
}

/** The `unwatch` handler: withdraw one registered watch by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unwatch(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `watch` or from `activity`")
  const result = (await callRpc("dropOwnWatch", { slug, id }))?.result
  // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled, or
  // another thread's — and a worker that believes it withdrew a wait it still holds will rest on it.
  const head = result?.dropped
    ? `Watch ${id} dropped. It is no longer holding your thread, and it will not wake you.`
    : `No ARMED watch ${id} on this thread — it was already settled, or the id is not one of yours.`
  return `${head}\n\n${armedWatchList(result)}`
}

/** Read back what the human still owes an answer on, so a worker never needs a second call to find out.
 * @param {Record<string, unknown> | undefined} result @returns {string} */
function openQuestionList(result) {
  const open = Array.isArray(result?.open) ? result.open : []
  if (!open.length) return "Nothing else is open on this thread — the human owes you no answer."
  const lines = open.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  return `Open on this thread now:\n${lines.join("\n")}`
}

/** The `ask` handler: register one or more questions the human owes an answer to.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function ask(args) {
  const slug = threadSlug()
  const questions = Array.isArray(args.questions) ? args.questions : []
  if (!questions.length) throw new Error("`questions` is required — at least one question to register")
  const result = (await callRpc("ask", { slug, questions }))?.result
  const registered = Array.isArray(result?.registered) ? result.registered : []
  const lines = registered.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  const head = registered.length === 1
    ? `Registered 1 question. It is on the human's board now and it will stay there until they answer it.`
    : `Registered ${registered.length} questions. They are on the human's board now and they will stay ` +
      "there until answered — the card sends every answer as one batch."
  return (
    `${head}\n${lines.join("\n")}\n\n` +
    "KEEP WORKING. A question waits on a person, carries no timeout and does not end your turn — do " +
    "everything that does not depend on the answer while it sits there. The answer arrives as its own " +
    "wake, restating what was asked.\n\n" +
    "WITHDRAW ONE THE MOMENT IT STOPS MATTERING (`unask`), above all if you work the answer out " +
    `yourself.\n\n${openQuestionList(result)}`
  )
}

/** The `unask` handler: withdraw one registered question by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unask(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ask`")
  const result = (await callRpc("unask", { slug, id }))?.result
  // A withdrawal that matched nothing is reported rather than swallowed: the id was wrong, the human
  // already answered it, or it is another thread's — and a worker that believes it withdrew a question
  // the human is still looking at will get an answer it has stopped expecting.
  const head = result?.withdrawn
    ? `Question ${id} withdrawn. Its card is gone and the human will not be asked.`
    : `No OPEN question ${id} on this thread — it was already answered or dismissed, or the id is not one of yours.`
  return `${head}\n\n${openQuestionList(result)}`
}

/** The `done` handler: declare the effort finished, or report exactly what refuses to let it.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function done(args) {
  const slug = threadSlug()
  const body = typeof args.body === "string" ? args.body.trim() : ""
  if (!body) throw new Error("`body` is required — the write-up the human reads on the card")
  const result = (await callRpc("markOwnDone", { slug, body }))?.result
  if (result?.done) {
    return (
      "Marked done. Your thread cards as a checked success in the human's queue and stays there until " +
      "they archive it.\n\nNOTHING WAS CLOSED, HIDDEN OR ARCHIVED — if there is more to say, say it in " +
      "your final message; if more work appears, keep going and call this again."
    )
  }
  // REFUSED, with everything that refuses it named by id, so the next move is a tool call and not a
  // guess. Reported as an ordinary result rather than thrown: this is a gate doing its job, not a fault.
  const questions = (result?.blockingQuestions ?? []).map((q) => `  ${q.id}  ${(q.question ?? "").split("\n")[0]}`)
  const watches = (result?.blockingWatches ?? []).map((w) => `  ${w.id}  ${w.what}`)
  const parts = ["NOT marked done. This thread still holds work open."]
  if (questions.length) {
    parts.push(
      `${questions.length} question${questions.length === 1 ? "" : "s"} the human has not answered:\n${questions.join("\n")}\n` +
      "Each one dies unread with a done card. Decide it yourself and withdraw it (`unask`), or leave it " +
      "open and keep working until it is answered.",
    )
  }
  if (watches.length) {
    parts.push(
      `${watches.length} registration${watches.length === 1 ? "" : "s"} still armed:\n${watches.join("\n")}\n` +
      "A live wait means the thing you were waiting for has not happened. Wait for it, or drop the ones " +
      "that stopped mattering (`unwatch`, or `watch_pr` with `action: \"drop\"`, or `timer` cancel).",
    )
  }
  parts.push("There is no force parameter. Resolve them and call `done` again.")
  return parts.join("\n\n")
}

/** The `watch_pr` handler: register, withdraw, or read back this thread's PR watchers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchPr(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedPrWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled,
    // or another thread's — and a worker that believes it withdrew a wait it still holds will rest.
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedPrWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the pull request, as `owner/repo#123` or a PR URL")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: typeof args.for === "string" ? args.for.trim() : "" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching ${ref} as ${id}${until}. Frizz wakes you when CI passes or fails and on every later ` +
      "review or comment, and the registration survives your turn ending, a compaction and a frizz restart."
  // A CLAMP IS NEWS. Silently handing back less coverage than was asked for is how a worker comes to
  // rest believing it is watched for a year when it is watched for one day.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`for: ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`prs: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the human what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`action: "drop", id: "${id}"\`).\n\n${armedPrWatchList(result)}`
  )
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
        replyTool(id, await handler(params?.arguments ?? {}))
      } catch (err) {
        replyTool(id, `\`${name}\` failed: ${err instanceof Error ? err.message : String(err)}`, true)
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
