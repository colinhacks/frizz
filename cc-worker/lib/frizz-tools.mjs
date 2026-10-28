// @ts-check
/**
 * frizz-tools — every capability Frizz hands its own WORKERS, as ONE registry: the definition of each
 * command (name, summary, description, input schema, how its arguments are spelled on a command line)
 * and the handler that performs it. Dependency-free, and transport-free: a front-end imports TOOLS and
 * HANDLERS and decides how a call arrives and how its answer leaves.
 *
 *   bin/frizzctl      — the command line a worker runs from its own shell. THE worker surface.
 *   bin/frizz-mcp.mjs — the same registry over MCP stdio, for a worker dispatched before the CLI.
 *
 * A new worker-facing capability joins the TOOLS registry below rather than growing a second surface.
 *
 * Every handler is a thin wrapper over one of Frizz's own RPCs: it reads the running server's port from
 * a server.lock and POSTs `/_frizz/<project>/rpc/<procedure>`. That surface has no token auth — only a
 * loopback-origin CSRF gate — so a headerless local POST with `sec-fetch-site: same-origin` (undici
 * sends no Origin) satisfies it.
 *
 * NOTHING HERE DEPENDS ON THE ENVIRONMENT STAYING TRUE. A worker lives inside a DETACHED daemon that
 * outlives Frizz restart after restart, so anything frozen into it at spawn is a bug waiting for the
 * next "Update & Restart" to move the port. Both facts we need are therefore resolved PER CALL, from
 * files: the server's address (serverLockPort — the env hint, then the machine-wide
 * `<frizz root>/server.lock`, then any live project lock, skipping any whose pid is gone) and our own
 * project (projectSegment — the stamp, else `.frizz/.id` walked up from our cwd). The env is a hint
 * that saves a lookup; the filesystem is the truth.
 *
 * A handler NEVER takes the caller's thread from its arguments: threadSlug() reads it from the
 * environment the worker was started with, which is what stops one thread acting as another.
 */
import { readFileSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"

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
    "its own final message, and its results come back to you, the caller, only if it sends them with " +
    "`steer` — which its prompt is told it can, and which you must ASK for in that prompt if you need " +
    "them. You cannot wait on it as you wait on a sub-agent. It is NOT an in-session " +
    "sub-agent. It returns only the new thread's slug and a ready-to-paste markdown link " +
    "`[title](/thread/<slug>)` that opens the thread in the frizz drawer — put that link in your handoff. " +
    "USE IT ONLY for a distinct, self-contained effort that belongs on the board in its own right and whose " +
    "output you do NOT need to read. Do NOT use it for a helper whose result you must COLLECT and fold into " +
    "your own work — a self-review, a verification pass, a research prong, a critic, any collect-back helper: " +
    "those are in-session sub-agents (Claude: the Agent tool with `run_in_background`; Codex: native " +
    "delegation), which return their findings to you. Spawning such a helper here STRANDS it — its work lands " +
    "on another card and never reaches you, so you gain nothing. " +
    "Because nothing it learns returns to you OR to its siblings unless somebody steers it across, a chain of " +
    "spawned threads re-derives the same facts in parallel and nobody notices — measured here: one thread " +
    "spawned four, three of those spawned more, and three descendants independently rediscovered the same " +
    "root cause over twenty hours. " +
    "Spawn only when the work genuinely cannot ride on your own card: a different repo, a different long-lived " +
    "runtime, an effort that must outlive yours. Never spawn merely to clear your own `done` fence. " +
    "The new thread lands on YOUR project's board unless you pass `project`: then it starts on that " +
    "project's board, in that project's checkout — the way to hand work to another repo this Frizz serves. " +
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
      project: {
        type: "string",
        description:
          "Optional: start the thread on ANOTHER project's board, in that project's checkout — its slug, as " +
          "its board URL shows it (`/project/<slug>/…`), or any link into that board. Omitted ⇒ your own " +
          "project. The new thread is told which project you are on, so it can `steer` results back.",
      },
    },
    required: ["prompt", "model", "effort"],
  },
}

const GOAL = {
  name: "goal",
  description:
    "Arm a GOAL on YOUR OWN thread: one piece of text that frizz re-sends you, on any or all of three " +
    "triggers, for as long as it is armed. The board shows it as the thread's Goal. (This command was " +
    "the `recurring_prompt` tool until 2026-08-28 — a summary or note that says so means this one.)\n\n" +
    "  --stop-hook           — every time you come to REST. Use it to keep a long autonomous effort moving " +
    "without the human driving every step, and to rescue yourself from a wait that may never resolve.\n" +
    "  --heartbeat-seconds   — on a CLOCK, whatever you are doing. This one reaches you MID-TURN: it arrives as " +
    "a queued message you read at your next tool boundary rather than waiting for you to stop, and it " +
    "never aborts what you are running. Use it for something that must be revisited on a schedule no " +
    "matter what you happen to believe at the time.\n" +
    "  --post-compaction     — every time your CONTEXT IS COMPACTED, delivered into the emptied window. If " +
    "you keep notes in your scratch directory, a prompt that LINKS them comes back at the exact moment " +
    "you have lost everything else. Also mid-turn — a compaction happens while you are working.\n\n" +
    "Set at least one; any combination is fine.\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime frizz runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "frizz itself and is unaffected.\n\n" +
    "READ IT BACK WITH `frizzctl goal get` — and do that BEFORE any `start` that is not a fresh arming. A " +
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
    "STOP IT when the work it drives is done (`frizzctl goal stop`) — one left armed on a finished thread " +
    "wakes it forever. The human sees it in the thread footer and can edit or switch it off there. " +
    "Signing off with a ```done fence stops it too, every trigger at once — but only when the work is " +
    "genuinely finished, because that files the thread away and a thread nobody is watching does not " +
    "restart itself.\n\n" +
    "You can only ever arm your OWN thread — there is no argument for anyone else's.",
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
          "Send it every time you come to rest. Defaults to true when neither `--heartbeat-seconds` nor " +
          "`--post-compaction` is given, so a `start` that names no mechanism still does the obvious thing.",
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
    "now. Give exactly one of `--in-seconds` or `--at`. You can only ever set a timer on your OWN thread.",
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
          `${TIMER_MAX_DELAY_SECONDS} — thirty days). Give this OR \`--at\`, not both. Sub-minute precision ` +
          "is not real: the delivery is read at your next tool boundary.",
      },
      at: {
        type: "string",
        description:
          "For `set`: fire at this exact instant, as an ISO-8601 timestamp (e.g. `2026-08-04T15:00:00Z`). " +
          "Give this OR `--in-seconds`, not both. Must be in the future and within thirty days.",
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
    "red, you push a fix, CI goes green, a reviewer comments — that is four wakes from one registration, and you " +
    "never have to re-register between them. It settles itself when the PR merges or closes, because " +
    "there is then nothing left to report.\n\n" +
    "REGISTER IT THE MOMENT YOU OPEN OR PUSH A PR. Nothing else watches for you: your runtime knows " +
    "nothing about GitHub, and an ```awaiting fence STATES what you are waiting on without creating any " +
    "wait at all. This command is the wait.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, and it is a different job: it is how you come to REST " +
    "without frizz asking you for a handoff, and how the human sees what you are waiting for. Register " +
    "the watcher with this command, then name the same PR in your fence's `prs:` list — and give the fence " +
    "the same long `for:` you gave the watcher, or the fence expires first and bumps you anyway.\n\n" +
    "GIVE AN EXTERNAL PR A LONG `--for` — MONTHS, up to a year. A pull request into a repo nobody here " +
    "controls moves on its maintainers' clock, not yours, and a short watcher on one expires against a " +
    "PR that has not changed: a wake with nothing in it, and a re-arm. Long costs nothing — real " +
    "activity still wakes you the instant it lands, and the human snoozes or archives the thread if " +
    "they want it off the board.\n\n" +
    "REGISTERING IS IDEMPOTENT per pull request: asking twice returns the SAME id and tells you it was " +
    "already armed, so re-registering after a compaction is safe and is the right instinct. Use " +
    "`frizzctl watch-pr list` when you want to know what you are holding without changing anything — it " +
    "answers with each PR's current check state too.\n\n" +
    "You can only ever watch a PR on your OWN thread — there is no argument for anyone else's.",
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
          "`180d`, `365d`). A short `--for` on one of those does not make it get reviewed sooner; it just " +
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

const WATCH_ISSUE = {
  name: "watch_issue",
  description:
    "REGISTER A GITHUB ISSUE and frizz brings you back whenever something happens on it — every later " +
    "comment, from a human or a bot alike, a label added or removed, someone assigned, and the issue " +
    "closing. Register it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, like `watch-pr` and unlike a timer: one registration covers the whole life " +
    "of the issue, and it settles itself when the issue closes, because there is then nothing left to " +
    "report. There is no CI and no merge on an issue, so those are the only things it can say.\n\n" +
    "USE IT WHEN THE NEXT STEP IS SOMEONE ELSE'S REPLY ON AN ISSUE — a reporter you asked for a " +
    "reproduction, a maintainer you asked to triage, a discussion you are waiting to see resolved. " +
    "Nothing else watches for you: your runtime knows nothing about GitHub, and an ```awaiting fence " +
    "STATES what you are waiting on without creating any wait at all. This command is the wait. A PULL " +
    "REQUEST is `frizzctl watch-pr`, not this — `gh issue view` refuses a PR number, and so does this.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, for the same reason it is beside `watch-pr`: it is " +
    "how you come to REST without frizz asking for a handoff, and how the human sees what you wait for. " +
    "Register the watcher, then name the same issue in the fence's `issues:` list, with the same long " +
    "`for:`.\n\n" +
    "GIVE IT A LONG `--for` — an issue in someone else's repo moves on their clock, and a short watcher " +
    "expires against an issue nobody has touched: a wake with nothing in it. Months are free; real " +
    "activity wakes you the instant it lands either way.\n\n" +
    "REGISTERING IS IDEMPOTENT per issue: asking twice returns the SAME id and says so, so re-registering " +
    "after a compaction is safe. `frizzctl watch-issue list` reads back the issues watched on this thread without changing " +
    "anything. You can only ever watch an issue on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per issue); `drop` withdraws one by id; `list` reads " +
          "back every issue armed on this thread, with its latest state, without changing anything.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The issue, as `owner/repo#123` or a GitHub issue URL. A ref that cannot " +
          "be parsed, a PR URL, or an issue the server's own `gh` cannot read, is REFUSED rather than " +
          "stored — a watcher that can never fire is worse than none. A refusal names the reason.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you. An issue you are waiting on someone else to answer deserves MONTHS.",
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
// than one it restates at every rest. Two commands rather than one action-switch, because they are two
// verbs and a worker reaching for `unwatch` should find `unwatch`. See plans/rest-by-registration.md.
const WATCH = {
  name: "watch",
  description:
    "REGISTER A WAIT on something this thread already has running — a background shell, a sub-agent — " +
    "and frizz brings you back when it finishes, or when `--for` runs out.\n\n" +
    "IT IS A ROW, NOT A SENTENCE. A ```awaiting fence has the lifetime of the message carrying it; this " +
    "survives your turn ending, a compaction and a frizz restart.\n\n" +
    "IT DOES NOT REPLACE THE FENCE. Where the thread sits while you wait is an answer about each REST, " +
    "so every rest on running work still ends with a ```awaiting fence that names the work and answers " +
    "`status: working|watching|needs_input` — `working` and `watching` keep the thread out of the " +
    "human's queue, and a rest with no fence lands in it.\n\n" +
    "`--for` IS REQUIRED and it is a DURATION, never an instant. When it runs out the row is CANCELLED " +
    "and you are woken to re-decide — that is deliberate, and it is what stops a wait outliving the " +
    "reason you made it. Register again if you still mean it.\n\n" +
    "THE TARGET IS CHECKED AGAINST WHAT IS ACTUALLY RUNNING, not against its shape. A handle nothing " +
    "live answers to is REFUSED rather than stored, and so is a `kind` that disagrees with what frizz " +
    "can see — a sub-agent registered as a shell is refused and told what it actually is. If you have " +
    "lost an id (a compaction, a long turn), run `frizzctl activity` rather than guessing.\n\n" +
    "A SUB-AGENT NEEDS NO REGISTRATION — its return re-invokes you — so the case this exists for is a " +
    "background SHELL: frizz cannot tell a build you are waiting on from a dev server you started and " +
    "moved on from, and only you know which it is.\n\n" +
    "NEVER WATCH SOMETHING YOU INTEND TO OUTLIVE. A dev server, a log tail, a file watcher — those are " +
    "things you started, not things you are waiting for, and registering one is a wait on work that " +
    "will never finish.\n\n" +
    "REGISTERING IS IDEMPOTENT per (kind, target): asking twice returns the SAME id, says it was " +
    "already armed, and leaves the original expiry alone — so re-registering after a compaction is safe " +
    "and is the right instinct. Use `frizzctl unwatch <id>` to withdraw one. A PULL REQUEST is `frizzctl watch-pr`, not this: " +
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
          "`frizzctl activity` prints all of them.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED. How long to hold the wait, as a DURATION — `30m`, `2h`, `3d` (max 24h). Never an " +
          "instant, and there is no default: choose it for THIS wait. When it elapses the row is " +
          "cancelled and you are woken to re-decide, so an over-long guess costs a wait that outlives " +
          "its reason and a too-short one costs one extra turn. The ceiling is a DAY here, unlike " +
          "`watch-pr`'s year: a shell or a sub-agent dies with this session, so a wait on one that has " +
          "stood for a day is a wait on something already gone.",
      },
    },
    required: ["kind", "target", "for"],
  },
}

const UNWATCH = {
  name: "unwatch",
  description:
    "WITHDRAW A WATCH you registered with `frizzctl watch`, by its id. It will not wake you any more.\n\n" +
    "Use it the moment a wait stops mattering — you decided not to wait for that build after all, or " +
    "you are about to end the thread. A watch you no longer care about still wakes you for nothing, and " +
    "it blocks `done` until it is withdrawn.\n\n" +
    "You do NOT need this when the work simply finishes: frizz settles the row itself and wakes you. " +
    "`frizzctl activity` prints the id of everything you hold. A `watch-pr` / `watch-issue` id (`prw_…` / " +
    "`isw_…`), a `timer` id (`tmr_…`) or a `watch-command` id (`cmw_…`) is withdrawn here too.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The watch id `frizzctl watch` printed (or that `frizzctl activity` lists), or a PR, issue, timer or command-watch id. Only your own thread's.",
      },
    },
    required: ["id"],
  },
}

// ---- `ask` / `secret`: RETIRED, and `unask` -------------------------------------------------------------
//
// A QUESTION IS A ```question FENCE IN THE WORKER'S OWN MESSAGE (2026-10-13). The server reads every
// assistant message, registers each new `id:` as a `thread_question` row, and reads an `id:`-only fence as
// a reference to one that exists (packages/shared/src/question-fence.ts). `ask` worked — about 4 failures
// in 220 calls — but 61% of those calls were the last tool call before the rest: a whole request spent
// re-reading the context to register, and then a handoff that copied the minted id back into a placement
// marker. See plans/rest-by-registration.md.
//
// BOTH COMMANDS STAY, AND REFUSE. A worker whose contract predates the fence still reaches for them, and
// so does one that read `frizzctl ask` in a project's own docs; refusing at that moment, with the fence in
// the refusal, teaches better than a command that is simply gone ("no such command" teaches nothing). The
// refusal makes no RPC: the `ask` RPC itself stays for the server's own registrar, its seeds and its tests.
// Neither is listed by `frizzctl --help`, and each MCP description is one line.

/** What a refused `ask` prints, and what `frizzctl ask --help` prints: the fence, whole enough to write one
 *  without the contract that taught it, because the worker reading it may have a contract that never did. */
const ASK_RETIRED =
  "NOT registered — `frizzctl ask` is retired (2026-10-13), and nothing was sent. Ask the human by writing " +
  "a ```question fence in your own message instead: Frizz registers it when the message lands and draws " +
  "its card exactly where you wrote it.\n\n" +
  "```question\n" +
  "id: settings-store\n" +
  "kind: choice\n" +
  "question: Should the settings store use SQLite or a JSON file?\n" +
  "options:\n" +
  "  - label: SQLite\n" +
  "    description: Transactional, and one store to back up\n" +
  "    recommended: true\n" +
  "  - label: JSON file\n" +
  "    description: No dependency, hand-editable\n" +
  "---\n" +
  "Optional context, in any Markdown: a table, a diff, a callout, a <details> section.\n" +
  "```\n\n" +
  "- `id:` is yours to choose: a lowercase slug, unique in this thread for good.\n" +
  "- `kind:` is `choice` (pick one), `multi` (pick several), `text` (free text) or `secret` (one masked " +
  "box, for a token or a one-time code).\n" +
  "- `question:` is one line. Each option takes `label:`, `description:` (one line, in sentence case), `recommended: true` " +
  "and `detail: |` (an indented Markdown block). The question may also carry `danger: true`.\n" +
  "- Every value is read verbatim to the end of its line. A code block inside the fence needs a longer " +
  "outer fence (````question).\n" +
  "- Several questions are several fences in one message. A follow-up is its own fence in the same message " +
  "with `when: <parent id> = <option label>`.\n" +
  "- At a later rest that still needs an answer, write a fence carrying that question's `id:` alone. " +
  "Withdraw one you no longer need with `frizzctl unask <id>`.\n\n" +
  "The question is your rest's sign-off and it does not end your turn: keep doing what does not depend " +
  "on the answer, then rest normally. A fence Frizz cannot register comes back to you as a correction " +
  "naming the fault."

const SECRET_RETIRED =
  "NOT registered — `frizzctl secret` is retired (2026-10-13), and nothing was sent. Ask for a value only " +
  "the human holds with a `kind: secret` question fence in your own message:\n\n" +
  "```question\n" +
  "id: npm-otp\n" +
  "kind: secret\n" +
  "question: The npm one-time code for the maintainer account, to publish frizz-server\n" +
  "```\n\n" +
  "The card is one masked box, and what the human pastes never enters the transcript or your context. The " +
  "answer's wake gives you the path of a private pipe that reads ONCE, within 15m: read it inside the " +
  "command that uses it — `npm publish --otp \"$(cat '<path>')\"` — and never cat, echo or copy it on its " +
  "own. A one-time code expires within a minute, so have the command ready before you rest. " +
  "`frizzctl ask --help` shows the rest of the question fence."

const ASK = {
  name: "ask",
  description: "RETIRED (2026-10-13): ask the human by writing a ```question fence in your own message. This only refuses, and the refusal shows the fence.",
  inputSchema: { type: "object", properties: {} },
}

const UNASK = {
  name: "unask",
  description:
    "WITHDRAW A QUESTION you asked, by its id — the `id:` you wrote in its ```question fence. Its card " +
    "disappears and the human is never asked.\n\n" +
    "Use it the moment the question stops mattering: you worked out the answer yourself, the code moved " +
    "and the fork is gone, or you are about to finish. A stale question on someone's board is worse " +
    "than no question — they answer it, and the answer is about a decision that no longer exists. An " +
    "open question also blocks `frizzctl done` until it is answered or withdrawn.\n\n" +
    "You do NOT need this for a question that gets answered; that settles itself and wakes you. Nor for " +
    "one a later rest simply does not mention: an older question stays answerable where it was asked. " +
    "Withdrawing is YOUR move and is never reported back to you as news. A withdrawn id is never asked " +
    "again — a new question takes a new id.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The question's id: the `id:` of its ```question fence, as `frizzctl activity` lists it — or a " +
          "`qst_…` id an older `frizzctl ask` printed. Only your own thread's.",
      },
    },
    required: ["id"],
  },
}

const SECRET = {
  name: "secret",
  description: "RETIRED (2026-10-13): ask for a value only the human holds with a `kind: secret` ```question fence in your own message. This only refuses, and the refusal shows the fence.",
  inputSchema: { type: "object", properties: {} },
}

// STEER (2026-10-09): one thread messaging ANOTHER thread — of the same project until 2026-10-26, of any
// project this Frizz serves since (maintainer: "frizz threads need the ability to steer other frizz
// threads regardless of project"). Claude Code's own
// cross-session `SendMessage` reaches a session only while its process is live, so a worker told to hand
// its results to a resting thread had no tool for it, and went looking for the board's `followUp` route
// to curl by hand — sixteen tool calls to find the route, the slug and the session id. This is that
// delivery, as a command: the server reads the target's current session, wraps the body so the receiver
// and the chat both know who sent it, and wakes, queues into, or reopens the target as a human
// follow-up would.
const STEER = {
  name: "steer",
  description:
    "SEND A MESSAGE TO ANOTHER THREAD, on this board or another project's, running or resting, and it " +
    "reads it as its next input. A running thread reads it at its next tool boundary; a resting thread " +
    "is WOKEN by it and starts a turn on it; a thread marked done is reopened. The receiver sees which " +
    "thread sent it and can answer with this same command.\n\n" +
    "USE IT INSTEAD OF RELAYING THROUGH THE HUMAN. Whenever another thread needs what you have, send it " +
    "there yourself: results a thread is waiting on (\"when the audit is done, send the results to " +
    "<thread>\"), a finding that changes another thread's work (it is chasing the bug you just fixed, it " +
    "depends on a commit you just landed, it is about to redo what you already did), or the answer to a " +
    "message another thread sent you. A finding that sits in your handoff until the human copies it " +
    "across costs them a trip and the other thread hours; sending it costs one command. A thread you spawned " +
    "with `frizzctl spawn-thread`, or the one that spawned you, is reachable the same way.\n\n" +
    "WRITE IT TO BE READ COLD. The receiver has none of your context: say what you found or what you " +
    "need, with the evidence, paths, commits and links it needs to act — in one complete message, not a " +
    "drip of partial ones. Every steer costs the receiver a turn on its full context, so do not send " +
    "progress chatter, and do not send what it did not need.\n\n" +
    "IT IS A COLLEAGUE'S MESSAGE, NOT THE HUMAN'S: it does not override the human's instructions to that " +
    "thread, and it is not a way to hand off work the human did not ask for. Nothing waits on a reply " +
    "unless your message asks for one, and you do not need to rest waiting for it: a reply wakes you " +
    "whenever it comes, even after `done`.\n\n" +
    "ANY PROJECT ON THIS MACHINE'S FRIZZ, not only yours. A thread's full link names its project " +
    "(`/project/<project>/thread/<slug>`), so passing the link is enough; with a bare slug, this " +
    "project is looked in first and then every other one, and `--project <slug>` says which when " +
    "several have a thread of that name. A message from another project names it, and so does the " +
    "reply command it suggests.\n\n" +
    "NOT FOR YOUR OWN SUB-AGENTS — those are inside your session; reach them with `SendMessage` to " +
    "their agent id. Not for your own thread.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "The thread to message: its slug (`fix-queue-focus`), or any link naming it — the " +
          "`[title](/thread/<slug>)` link `frizzctl spawn-thread` prints, or a full board URL such as " +
          "`http://localhost:9393/project/frizz/thread/<slug>/full`, whose `/project/<slug>/` also " +
          "names the thread's project.",
      },
      project: {
        type: "string",
        description:
          "The project the thread is on, when it is not yours: its slug, as its board URL shows it " +
          "(`/project/<slug>/…`). Needed only when a bare slug is ambiguous; a link that names a " +
          "project already says it.",
      },
      message: {
        type: "string",
        description:
          "The message, as markdown. Self-contained: the receiver has none of your context. It arrives " +
          "wrapped with your thread's name and slug, so do not sign it.",
      },
    },
    required: ["to", "message"],
  },
}

const DONE = {
  name: "done",
  description:
    "DECLARE THIS EFFORT FINISHED, with the write-up the human reads. Your thread cards as a checked " +
    "success in their queue and stays there until they archive it — marking done is not dismissal, and " +
    "it does not close, archive or hide anything.\n\n" +
    "FRIZZ CAN REFUSE THIS, which is the whole reason it is a command rather than a fence. An OPEN " +
    "QUESTION or an ARMED REGISTRATION blocks it, and the refusal names each one by id: a question " +
    "nobody answered dies with the card, and a live wait means the thing you were waiting for has not " +
    "happened yet. Resolve them for real — answer it yourself and `unask`, or `unwatch` the wait you no " +
    "longer need — then run it again. There is no force flag and there will not be one.\n\n" +
    "IT ONLY COUNTS WHAT IS REGISTERED. A background shell or a sub-agent you never registered does " +
    "not block this, because frizz cannot tell a build you are waiting on from a dev server you walked " +
    "away from. That judgement is yours, and registering it is how you make it.\n\n" +
    "DONE MEANS THE WORK LANDED, NOT THAT YOU STOPPED. Code committed to the project's mainline; a " +
    "plan, doc or commissioned report written INTO A FILE. An open pull request is not done — the " +
    "merge is. An investigation headed for a fix is not done — the fix is. And a verdict that ends in " +
    "SOMEBODY SHOULD NOW DO SOMETHING (merge it, post this, pick one of these) is not done either: " +
    "that is a question — a ```question fence in your message — carrying your recommendation as the " +
    "first option.\n\n" +
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
      title: {
        type: "string",
        description:
          "OPTIONAL. The card's heading: a short phrase in sentence case naming what LANDED (\"Resolver " +
          "cache keyed on the normalized id\"), not the handoff. It wraps, so name the work fully; past " +
          "120 characters it is trimmed on a word boundary. Without it the card is headed \"Done\", which " +
          "is true of every completion and specific to none. It wins over a `title:` line the body opens with.",
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
    "called Zod. You know. That is the entire point of this command.\n\n" +
    "WHEN TO RUN IT: after you have oriented — read the issue, opened the code, found the bug — and " +
    "can name the actual work in your own words. Not on arrival: a name you register before you " +
    "understand the task is the same guess the board already has. Once is normally enough; run it " +
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

// The registry: `frizzctl` lists these and routes a command by name (and the legacy MCP front-end
// answers `tools/list` and `tools/call` from the same list). Adding a worker-facing capability = one
// entry here + one handler in `HANDLERS` + its spelling in `CLI` — never a second surface.
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60

const ACTIVITY = {
  name: "activity",
  description:
    "EVERYTHING YOU CURRENTLY HAVE OUT, with the id each one is named by — your background shells, your " +
    "sub-agents, your armed timers, the pull requests you registered, the `wch_…` of every watch holding " +
    "one of them, every QUESTION still owed an answer, and saved links/files with their lnk_ ids.\n\n" +
    "WHY YOU NEED IT: an ```awaiting fence names what you are waiting on BY ID, and frizz checks every " +
    "one against what is actually live. A name that matches nothing is not a park — you are bumped and " +
    "your thread queues. The same goes for the ids `unwatch` and `unask` take, and for the `id:` a " +
    "```question fence references when a later rest still needs that question's answer. So if you have " +
    "lost one (a compaction, a long turn, a wake you did not expect), run this rather than guessing. " +
    "Guessing is the failure this command exists to remove — and it is how you read back your open " +
    "questions, by the id you gave each one.\n\n" +
    "It takes nothing and changes nothing. You can only ever read your OWN thread.",
  inputSchema: { type: "object", properties: {}, required: [] },
}

const LINK = {
  name: "link",
  description: "Register a labeled URL or local file on this thread, beside its agents and shells: a count above the prompt box " +
    "(`1 link`, `2 files`) that lists it on hover, the side rail in full screen, and Files and links under ⋯ on a phone. " +
    "Use for dev servers, working documents, reports, and downloads the human will need again. " +
    "The same label updates its existing row without duplicating or reordering it. " +
    "HTTP(S) destinations render as Link; local files render as File and use Frizz's existing file reader/opener. " +
    "Files must exist. Relative paths resolve from the project root; use absolute paths for worktrees. " +
    "Registration survives rests and restarts, but does not start, monitor, or verify a server. " +
    "It never blocks done or parks the thread. Read registrations with `frizzctl activity`; remove one with `frizzctl unlink <id>`.",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Short destination label, such as Open dev server or Working plan. Reuse it to update that row." },
      target: { type: "string", description: "An HTTP(S) URL, file:// URL, or existing local file path. No credentials in URLs." },
    },
    required: ["label", "target"],
    additionalProperties: false,
  },
}
const UNLINK = {
  name: "unlink",
  description: "Remove one saved link/file from this thread by its lnk_ id (printed by `frizzctl link` or listed by `frizzctl activity`). " +
    "Only removes the registration: it never deletes a file or stops a server.",
  inputSchema: {
    type: "object", properties: { id: { type: "string", description: "The lnk_ id of a registration on this thread." } },
    required: ["id"], additionalProperties: false,
  },
}

// A wait on an OUTSIDE condition that a command can check, run by the SERVER (2026-10-11). It exists
// because the alternative was a polling loop in a background shell, which pins the thread's whole
// process tree: hibernation refuses a thread holding one. See packages/server/src/command-watch.ts.
const WATCH_COMMAND = {
  name: "watch_command",
  description:
    "WAIT ON AN OUTSIDE CONDITION WITHOUT HOLDING A PROCESS. Give Frizz a shell command that exits 0 once " +
    "the thing you are waiting for is true — a package version npm serves, a release run that finished, a " +
    "URL that answers — and the SERVER runs it every `--every` until it does, then wakes you ONCE with " +
    "the command and the end of its output. Nothing of yours runs meanwhile, so your thread can be " +
    "hibernated while it rests. A polling loop in a background shell (`until …; do sleep 300; done`) pins " +
    "your whole process tree, ~250 MB, for as long as it loops; this is that loop without the cost.\n\n" +
    "THE CONDITION IS EXIT STATUS 0, and nothing else. Write the check so it FAILS until the condition " +
    "holds: `npm view frizz@0.13.12 version` (non-zero while npm does not serve it), `gh run view 123 " +
    "--json conclusion -q .conclusion | grep -qx success`, `curl -fsS http://localhost:5173/health`.\n\n" +
    "IT RUNS ON THE SERVER, NOT IN YOUR SHELL: `/bin/sh -c` in the project root, with the server's " +
    "environment and PATH, stdin closed, killed after 2m. Nothing your session exported, no aliases, no " +
    "functions. A first check runs at registration: exit 0 means the condition already holds and nothing " +
    "is armed, and a command the server cannot run at all (`command not found`) is refused.\n\n" +
    "ONLY ON A THREAD WITH NO PERMISSION CHECKS. The server runs the command with no permission prompt and " +
    "outside any sandbox, so Frizz refuses it unless this thread runs in `bypassPermissions` mode with " +
    "Claude Code's sandbox off, and refuses it on Codex. The refusal says why; wait in a background shell " +
    "then.\n\n" +
    "ONE-SHOT: the first passing check settles it. When `--for` runs out it is cancelled and you are woken " +
    "to re-decide. Name its id in your ```awaiting fence — `commands: [cmw_…]` with `status: watching`. " +
    "Registering is idempotent on the exact command text. `list` reads back what is armed, with each " +
    "watch's last check; `drop` withdraws one (so does `frizzctl unwatch <id>`). Only ever your OWN thread's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watch (idempotent per command); `drop` withdraws one by id; `list` reads back " +
          "every watch armed on this thread, with its last check, without changing anything.",
      },
      command: {
        type: "string",
        description:
          "Required for `add`. The check, as one shell command line run with `/bin/sh -c` in the project " +
          "root. Exit 0 means the condition holds. Use absolute paths for anything not on a plain PATH.",
      },
      every: {
        type: "string",
        description:
          "Required for `add`. How often to check, as a DURATION — `1m`, `5m`, `1h` (min 1m, max 24h). " +
          "Pick it for how soon you need to know: a release in npm's review is minutes to hours, so `5m`.",
      },
      for: {
        type: "string",
        description:
          "Required for `add`. How long to keep checking, as a DURATION — `2h`, `1d`, `7d` (max 7d). When it " +
          "runs out the watch is cancelled and you are woken to decide what the silence means.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The `cmw_…` id `add` printed (or that `list` and `frizzctl activity` show).",
      },
    },
    required: ["action"],
  },
}

// WATCH_ISSUE rides at the END (2026-09-14), and SECRET, STEER and WATCH_COMMAND after it: the tool list is read by position
// in frizz-mcp.test.ts, and a worker's runtime reads it by name, so the order costs nothing and appending
// breaks nothing.
const TOOLS = [SPAWN_THREAD, GOAL, TIMER, WATCH_PR, WATCH, UNWATCH, ASK, UNASK, DONE, TITLE, ACTIVITY, LINK, UNLINK, WATCH_ISSUE, SECRET, STEER, WATCH_COMMAND]

/** @type {Record<string, (args: Record<string, unknown>) => Promise<string>>} */
const HANDLERS = {
  [SPAWN_THREAD.name]: spawnThread,
  [GOAL.name]: goal,
  [TIMER.name]: timer,
  [WATCH_PR.name]: watchPr,
  [WATCH_ISSUE.name]: watchIssue,
  [WATCH.name]: watch,
  [ASK.name]: ask,
  [UNASK.name]: unask,
  [SECRET.name]: secret,
  [DONE.name]: done,
  [TITLE.name]: title,
  [UNWATCH.name]: unwatch,
  [ACTIVITY.name]: activity,
  [LINK.name]: link,
  [UNLINK.name]: unlink,
  [STEER.name]: steer,
  [WATCH_COMMAND.name]: watchCommand,
}

// The slug out of whatever a worker has in hand for a thread: the slug itself, the `[title](/thread/<slug>)`
// link spawn_thread returns, or a board URL (`…/project/<p>/thread/<slug>/full`) — which also names the
// thread's project.
const THREAD_LINK = /\/thread\/([^/?#)\s]+)/
const PROJECT_LINK = /\/project\/([^/?#)\s]+)\/thread\//
// The project out of any link into a board (`…/project/<p>/…`), for `spawn-thread --project`.
const PROJECT_SEGMENT = /\/project\/([^/?#)\s]+)/

/** The `steer` handler: deliver a message into ANOTHER thread, of this project or any other.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function steer(args) {
  const raw = typeof args.to === "string" ? args.to.trim() : ""
  const message = typeof args.message === "string" ? args.message.trim() : ""
  if (!raw) throw new Error("`to` is required — the slug of the thread to message, or a link naming it")
  if (!message) throw new Error("`message` is required and must be a non-empty string")
  const to = decodeURIComponent(THREAD_LINK.exec(raw)?.[1] ?? raw)
  const linked = PROJECT_LINK.exec(raw)?.[1]
  const named = typeof args.project === "string" ? args.project.trim() : ""
  const project = named || (linked ? decodeURIComponent(linked) : "")
  if (named && linked && decodeURIComponent(linked) !== named) {
    throw new Error(`\`--project ${named}\` disagrees with the link, which names project \`${decodeURIComponent(linked)}\`; pass one of them`)
  }
  // THE SENDER IS THE ENV'S, never the model's: the receiver is told which thread sent this, and that
  // has to be true. The call goes to OUR project, which verifies the sender and finds the target
  // wherever it lives.
  const result = (await callRpc("steerThread", { from: threadSlug(), to, ...(project ? { project } : {}), message }))?.result
  if (!result?.slug) throw new Error(`steerThread returned no receipt: ${JSON.stringify(result)?.slice(0, 300)}`)
  const how = result.delivery === "running"
    ? "It is mid-turn, so it reads this at its next tool boundary."
    : result.delivery === "reopened"
      ? "It had been marked done; this message reopened it and started a turn."
      : "It was resting; this message woke it and started a turn."
  const where = result.project ? ` on the \`${result.project}\` project` : ""
  const href = result.project ? `/project/${result.project}/thread/${result.slug}` : `/thread/${result.slug}`
  return (
    `Delivered to «${result.title}» (\`${result.slug}\`)${where}. ${how}\n\n` +
    "Its reply, if it sends one, arrives as your next input and wakes you — do not rest waiting for it. " +
    `Link for your handoff: [${result.title}](${href})`
  )
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function link(args) {
  const label = typeof args.label === "string" ? args.label.trim() : ""
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!label || !target) throw new Error("`label` and `target` are required")
  const result = (await callRpc("upsertOwnLink", { slug: threadSlug(), label, target }))?.result
  const saved = result?.link
  if (!saved?.id) throw new Error("Frizz did not return a saved link")
  return `Registered ${saved.kind} ${saved.id}: ${saved.label}\n${saved.target}\n\nThe human finds it in the count above this thread's prompt box. It does not assert a server is running or block completion. Remove it with \`frizzctl unlink ${saved.id}\`.`
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unlink(args) {
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `frizzctl link` or `frizzctl activity`")
  const result = (await callRpc("dropOwnLink", { slug: threadSlug(), id }))?.result
  return result?.dropped ? `Removed registration ${id}. No file was deleted and no server was stopped.` : `No registration ${id} on this thread.`
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
      "outranks yours. Leave it; do not run this again for this thread."
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
  const links = Array.isArray(result?.links) ? result.links : []
  const linksBlock = links.length === 0 ? "" : "\n\nSaved links and files (not running work; remove with `frizzctl unlink <id>`):\n" +
    links.map((link) => `  ${link.id}  ${link.kind}: ${link.label}\n    ${link.target}`).join("\n")
  // THE QUESTIONS GET THEIR OWN SECTION, because they are not running work: a question waits on a
  // person. Each is listed by the worker's own id (its fence's `id:`), the one `unask` takes and a
  // reference fence names; a `qst_…` row `frizzctl ask` registered has no other. Since 2026-10-13 no
  // fence has to name them — `questions:` is still read for older contracts, and taught nowhere — so the
  // ready-to-paste fence below no longer carries them.
  const questionId = (q) => String(q?.handle ?? q?.spec?.handle ?? q?.id ?? "")
  const askedBlock = questions.length === 0 ? "" : (
    `\n\n${questions.length} question${questions.length === 1 ? "" : "s"} still owed an answer:\n\n` +
    questions.map((q) => `  question: ${questionId(q)}\n    ${String(q?.spec?.question ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n") +
    "\n\nEach one blocks `done` until it is answered or withdrawn — `frizzctl unask <id>` the ones since " +
    "decided. Its card stays where you asked it, and a later rest owes it nothing; a rest that still needs " +
    "the answer writes a ```question fence carrying its `id:` alone, which draws the card there."
  )
  if (!items.length) {
    if (questions.length > 0) {
      return (
        "Nothing is RUNNING on this thread — no background shells, no sub-agents, no armed timers, no " +
        "registered PRs. Your open questions are not running work: they need no ```awaiting fence, and a " +
        "rest that still needs an answer references its question instead." +
        askedBlock + linksBlock
      )
    }
    return (
      "Nothing is running on this thread — no background shells, no sub-agents, no armed timers, no " +
      "registered PRs, and no open questions.\n\nSo there is nothing to wait on: an ```awaiting fence " +
      "would have nothing to name, and a fence naming nothing is not a park. End with ```done, or " +
      "ask a ```question if you need the human." + linksBlock
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
  // into a fence — it has to see the shape. This command is where the contract sends a worker that has lost
  // an id, so printing the retired one-line-per-item form would teach the very grammar frizz refuses.
  const byKind = { shell: [], agent: [], timer: [], pr: [], issue: [], command: [] }
  for (const i of items) if (byKind[i.kind] && i.id) byKind[i.kind].push(i.id)
  const block = Object.entries({ shells: byKind.shell, agents: byKind.agent, timers: byKind.timer, prs: byKind.pr, issues: byKind.issue, commands: byKind.command })
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => `  ${key}: [${ids.join(", ")}]`)
  // The template guesses `status:` from the kinds — a shell or a sub-agent is usually work that finishes
  // by itself, a PR, an issue or a timer a watch — and the prose tells the worker to correct it.
  const status = byKind.shell.length + byKind.agent.length > 0 ? "working" : "watching"
  return (
    `${items.length} thing${items.length === 1 ? "" : "s"} running on this thread:\n\n${lines.join("\n")}\n\n` +
    "Name the ones you are ACTUALLY waiting on in your ```awaiting fence. The frontmatter is YAML — one " +
    "PLURAL key per kind, taking a list — plus a required `for:` duration and a required `status:` " +
    "answer: `working` (the work finishes by itself; the thread shows as running), `watching` (the wait " +
    "is on something outside the thread; it is snoozed) or `needs_input` (the human can act on something " +
    "now; it goes in their queue, with what to look at BELOW a `---` line — there is no `reason:` key). " +
    "`working` and `watching` need no prose at all.\n\nEverything above, as a fence:\n\n" +
    "```awaiting\n" +
    `${block.join("\n")}\n  status: ${status}\n  for: 2h\n` +
    "```\n\nDrop the lines you are not actually waiting on — a dev server you left running is not a wait " +
    "— and change `status:` if it names the wrong place." +
    "\n\nA `frizzctl watch` registration (marked `[watched as …]` above) keeps the WAKE across a compaction and a " +
    "restart, but it does not replace the fence: name the work in the fence all the same." +
    askedBlock + linksBlock
  )
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

/** The caller's environment names no Frizz at all — as opposed to naming one that is not answering. */
class NoFrizzState extends Error {}

/**
 * This project's state dir (`<frizz root>/projects/<project id>`), from whichever stamp the caller has.
 *
 * FRIZZ_STATE_DIR is the explicit one. FRIZZ_PERM_DIR is `<state dir>/perm-requests` (project.ts
 * `permDir`) and has been in every Claude worker's environment since long before the command line
 * existed — so a shell inside a worker forked by an OLDER Frizz, which was never handed the state dir,
 * still finds the server through it.
 */
function projectStateDir() {
  if (process.env.FRIZZ_STATE_DIR) return process.env.FRIZZ_STATE_DIR
  const perm = process.env.FRIZZ_PERM_DIR
  return perm && basename(perm) === "perm-requests" ? dirname(perm) : undefined
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
  const stateDir = projectStateDir()
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
  if (candidates.length === 0) {
    throw new NoFrizzState(
      "cannot locate the Frizz server: this environment names no Frizz state (FRIZZ_STATE_DIR, " +
      "FRIZZ_SERVER_LOCK and FRIZZ_PERM_DIR are all unset). That is what a shell OUTSIDE a Frizz worker " +
      "looks like; inside one it is a Frizz bug. NOTHING WAS SAVED — this command had no effect.",
    )
  }
  // SAY THAT NOTHING WAS SAVED, and say to retry. A worker reads "is frizz running?" as a fact about the
  // world rather than as a fact about ITS OWN call, and moves on — so whatever it was arming is silently
  // gone. Measured 2026-08-17: a worker's `recurring_prompt start` hit a restart window, got this error,
  // carried on, and its Goal — the thing keeping a long autonomous effort alive — never existed. The
  // window is ordinary (frizz restarts, and this process outlives every one of them), so the recovery has
  // to be ordinary too: try again.
  throw new Error(
    `no running frizz server found (looked at ${candidates.join(", ")} and every project lock under ` +
    `${root ? join(root, "projects") : "the frizz root"}; each was missing, malformed, or written by a process that is gone). ` +
    `NOTHING WAS SAVED — this command had no effect. frizz is probably mid-restart, which is ordinary and ` +
    `brief; RETRY this exact command before you do anything else, and do not come to rest assuming it took.`,
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
 * file project-root.ts treats as identity). A command that reaches ANOTHER project (`steer`, and
 * `spawn-thread --project`) still lands here, on our own, which verifies the caller and then finds the
 * other project itself; a model can name a target, never be somebody else.
 *
 * The walk-up is what makes this work for a worker spawned by a server that predates the stamp, and it
 * is the honest source anyway: a worker's project is wherever its cwd is, and that cannot go stale.
 */
function projectSegment() {
  const stamped = process.env.FRIZZ_PROJECT_ID
  if (stamped) return stamped
  // The state dir IS `<frizz root>/projects/<project id>` (frizz-paths.ts `projectStateDir`), so a
  // caller that knows its state dir knows its project — which is the thread's own project even when
  // the worker has `cd`'d somewhere with no `.frizz/` above it, or into another project's tree.
  const stateDir = projectStateDir()
  if (stateDir && basename(dirname(stateDir)) === "projects") return basename(stateDir)
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

  // THE WAY BACK. A spawned thread starts with nothing but this prompt, so without its spawner's slug it
  // could not `steer` anything back even when asked to — the footer names it, once, at the end.
  const parent = process.env.FRIZZ_THREAD_SLUG || process.env.FRIZZ_THREAD
  const footer = parent
    ? `\n\n---\nSpawned by the Frizz thread \`${parent}\`. If this prompt asks for results back, or you find ` +
      `something that thread must know, send it there with \`frizzctl steer ${parent} --message-file <file|->\`.`
    : ""
  /** @type {Record<string, unknown>} */
  const body = { prompt: prompt + footer, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend

  // ANOTHER PROJECT'S BOARD goes through OUR project's `spawnThread`, as a steer does: the server checks
  // that we are a real thread, finds the project, and writes the footer itself, because it knows our
  // project's slug and we hold only its id.
  const rawProject = typeof args.project === "string" ? args.project.trim() : ""
  if (rawProject) {
    const project = decodeURIComponent(PROJECT_SEGMENT.exec(rawProject)?.[1] ?? rawProject)
    const { prompt: _withFooter, ...rest } = body
    const result = (await callRpc("spawnThread", { ...rest, prompt, from: threadSlug(), project }))?.result
    if (typeof result?.slug !== "string" || !result.slug) throw new Error(`spawnThread returned no slug: ${JSON.stringify(result)?.slice(0, 300)}`)
    return spawnedReceipt(result.slug, typeof body.title === "string" ? body.title : result.slug, result.project)
  }

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
    throw unreachable("dispatch", err)
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
  return spawnedReceipt(slug, typeof body.title === "string" ? body.title : slug, undefined)
}

/** What the spawner reads back. `project` is the new thread's project slug when it is not ours.
 * @param {string} slug @param {string} label @param {string | undefined} project @returns {string} */
function spawnedReceipt(slug, label, project) {
  const where = project ? ` on the \`${project}\` project's board` : " on the board"
  const steer = project ? `frizzctl steer ${slug} --project ${project}` : `frizzctl steer ${slug}`
  const href = project ? `/project/${project}/thread/${slug}` : `/thread/${slug}`
  return (
    `Spawned a new frizz thread \`${slug}\`. It is now${where} driving independently — it reports ` +
    `to the human via its own final message, so do not wait on a result from it. It knows your slug: if ` +
    `its prompt asked for results back, they arrive as a \`steer\` that wakes you. You can message it ` +
    `the same way, with \`${steer}\`.\n\n` +
    `Paste this link to let the human open it in the drawer:\n\n[${label}](${href})`
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
      // No lock to wait FOR is not a restart window: nothing in this environment names a Frizz, and
      // six seconds of retrying would only delay saying so.
      if (err instanceof NoFrizzState || Date.now() >= deadline) throw err
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
    throw unreachable(procedure, err)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`${procedure} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  return await res.json().catch(() => null)
}

/**
 * A request that never reached the server, as the error the caller reads.
 *
 * ONE CAUSE GETS ITS OWN WORDS: a shell sandboxed off the network. A codex thread narrowed to
 * `workspace-write` or `read-only` cannot open a socket at all, loopback included (measured on codex
 * 0.161.0, `_live_codex_shell_identity.mts`: curl exit 7 against a TCP listener and a unix socket
 * alike), and codex says so in the shell's own environment. "fetch failed" there reads as Frizz being
 * down, and a worker told that retries — forever, since nothing it can do from inside changes it.
 * Every thread Frizz creates runs with full access, so this is a thread a human narrowed on purpose.
 * @param {string} procedure @param {unknown} err
 */
function unreachable(procedure, err) {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    return new Error(
      `${procedure} could not reach Frizz: this shell is sandboxed with network access off ` +
      "(CODEX_SANDBOX_NETWORK_DISABLED=1), and that includes the Frizz server on this machine. NOTHING " +
      "WAS SAVED, and no Frizz command can work from this thread while it stays sandboxed — do not " +
      "retry. Say what you needed in your final message, and say there that this thread needs full " +
      "access before a Frizz command can run.",
    )
  }
  return new Error(`${procedure} request failed: ${err instanceof Error ? err.message : err}`)
}

/** Which thread is calling. Read from the environment the worker was started with, because nothing
 * else names the caller: a command run from a worker's shell inherits that worker's environment, and
 * the MCP protocol carries no caller identity at all.
 * FRIZZ_THREAD is what a Claude worker's broker daemon is tagged with, so a shell inside one has it.
 * FRIZZ_THREAD_SLUG is the explicit stamp, and wins: the MCP mount's own env, and the whole identity of
 * a codex thread's shell and an ACP agent, which must never carry FRIZZ_THREAD — that is the orphan
 * reaper's ownership tag, and neither has the live `claude`/`codex` root that keeps a tagged process
 * from being reaped (packages/server/src/backend/types.ts frizzCliEnv).
 *
 * This is also the reason a model can never point `goal` at someone else's thread: the slug is
 * read from HERE, never from the arguments. */
function threadSlug() {
  const slug = process.env.FRIZZ_THREAD_SLUG || process.env.FRIZZ_THREAD
  if (!slug) {
    // Ten commands resolve their caller through here, so the message must not name one of them. It said
    // "so it cannot arm a goal for it" for every single one — which read as a bug in `goal` no matter
    // which one the worker had actually called, and sent at least one worker off debugging the wrong
    // thing after `title` failed on a codex thread.
    throw new Error(
      "Frizz could not tell which thread is calling (neither FRIZZ_THREAD_SLUG nor FRIZZ_THREAD is in this environment), so it cannot " +
      "act on the caller's own thread. Inside a Frizz worker this is a Frizz bug — report it rather than " +
      "working around it. Outside one there is no thread to act on.",
    )
  }
  return slug
}

/** A handler's answer when it did its job by REFUSING: a gate that held, not a fault. A front-end
 *  prints `text` like any other answer; the command line also exits 2, so a script can branch on it. */
class Refused {
  /** @param {string} text */
  constructor(text) { this.text = text }
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
    throw new Error("at least one is required: `--stop-hook`, `--heartbeat-seconds <n>`, `--post-compaction`, or any combination")
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
      `it with another \`frizzctl goal start\` if it was not:\n\n${goalReport(replaced)}\n`
    : ""
  // NO QUESTION HOLD ANY MORE (2026-08-16). Every trigger fires while you are waiting on the human, and
  // the at-rest one fires over your own unanswered registered question — the delivery says so, and expects
  // you to decide the question yourself rather than re-ask it. A ```done fence, and an ```awaiting on a
  // wait frizz itself will deliver, still stop the at-rest trigger.
  return (
    `Goal armed — frizz will send you this ${when}.${superseded}\n\n` +
    "Run `frizzctl goal stop` once the work it drives is finished — one left armed on " +
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
    if (!id) throw new Error("`id` is required to cancel a timer — take it from `frizzctl timer set`'s reply or from `frizzctl timer list`")
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
  if (hasIn && hasAt) throw new Error("give `--in-seconds` OR `--at`, not both")
  if (!hasIn && !hasAt) throw new Error("give either `--in-seconds` (fire N seconds from now) or `--at` (an ISO-8601 instant)")

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
    `with \`frizzctl timer cancel ${id}\` if it stops being useful.\n\n${armedList(result)}`
  )
}


/** How the armed PR-watcher set reads back, on every action, so a worker never needs a second call.
 * @param {{ watches?: Array<{id: string, target: string, github?: {checks: string, running: number, passed: number, failed: number, failing: string[], merge: string, state: string}}> }|undefined} result */
function armedPrWatchList(result) {
  // Only the PULL REQUESTS: the registry holds issues too (`watch_issue`), and each command reads back its
  // own kind so a worker asking where its PRs stand is not told about an issue it registered elsewhere.
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind !== "issue")
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

/** The issue twin of armedPrWatchList: the ISSUES watched on this thread, with each one's last-polled state.
 * @param {{ watches?: Array<{id: string, kind?: string, target: string, issue?: {state: string, stateReason?: string, title?: string, comments: number}}> }|undefined} result */
function armedIssueWatchList(result) {
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind === "issue")
  if (!watches.length) return "No issues are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const i = w.issue
    const state = !i
      ? "not polled yet"
      : i.state === "closed"
        ? `closed${i.stateReason ? ` (${i.stateReason.replace(/_/g, " ")})` : ""}`
        : `open, ${i.comments} comment${i.comments === 1 ? "" : "s"}`
    return `  ${w.id}  ${w.target}${i?.title ? `  "${i.title}"` : ""}  —  ${state}`
  })
  return `Issues watched on this thread now:\n${lines.join("\n")}`
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
  if (!target) throw new Error("`target` is required — the handle you were shown; `frizzctl activity` prints them all")
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
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the 24h ceiling for a shell or a sub-agent — ` +
      "the expiry listed below is what you actually hold."
    : ""
  return (
    `${head}${clamped}\n\nWHEN \`--for\` RUNS OUT the row is CANCELLED and you are woken to re-decide — register ` +
    `again if you still mean it.\n\nDROP IT the moment it stops mattering (\`frizzctl unwatch ${id}\`); ` +
    `you do NOT need to when the work simply finishes.\n\n${armedWatchList(result)}`
  )
}

/** The `unwatch` handler: withdraw one registered watch by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unwatch(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `frizzctl watch` or from `frizzctl activity`")
  // A PR, issue or timer id is not a `watch` row, and dropOwnWatch would report it "already settled"
  // while it stayed armed. The id prefix names its kind, so the one verb a worker reaches for routes it
  // to the call that really withdraws it.
  if (id.startsWith("prw_") || id.startsWith("isw_")) {
    const dropped = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const kind = id.startsWith("isw_") ? "issue" : "pull request"
    const head = dropped?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED ${kind} watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${id.startsWith("isw_") ? armedIssueWatchList(dropped) : armedPrWatchList(dropped)}`
  }
  if (id.startsWith("cmw_")) {
    const dropped = (await callRpc("dropOwnCommandWatch", { slug, id }))?.result
    const head = dropped?.dropped
      ? `Command watch ${id} dropped. Frizz will not run it again, and it will not wake you.`
      : `No ARMED command watch ${id} on this thread — it already passed, expired or was cancelled, or the id is not one of yours.`
    return `${head}\n\n${armedCommandWatchList(dropped)}`
  }
  if (id.startsWith("tmr_")) {
    const cancelled = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = cancelled?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(cancelled)}`
  }
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
  const lines = open.map((q) => `  ${q.handle ?? q.spec?.handle ?? q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  return `Open on this thread now:\n${lines.join("\n")}`
}

/** The `ask` handler: RETIRED (2026-10-13). It refuses without calling Frizz, and the refusal is the fence.
 * @returns {Promise<Refused>} */
async function ask() {
  return new Refused(ASK_RETIRED)
}

/** The `secret` handler: RETIRED with `ask` — a `kind: secret` question fence is how a value is asked for.
 * @returns {Promise<Refused>} */
async function secret() {
  return new Refused(SECRET_RETIRED)
}

/** The `unask` handler: withdraw one registered question by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unask(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — the `id:` of the question's fence, or what `frizzctl activity` lists")
  const result = (await callRpc("unask", { slug, id }))?.result
  // A withdrawal that matched nothing is reported rather than swallowed: the id was wrong, the human
  // already answered it, or it is another thread's — and a worker that believes it withdrew a question
  // the human is still looking at will get an answer it has stopped expecting.
  //
  // A FOLLOW-UP IS NOT WITHDRAWN ON ITS OWN. It rides inside its parent's row, so the server answers
  // `unask sqlite-path` with the `settings-store` it follows and withdraws nothing: taking the parent
  // back for an id the worker did not type cost it a question it may still have wanted answered.
  const root = typeof result?.id === "string" && result.id ? result.id : id
  const viaFollowUp = root.toLowerCase() !== id.toLowerCase()
  const settled = {
    answered: `Question ${root} was already answered, so nothing was withdrawn — the answer reaches you as its own message.`,
    dismissed: `Question ${root} was already dismissed by the human, so nothing was withdrawn — decide it yourself.`,
    withdrawn: `Question ${root} was already withdrawn.`,
  }
  const head = result?.withdrawn
    ? `Question ${root} withdrawn. Its card is gone and the human will not be asked.`
    : viaFollowUp && result?.state === "open"
    ? `Nothing was withdrawn: ${id} is a follow-up of ${root}, and a follow-up cannot be withdrawn on its own. ` +
      `The human is only asked it after picking the option it hangs on. To take the whole question back, ` +
      `follow-ups and all, run \`frizzctl unask ${root}\`.`
    : settled[result?.state] ??
      `No OPEN question ${id} on this thread — it was already answered or dismissed, or the id is not one of yours.`
  return `${head}\n\n${openQuestionList(result)}`
}

/** A body's own leading `title:` block — the key line and any indented lines under it, then a `---`
 *  if one follows — cut off, so `--title` can replace it rather than stack a second heading above it.
 *  The SAME rule as `splitDoneFrontmatter` in @frizz/shared, which this plain .mjs cannot import (it
 *  ships loose beside the server with no build step): only a FIRST non-blank line counts, and a body
 *  that does not open on one comes back untouched.
 * @param {string} body @returns {string} */
function withoutLeadingTitle(body) {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""))
  let i = 0
  while (i < lines.length && lines[i].trim() === "") i++
  if (i >= lines.length || !/^title:/i.test(lines[i])) return body
  i++
  while (i < lines.length && /^\s+\S/.test(lines[i])) i++
  let next = i
  while (next < lines.length && lines[next].trim() === "") next++
  if (next < lines.length && /^\s*---+\s*$/.test(lines[next])) i = next + 1
  return lines.slice(i).join("\n").trim()
}

/**
 * What an open question does to a sign-off as done: how many are open, each by the worker's own id with
 * its first line, and the two ways out.
 *
 * A COPY, AND IT MUST STAY ONE. The same paragraph is sent by the server when a worker signs off with a
 * ```done FENCE over an open question (scheduler SOURCE 15), built by the function of this name in
 * `packages/shared/src/index.ts`. This file imports nothing but node, because it ships to a worker as
 * plain .mjs, so the words live in both places; `packages/server/src/question-done.test.ts` fails when
 * the two outputs differ. Change one, change the other.
 * @param {{ id: string, question?: string }[]} questions @returns {string} */
function doneOpenQuestionsRefusal(questions) {
  const lines = questions.map((q) => `  ${q.id}  ${(q.question ?? "").split("\n")[0]}`)
  return (
    `${lines.length} question${lines.length === 1 ? "" : "s"} the human has not answered:\n${lines.join("\n")}\n` +
    "Each one dies unread with a done card. Decide it yourself and withdraw it (`frizzctl unask <id>`), or leave it " +
    "open and keep working until it is answered."
  )
}

/** The `done` handler: declare the effort finished, or report exactly what refuses to let it.
 *
 *  A `--title` is sent INSIDE the body, in the ```done fence's own grammar (`title: …`, `---`, then the
 *  ledger), rather than as a field of its own: the server stores one body and splits it with the same
 *  function that splits a fence, so a registered done and a fenced one can never head their cards two
 *  different ways (2026-10-13).
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function done(args) {
  const slug = threadSlug()
  let body = typeof args.body === "string" ? args.body.trim() : ""
  if (!body) throw new Error("`body` is required — the write-up the human reads on the card")
  // One line, because a heading is one: a title with a newline in it would end the `title:` line and
  // spill the rest into the ledger.
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : ""
  if (title) body = `title: ${title}\n---\n${withoutLeadingTitle(body)}`
  const result = (await callRpc("markOwnDone", { slug, body }))?.result
  if (result?.done) {
    return (
      "Marked done. Your thread cards as a checked success in the human's queue and stays there until " +
      "they archive it.\n\nNOTHING WAS CLOSED, HIDDEN OR ARCHIVED — if there is more to say, say it in " +
      "your final message; if more work appears, keep going and run this again."
    )
  }
  // REFUSED, with everything that refuses it named by id, so the next move is a command and not a
  // guess. Reported as an ordinary result rather than thrown: this is a gate doing its job, not a fault.
  const questions = (result?.blockingQuestions ?? []).map((q) => ({ id: q.handle ?? q.id, question: q.question }))
  const watches = (result?.blockingWatches ?? []).map((w) => `  ${w.id}  ${w.what}`)
  const parts = ["NOT marked done. This thread still holds work open."]
  if (questions.length) parts.push(doneOpenQuestionsRefusal(questions))
  if (watches.length) {
    parts.push(
      `${watches.length} registration${watches.length === 1 ? "" : "s"} still armed:\n${watches.join("\n")}\n` +
      "A live wait means the thing you were waiting for has not happened. Wait for it, or drop the ones " +
      "that stopped mattering (`frizzctl unwatch <id>` takes a watch, a PR or issue watcher, a timer, or a command watch).",
    )
  }
  parts.push("There is no force flag. Resolve them and run `frizzctl done` again.")
  return new Refused(parts.join("\n\n"))
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
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`prs: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the human what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`frizzctl watch-pr drop ${id}\`).\n\n${armedPrWatchList(result)}`
  )
}

/** The `watch_issue` handler: register, withdraw, or read back this thread's issue watchers. The same
 * three RPCs as `watchPr` — one registry — with `kind: "issue"` on the add.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchIssue(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedIssueWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedIssueWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the issue, as `owner/repo#123` or a GitHub issue URL")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `3d`, `30d` or `180d` (max 365d), never an instant")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: forValue, kind: "issue" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching issue ${ref} as ${id}${until}. Frizz wakes you on every later comment, on a label or ` +
      "assignee change, and when the issue closes; the registration survives your turn ending, a compaction and a frizz restart."
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`issues: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the human what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`frizzctl watch-issue drop ${id}\`).\n\n${armedIssueWatchList(result)}`
  )
}

/** The command watches armed on this thread, as every `watch-command` action reads them back.
 * @param {{ watches?: Array<{id: string, command: string, every: string, expiresAt: string, runs: number, lastRun?: {outcome: string, exitCode: number|null}}> }|undefined} result */
function armedCommandWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No command watches are armed on this thread — none will wake you."
  const lines = watches.map((w) => {
    const last = !w.lastRun
      ? "no check finished yet"
      : `last check ${commandRunClause(w.lastRun)}`
    return `  ${w.id}  every ${w.every}, until ${w.expiresAt} — ${w.runs} check${w.runs === 1 ? "" : "s"}, ${last}\n    $ ${w.command}`
  })
  return `Command watches on this thread now:\n${lines.join("\n")}`
}

/** "exited 1", "timed out", … — how one check ended. @param {{outcome: string, exitCode: number|null}} run */
function commandRunClause(run) {
  if (run.outcome === "exit") return `exited ${run.exitCode}`
  if (run.outcome === "timeout") return "timed out"
  if (run.outcome === "signal") return "was killed by a signal"
  return "could not start"
}

/** The end of a check's output, short enough to read inline. @param {string|undefined} output */
function outputTail(output) {
  const text = String(output ?? "").trim()
  if (!text) return "It printed nothing."
  const tail = text.length > 800 ? `…${text.slice(-800)}` : text
  return `Its output ended:\n${tail.split("\n").map((l) => `  ${l}`).join("\n")}`
}

/** The `watch_command` handler: register, withdraw, or read back this thread's command watches.
 * @param {Record<string, unknown>} args @returns {Promise<string|Refused>} */
async function watchCommand(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedCommandWatchList((await callRpc("listOwnCommandWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a command watch — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnCommandWatch", { slug, id }))?.result
    const head = result?.dropped
      ? `Command watch ${id} dropped. Frizz will not run it again, and it will not wake you.`
      : `No ARMED command watch ${id} on this thread — it already passed, expired or was cancelled, or the id is not one of yours.`
    return `${head}\n\n${armedCommandWatchList(result)}`
  }

  const command = typeof args.command === "string" ? args.command.trim() : ""
  if (!command) throw new Error("`command` is required — a shell command that exits 0 once the condition holds")
  const every = typeof args.every === "string" ? args.every.trim() : ""
  if (!every) throw new Error("`every` is required — how often to check, a DURATION like `5m` (min 1m, max 24h)")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — how long to keep checking, a DURATION like `6h` or `3d` (max 7d)")
  const result = (await callRpc("addOwnCommandWatch", { slug, command, every, for: forValue }))?.result
  // A REFUSAL is the gate doing its job, not a fault: exit 2, with the reason and the background-shell
  // fallback in the server's own words.
  if (result?.refused) {
    const ran = result.firstRun ? `\n\n${outputTail(result.firstRun.output)}` : ""
    return new Refused(`NOT registered. ${result.refused}${ran}`)
  }
  if (result?.passed) {
    return (
      "NOTHING WAS ARMED: your command exited 0 on its first check, so the condition already holds. Carry on " +
      `with whatever you were going to wait for.\n\n${outputTail(result.firstRun?.output)}`
    )
  }
  const id = result?.id ?? "(unknown)"
  if (result?.alreadyArmed) {
    return (
      `Already watching this command as ${id} (every ${result.every}, until ${result.expiresAt}) — nothing new was ` +
      `registered, and its original expiry stands.\n\n${armedCommandWatchList(result)}`
    )
  }
  const first = result?.firstRun
    ? result.firstRun.outcome === "timeout"
      ? "Its first check did not finish in time, so Frizz runs it again now with the full 2m."
      : `Its first check ${commandRunClause(result.firstRun)}. ${outputTail(result.firstRun.output)}`
    : "Frizz runs its first check within the next minute."
  // A CLAMP IS NEWS, as on every other `for` — a worker told nothing rests on coverage it does not have.
  const clamps = []
  if (result?.clamped?.every) clamps.push(`\`--every ${result.clamped.every}\` was clamped to ${result.every}`)
  if (result?.clamped?.for) clamps.push(`\`--for ${result.clamped.for}\` was capped at the 7d ceiling`)
  const clamped = clamps.length ? `\n\nYOUR ${clamps.join(", and ")} — what is listed below is what you hold.` : ""
  return (
    `Watching as ${id}: Frizz runs it every ${result?.every} until it exits 0, or until ${result?.expiresAt}, and ` +
    `then wakes you once with its output. Nothing of yours runs meanwhile.\n\n${first}${clamped}\n\n` +
    `NAME IT IN YOUR \`\`\`awaiting FENCE (\`commands: [${id}]\`, \`status: watching\`) and come to rest. DROP IT ` +
    `when it stops mattering (\`frizzctl watch-command drop ${id}\`).\n\n${armedCommandWatchList(result)}`
  )
}

/**
 * HOW EACH COMMAND IS SPELLED ON A COMMAND LINE. The schema above already says what a command takes;
 * this says the three things a schema cannot:
 *
 *   summary    — the one line `frizzctl --help` lists it under. The description is the full reference
 *                and is printed only by `frizzctl <command> --help`, so a worker reads the long text of
 *                the command it is about to run and of no other.
 *   positional — which arguments may be given bare, in order (`frizzctl title "Fix queue focus"`).
 *                Every argument is ALSO a `--flag`, and the whole set a JSON object through `--input`.
 *   then       — further positionals that depend on the first one's value, for the commands that
 *                switch on an `action` (`frizzctl timer cancel tmr_ab12`).
 *   wrap       — the one array argument a bare JSON array, or a single item, is taken to be.
 *   retired    — the text a retired command prints instead of running: its refusal, and its `--help`.
 *   examples   — real invocations, shown under the command's own help.
 *
 * `group` only orders the top-level listing.
 */
const CLI = {
  // RETIRED (2026-10-13): a question is a ```question fence. `retired` is the text the command prints in
  // place of running — as its refusal (exit 2) and as its `--help` — and it keeps the command out of the
  // top-level listing.
  ask: {
    summary: "Retired: a question is a ```question fence in your own message",
    retired: ASK_RETIRED,
    examples: [],
  },
  unask: {
    group: "Sign off",
    summary: "Withdraw a question you asked, by its id",
    positional: ["id"],
    examples: ["frizzctl unask settings-store"],
  },
  secret: {
    summary: "Retired: a value only the human holds is a `kind: secret` question fence",
    retired: SECRET_RETIRED,
    examples: [],
  },
  done: {
    group: "Sign off",
    summary: "Declare the effort finished, with the write-up the human reads (exits 2 if refused)",
    examples: [
      "frizzctl done --body-file - <<'EOF'\n" +
      "Fixed the cache collision in the resolver.\n\n" +
      "- **Fixed the lookup** in `src/resolver.ts` — it now keys on the normalized id.\n" +
      "- **Added a regression test**; `npm test` green.\n" +
      "EOF",
      "frizzctl done --body-file handoff.md",
      "frizzctl done --title \"Resolver cache keyed on the normalized id\" --body-file handoff.md",
    ],
  },
  activity: {
    group: "Waiting",
    summary: "List everything this thread has out, with the id each one is named by",
    examples: ["frizzctl activity"],
  },
  watch: {
    group: "Waiting",
    summary: "Register a wait on a background shell or a sub-agent",
    positional: ["kind", "target"],
    examples: ["frizzctl watch shell bzvtnt3ig --for 2h", "frizzctl watch agent a01b2d20b32feab11 --for 1h"],
  },
  unwatch: {
    group: "Waiting",
    summary: "Withdraw a registered wait",
    positional: ["id"],
    examples: ["frizzctl unwatch wch_ab12cd34"],
  },
  watch_pr: {
    group: "Waiting",
    summary: "Wake on a pull request's CI, reviews, comments and labels",
    positional: ["action"],
    then: { add: ["target"], drop: ["id"] },
    examples: ["frizzctl watch-pr add acme/app#391 --for 180d", "frizzctl watch-pr list", "frizzctl watch-pr drop prw_ab12cd34"],
  },
  watch_issue: {
    group: "Waiting",
    summary: "Wake on a GitHub issue's comments, labels, assignees and close",
    positional: ["action"],
    then: { add: ["target"], drop: ["id"] },
    examples: ["frizzctl watch-issue add acme/app#482 --for 30d", "frizzctl watch-issue list", "frizzctl watch-issue drop isw_ab12cd34"],
  },
  watch_command: {
    group: "Waiting",
    summary: "Wake when a shell command the server re-runs exits 0 (a version published, a URL up)",
    positional: ["action"],
    then: { add: ["command"], drop: ["id"] },
    examples: [
      'frizzctl watch-command add "npm view frizz@0.13.12 version" --every 5m --for 6h',
      "frizzctl watch-command list",
      "frizzctl watch-command drop cmw_ab12cd34ef56",
    ],
  },
  timer: {
    group: "Waiting",
    summary: "Set, list or cancel one-off timed prompts to yourself",
    positional: ["action"],
    then: { cancel: ["id"] },
    examples: [
      'frizzctl timer set --in-seconds 600 --prompt "Re-check the deploy and report its status"',
      "frizzctl timer list",
      "frizzctl timer cancel tmr_a1b2c3d4e5f6",
    ],
  },
  goal: {
    group: "Waiting",
    summary: "Arm, read back or stop the text Frizz re-sends this thread",
    positional: ["action"],
    examples: [
      "frizzctl goal get",
      "frizzctl goal start --post-compaction --no-stop-hook --prompt-file resume-prompt.md",
      "frizzctl goal stop",
    ],
  },
  title: {
    group: "This thread",
    summary: "Name this thread on the board, once you know what the work is",
    positional: ["title"],
    examples: ['frizzctl title "Fix queue focus"'],
  },
  link: {
    group: "This thread",
    summary: "Save a link or a file on this thread for the human",
    positional: ["label", "target"],
    examples: ['frizzctl link "Dev server" http://localhost:5173', 'frizzctl link "Audit report" /abs/path/report.md'],
  },
  unlink: {
    group: "This thread",
    summary: "Remove a saved link or file",
    positional: ["id"],
    examples: ["frizzctl unlink lnk_ab12cd34"],
  },
  steer: {
    group: "Other threads",
    summary: "Send a message into another thread, in any project",
    positional: ["to"],
    examples: [
      "frizzctl steer fix-the-resolver-cache --message-file - <<'EOF'\n" +
      "The audit found the same root cause: `normalizeId` drops the scope. Details in `audits/resolver.md`.\n" +
      "EOF",
      "frizzctl steer bump-the-sdk --project nub --message-file handoff.md",
    ],
  },
  spawn_thread: {
    group: "Other threads",
    summary: "Dispatch a new, separate top-level thread (the last resort)",
    examples: [
      'frizzctl spawn-thread --model opus --effort high --title "Port the relay to Bun" --prompt-file prompt.md',
      'frizzctl spawn-thread --project nub --model opus --effort high --title "Bump the SDK pin" --prompt-file prompt.md',
    ],
  },
}

export { TOOLS, HANDLERS, CLI, Refused, doneOpenQuestionsRefusal }
