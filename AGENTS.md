# Git: how work lands here

**Contributing from a fork.** Frizz takes pull requests. Fork the repo, branch, open a PR against `main`, and CI runs on it — see [Contributing](README.md). Nothing else in this section concerns you.

**Working in the maintainer's own checkout** — which is every agent Frizz dispatches on that machine, and every sub-agent it dispatches in turn — read [`AGENTS.local.md`](AGENTS.local.md) FIRST and follow it, because the git rules there are strict and this is the most-violated one in the repo: that checkout does NOT use pull requests, at all, ever. Finished work is committed to its local `main`, and `gh pr create` is always the wrong move there. The same file covers committing out of a working tree other agents are editing concurrently, which has its own traps.

# Cutting a release — `release` publishes, `main` does not

Frizz publishes to npm from the [`release`](.github/workflows/release.yml) branch, never from `main`. `main` moves under you — several agents land on it continuously — so the commit you verified and the one that would publish are routinely different, and a release from `main` carries whatever happened to arrive in between. `main` answers "has this landed?"; `release` answers "has this been VERIFIED and chosen to ship?", and only the second publishes (maintainer 2026-09-08: *"you can bump these versions and do your own testing independent of whatever's landed on `main`"*). **`release` is a fast-forward pointer into `main`, never a fork.** It holds no commits of its own: you move it to the `main` commit you tested. If it ever needs a non-fast-forward push, stop and look rather than forcing it.

When the maintainer says "cut a patch" or "cut a release", this is the whole job, in order:

1. **Bump the package that changed on `main`.** Server, frontend and provider-runtime changes bump `version` in [`packages/server-release/package.json`](packages/server-release/package.json); ordinary server updates leave the stable root `frizz` version alone. Launcher changes also bump root [`package.json`](package.json). A new shell's `frizzServer.version` names its exact compatible bootstrap server. Protocol/data-epoch changes require an explicitly compatible shell and server together; see [`plans/stable-server-publishing.md`](plans/stable-server-publishing.md). Commit version changes as `chore(release): <package> X.Y.Z`; patch bumps remain the default.
2. **Look at what ships with you.** `git log release..HEAD` is the exact set. Anything there you have not verified either gets verified now or gets left behind by pointing `release` at an earlier commit — that choice is the whole reason the branch exists.
3. **Verify the commit you are about to publish, not "the tree".** `nub run typecheck` and `nub run test` against that sha. Typecheck is the workflow's own gate, deliberately not the full suite: the suite drives real provider CLIs and a real browser and has never run on a CI box, so it runs HERE, before the push, or the release goes out untested.
4. **Push `main`, then fast-forward and push `release`.** `git push origin main`, then `git branch -f release <sha> && git push origin release`. The push to `release` is what publishes. It is the one push the no-PR rule in [`AGENTS.local.md`](AGENTS.local.md) does not reach — that rule forbids pushing a branch to STAGE A REVIEW, and a release push stages nothing; it ships.
5. **Watch the run, then APPROVE the staged versions — the run cannot finish without you.** `gh run list --workflow=release.yml --limit 1` names the run; `gh run watch <id> --exit-status` follows it. The workflow typechecks and then STAGES `frizz-server` and `frizz`: the trusted publisher on both packages is stage-only, so CI can reserve a version and nothing more, and neither version is installable until a maintainer approves it with 2FA. Run `npm stage list frizz-server` for the stage ids and `npm stage approve <id>` one at a time, or `pnpm stage approve` for both under one one-time password. **Approve `frizz-server` first** — the shell fetches its pinned server from the registry on first boot, so a live shell with no server behind it is broken for whoever installs it in that window. The job then polls until the registry serves both versions, which also absorbs npm's publish queue (6m 40s for 0.13.5 on 2026-09-14; other projects report up to ~40m), and tags and creates the GitHub release only after that. A green run therefore means published, not accepted. The job waits six hours; approve later than that and the re-run resumes from the approval, since each package keeps its own registry existence check. Tags `vX.Y.Z` and GitHub releases belong to the shell only and target its registry-recorded `gitHead`, not a later server-only commit. If the run dies after npm accepts a package, `gh workflow run release.yml --ref release` reconciles the missing metadata without republishing.

**A version bump on `main` is INERT until `release` moves.** Pushing `main` publishes nothing, by design; that silence is why step 4 has two pushes. Release checks must compare both public manifests against their respective npm packages; a provider pin now ships in `frizz-server`, not necessarily a new shell. The trap that has actually broken releases at the install step — `pnpm install --frozen-lockfile` disagreeing with a lockfile `nub` wrote — and the full reasoning live in [`plans/runtime-pin-bumps.md`](plans/runtime-pin-bumps.md) § Then cut a release.

# Web UI completion rule — proportionate, not reflexive

Browser QA is for the changes where a browser is what actually settles the question, not for every diff
that happens to touch a `.tsx` file. Judge the change in front of you.

**Drive it in Chrome, and carry the evidence in your handoff** (inspected screenshots, console/page-error
check, the optical-review result, explicit browser-cleanup confirmation) when the change is: a new or
restructured surface, layout or interaction flow; anything judged OPTICALLY — spacing, alignment, colour,
truncation, a glyph beside text; behaviour you cannot predict from the code alone (live state, timing,
streaming, restart/recovery, a seam between processes); a fix no test pins where the bug actually lives;
or anything large, cross-cutting, or that you are unsure of.

**Skip it for the small and the certain** — a targeted fix in code you have read, pinned by a test at the
right level, with a blast radius you can name; docs, comments, types, provably mechanical edits; and
anything with no browser surface at all (prove that in its own real runtime). Then say plainly in the
handoff what you verified and how, so the maintainer can weigh the call. Confidence is earned, never
asserted: "it should work" is not confidence, a green unit test over a stubbed seam is not either, and
you never describe something as driven or verified when it was not.

**Load the skill that matches what you need**, and compose them — they were one 300-line skill until
2026-08-08, which meant a backend fix had to read the browser rules and a CSS tweak had to read the
stack rules:

- **`frizz-stack`** — boot a real, fully-isolated disposable Frizz (`scripts/adhoc-stack.mjs`), including
  the multi-project/tenant case, and seed real state through its own RPC surface.
- **`headless-browser`** — take the shot without putting a window on the maintainer's screen
  (`scripts/shot.mjs` is the DEFAULT; Chrome DevTools MCP second, and only because this repo forces it
  headless through its own `.mcp.json` — Frizz mounts no browser into the workers it dispatches),
  which states and widths to capture, browser process hygiene (one owned instance per task;
  never a global close or a broad `pkill`), and how to embed evidence so Frizz renders it inline.
- **`real-subsystem-harness`** — for behavior no browser can reach: the broker socket, a pty, spawn/exec
  paths, migrations, a detached daemon's environment. Real resource, real function, negative control.

# Visual alignment is the implementer's job, not a review someone else does

**Load the `visual-review` skill whenever you place an icon, glyph, emoji, badge, chip, or counter next
to text — and before you declare any new UI correct.** It carries the ink-measurement routine, the
per-glyph offsets it produced, and the instrument bug that makes a naive baseline probe report ~3x the
real error. Two non-negotiables from it:

- **You are the first reviewer of your own screenshot.** Capturing evidence is not reviewing evidence.
  Read the shot back and actively hunt for what is wrong with it — a glyph riding high, mismatched visual
  weight, a collision at a narrow width. Never hand over a screenshot you have not personally critiqued.
  Capture at a scale where the detail is judgeable; a 40px component inside a 1400px shot cannot be
  reviewed, and glancing at it counts for nothing.
- **Icon-beside-text alignment is an INK problem, and every glyph differs.** `items-center` centers a
  glyph's BOX on the flex line; the eye aligns ink. A digit has no descender, an SVG's ink sits wherever
  its path falls inside its viewBox, an emoji ignores your font size — so one shared nudge cannot fix a
  cluster. Measure each glyph, correct each in `em`, then re-measure and confirm the residual is ~0.

**And load the `optical-spacing` skill whenever you set or judge the spacing of a ROW of controls** —
an icon strip, a button rail, a footer of mixed glyphs and pills. The same law sideways: `gap` spaces
boxes, so a bare glyph in a hover square and a bordered pill on one uniform `gap` drew ink distances
from 5.78px to 20.50px on a single strip. It carries the ink-gap instrument (this repo's copy is
`scripts/ink-gaps.mjs`), the negative-margin fix, and the pen-width rule for matching perceived weight
— which no colour token can fix. It is a GLOBAL skill, not one of this repo's, so it needs no entry in
`.agents/skills/`.

## Every UI change gets an OPTICAL SPACING PASS before you call it done — no exceptions, no threshold

Any time you implement or touch any UI, measure the spacing the eye actually reads before you hand it over. This is not conditional on the change looking like an "icon strip", and not something to reach for only when someone complains. It is the last step of implementing UI, the same way running the tests is the last step of implementing logic.

- **Two marks on one line ARE a row.** A label and its chevron. A gerund and its elapsed clock. A badge beside a title. If you can name two things sitting side by side, the skill applies — that is the reading that keeps getting missed, because "row of controls" sounds like a toolbar and a disclosure row does not.
- **A `gap` is not a distance.** It spaces BOXES, and small glyphs are mostly empty box. Lucide's chevron paints 4.67 of its 14 box px, a third of dead space per side — so `gap-1` beside its label and `gap-2` before its clock drew **9.06px and 13.00px** of ink where the CSS claimed 4 and 8, and the chevron floated equidistant between the two instead of reading as the label's handle (maintainer 2026-08-05: *"Fix the fucking optical spacing on that chevron"*). Nothing in the CSS looks wrong; you only see it by measuring the pixels.
- **Run the instrument, both axes.** `scripts/ink-gaps.mjs` for horizontal ink gaps, the `visual-review` ink routine for vertical ink-vs-cap-band. One caveat that will bite: once a negative margin makes boxes overlap, `ink-gaps.mjs` unions the NEIGHBOUR's ink into the mark and reports nonsense — switch to geometry then (an SVG child's `getBoundingClientRect` IS its ink box; canvas `actualBoundingBox*` gives a string's ink edges).
- **Then look at it, cropped, at dsf 6–8.** The numbers say whether the gap is what you set; only the picture says whether what you set is right. Both failures happened here in one sitting: shipping 9.06px because the CSS said 4, then over-collapsing to 4.4px because the trim was correct and the target was not.
- **THE APP RENDERS IN SANS, BUT THE STYLESHEET STILL DEFAULTS TO MONO — set `data-font="sans"` on any fixture you measure on.** The prose/UI font was a user setting until 2026-09-19 (`html[data-font="sans"|"mono"]`; maintainer: *"let's drop monospace as an option"*), and the setting is gone: `index.html` pins `data-font="sans"` on the `<html>` tag and no user can reach the mono family. The sheet's structure is unchanged, though — its sans rules still key on that attribute, so a fixture page that does not set it silently renders the mono default nobody sees in the product: a chevron measured there at a 0.00px residual rode visibly high in the maintainer's sans window (2026-08-05: *"this is awful"*). Sans is the only reading that matters now; the per-font measurements in `styles.css` and the components are kept for the day the attribute is dropped, not as a second target.
- **Prefer a correction the BROWSER computes to one you fit by hand.** `1cap` is the resolved font's cap height, so `self-baseline` + `translate-y-[calc(0.5em_-_0.5cap)]` puts a symmetric 1em glyph's ink exactly on the cap band **in any font, at any size**, with nothing to re-measure when the setting flips or the type scale moves. Reach for a measured `em` constant only where no derivable reference exists — and say which font you measured. (`align-self: baseline` needs a shared baseline to align against: if the row is `items-center`, the glyph has nothing to align to and silently lands ~1px off. Make the row `items-baseline`.)
- **Put the corrections in ONE place with the readings in the comment,** not per call site. Three chevrons in one column each placed by hand had drifted into two vertical offsets, two tones, and a horizontal rhythm nobody had ever measured. They are measurements, not taste — the next reader has to know to re-measure rather than re-guess.

Do not ship "it renders" and wait to be told it looks wrong. If the pattern exists in a real product
(GitHub, Linear, this app's own components), measure the real one and mirror it instead of designing
from taste.

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

**"Frizz" is a proper noun — always capitalize it in prose.** The product is Frizz; write "Frizz
dispatches a worker", never "frizz dispatches a worker". Lowercase survives only in literal
identifiers, where it is part of the name: `npx frizz`, `FRIZZ.md`, `.frizz/`, `~/.frizz/`,
`frizz-<slug>` session names, the `frizz`/`frizz-update` CLIs, and the `frizz:*` skill and sub-agent profile names.

# Durations: ONE grammar, every reading — `40m`, `2h 35m`

Every duration and relative age the product renders uses one spelling, and it is not negotiable per surface (maintainer 2026-08-31, after finding five of them in one app: *`"40 minutes" -> "40m"` … `2hr 35m` … Use this stylization everywhere. EVERYWHERE*, then, hours corrected the same evening: *h is better than hr*).

**The units are `ms` · `s` · `m` · `h` · `d` · `w` · `mo` · `y`.** The unit is a SUFFIX glued to the number with no space (`40m`, never `40 min` and never `40 minutes`), and a compound reading joins at most two of them with one space (`2h 35m`, `3d 4h`, `12m 05s`). Every unit is ONE letter except months, which are `mo` because a bare `m` is already minutes — so hours are `h`, never `hr` and never `hour`.

- **The canonical statement, with the reasoning, is the header comment of [`packages/web/src/lib/durationLabels.ts`](packages/web/src/lib/durationLabels.ts)**, and a test in that directory pins it as a SHAPE, so a reading that reverts to `40 min`, `12 minutes` or `1hr 5m` fails rather than shipping. Relative ages share one ladder in [`activityTime.ts`](packages/web/src/lib/activityTime.ts) (`ageLadder`) for the same reason: three copies of it had already drifted, and one carried a `0y ago` bug the other two also had.
- **It reaches past the browser.** The same grammar spells the cadence in a Goal's trailer, the elapsed in a worker's wake header (`you last spoke 3h 12m ago`), the quota chips, the `frizz --sessions` CLI, and the board CLI's ETA. A worker reads its own duration readings; two vocabularies teach it there are two.
- **What is NOT unified is the LADDER** — which units a reading climbs to, and how much precision it keeps. A countdown pads and ticks (`3h 05m`), the runtime slot drops seconds past a minute, a tool call keeps them, the GitHub cards stop at `2w` and then give a date. Those are per-surface behaviours with their own documented reasons; only the SPELLING is shared.
- **The `for:` fence vocabulary is a separate contract that happens to agree.** `30s` / `15m` / `2h` / `3d` is a grammar the worker WRITES and Frizz PARSES, defined in the worker contract; the card echoes the worker's own token back. It reads identically to the house grammar today, which is a coincidence worth not relying on — a change to one must never be applied to the other by sweep, because restyling the fence breaks the parse and the contract at once.
- **Running prose keeps its words.** "expires in 5 minutes" in a help line is a sentence, not a reading. The grammar governs a duration rendered as a VALUE: a column, a chip, a label, a status tail, a countdown, a tooltip.

# ONE server, EVERY project — never one per repo

Frizz is a SINGLETON. One server on one origin serves every project on the machine, each named by a URL prefix (`/project/<slug>/…`). It ran one server per repo until 2026-08 and the change is recent enough that stale statements survive in comments, docs and muscle memory — `ARCHITECTURE.md` itself still said "One server per repo" in one bullet while explaining the singleton in another, and the README still promised "one server and one tab per repo" (both corrected 2026-08-19).

The practical consequences, because getting these wrong produces working-but-wrong code and copy:

- **Nothing is scoped to "the repo you launched from."** A command does not serve *a project*; it starts *the server*. Copy that says "serve this repo" is wrong, and so is a CLI shape that takes a repository path to decide what to serve.
- **`--host` / `--public-origin` / a tunnel expose EVERY project**, not the one you are standing in. Any auth story has to be told at that altitude.
- **A second launch JOINS the running server rather than starting one**, so flags on it are not applied — the launcher now refuses rather than ignoring them silently (`352455e`).
- Full detail, including the characteristic bug (another project's data rendered under this project's URL), is in `ARCHITECTURE.md` § "URL shape (one server, every project — the singleton)".

# There is NO tmux. Agents are detached broker daemons

Agents ran in tmux panes once, and the vocabulary outlived the transport by weeks: a `tmux_name` column, a `FRIZZ_LAUNCH_TMUX_SOCKET` launch variable, hundreds of comments in `router.ts`, `tailer.ts` and `dispatch.ts` narrating a pane, and 53 seed scripts opening a dummy pane nothing read. Every agent that read them eventually told the maintainer that stopping Frizz was safe "because the agents are in tmux" — wrong, and saying the wrong reason cost real trust. **That vocabulary was swept out on 2026-08-19.** The column is `thread_name`, the launch variable is gone, no script execs or installs tmux, and `packages/server/src/tmux.ts` has not existed since 2026-08-02. Check it in ten seconds with `grep -rn tmux --include='*.ts' packages/server/src`.

What actually happens: a Claude thread is `claude_runtime="broker"`, and `claude-broker-host.ts` forks a daemon with `detached: true, stdio: "ignore"` into its **own process group**. That single fact is the answer to most operational questions — Ctrl-C on the server signals the launcher's group and cannot reach the daemon, so a running turn survives a stop; its events queue in a 20,000-frame backlog rather than dropping while nothing is attached, and the bridge replays them on reconnect. Sub-agents live inside that daemon's SDK session, so they ride along too.

**So: never tell the operator anything about tmux, and never repeat "the agents are in tmux" as a reason a restart is safe.** It is safe, for a different reason, and saying the wrong one has cost real trust here. Exactly one tmux reference survives on purpose — `isTmuxServer` in `orphan-reaper.ts`, which refuses to reap a tmux server process, because upgrading from a pre-cutover Frizz can leave one holding panes an operator is still reading. Everything else that still says tmux is either dated design history under `plans/` (left as a record, not as guidance) or something the sweep missed; treat the second kind as a bug and prefer `git log -S` over believing it.

# Board nomenclature: "active" means SPINNING, and nothing else

The sidebar's row groups have names the maintainer uses precisely (2026-08-05: *"when I say active, I'm only referring to the things that are currently spinning; the things beneath that, I would refer to as rested, or just items in the queue"*). Use them in code, comments, copy and when reporting back. (The quote says "beneath" because Rested sat below Active when it was said; on 2026-08-08 the two bands SWAPPED position — the cue moved up under the prompt box — and the vocabulary did not change with them.)

Top to bottom:

- **Rested** — the CUE: the top band, directly under the prompt box; the same set as **"the queue"** / "items in the queue", one row per card, each with a right-justified rest time.
- **Active** — the rows below that rule, in practice the ones currently spinning. Never carries a queue card, and never a rest time — the rule is drawn on the CARD, so a thread the server excused from the queue while it rests lands here too (see `ARCHITECTURE.md`).
- **Snoozed** — the dimmed, labeled park band (a future `timer:`, a wall-clock snooze, an auto-resumed limit pause, a worker's own indefinite snooze). It was called **Held** until 2026-08-26; the group key moved with the label, so `sectionOf` returns `"snoozed"` and nothing reads `"held"` any more.
- **Done** — the collapsed archived section.

The trap is that `groups.ts` `sectionOf` returns `"active"` for Active AND Rested rows alike — that key names the `<section>` holding both bands, not the maintainer's word. `partitionActive` splits it (`.running` = Active, `.rested` = Rested), and `inActiveBand` is the one predicate that means Active exactly. Full detail, including why the archived key is `"inactive"` while its label reads Done, in `ARCHITECTURE.md` § Board nomenclature.

# "Shipped" means merged into the primary branch

Never describe a created, opened, or pushed PR as "shipped." An open PR is implemented, pushed,
ready for review, or awaiting merge. Use "shipped" only after the change has actually been merged
into the repository's primary branch. This applies to progress updates, final handoffs, and signal-card
bullets.

# Project-local skills and tools are shared across agents

Any project-local skill or tool lives in ONE agent-neutral copy that every agent configuration
discovers — never a per-agent fork. Skills live canonically in `.agents/skills/<name>/` (Codex
discovers this path natively); `.claude/skills/<name>` is a relative symlink into that canonical copy
so Claude Code discovers the identical content. When adding a skill, create it under
`.agents/skills/` and add the symlink; verified end-to-end 2026-07-21 with `adhoc-cdp` (Claude lists
it through the symlink, `codex exec` resolves it at `.agents/skills/<name>/SKILL.md`) — that skill has
since been split into `frizz-stack` / `headless-browser` / `real-subsystem-harness`, which is also the
shape to copy: **one skill, one job**, cross-linked, rather than a single file every caller must skim. Shared
tooling scripts follow the same rule: one copy in an agent-neutral location (e.g. `scripts/`),
referenced from skills — never duplicated into agent-specific config trees.

**A GLOBAL skill takes the identical shape one level up**: canonical in `~/.agents/skills/<name>/`,
with relative symlinks at `~/.claude/skills/<name>` and `~/.codex/skills/<name>` (both `../../.agents/…`
— `~/.codex/skills` is two levels deep, not one, and getting that wrong yields a dangling link that
still `ls`es fine). A global skill must BUNDLE any script it needs beside its `SKILL.md`; it cannot
reach into a repo's `scripts/`. And a skill belongs in exactly one scope — never a project copy AND a
global copy of the same name, or they drift and the agent lists it twice.

# Use Nub for the Node toolchain

Prefer Nub over direct `node`, `npm`, `npx`, `pnpm`, `yarn`, `tsx`, or `ts-node` commands. Run
JavaScript and TypeScript files with `nub <file>`, package scripts with `nub run <script>`, installed
CLIs with `nubx <tool>`, tests with `nub --test`, and installs with `nub install`. Nub transpiles
TypeScript but does not typecheck it, so keep `tsc --noEmit` and project typecheck gates separate.

# Agent completion invariant

Once spawned, an agent runs to its terminal return. Do not interrupt or cut off an active agent to
reduce churn, reclaim slots or quota, redirect work, respond to a user steer, contain live-server
instability, or hurry completion. Deliver new direction through the agent's message/follow-up path,
then reconcile obsolete or conflicting results after it returns. Mid-turn interruption can leave
partially applied edits, tests, and owned processes behind, making the resulting repository state
unsound. Isolate or restart only the affected unstable service; never stop a writer to stabilize it.
If an agent appears hung or continuing would be dangerous, use the interactive question path to ask the
user. The sole exception is an explicit user instruction that names the interruption.
