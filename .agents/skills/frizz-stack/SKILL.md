---
name: frizz-stack
description: Boot a REAL, fully-isolated, disposable Frizz you can poke — `scripts/adhoc-stack.mjs` (own server, sandbox HOME, throwaway port, one or many projects) — and seed real state through its own RPC surface. LOAD THIS BEFORE HAND-ROLLING ANY VERIFICATION HARNESS: the sandbox HOME, real credentials, extra registered projects, the launcher's lock path and every tenant's id/slug are already flags, and rebuilding them by hand costs a boot cycle per mistake. Use it whenever the question is "does this actually work in a running Frizz" — a new surface, live/timing/restart behavior, a seam between processes, a bug no test pins — and above all anything touching the SINGLETON: one Frizz serving N projects, tenant routing (`/_frizz/<project>/rpc/…`), a project the server did NOT launch from, dispatching a real worker, or the Frizz MCP worker tools (`spawn_thread`, `recurring_prompt`, `timer`). Pair with `headless-browser` to LOOK at it and `real-subsystem-harness` for what a browser cannot reach.
version: 0.1.0
metadata:
  internal: true
---

# frizz-stack — a real Frizz that touches nothing real

A throwaway instance, sandboxed on every axis, so you can verify against the running thing instead of
reasoning about it. Booting it is cheap; being wrong in front of the maintainer is not.

**It is not a tax on every diff.** A targeted fix in code you have read, pinned by a test at the right
level and with a blast radius you can name, is verified without a stack — say what you verified and how,
and move on. Judge which one you have; both directions are real failures.

---

## 1. Boot it

`scripts/adhoc-stack.mjs` sandboxes every axis so it can never touch the maintainer's live instance or
real `~/.frizz` SQLite:

- `HOME` → a fresh temp dir (the SQLite DB + `server.lock` live in an empty `~/.frizz` there)
- `PORT` → a unique high port (never fights the dev server on 5175)
- `FRIZZ_WAKERS_OFF=1` → scheduler OFF by default; pass `--wakers` to arm it when testing wake delivery
- the orphan reaper OFF by default, so a disposable stack never reaps the real machine's processes
- tenant priming OFF by default (`FRIZZ_TENANT_PRIME_OFF=1`), so a stack run with `--home=$HOME` never puts a second tailer on the maintainer's live boards; pass `--prime` to arm it under a sandbox HOME

Boot it in the **background** (never foreground — it stays up until killed) and read back its json line:

```bash
nub scripts/adhoc-stack.mjs --port=4930 > /tmp/stack.log 2>&1     # Bash run_in_background: true
# → {"url","gridUrl","slug","port","home","project","launcher":{id,slug,serverLock},"tenants":[…]}
```

**Never pipe it through `head`/`sed`/`grep` to read that line.** The stack keeps logging (every Vite HMR
update, and the shared tree is edited constantly), so the reader exits, the pipe closes, and the next
write kills the server with SIGPIPE — minutes later, mid-verification, looking like an unrelated crash.
Redirect to a file and poll the file.

Flags: `--port=N`, `--project=/abs/dir` (defaults to the frizz repo), `--also-project=/abs/dir`
(repeatable — see §2), `--creds` (links the real agent logins in, except Claude's on macOS, see
§ A real Claude worker), `--wakers`, `--reaper`,
`--prime`, `--keep`, `--home=/abs`, `--seed`.

`--home=/abs` reuses a sandbox a previous `--keep` run left behind, which is the only way to verify
anything that happens at BOOT against state that already exists — a schema migration, a registry repair,
resume/recovery. It implies `--keep`: a HOME you were handed is never one this run may delete.

**Cleanup:** send SIGTERM/SIGINT — it deletes the temp HOME automatically. Always kill it before you come
to rest; never rest on a running stack. Kill by the **exact PID** you started, never a broad `pkill`:
other agents run stacks on this machine at the same time.

**A SERVER change needs a RESTART; only the web hot-reloads.** Vite HMR covers `packages/web`, so a
component edit is live on the next reload — but the server modules (`transcript.ts`, the tailer, the RPC
router) were loaded once at boot, so an edit there is invisible until you restart the stack. The failure
is silent and reads as "my fix didn't work": the page renders the OLD projection and your assertion fails
against code you already corrected. If a server-side assertion fails and the code plainly says otherwise,
restart before debugging.

---

## 2. TWO projects on one server — the singleton half most bugs hide in

One Frizz serves N projects, so "it works" in the LAUNCHING project proves almost nothing about the
others. A whole class of defect exists only in a *tenant* — a project the server did not launch from —
because the launcher is the one that gets the `server.lock`, the unprefixed routes and the boot-time
context. That is exactly where the Frizz MCP tools broke (2026-08-08: every worker outside the launching
project lost `spawn_thread`, `recurring_prompt` and `timer`, because it was reading a lock that only the
launcher publishes, and POSTing an unprefixed RPC that means "the launching project" by definition).

```bash
# a launcher + one tenant
nub scripts/adhoc-stack.mjs --port=45571 --project=/abs/launcher --also-project=/abs/tenant \
  > /tmp/stack.log 2>&1
# → …"launcher":{"id","slug","serverLock"},"tenants":[{"id","slug","dir","stateDir"}]
```

Then address a tenant by **id or slug** — both work, and the id is what a worker is stamped with:

```bash
curl -s -H 'sec-fetch-site: same-origin' "http://127.0.0.1:45571/_frizz/<tenant-id>/rpc/board"
```

The traps, each of which costs a full boot cycle to rediscover:

- **RPC verbs are HTTP verbs.** A `query` is a GET and a `mutation` is a POST; POSTing a query answers
  `unknown RPC procedure` — which reads exactly like a version mismatch and sends you hunting the wrong bug.
- **An unprefixed `/_frizz/rpc/…` is the LAUNCHING project**, silently. That is the correct design, and it
  is why a tenant bug looks like "it worked" — your call landed on the launcher's board. An UNKNOWN project
  segment 404s instead, which is the safe direction; check for the 404 before assuming your id is wrong.
- **The broker is the SOLE claude transport.** The interactive-TUI path is retired, so `FRIZZ_CLAUDE_BROKER_BRIDGE=0`
  does not "fall back" — dispatch fails outright with *"Claude session broker is unavailable"*. You cannot
  capture a worker's argv with a stub `claude`; to see the env a worker really gets, dispatch a real one and
  read it off the process table (`ps -Ao pid,command | grep FRIZZ_PROJECT_ID`). A real CLAUDE worker only
  ever runs on a real-HOME stack: see § A real Claude worker.
- **A sandbox HOME has no Claude login, even with `--creds` on macOS**, so a Claude dispatch there fails
  `AUTH_REQUIRED:claude` on purpose. Given one, its next token save puts a keychain dialog on the
  maintainer's screen (§ A real Claude worker).
- **`startServer({port: 0})` does not give you an ephemeral port** — pick a real high port.
- **A dispatched worker is a DETACHED daemon.** It survives the stack it was born in and keeps burning
  quota. `ps -Ao pid,command | grep <your temp HOME>` → `kill <pid>` each, then re-check none survive.

---

## 3. Seeding real state

An empty board proves the shell renders but not much else. Drive the app's own RPC surface or the UI
itself so state is created the way production creates it — never hand-write rows into the sandbox SQLite.

**Use `scripts/lib/rpc-client.mjs`. Never hand-roll `fetch` against `/rpc`.** Two details are easy to get
wrong, and both fail SILENTLY — a plausible wrong answer instead of an error, which is how a harness ends
up "proving" something it never tested:

- **queries are `GET /rpc/<name>?input=<json>`, mutations are `POST /rpc/<name>`.** POSTing a query does
  not throw; it 404s, and reads back as "no data" (this is what made a verify run report an empty board).
- **every response is `{result}` or `{error}` — never the payload bare.** Reading `body.slug` off the
  envelope yields `undefined` for a call that actually SUCCEEDED.

```js
import { createRpcClient } from "./lib/rpc-client.mjs"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const { slug, sessionId } = await api.mutate("dispatch", { prompt: "…", backend: "codex" })
const board = await api.query("board")            // unwrapped result; throws RpcError on {error}
```

The client also sets the loopback `Origin` header, without which any write 403s.

### A real Claude worker

**Never start a live Claude worker under a sandbox HOME** (AGENTS.md § Never put a macOS keychain dialog
on the maintainer's screen). `--creds` used to symlink the real `~/.claude*` in, so a sandboxed worker
signed in from `~/.claude/.credentials.json`. But whenever its OAuth token is due, Claude Code saves the new
one to the keychain first (`security add-generic-password`), macOS finds no keychain under the sandbox HOME,
and the maintainer gets a modal *"Keychain Not Found — A keychain cannot be found to store "colin.""*.
Whether a given run hits a refresh is luck (2026-10-13: two Haiku dispatches from a scratch `rd.mjs`, eight
failed `security` saves, two dialogs). The maintainer kept sandboxes keychain-less, so on macOS `--creds`
now leaves Claude's login out (`"claudeLogin": false` in the json line) and a Claude dispatch fails
`AUTH_REQUIRED:claude`. Never link or copy `~/.claude` in by hand to get past that. In order of preference:

1. **Simulate the worker** (§ Simulating a worker, below). Records appended to the JSONL drive the same
   tailer → board → push → render path a live worker does, on a timeline you control, which is what a UI,
   timing or layout check actually needs. A model in the loop adds nothing there but nondeterminism.
2. **Keep the real HOME and isolate only the PROJECT** (`--home=$HOME --project=/tmp/<throwaway>`) when
   nothing but a live model can show the behavior. The keychain is found there, so nothing prompts.

**Where a real-HOME stack keeps Frizz's own state is the `frizzRoot` in its json line**, and it is never
a `~/.frizz` the machine did not already have. That folder existing is what tells every Frizz process
to use it for everything (`frizz-paths.ts`, rule 1), so on a machine whose Frizz lives in the platform's
own location (macOS Application Support) creating it starts the maintainer's server on an empty tree
the next time it boots. `--home=$HOME` did create it until 2026-10-13, and left it behind.

- `"isolated"`: the machine has no `~/.frizz`. The stack's registry, `ui.db`, locks and cache are in a
  temp root (`isolatedRoot`) it deletes on exit unless you pass `--keep`, and nothing of the real Frizz
  is shared. The root is named by `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`, which every
  process the stack starts inherits: a tool in a worker that honors XDG finds empty directories there
  (a package cache refills; opencode's login under `~/.local/share` is not found).
- **Every stack forces all four XDG roots to its own** (`xdgConfigHome` / `xdgStateHome` in the json
  line), whatever it inherited and whatever `--creds` links, so an OpenCode it starts registers its
  service, keeps its database and reads its port there, never in the operator's
  `~/.local/state/opencode` or `~/.config/opencode`. The config root links each of the operator's
  `~/.config` entries but `opencode` (with `--creds`, or on a real HOME), so `gh` and `git` read their
  own as before; `--creds` gives OpenCode the operator's `auth.json` alone, never their database.
- `"shared"`: the machine's Frizz already lives in `~/.frizz`, and the stack uses that tree as it is,
  registry and settings included.

Never `mkdir ~/.frizz` yourself, and if you find one on a machine whose state is under
`~/Library/Application Support/Frizz`, move it out of the HOME before anything else starts.

`--creds` remains for the other backends that need a login in the sandbox (Codex, and opencode's
`~/.local/share/opencode`, ARCHITECTURE.md § ACP backend); after dispatching one, run the AGENTS.md log query and
confirm no `SecurityAgent` started. HOME's keychain is also why a bare temp HOME fails
`AUTH_REQUIRED:claude` (the macOS login keychain lives at `$HOME/Library/Keychains`, so redirecting HOME
hides the credential even though it is user-scoped).

**A raw Chromium raises the same dialog.** A process in a sandbox HOME that starts a Chromium without `--use-mock-keychain` — it was the real `/Applications/Google Chrome.app`, which no agent starts at all any more (AGENTS.md § Agents never touch the maintainer's real Chrome) — makes Chrome store its "Chrome Safe Storage" key, macOS finds no default keychain under that HOME, and the system shows *"Keychain Not Found — A keychain cannot be found to store "Chrome.""* for every Chrome start. Headless `--screenshot` Chrome also often hangs at exit on its own, so a worker kills and restarts it, and every restart opens another dialog (2026-10-03: two harness runs, 13 SecurityAgent processes, maintainer: *"It's shown up hundreds of times"*). Chrome that puppeteer launches is immune, because puppeteer passes `--use-mock-keychain --password-store=basic`. So a worker's browser comes from `launchHeadless()` (`scripts/lib/headless-browser.mjs`), every raw headless-shell command a sandbox worker runs carries `--use-mock-keychain`, and when your prompt asks a worker for a browser, the launcher or the flag goes in the prompt you hand it. The sandbox HOME itself stays WITHOUT a keychain: the maintainer declined linking the real `~/Library/Keychains` in (2026-10-03), and an empty keychain there is worse, because Claude Code deletes the real `~/.claude/.credentials.json` after its first token write into one. `log show --last 3h --style compact --predicate 'process == "SecurityAgent"'` tells you whether a dialog fired.

Clean up after yourself: kill the stack by exact PID, kill the leftover `claude` broker processes (find
them by the checkout's `packages/server/src/backend/claude-agent-broker.ts` in `ps`), then
`rm -rf <throwaway-repo> ~/.claude/projects/<cwd-slug>`. An isolated root went with the stack; on a
`"shared"` one, also `rm -rf ~/.frizz/projects/<id>`, and do NOT write settings through the stack:
`~/.frizz/ui.db` settings there are global and shared with the real boards.

### Simulating a worker (no live provider)

For transcript/board/telemetry flows, the tailer needs only three things, all inside the sandbox:

1. a JSONL at `<tempHome>/.claude/projects/<cwd-slug>/<sessionId>.jsonl` you append records to
   (copy real record shapes: `user` / `assistant` (+`stop_reason`) / `queue-operation` / `queued_command`
   attachment — `transcript.ts` + `tailer.ts` document what each field drives);
2. one `session` row in the sandbox DB (`sqlite3 <tempHome>/.frizz/projects/*/ui.db "INSERT INTO session
   (slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode) VALUES (…)"`)
   — `thread_name` is the thread identity string `frizz-<slug>`. There is nothing to spawn beside it:
   liveness comes from the row's runtime, so a simulated worker needs no process at all.

This is the sanctioned exception to "never hand-write rows": the row is the fixture, and appending records
then exercises the REAL tailer → board → push → render pipeline end-to-end. Dozens of worked examples live
in `scripts/seed-*.mjs`.

### A scripted worker behind the REAL broker

Appended records start at the tailer, so they skip everything before it: dispatch, the broker daemon, the
delivery ledger, a steer's queue, runtime ingest. When the behavior lives THERE (the order in which a send,
its echo and the board's delta reach a page; a steer handed over at a tool boundary; the instant a turn
ends), boot the stack with `--claude-bin=$PWD/scripts/scripted-claude.mjs`. It is a stand-in `claude`
binary: the real broker spawns it, it speaks the stream-json protocol and writes real transcript JSONL, and
it holds no credentials, so it cannot raise a keychain dialog and its timings repeat.

```js
await api.mutate("dispatch", { prompt: "[script ending=steps paras=14] …", backend: "claude", model: "haiku", effort: "low" })
```

The first message's `[script …]` token is the whole script: how the turn ends
(`ending=done|steps|needs|bare|question`, the last one closing on a ` ```question ` fence that Frizz registers),
how long it runs (`paras`, `tools`, `toolms`, `think`), and what each later turn does (`reply`,
`replyparas`, `replytools`, `replythink`). A message that arrives mid-turn is a steer. The file's header
lists every knob. The workers are still detached broker daemons: kill them by PID when the stack goes.

`scripts/layout-timeline.mjs` records a thread page or a drawer on such a stack: every layout it paints
around a send, an answer, a steer or a turn's end, with the event that committed each.

#### Stating each turn, when the seam is DELIVERY

The knobs generate a turn. To check anything Frizz SENDS a worker — a wake, a correction, an answer, a
Goal's cancellation — a test has to say exactly what the worker writes back, so the same binary takes a
file: `[script file=/abs/turns.json]` lists the turns, each with the shell commands it runs as real Bash
tool calls (`frizzctl done`, `frizzctl timer set …`) and its final message verbatim (a ` ```question `
fence, a broken one, a reference), optionally keyed to the message it answers (`"on": "…"`). Boot with the
scheduler armed and a HOME that survives a stop:

```bash
nub scripts/adhoc-stack.mjs --port=47611 --wakers --keep --project=/abs/throwaway-repo \
  --claude-bin=$PWD/scripts/scripted-claude.mjs > /tmp/stack.log 2>&1
```

`scripts/verify-question-fence-wakes.mjs` is the worked example, including a tool call that holds a turn
open until the verifier releases it, and a restart of the stack by pid.

- **`--wakers` arms every scheduler source**, the sign-off reminder included: a scripted rest with no
  sign-off is reminded within a tick (10s). Script a reply for it or end the turn on a fence.
- **Boot it from a shell with no Frizz worker variables** (`env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK
  -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK …`). Claude
  Code APPENDS its plugin's `bin/` to the PATH it inherited, and so does the scripted worker, so a
  `frizzctl` already on that PATH wins; the stack strips the installed one a Frizz thread passes down, so
  a worker's `frizzctl`, live or scripted, is the checkout's own.
- **`FRIZZ_LOG_PATH=/abs/server.log`** in the stack's environment is the only way to read the scheduler's
  log (`waker: queued …`, `waker: sent …`): the stack's stdout carries none of it.
- **A wake to a Claude thread is never filed `delivered` on arrival.** It is `leased` when sent and settled
  later: `delivered` when its 60s confirmation window closes, or `superseded` once the worker's reply moves
  the rest it was bound to (a correction, a reminder). Assert a delivery on the worker's transcript, never
  on `wake_delivery.state`.
- **The daemon's command line names the checkout, not the sandbox HOME**:
  `ps -Ao pid,command | grep '<checkout>/packages/server/src/backend/claude-agent-broker.ts'`, kill each
  by pid, and check again.


---

## Composes with

- **`headless-browser`** — how to LOOK at this stack without putting a window on the maintainer's screen.
- **`real-subsystem-harness`** — for behavior no browser can reach (broker socket, pty, migrations).
- **`frizz-artifact-e2e`** — this stack runs `startServer({dev:true})` = SOURCE. A green run here does NOT
  prove the promoted artifact works. For packaging, detached daemons, spawn/exec paths, use that skill.
- **`visual-review`** / **`optical-spacing`** — how to judge what you captured.
