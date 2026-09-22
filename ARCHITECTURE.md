# frizz architecture (read this before touching any package)

frizz is a workspace-scoped orchestration surface: a localhost server + web client (a browser tab by
default) showing a sidebar of threads and, for the selected thread, a live embedded agent terminal.
The UI has ZERO intelligence: all orchestration wisdom lives in the user-editable dispatch preamble
(settings), in the repo's own `FRIZZ.md`, and in the worker plugin (`cc-worker/`). The original plan:
`plans/standalone-ui.md`.

## Repo layout

**The repo root IS the published `frizz` package** — root `package.json` is the manifest, `src/` is
the launcher, the publish runs from the root, and the root `README.md` is the npmjs.com page.
**Releases publish from the `release` branch, not from main** (since 2026-09-08): main says a change
landed, `release` says it was verified and chosen to ship, and only the second one triggers
[`release.yml`](.github/workflows/release.yml). The branch is a fast-forward pointer into main with no
commits of its own — you move it to the tested sha — so a version bump on main is inert until it does.
Full procedure in [plans/runtime-pin-bumps.md](plans/runtime-pin-bumps.md).

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The `frizz` launcher itself — artifact build/promote/verify, port + lock, browser launch. |
| [`packages/`](packages/) | The app workspace — `shared`, `rpc`, `server`, `web` (see **Packages** below). |
| [`board/`](board/) | The zero-dep `.frizz/` board parser + thread writer. The server SHELLS OUT to it; never re-implement it. |
| [`cc-worker/`](cc-worker/) | The Claude Code plugin every dispatched agent loads: worker contract seed, sub-agent profiles, hooks. |
| [`monitors/`](monitors/) | Portable CI/PR/review watchers, synced into `cc-worker/skills/gh/scripts/`. |
| [`scripts/`](scripts/) | Packaging (`prepare-package.mjs`, `build-*.mjs`) + dev tooling (`seed-*`, `verify-*`, `shot.mjs`). |

`board/` used to be `cc/scripts/frizz/` — `cc/` was the Claude Code **plugin** port back when frizz
itself shipped as an agent plugin rather than an app. The plugin is retired; the parser is not.

## Developing frizz

```sh
nub install
nub run frizz-dev:install     # one-time: ~/.local/bin/frizz-dev -> this checkout's launcher source
```

Then from any Git repo: `frizz-dev` (foreground; Ctrl-C stops only that workspace's server).
`frizz-dev /path/to/repo` selects a repository, `--no-app` prints the URL instead of opening a browser,
`--app` opts into the legacy dedicated window, `--status` reports workspace/port/supervisor PID, and
`--stop` stops the UI server while agent processes survive. `frizz-dev:check` verifies the shim
without changing it; `frizz-dev:uninstall` removes only that owned shim. Use
`FRIZZ_BIN_DIR=/another/bin` to install elsewhere.

### Readout and logs

A TTY launch repaints a step list while booting and settles into a static block naming the address,
the project, and this run's log. It repaints only during the boot — once that block prints, nothing
touches the cursor again, so a stray write can never land on a live region.

Under that block the launcher APPENDS one timestamped line per lifecycle beat — Restart Frizz, Update Frizz, a control-plane crash, and the recovery that follows each. Appending keeps the no-repaint rule above intact. The supervisor raises these through `onActivity` (`SupervisorActivity` in `dev-supervisor.ts`), which every transition reaches through `writeStatus`, so a path added later announces itself without being wired up again; `renderSupervisorActivity` in `src/readout.ts` turns one into a row. Beats are suppressed until the first boot settles, because until then the readout owns the terminal. A launcher that re-execs itself for an update — `frizz-dev` keeps its pid and its tty across the handoff — builds a `noticeOnlyReadout` instead, or the generation that took over would be mute for the rest of the session. The registry launcher does the same on a Node that has `process.execve` (22.15+ / 23.11+, which is why that is the floor). Where there is none — Windows — it starts the successor detached with its stdio closed, holds on until that successor answers the status route with the new version (a successor that exits first or never answers is a failed update, and the old board is restored), and only then prints a farewell naming the new version and `frizz --stop` and exits; `frizz --stop` and `frizz --status` are real flags on that launcher since 2026-09-11.

Every process writes the complete feed to `<stateDir>/logs/frizz-<timestamp>-<pid>.log`, one file per
run, with `logs/latest.log` pointing at the newest. The launcher passes that path down in
`FRIZZ_LOG_FILE`, so the supervisor and the forked control-plane child append to the SAME file — they
share the file, not a writer, and O_APPEND makes each short write atomic. That is what lets the child
stay silent on a terminal the launcher is repainting without losing anything it had to say.
Retention keeps 20 runs and nothing older than 14 days; a single file stops at 32 MB.
`FRIZZ_LOG_PATH` overrides the location (a directory or an exact `.log` file).

`--debug` streams that same feed to the terminal instead of the compact readout, in every process at
once — the launcher sets `FRIZZ_DEBUG` in the child environment, since the child never sees the
command line. Ctrl-C and a failed boot both print the log path.

Gates: `pnpm run typecheck` and `pnpm test`. CI (`.github/workflows/ci.yml`) runs only the checks that
need no install or provider CLI; the full suite is local-only by design.

The suite runs through `scripts/run-tests.mjs` rather than calling node's runner directly, because a
green run has to prove the whole run happened. `--test-force-exit` is load-bearing here — without it
`claude-agent-broker.test.ts` leaks a handle and hangs forever — but it also makes each per-file child
`process.exit()` while verdicts are still queued on the pipe carrying them to the parent, which drops
them with no failure and no non-zero exit ([nodejs/node#64833](https://github.com/nodejs/node/issues/64833),
still open; measured here 2026-08-16 as a run that silently lost 31 of one file's 70 tests). So the
runner is wrapped: every child puts its report pipe in blocking mode and tallies the verdicts it
emits, and the wrapper refuses to report success unless that tally matches what reached the parent.
Invoking `nub --test` by hand is fine for one file, but it bypasses that check.

## Invariants

- **THERE IS NO TMUX. Agents run as detached broker daemons.** A Claude thread is
  `claude_runtime="broker"`, forked by `claude-broker-host.ts` with `detached: true` into its own
  process group, which is exactly why Ctrl-C on the server does not reach it and why a turn survives
  a restart. `packages/server/src/tmux.ts` has not existed since 2026-08-02, and nothing execs,
  spawns or imports tmux. The old vocabulary outlived the transport for weeks and had every reader
  re-deriving the wrong answer from it, so it was swept out on 2026-08-19: the session column is
  `thread_name` (the thread identity string `frizz-<slug>`, never a pane name), the launch variable
  is gone, and no seed or verify script opens a pane. One reference survives on purpose —
  `isTmuxServer` in `orphan-reaper.ts` refuses to reap a tmux server left behind by a pre-cutover
  Frizz. Anything else still saying tmux outside `plans/` is a miss; prefer `git log -S` over
  believing it.
- **One server, every project.** A SINGLETON: one server on one origin serves every project on the
  machine, each named by a URL prefix. It was one server per repo until 2026-08; if you find a
  statement to that effect anywhere, it is stale. See "URL shape (one server, every project)" below —
  that section is load-bearing, and most bugs in this area come from carrying the old model forward.
- **Frizz files are the source of truth for thread status.** The server imports the board logic
  from `../../board/*.mjs` (zero-dep, plain node) — NEVER duplicate the parser. Writes
  to thread files go through the same code paths as `frizz-update` (import `thread-update.mjs`
  helpers), never hand-rolled markdown edits.
- **Session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) is telemetry only** —
  liveness, previews. Parse defensively; on schema surprise degrade to "unknown", never crash,
  never let correctness depend on it.
- **Agents are headless processes frizz owns over a pipe**, spawned with a pinned
  `--session-id <uuid>`: a Claude thread runs in the session BROKER (a detached daemon holding one
  Agent SDK session, reached over a unix socket or, on Windows, a named pipe), and a Codex thread in
  the app-server. There is no multiplexer and no pane — `/term/:slug` now serves exactly one thing,
  a provider sign-in attempt, whose pty the login utility owns and shares across every viewing tab.
- **An idle thread's daemon is HIBERNATED, and that is not a stop.** A resting worker costs ~504 MB (measured 2026-08-19: the `claude` CLI 289 MB, a chrome-devtools MCP pair 159 MB, the broker daemon 39 MB, the frizz MCP server 17 MB), and 38 idle threads held 19 GB. That browser was Frizz's own always-on mount, dropped 2026-08-26 — Frizz injects only the `frizz` MCP server now, so a thread in a project that brings no browser of its own rests nearer ~345 MB, and one whose `.mcp.json` mounts chrome-devtools is back at the measured figure. So `thread-hibernation.ts` sweeps every 5 minutes and retires the daemon of any broker thread that has rested past the 60-minute prompt-cache TTL with nothing outstanding; the next input cold-resumes it from the on-disk transcript, and above the TTL that resume costs no extra tokens because the cache is already gone. **A hibernated thread is still an ordinary Rested queue row** — same `turn-idle` runtime, same rest time, same card — because the predicate refuses any thread whose dead daemon would change what the board draws. It fails CLOSED on every unknown, and the list of refusals is the point: no telemetry, no transcript, a turn in flight, a pending approval or ask, ANY direct sub-agent (including `stale` and `rested`, unlike the Mark-as-done gate), any background shell, any undelivered send, a daemon under 5 minutes old. `FRIZZ_HIBERNATE_OFF=1` disables it; `FRIZZ_HIBERNATE_IDLE_MINUTES` moves the threshold. Codex is deliberately excluded — one app-server daemon serves every codex thread, so there is no per-thread process to reclaim.
- **A teardown frizz CHOSE is never reported as a crash.** `attach` reports a death whenever a resume has to cold-start, because that is normally the only way frizz learns a daemon died unobserved — but a permission-mode change, a usage-limit resume and hibernation all end in exactly that cold start. `killBroker(stateDir, sessionId, reason)` leaves a one-shot `<key>.retired` mark beside the broker record, stamped with the dying daemon's `generation`; the next cold fork consumes it and suppresses the report only when the exit record's generation matches. Genuine crash detection is untouched — an unmarked teardown still reports, which is what the negative control in `claude-agent-broker-bridge.test.ts` pins.
- **Full-snapshot SSE.** The single `/events` SSE channel pushes `{type:"board", board}` full
  snapshots (see `@frizz/shared` `ServerEvent`). No diff protocol.
- **Permission prompts come from a MARKER, not from JSONL.** Even under `--permission-mode auto` a
  worker can pause on a permission request with NO transcript signal (the last record stays assistant
  + `stop_reason:"tool_use"`), so the cc-worker hook writes a marker into `FRIZZ_PERM_DIR` naming what
  is waiting and the tailer reads that. A broker thread's approvals arrive as typed permission
  requests over the control channel. The `perm-prompt` runtime rides the board snapshot
  with no notify and no unread — the sidebar's attention sort surfaces it.
- **Human questions are REGISTERED rows (`mcp__frizz__ask`, a `thread_question` row, since 2026-08-27). The free-form ```question fence — a question written into a fence body — is RETIRED for every thread dispatched at or after `QUESTION_FENCE_RETIRED_AT` (2026-09-11, `packages/shared`): there it is prose, never `pendingQuestion`, never a card, never a sign-off; a thread dispatched before it keeps the fence as an ask, because a running worker keeps the contract it was dispatched under (`questionFencesLive`). The one fence a worker still writes is the EMPTY marker `` ```question qst_… `` that PLACES its registered card inside the handoff (web/src/lib/questionShadow.ts `placeQuestions`); an unplaced question renders at the tail of its rest, and the rest's one Send sends every answer.** The fence was the only medium until 2026-08-27 (two earlier designs — a BLOCKING MCP tool and a frizz-ask CLI + .questions/ sidecars — were built and rejected: fragile timeouts / redundant state); `ask` is non-blocking, and the row outlives the message, a compaction and a restart, which is what the fence could not do (`plans/rest-by-registration.md`). Both reach the same card. A fence that RESTATES a question registered at the same rest draws nothing — the registered card wins, because answering it is what settles the row (web/src/lib/questionShadow.ts; 2026-08-28, one question drawn twice back to back). The fence body is plain
  markdown; a TRAILING `- A. …` option list + optional `Recommendation:` line are convention-parsed
  into choice chips (web/src/lib/questionBlocks.ts). A go/no-go is just a two-option question — the
  old ` ```question approval ` gate (one Approve button that sent on click) was dropped 2026-07-26;
  its token now degrades to a plain question so legacy transcripts still render.
  Answers compose into one follow-up numbered by ORIGINAL block position ("Answers:\n2. …"), a ONE-block ask included — the numbering is what the renderer keys on to card the reply up instead of dropping it into a flat bubble. The
  contract lives in packages/server/src/workerPrompt.ts + cc-worker's SKILL/deny-ask hook — keep all three aligned.

## Board nomenclature (the maintainer's words — write code, comments and copy in them)

Saved links and files are thread references, not activity or waits. Workers register them with `mcp__frizz__link` (`label`, `target`) and remove them with `mcp__frizz__unlink` (`id`); `activity` lists their ids separately from running work. The `thread_link` table scopes them to project + thread, with one slot per label. They survive rests, archive/reopen and restarts, disappear when the thread is deleted, and never block completion. The prompt's activity area renders them below an unlabeled divider; files use the existing reader/opener and trust boundary.

These are the names for the sidebar's row groups, top to bottom. They are the MAINTAINER's vocabulary (2026-08-05), so they win over whatever a symbol happens to be called; when a comment and this list disagree, the comment is wrong.

- **Pinned** — the human's shelf, ABOVE everything including the cue (maintainer 2026-09-02: a pin "takes a thread entirely out of the whole rail system"). Unlabeled; each row wears a small solid pin where the cue's rest time would sit. Membership is one fact — `pinnedAt` on the thread, written only by the row's hover pin/unpin verb — and it outranks every derived state: a pinned thread that spins, rests, snoozes or finishes stays here, in PIN order (oldest pin first), until unpinned. Not a `SectionKey`: `sectionThreads` diverts these rows before `sectionOf` runs (`isPinned`, groups.ts), which is what keeps the pin from having to be excluded band by band. One deliberate consequence: a pinned thread that needs you keeps its QUEUE CARD (the pin is a rail arrangement, not a queue excusal), so its card's row lives up here rather than in the cue — the card↔cue pairing below holds for every UNPINNED thread.
- **Rested** — the top band of the RAIL SYSTEM proper, directly under the prompt box (maintainer 2026-08-08), and the same set as **"the queue"** / **"the cue"** / **"items in the queue"**: one rested row per queue card, in the identical order, so the rail's first row faces the queue's first card. Say "rested" or "in the queue"; do NOT say "active" about these rows just because they share a `<section>` with the Active band. Each carries a right-justified rest time — when that thread came to rest — reading off the same instant its card's "Last active" line does.
- **Active** — the rows below the rule, in practice the ones currently SPINNING. The rule is drawn on the CARD, both ways: nothing below it has a queue card, and every card has a row above it. So the band also takes the occasional row that is neither spinning nor asking — a thread the server excused from the queue while it rests (a live sub-agent, a background shell, CI running on a watched PR, a follow-up still in flight). That is the honest place for it, and it wears its own at-rest mark rather than a spinner; the alternative, tried until 2026-08-14, was a cue row with no card behind it, which looks queued and opens a drawer on click. No rest time: nothing below the rule has handed anything back.
- **Snoozed** — the dimmed, labeled band under Active: a valid future `timer:`, a user wall-clock snooze, or the resting card's event-snooze (parked until the thread next comes to rest — since 2026-08-28; before that it sat in Active with the dot). Parked, not asking. A limit pause frizz will auto-resume was a member until 2026-08-31; it now QUEUES as a failed thread (yellow hourglass in the cue, hover Retry) — a whole fleet a quota limit killed once sat here as calm muted hourglasses, which is the opposite of what a mass kill should look like (maintainer: "they should have shown up in the queue … as threads that had failed in some way"). Renamed from **Held** on 2026-08-26, key and label together.
- **Done** — the collapsed archived section, last of the thread groups.

Where the CODE disagrees, and it does in two places worth knowing before reading `web/src/groups.ts`:

- `sectionOf` returns `"active"` for Active AND Rested rows alike. That key names the `<section>` that holds both bands, not the maintainer's "Active". `partitionActive` splits it: `.running` is Active, `.rested` is Rested.
- The archived section's `SectionKey` is `"inactive"`, but its rendered label is **Done**.

Neither name is worth a rename sweep — but every new comment says Active / Rested / Snoozed / Done in the sense above, and `inActiveBand` (the predicate for "this row has no queue card") is the one function that means "Active" exactly.

## Packages

- `shared` — zod schemas + types + constants. THE contract; read `src/index.ts` first.
- `rpc` — typed query/mutation/stream over Hono (lifted from gent, unchanged). Server defines a
  `Router` in `server/src/router.ts`; web imports `type AppRouter` from it for the typed client.
- `server` — Hono app on 127.0.0.1 (default port in shared). Every route of its own lives under the
  RESERVED `/_frizz` namespace (`FRIZZ_ROUTE_PREFIX`), which is what leaves the top level free for a
  project slug: rpc mounts at `/_frizz/rpc` (and `/_frizz/<project>/rpc` — see § URL shape), SSE at
  `/_frizz/events`, the multiplex socket at `/_frizz/ws`, static web assets in prod, Vite
  middleware in dev (`src/dev.ts`). Subsystems: `bus.ts` (EventEmitter → SSE), `board.ts`
  (.frizz watcher + read model), `sessions.ts` (SQLite registry via better-sqlite3),
  `tailer.ts` (JSONL), `dispatch.ts` (thread file create + prompt compose + spawn),
  `settings.ts`.
- `web` — React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query + xterm.js.

Plus root `src/` — the `frizz` launcher (NOT a workspace package): canonicalize cwd's Git root,
health-check/reuse its detached supervisor, atomically allocate/persist an isolated port, then open the
URL. Locks and logs live under `~/.frizz/projects/<id>/`; `src/browser.ts` is vendored from Gluon via
gent. See **CLI launcher** below.

## URL shape (one server, every project — the singleton)

Frizz used to run ONE SERVER PER PROJECT, each on its own port, so every URL was unambiguous and unprefixed. It is now a SINGLETON: one server on one origin serves EVERY project on the machine, and the project is named by a URL PREFIX. Two rules follow, and most of the bugs in this area come from missing one of them.

**Frizz's own routes are under `/_frizz`, so the top level is free.** That is what lets a first path segment be a project slug at all. Anything outside `/_frizz` is either an SPA route name (`APP_ROUTE_SEGMENTS` — `thread`, `status`) or a project.

**Projects live under `/project/<slug>`, not at `/<slug>`.** One segment buys back the whole root namespace, so a future page can never be shadowed by a directory somebody happens to have. `/` is the ALL-PROJECTS GRID.

`packages/web/src/lib/base-path.ts` is the single definition, and every URL a client builds or parses goes through it:

| helper | answers |
| --- | --- |
| `projectSlug(path)` | the slug this page is showing, or `undefined` for the launching project |
| `basePath(path)` | `/project/<slug>`, or `""` when unprefixed |
| `innerPath(path)` | the path with the prefix removed — what the ROUTER reasons about |
| `outerPath(inner)` | an inner path put back in ADDRESS-BAR terms |
| `apiBase(path)` | `/_frizz/<slug>`, or `/_frizz` unprefixed |
| `projectHref(slug)` | another project's page — the one place that knows the shape |
| `prefixedAppRoute(href)` | an agent-written `/thread/<slug>` re-pointed at this page's project |

**AN EMPTY BASE IS A SUPPORTED STATE.** The LAUNCHING project is still served unprefixed at `/thread/<slug>` and `/status/<name>`, so every pre-singleton bookmark still resolves. It is a legacy INBOUND alias, not a shape to MINT: a link built without the prefix silently addresses whichever project started the server, which is how the drawer's ↗ button came to open a stranger's board (2026-08-07). Build outward-facing URLs with `outerPath`/`projectHref`; parse with `innerPath`.

One consequence worth knowing because it is not symmetric: the launching project's board has NO unprefixed queue URL, because `/` is the grid. `queueDestination` (`lib/router.ts`) uses the board snapshot's `projectSlug` to send it to `/project/<slug>` instead — without which closing the last drawer navigated to the project picker.

## Switching projects without a document load (the invariants that keep one project's data off another's page)

The singleton's characteristic bug is not a crash: it is **another project's board, transcript or settings rendered under this project's URL, silently**. It shipped once (2026-08-11, `/project/frizz` showing the zod board on every board on the machine), and auditing it turned up two more live instances, so treat this section as load-bearing rather than descriptive. The reason the class keeps recurring is that "which project" used to be AMBIENT — re-derived from `location` by a dozen modules — and never travelled WITH the data, while thread slugs are unique only WITHIN a project. Nothing downstream can tell one project's payload from another's unless the payload says.

**Nothing keeps a second copy of "which project we are on".** The module that HOLDS the live connection answers `feedIsBoundTo(slug)` (`api/socket.ts`); `routes.tsx` asks it rather than remembering. The shipped bug was a `useRef` guard in a component: react-router unmounts one element and mounts another whenever the matched ROUTE changes (the grid to a board, a board to a thread page), so the ref was reborn equal to the new slug and reported "already bound" while the socket sat on the previous project. A bystander with nothing to remember cannot get it wrong, and being asked redundantly is free.

**A board must say which project it is, and is refused at the door if it is not ours.** The server stamps `BoardSnapshot.projectSlug`; `setBoard`/`seedBoard` check it through `ownedByThisPage` (`lib/projectOwnership.ts`). This rests on the payload's own evidence rather than on client bookkeeping — which is the thing that failed — and it is what catches the seed race: `seedBoard` takes a board only when the store is EMPTY, which is precisely the state a switch leaves behind, so the previous project's in-flight `rpc.board()` walks straight in. The check is deliberately permissive when the PAGE names no project (the unprefixed launching project) or the PAYLOAD names none (a pre-restart server, a test fixture): refusing on a guess would blank a working board.

**A live connection is stamped with the project it was opened for, and drops what arrives after the page moves.** Both transports do it (`api/socket.ts`, `api/sse.ts`). This is what covers TRANSCRIPT frames, which name a thread and nothing else — no downstream check can tell alpha's `fix-auth` from beta's, so only the socket, which knows what it was opened for, can. A switch is `rebindProject()`, the single entry point, which re-opens whichever transport is live: a session that fell back to SSE switches projects too, and did not for a long time because `rebindSSEProject` sat exported with no caller.

**The query cache is scoped per project at the HASH, not by prefixing keys.** `queryKeyHashFn` (`lib/queryKeyScope.ts`) folds the page's project into every cache-entry identity, so a query written tomorrow is scoped without its author knowing this problem exists. `projectsList` and `threadLocate` are the machine-wide exceptions. There is no per-switch cache wipe any more, and that is a gain: one project's entries are invisible to another rather than deleted in front of it, so switching back finds a warm cache and a late response has nowhere wrong to land.

**Anything that outlives the moment it was started captures its project BEFORE it — an `await`, and a callback that fires later.** `apiBase()`/`projectSlug()` answer for whatever the address bar says at the instant they are called, which is correct at send time and wrong in a continuation. Reading a large file is long enough to switch projects, which is how an attachment came to be filed in a project the message was never going to (`Composer.uploadAttachment`). A desktop notification is worse, because it is raised only while the window is HIDDEN and clicked whenever the operator comes back: its click handler now carries the project it was raised for (`notify` in `api/board-stream.ts`), instead of opening that slug in whatever project is on screen — which did not fail, it opened a different thread that happened to share the name.

**A URL naming a project that does not exist is answered by the SERVER.** `/project/<slug>` is an SPA route, so the client used to be handed the app for a slug nobody has, whereupon every call 404s, the board never lands, and the page retries forever on its boot spinner. `unknownProjectPage` (`packages/server/src/index.ts`) redirects to the grid with `?unknown=<slug>`, and the grid says what happened.

Two browser-level checks live in `packages/web/src/lib/projectSwitch.e2e.test.ts` (opt-in — see its header for the `adhoc-stack.mjs` invocation and the `FRIZZ_PROJECT_SWITCH_E2E_URL` env). The unit-level pins are `api/projectFeed.test.ts`, `lib/projectOwnership.test.ts` and `lib/queryKeyScope.test.ts`; each has a negative control, which is the bar to keep when adding to them.

## CLI launcher

Two entry points, deliberately distinct:

- **`npx frizz`** installs a stable, small `frizz` shell that resolves a compatible `frizz-server`
  generation into an immutable managed directory. The shell package contains only `dist/frizz.js`;
  its `frizzServer` manifest field names the default server package/version and compatibility epoch.
  `prepare-package.mjs --server` stages the public server's runtime closure at
  `packages/server-release/`: `web-dist/` (built client), `runtime/board/` (the board parser the
  server shells out to), and `runtime/cc-worker/` (the worker plugin dispatch loads), while
  `build-package.mjs --server` emits `dist/dev-child.js` plus every detached daemon sibling. The
  runtime tree MUST keep board and cc-worker as siblings because the worker shims reach back
  relatively (`../../board`); it is a COPY rather than a `files` entry naming source directories, so
  every public server path remains build output. Root prepack intentionally leaves this staging in
  place: `npm pack --ignore-scripts packages/server-release` is the reproducible standalone server
  pack after a root build. Both build paths assert the same closure (`src/worker-plugin-closure.ts`);
  widening it is one edit.
- **`frizz-dev`** (`nub run frizz-dev:install`) is source-backed at launch only: the shim holds an
  absolute pointer to this checkout's CLI entrypoint. On each fresh launch it selects a
  verified immutable artifact matching the current source fingerprint, reuses an identical global one,
  or builds and promotes one. **The running server never watches the checkout and never runs HMR** —
  edits do nothing until you stop frizz and relaunch.

State is keyed by a stable checkout UUID: an ordinary worktree keeps it in `git config --local frizz.id`,
each linked worktree in its private Git admin dir, so siblings stay isolated. Canonical real paths make
a checkout opened through a symlink reuse the same instance. The project id and its state dir are the
whole identity — there is no multiplexer and nothing else to key.

### Stable server updates

The registry launcher owns the public proxy and recovery listener for its entire lifetime. It installs an exact `frizz-server` version with npm's JavaScript entry under the current Node executable, with lifecycle scripts disabled and a private prefix. No shell startup hooks, global provider upgrades or project permission changes are part of this operation. The only native permission repair targets the installed server generation's own `node-pty` spawn helper.

An update stages and validates the candidate while the old server continues serving, drains the old child, then starts the candidate. After authenticated readiness and a short stability interval, it atomically commits the active generation. Candidate failures restore the previous same-epoch selection. Frontend assets, provider daemons and worker plugin files come from that same immutable server generation; retained generations protect detached workers still using their files.

A global generation-checked lease in the Frizz state root keeps stable launchers from starting separate schedulers across repositories or custom ports. Each server child registers as a delegate before opening application state. After a launcher crash, a replacement cannot acquire that lease until its live delegates have exited. A second launch joins the recorded public listener even while the application child is unavailable.

Protocol and data epoch are explicit compatibility contracts. Ordinary updates reject a mismatched epoch before draining. An explicitly newer compatible shell may stage its exact next-epoch bootstrap server, but advances a global compatibility marker before that server can write data; lower-epoch shells then fail closed, including after a pre-readiness crash. Protocol changes require a separately designed migration. Pre-split binaries cannot honor a marker they predate, so manually downgrading to those releases is unsupported.

### Browser launch modes

The default launch makes one standard OS request to open the localhost URL in the default browser; the
browser decides which window receives it. frizz does not scan, reuse, focus, or privately address tabs.

`--app` preserves the legacy dedicated/chromeless window as an explicit opt-in. On macOS that window
gets its own Dock name and icon: on first opt-in launch the launcher silently installs the frizz PWA
into the project's browser profile over CDP (`--remote-debugging-pipe` → `PWA.install` +
`PWA.changeAppUserSettings(displayMode: standalone)`; windowless, ~3-4s, once per machine). Chrome then
generates a real app-shim bundle at `~/Applications/Chrome Apps.localized/frizz.app` and every launch
goes through it. Why it works this way (all verified empirically on Chrome 150 / macOS):

- A plain `--app=` window is owned by the Chrome browser process — the Dock shows "Google Chrome", no
  launch flag changes it, and a hand-rolled `.app` that `exec`s Chrome loses its identity the moment
  Chrome's Cocoa startup re-registers the process. Chrome's generated app-shim is the only mechanism
  that yields an own Dock identity.
- The CDP `PWA.*` domain is only exposed on `--remote-debugging-pipe` connections (port-based
  websocket clients lack `AllowUnsafeOperations`), and a CDP install defaults the app to open-in-a-tab
  — `changeAppUserSettings(displayMode: "standalone")` is the required second half.
- Shim detection is stateless: scan shim `Info.plist`s for `CrAppModeShortcutURL` == the launch URL and
  `CrAppModeUserDataDir` under the project profile. (Chrome's generated app id is NOT a reproducible
  hash of the URL — don't try.)

Failure at any opt-in app step falls back silently to a plain `--app` window.
`packages/web/public/favicon.svg` is the canonical artwork; `nub scripts/generate-icons.mjs`
regenerates its six tracked PNG derivatives (`--check` detects drift, `--refresh-app-icons` refreshes
ICNS in idle shims). *Windows/Linux Dock branding is an unwired TODO:* Windows would set an
`AppUserModelID` on a generated `.lnk`; Linux (X11) would pass `--class=frizz` + a `.desktop` file whose
`StartupWMClass` matches.

### Running against a repo outside this monorepo

Set `FRIZZ_SCRIPTS_DIR` to the board parser directory and `FRIZZ_WORKER_PLUGIN_DIR` to the `cc-worker`
plugin directory. The published package does this for you.

## Conventions

- TypeScript run directly by Node in a source checkout (type stripping) — no build step for
  server/cli; Vite builds web. The published package ships compiled JS instead (a dependency under
  `node_modules` cannot be type stripped), so a consumer's Node floor is `engines`, not this one.
- ESM everywhere, `type: "module"`.
- Comments sparse and dense: design/invariant/provenance only.
- Tests: `node --test`, colocated `*.test.ts`, minimal + contract-shaped.
- Known gotcha: node-pty prebuilds lose the exec bit on `spawn-helper` (npm/pnpm strip it) —
  the server package postinstall re-chmods it. PTY code cannot run inside a sandboxed shell.
- UI state (unread, lastReadAt, session registry, settings) lives in ONE SQLite file for the whole
  machine, `~/.frizz/ui.db`, every row tagged with its project id (`packages/server/src/frizz-db.ts`;
  one file per project under `~/.frizz/projects/<projectId>/ui.db` until 2026-08-27 — a leftover is
  imported once on the next boot, recorded in `imported_project`, and left in place so an older build
  still finds it). An ordinary/main worktree's UUID remains the repo's
  `.git/config` key `frizz.id`; a linked worktree stores its own UUID at
  `<worktree-gitdir>/frizz.config`, preserving ordinary state while isolating sibling DB and lock
  namespaces. NEVER store UI state in the checkout's `.frizz/`.
- **Sidebar design philosophy (2026-07-09, maintainer-directed — don't regress it).** A FLOATING
  left column: NO background, NO border, NO clipping on the column itself (the New-thread pill's
  hover-scale must never clip; only the section LIST is a scroll container). Vertically centered in
  the viewport (sticky full-height wrapper; the inner column grows fit-content to
  `max-h-[calc(100vh-96px)]` — symmetric 48px margins — and scrolls internally only past that cap;
  horizontal overflow impossible by width discipline: min-w-0 everywhere + break-words titles).
  Width scales `clamp(240px, 30vw, 600px)`; it and the 720px workpane sit as a centered pair with
  one fixed 40px gutter, and the workpane itself vertically centers while shorter than the viewport
  (`my-auto`). Row groups keyed on the session-first model (`web/src/groups.ts` `sectionOf`), in the
  vocabulary above: Active then Rested (one uncollapsible `<section>`, split by a bare rule), then a
  labeled collapsible Snoozed band, then Done (archived; collapsed).
  Rows order by most-recent USER interaction (`orderByInteraction` — agent churn never
  reorders), except the Rested band, which uses the EXACT queue comparator (`orderQueue`) so the rail
  and the cards read in one order.
  Titles WRAP, never truncate. ONE derived indicator per row (spinner running, blue ● a live background
  shell — in Active AND in its snoozed twin, since 2026-08-31; GitHub's octocat for a PR wait and the
  hourglass for a timer wait, each in WHICHEVER band the row sits — a timer park queues, and its queued
  row wore the shell's dot until 2026-09-07; the hourglass for a user snooze, "?"
  needs-action, "!" stalled, faint · idle); a petite-caps PLAN tag marks a doc with a
  `## Plan` section (derived `hasPlan`). ENTIRELY MOUSE-DRIVEN — no arrow-walk, no chevron, no focus
  machine (all deleted): a row click opens the thread's drawer (chat; the frizz DOC composite for a
  never-spawned thread — `store.openThread`), and the remaining keyboard is ⌘K/⌘I + Esc
  unwinding overlays then drawers. A ZERO-thread board (brand-new user) hides the sidebar entirely
  and centers the dispatch prompt as the whole screen.

## Provisioned runtimes (Frizz owns the Claude Code and Codex it runs)

A worker is NOT whatever `claude` or `codex` is first on the operator's PATH — it was until 2026-09-04, and that left half of each pair unpinned: the bundled Claude Agent SDK is built against ONE Claude Code build (`claudeCodeVersion` in its package.json, shipped as a matched platform package the SDK resolves by itself when handed no path), yet Frizz handed it PATH's binary, fifty-odd releases ahead on the maintainer's own machine, over a private wire nothing audited. Codex had the audited pin (`CODEX_APP_SERVER_SUPPORTED_VERSION`) but no binary behind it, so the gate merely WARNED on a newer build and the conformance test skipped on any machine that had moved on.

`packages/server/src/runtimes.ts` is the single source: one pin per backend, resolved in the `runtimes` boot phase (right after launch ownership, before the context, because every consumer — the broker bridge, the app-server daemon, `claude auth status`, the login utility, the quota readers — takes the executable as a plain string from the context). First boot on a machine fetches each exact platform binary from the vendor's own npm package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>@<sdk>`, `@openai/codex@<version>-<os>-<arch>`) into `<cache>/runtimes/<backend>/<version>/`, verified against the registry's sha512 and renamed into place only complete; the launcher readout follows the download through boot progress. Every later boot is a marker read.

- **Resolution order:** an explicit executable (`StartOptions.claudeBin`/`codexBin`, or `FRIZZ_CLAUDE_BIN`/`FRIZZ_CODEX_BIN`) wins and is never provisioned around; then the pin; then the bare name on PATH as a WARNED fallback, so an offline machine still dispatches and the log says the version seam is open. `FRIZZ_RUNTIMES=path` skips provisioning (the test runner sets it — a suite must never pull half a gigabyte); `FRIZZ_RUNTIMES_DIR` relocates the root (the ad-hoc stack points a sandbox HOME at the machine's real copies).
- **Bumping a pin is a release.** The SDK version moves in `packages/claude-agent-sdk-runtime` and `CLAUDE_CODE_VERSION` follows it — `runtimes.test.ts` pins the pair to the SDK's own manifest. The Codex coordinate is the audited one and moves with the re-audit.
- **A provisioned Claude Code runs with `DISABLE_AUTOUPDATER=1`**, set on the server's own environment so every worker and every auth probe inherits it; otherwise the pin updates itself out from under Frizz.
- **The sweep keeps only the current pin**, plus any `.partial-*` younger than a day (another process may be mid-download). Nothing under `runtimes/` is precious — it is the cache root, regenerable by definition.
- **Not reused on purpose:** the vendors' own versioned installs (`~/.local/share/claude/versions/`, `~/.codex/packages/standalone/releases/`). Both prune on their own schedule, and a pin that can vanish under a running server is worse than one download.

## Codex app-server bridge (the only Codex transport)

**Codex is a first-class backend, not an experiment.** A `backend: "codex"` dispatch runs through `backend/codex-app-server.ts` and nothing else, since 2026-08-02 (`f926288f`: "both backends have exactly one transport now — codex → app-server, claude → broker"). The old opt-in flag is gone: `codexAppServerBridgeEnabled()` returns true unconditionally and the context wires the bridge at boot. This section read "Disabled by default … do not enable this flag" until 2026-09-14, and a worker that trusted it over `dispatch.ts` reported Codex as unfinished work to the maintainer — prefer the code.

- The bridge is deliberately not an `AgentBackend`: it starts new sessions and resumes only native thread ids in its own SQLite ownership table, so no existing/default/TUI Codex session can cross the boundary. The default transport is the native listener (`codex app-server --listen unix://`, `FRIZZ_CODEX_NATIVE_LISTEN`), which owns its own socket and outlives every Frizz process; the hand-written daemon is the fallback.
- **The audited coordinate is `CODEX_APP_SERVER_SUPPORTED_VERSION`** (`0.154.0` at the time of writing, source tag `rust-v0.154.0`), and the acceptance rule is a FLOOR that refuses and a CEILING that only warns (`codexVersionVerdict`): an older binary is refused because it may lack params Frizz sends; a newer one runs with one loud warning, because the protocol is additive and `codex-protocol-conformance.test.ts` asks the installed binary for its own schema and fails when a param Frizz sends is gone. Moving the pin is a re-audit at the matching immutable Rust tag, then new fixtures. Frizz provisions that exact binary itself (see Provisioned runtimes).
- The wire is JSON-RPC after `initialize` / `initialized`. It rejects versioned `jsonrpc` envelopes, bounds and serializes inbound records, and never retains stderr text. No PTY or terminal scraping. `turn/steer` delivers a mid-turn follow-up and `turn/interrupt` stops a turn; both are wired.
- The child receives an explicit minimal environment, not `process.env`: executable/runtime/home,
  locale/temp, OS credential-store plumbing, proxy/custom-CA settings, and only the audited built-in
  Codex/OpenAI auth/provider variables. Frizz, GitHub, Anthropic, AWS, Node injection, and arbitrary
  `CODEX_*`/`OPENAI_*` values are excluded. Arbitrary custom-provider `env_key` support remains out of
  scope until it can be derived and approved without forwarding unrelated secrets.
- Provider responses are durably claimed once, but the interaction journal remains pending until
  Codex emits `serverRequest/resolved`. A disconnect never blindly replays an unknown send; a newly
  witnessed matching server request is required. Session/turn ownership, provider RPC ids, and
  response acknowledgements remain connection-epoch and project-session scoped. Secret user-input
  delivery fails closed until a secure transient escrow exists.
- Exact response semantics are intentionally narrow: additional permissions expose turn/session
  grants plus deny (the server treats an empty granted profile as no grant), while
  `request_user_input` exposes only answer. That protocol has no decline/cancel response; cancelling
  work is the separate `turn/interrupt` client request, never a fabricated interaction choice.
- Registry replacement/deletion atomically cancels old delivery rows and detaches the exact native
  binding before a lifecycle hook removes it and terminates the child. Bridge disconnect/close
  detaches active bindings, and action authority requires a live connection plus the exact active
  binding/epoch. Ordinary TUI sessions have no matching binding and are untouched.
- Scoped interaction reads expose only a provider-neutral delivery effect. `awaiting-user` is the
  sole provider-backed state that enables controls; durable `queued`/`sent` projects as noninteractive
  “Sending to runtime…” across remounts and restarts, and a missing bridge projects as
  `reconnect-required`. Transport ids, provider context/responses, and secret values never cross this
  RPC boundary. The board retains pending thread visibility but removes queued/sent work from Needs
  You until a genuinely actionable request exists.
- Still out of scope on purpose: arbitrary custom-provider `env_key` forwarding (above) and secret user-input delivery, which fails closed until a transient escrow exists.

## ACP backend (any Agent Client Protocol agent, as a third backend)

**`backend: "acp"` is the generic fallback beside the two rich integrations, added 2026-09-15 (design: [`plans/acp-backend.md`](plans/acp-backend.md)).** Claude keeps the SDK broker and Codex keeps the app-server bridge — quota chips, account actions, sub-agent telemetry, per-thread model/effort/permission controls all stay theirs. An ACP thread gets what the protocol carries and nothing invented on top: streamed text and reasoning, tool calls with status, permission requests as cards, a queued follow-up, cancel, and resume after a restart. Verified end to end on a disposable stack against `opencode acp` 1.18.29: the frizz MCP tools were called through the real server, a `write` and a `bash` permission card each round-tripped, a follow-up sent mid-turn queued and delivered the instant the turn ended, `killAgent` cancelled a running `sleep` through `session/cancel`, and a follow-up after a server restart answered from the `session/load`-replayed history.

- **The agent is a model, and the agent's model rides the same slug.** The composer's profile grid lists every ACP agent found on the server's PATH under "ACP agents" with one `Default` cell (an agent runs on its own CLI's effort — Frizz has no effort axis to offer), and a MODEL DROPDOWN beside the pill (`AcpModelSelect`, 2026-09-16, maintainer: "a dropdown picker, not the grid") lists the models the agent itself advertises — ACP exposes them only as a session's `model` config option, so `rpc.acpAgentModels` opens a throwaway session per agent, reads the option and caches it ten minutes (`AcpBridge.agentModels`). The thread carries `model: "acp:<agent>"` or `"acp:<agent>@<model>"` (`@`, because model ids contain `/` and `:`; helpers in `@frizz/shared`), `backendForModel` reads the prefix as `acp`, the bridge asks for the model with `session/set_config_option` when it opens a session (a refusal becomes an `acp-note` and the session runs on the agent's own model), and `setThreadProfile` on a live ACP thread switches it in place through the same request — the AGENT half of the slug is refused, since the session belongs to the process that opened it. The catalogue is `backend/acp-agents.ts` (opencode, cursor-agent, gemini, copilot, kilo, qwen, goose, kimi — each the executable plus the argument that puts it into ACP mode) merged with `settings.acpAgents`; agents are PATH-resolved and NEVER provisioned, and their credentials are their own CLI's (`AccountBackend` narrows sign-in, quota and logout to Claude and Codex; `/login` on an ACP thread says so).
- **Transport:** `backend/acp-rpc.ts` is a hand-rolled newline-delimited JSON-RPC 2.0 client over the child's stdio (`initialize` v1 → `session/new` or `session/load` → `session/prompt`, the prompt's response being the end of the turn). No `@agentclientprotocol/sdk`, no PTY, no scraping. One direct child per live thread, owned by the server process — an ACP turn does NOT survive a Frizz restart (the Claude daemon and the Codex listener do); the bridge (`backend/acp-bridge.ts`) re-opens the session on the next follow-up with `session/load` when the agent advertised `loadSession`, else a fresh session with an `acp-note` saying the earlier conversation is gone. The child's environment goes through `inheritWorkerEnvironment`, never raw `process.env`.
- **The transcript is Frizz-written.** ACP has no on-disk session format Frizz could tail, so the bridge writes `<stateDir>/acp/<frizz session id>.jsonl` — an `acp-session` header (agent, ACP session id, cwd, model) then NormalizedEvents as the tailer already folds them (`backend/acp-transcript.ts`). The stem is ALWAYS the frizz `session_id`; `agent_session_id` holds the agent's own session id for `session/load` only, and every reader that switches on backend (tailer prime, `sourceForThread`, `projectSnapshot`, the cursor, `readThreadTranscript`) has an acp arm keyed that way — the first live dispatch spun `running` forever because the tailer built the stem from `agent_session_id`. ACP rows skip the Claude discovery sweep and the perm-marker read exactly as Codex rows do.
- **Permissions are cards with canonical ids.** `session/request_permission` becomes a `command-approval` (bash-like) or `file-approval` (edit-like, with the agent's diff preview) interaction whose decisions are `accept` / `acceptForSession` / `decline`; the agent's own `optionId`s stay beside the pending entry and the chosen one goes back on the wire. A turn ending or the session being released cancels its open cards. Whether an agent asks at all is the agent's configuration (opencode: `permission.edit`/`permission.bash` in `opencode.json`; its default in ACP mode allows edits silently).
- **Follow-ups queue; there is no steer.** A follow-up during a turn is held by the bridge and sent as the next `session/prompt` when the turn ends (the delivery ledger draws it as the gray queued bubble meanwhile); `killAgent` is `session/cancel`, after which the queue drains. A cancelled turn records `turn-end` with `successful: false` plus an `acp-note`, and a zero-token `usage_update` (opencode sends one on cancel) is dropped rather than emptying the context dial.
- **Deliberately not integrated:** quota/usage chips, sub-agent and background-shell telemetry, per-thread effort and permission changes (the RPCs refuse an ACP thread; the model is the one profile axis it has), the `fs/*` and `terminal/*` client methods, hibernation, and a detached host that would let a turn outlive the server. Each is a separate effort on top of the seam, not a gap in it.
- **Verifying it needs a real agent:** `scripts/adhoc-stack.mjs --creds` links `~/.local/share/opencode` into the sandbox HOME for opencode's own credentials; `backend/_live_acp_opencode.mts` is the manual wire probe; the fake agent under `backend/acp.fixtures/` drives the protocol, bridge and transcript tests without a vendor CLI.
