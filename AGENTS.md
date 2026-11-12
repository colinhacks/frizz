# Git: how work lands here

**Contributing from a fork.** Frizz takes pull requests. Fork the repo, branch, open a PR against `main`, and CI runs on it — see [Contributing](README.md). **Keep "Allow edits by maintainers" checked on every PR you open** (GitHub offers it only on a fork owned by a personal account, not an organization, so fork into your own account), so the maintainer can push a follow-up commit onto your branch; with it cleared the push is rejected, and the follow-up lands on `main` separately after the merge instead of in your PR (maintainer 2026-10-10, on [#56](https://github.com/colinhacks/frizz/pull/56#issuecomment-6091787715)). `gh pr create` leaves it on unless passed `--no-maintainer-edit`; a PR opened through the REST API needs `"maintainer_can_modify": true` in its `POST /repos/colinhacks/frizz/pulls` body. Nothing else in this section concerns you.

**Working in the maintainer's own checkout** — which is every agent Frizz dispatches on that machine, and every sub-agent it dispatches in turn — read [`AGENTS.local.md`](AGENTS.local.md) FIRST and follow it, because the git rules there are strict and this is the most-violated one in the repo: that checkout does NOT use pull requests, at all, ever. Finished work is committed to its local `main`, and `gh pr create` is always the wrong move there. The same file covers committing out of a working tree other agents are editing concurrently, which has its own traps.

# Cutting a release — `release` is what ships, and a dispatch is what starts it

**Releases belong to ONE dedicated releaser thread, and it is not you unless the maintainer told you to cut one.** Every other thread's job ends when its work is committed to local `main`: land it there, and the releaser picks it up with everything else since the last release. Never cut a release, bump a version in `package.json` or `packages/server-release/package.json`, move or push `release`, or dispatch the workflow on your own initiative — and never OFFER to: no "want me to cut a patch?", no release option in a question, no "this needs a release to reach users" as a follow-up in your handoff. Saying the change is on `main` is the whole report (maintainer 2026-10-11: *"there's a dedicated releaser agent … threads should just get all their stuff merged into main, but never offer to cut releases"*). The procedure below is for that releaser, and for a thread the maintainer explicitly asked to cut one.

**The releaser also owns the bundled Claude Code and Codex pins** (maintainer 2026-11-04). Run `nub scripts/check-runtime-pins.mjs` every day and before every release; a pin that is behind is bumped, verified against the real binary and landed on `main` first. [`plans/runtime-pin-bumps.md`](plans/runtime-pin-bumps.md) § Who runs it, and a whole bump in order has every step, and its tools are in [`scripts/pin-bump/`](scripts/pin-bump/).

Frizz publishes to npm from the [`release`](.github/workflows/release.yml) branch, never from `main`. `main` moves under you — several agents land on it continuously — so the commit you verified and the one that would publish are routinely different, and a release from `main` carries whatever happened to arrive in between. `main` answers "has this landed?"; `release` answers "has this been VERIFIED and chosen to ship?", and only the second is ever released (maintainer 2026-09-08: *"you can bump these versions and do your own testing independent of whatever's landed on `main`"*). **`release` is a fast-forward pointer into `main`, never a fork.** It holds no commits of its own: you move it to the `main` commit you tested. If it ever needs a non-fast-forward push, stop and look rather than forcing it.

**No push publishes anything (2026-09-23), every run waits for an approval (2026-11-05), and nothing reaches npm without a 2FA code (2026-11-06).** Moving `release` selects the commit, `gh workflow run release.yml --ref release` starts a run, and the run waits on the `npm-publish` environment until `colinhacks` approves it. It can then only stage, because the trusted publishers on `frizz` and `frizz-server` are stage-only, and neither version is installable until the maintainer approves it with an authenticator code. GitHub's docs say a pushed branch workflow can dispatch `release.yml` with its own `GITHUB_TOKEN`, and the classic `GH_TOKEN` can approve its own run, so one Keyward window can start a release. Neither can finish one.

**Every `gh` below that WRITES runs as `keyward --reason "<the task>" -- gh …`** on the maintainer's Mac (2026-11-04): Keyward holds the GitHub sign-in that can write, one Touch ID per hour per repository, nothing while the screen is locked. A worker's plain `gh` reads with Frizz's read-only credential ([`github-credential.ts`](packages/server/src/github-credential.ts)), so `gh run watch` needs nothing, and `gh workflow run` needs Keyward. Keyward reads only the first word of a command, so it cannot wrap a script: `release-notes.mjs`, `tag-release.mjs` and the other repo scripts call it themselves through [`scripts/lib/gh-command.mjs`](scripts/lib/gh-command.mjs), so run those plainly.

When the maintainer says "cut a patch" or "cut a release", this is the whole job, in order:

1. **Bump the package that changed on `main`.** Server, frontend and provider-runtime changes bump `version` in [`packages/server-release/package.json`](packages/server-release/package.json); ordinary server updates leave the stable root `frizz` version alone. Launcher changes also bump root [`package.json`](package.json). A new shell's `frizzServer.version` names its exact compatible bootstrap server. **That pin only reaches a machine with no server yet**: everyone else keeps the server they have until they click Update, so a new shell on a server several releases old is the ordinary pairing. A shell that depends on something a server release learned raises `frizzServer.minimum` to that release in the same commit, and a machine below it is then started on the pinned server instead ([`plans/server-side-launch-routing.md`](plans/server-side-launch-routing.md) § 7). Protocol/data-epoch changes require an explicitly compatible shell and server together; see [`plans/stable-server-publishing.md`](plans/stable-server-publishing.md). Commit version changes as `chore(release): <package> X.Y.Z`; patch bumps remain the default.
2. **Look at what ships with you.** `git log release..HEAD` is the exact set. Anything there you have not verified either gets verified now or gets left behind by pointing `release` at an earlier commit — that choice is the whole reason the branch exists.
3. **Verify the commit you are about to publish, not "the tree".** `nub run typecheck` and `nub run test` against that sha. Typecheck is the release workflow's own gate, deliberately not the full suite. The `test` job in `ci.yml` runs the suite on a push to `main`, but the release neither waits for that run nor reads it, so the suite runs HERE, before the push, or the release goes out untested. Then `nub scripts/release-preflight.mjs <sha>`: it reads git, npm and GitHub and changes nothing, and it asks what this section can only tell you to remember, before the push instead of inside the run (the lockfile under the workflow's own pnpm, a release run still in flight, the version order, both manifests, the runtime pins, the two approval environments, what ships). A ✖ is a reason to stop.
4. **Push `main`, then fast-forward and push `release`.** `git push origin main`, then `git branch -f release <sha> && git push origin release`. This chooses the commit that will ship; it starts nothing. It is the one push the no-PR rule in [`AGENTS.local.md`](AGENTS.local.md) does not reach — that rule forbids pushing a branch to STAGE A REVIEW, and a release push stages no review.
5. **Dispatch the workflow, then approve the run.** `gh workflow run release.yml --ref release`. This is the only thing that starts a release, and the workflow refuses any ref but `release`. The run then waits on `npm-publish`. Approve it from the same repository, inside the same Keyward window, with `printf '{"environment_ids":[24114953080],"state":"approved","comment":"Approved by the releaser"}' | keyward --reason "Approve the frizz release run" -- gh api -X POST repos/colinhacks/frizz/actions/runs/<run id>/pending_deployments --input -`. **It also refuses to stage a version that does not directly follow the highest one npm serves** ([`npm-refuse-overtake.sh`](.github/scripts/npm-refuse-overtake.sh)): npm serves two versions held in its review in whichever order it likes, and on 2026-10-11 it served `frizz` 0.13.11 eighteen minutes before 0.13.10, which had been accepted nearly six hours earlier. So never dispatch a release while an earlier version of the same package is still in review — wait for npm to serve it and re-run. Only when the number in between was never published at all (its run was cancelled before the staging step) does the dispatch take `-f allow_version_gap=true`.
6. **Put the approval on the maintainer's screen, and do not call it cut until npm serves both versions.** `gh run list --workflow=release.yml --limit 1` names the run, and `gh run watch <id> --exit-status` follows it. The run ends once both versions are staged, so a green run means staged, not served. Once its `stage` job is green, run `stager ask 'frizz-server@<server version>' 'frizz@<shell version>'` and tell the maintainer once that the notification is up: Approve, one authenticator code (the `npm-web-approvals` skill has the details; never `stager approve`, which costs one browser approval per package). The daemon posts it the moment npm's review ends, which has taken up to 236 minutes, or queues it until then. Its one code approves the server first, because the shell fetches its pinned server from the registry on first boot and a live shell with no server behind it is broken for whoever installs it, then the shell. Stager's notifications can sit beside another project's release, so say which one to approve. Then `stager await 'frizz-server@<server version>' 'frizz@<shell version>'` blocks until npm serves both: that, not the run, is the release's end. No GitHub step follows the approval: until 2026-11-12 a `finish` job held on a `release-approval` environment waited for npm, and resuming it cost the maintainer a Touch ID on every approval for a job that published and tagged nothing (maintainer: *"I thought the whole point of Stager is that it can resume those runs on its own"*). A staging step that fails with `E403 OIDC permission denied for this action` means the package's trusted publisher on npmjs.com does not allow `npm stage publish`; a maintainer must allow it there. If the run dies after npm accepts a package, `gh workflow run release.yml --ref release` finishes it without staging again. (Staging first ran from 2026-09-22 to 2026-09-30 and was dropped as too onerous, before stager could approve both packages with one code. It came back on 2026-11-06.)
7. **Publish the release notes, with the tag and GitHub release, yourself — EVERY release, server-only ones included.** The maintainer, 2026-10-16: *"You should start publishing release notes with each one. That's important."* Once the run is green, from your own `gh` session:
   1. **Draft them:** `nub scripts/release-notes.mjs frizz-server > notes.md` (and `nub scripts/release-notes.mjs frizz > shell-notes.md` when the shell shipped too). It reads the range from npm, from the previous served version's `gitHead` to this one's, and drafts Added / Fixed / Faster sections from the conventional commit types. Every item links its commit, and its pull request with the author credited when it came through one. A Contributors section, the full commit list (collapsed) and a compare link follow.
   2. **Edit the draft into notes.** Rewrite each drafted bullet in the product's words, as what someone running Frizz notices, never the commit subject. Merge bullets that are one change, drop what nobody would notice, and keep every link. Lead with what matters most, and delete the DRAFT line. The maintainer, of 0.15.28's first notes, two unlinked hand-written bullets: *"absolutely fucking terrible. They don't link to the relevant commits or PRs."*
   3. **Publish them:** `nub scripts/tag-release.mjs frizz-server --notes-file notes.md`, and `nub scripts/tag-release.mjs --notes-file shell-notes.md` for a shell. It refuses notes that still carry the DRAFT line, link no commit or PR, or have no compare link. It appends the npm link itself. Re-run with corrected notes to replace a published release's notes.
   - **Tags:** the shell's are `vX.Y.Z`, and the server's `frizz-server-vX.Y.Z`, never marked GitHub's "Latest" (that badge names what `npx frizz` installs). Both target the registry-recorded `gitHead`, never a checkout, and an existing tag is never moved. The workflow did this until 2026-10-12 and no longer can: GitHub refuses a workflow's own token a ref whose commit carries a different `.github/workflows/` than the run's checkout, which is the usual case once a later run reconciles an earlier shell (frizz 0.13.13). Your `gh` session has the workflow scope; the job now has read-only access to the repository (maintainer 2026-10-12: the releaser tags after the run).

**A version bump on `main` is INERT until step 5 dispatches the workflow.** Pushing `main` publishes nothing, and neither does moving `release`; that silence is by design, and it is why step 4 has two pushes and step 5 exists at all. Release checks must compare both public manifests against their respective npm packages; a provider pin now ships in `frizz-server`, not necessarily a new shell. The trap that has actually broken releases at the install step — `pnpm install --frozen-lockfile` disagreeing with a lockfile `nub` wrote — and the full reasoning live in [`plans/runtime-pin-bumps.md`](plans/runtime-pin-bumps.md) § Then the releaser ships it.

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
- **`real-subsystem-harness`** — for behavior no browser can reach: the broker socket, spawn/exec
  paths, migrations, a detached daemon's environment. Real resource, real function, negative control.

# Agents never touch the maintainer's real Chrome

**No agent launches, scripts, attaches to, or reads the profile of the installed Google Chrome — not headless, not on a throwaway profile, not for one screenshot** (maintainer 2026-10-11: *"an agent should not be allowed to drive my real Chrome. Ever"*). Every browser an agent starts is puppeteer's own `chrome-headless-shell` on a temp profile, through `launchHeadless()` in [`scripts/lib/headless-browser.mjs`](scripts/lib/headless-browser.mjs). `scripts/shot.mjs`, every `verify-*` script and every e2e test go through it, and a scratch driver you write imports it too rather than calling `puppeteer.launch`. That file's header has the measurements behind each choice, including why it is the headless shell and not "new" headless: the full Chrome for Testing app made the Dock flicker once per launch, 187 times in 40 minutes.

- **Why the binary matters even on an empty profile.** The signed Google Chrome is the one program macOS lets read the "Chrome Safe Storage" keychain item without asking. That binary pointed at a COPY of the real profile, with a debugging pipe attached or `--dump-dom`, is the maintainer's logged-in sessions. Nothing else on the machine can do that silently, so the rule is about the binary, not about which profile it is given.
- **What it rules out, by name.** `"/Applications/Google Chrome.app/…"` in any command; `executablePath`, `channel: "chrome"` or `CHROME_PATH` in a script; `open -a "Google Chrome"`; `osascript` aimed at Chrome; anything under `~/Library/Application Support/Google/Chrome`; and `chrome-devtools-mcp` run any way but through [`scripts/chrome-devtools-mcp.mjs`](scripts/chrome-devtools-mcp.mjs) — the server's default browser IS the installed Chrome, and its `--autoConnect` / `--browserUrl` attach to the one already running.
- **What enforces it.** `scripts/browser-launch-policy.test.mjs` fails the suite on a launch outside the launcher, a script that names the installed Chrome, or an agent config that bypasses the wrapper. On the maintainer's machine a `PreToolUse` hook (`~/.claude/hooks/no-real-chrome.sh`) refuses the command forms above, and a Chrome managed policy (`RemoteDebuggingAllowed: false`, `HeadlessMode: 2`, delivered as a configuration profile) makes the real browser itself refuse a debugging pipe or a headless start, whoever asks. If one of them stops you, the task does not need the real browser. Do not route around it; ask.
- **`src/browser.ts` is a different thing, not an exception**: the product opening the HUMAN's browser for them (`frizz --app`). It is not automation, and no agent calls it to drive a page.

# Never put a macOS keychain dialog on the maintainer's screen

macOS finds the login keychain through `HOME`. A process that WRITES to it while `HOME` is a temp dir with no keychain, which is what every sandbox here gives its workers, fails with `errSecNoDefaultKeychain` (-25307), and macOS answers with a modal *"Keychain Not Found"* on the maintainer's screen. Two programs have done it, and each has a rule below.

**No live Claude Code runs under a sandbox `HOME`.** Claude Code saves its login to the keychain (`security add-generic-password -a $USER -s "Claude Code-credentials"`) every time it refreshes its OAuth token. Under a sandbox `HOME` that save raises *"A keychain cannot be found to store "colin.""*: the account name, under the `exec` icon of the `security` tool. It fires only when a token is due, so a stack can run clean for an hour and then raise it on the next dispatch. On 2026-10-13 two real Haiku dispatches into a `scripts/adhoc-stack.mjs --creds` stack ran eight failing `security` saves and put the dialog up twice, while the puppeteer browser recording them carried `--use-mock-keychain` and was innocent. The maintainer chose to keep sandboxes keychain-less with no real Claude worker in them, so on macOS `--creds` now leaves Claude's login out of a sandbox `HOME` (the stack's json line says `"claudeLogin": false`) and a Claude dispatch there fails `AUTH_REQUIRED:claude`. Do not route around that by linking or copying `~/.claude` in yourself. A sandbox stack never starts a real Claude worker: not with `dispatch`, not with a follow-up that resumes a thread, and not with a script that wraps either. Simulate the worker instead (`frizz-stack` § Simulating a worker): appended records drive the same tailer, board and render path on a timeline you control. When nothing but a live model can show the behavior, run the stack on the real `HOME` with a throwaway project (`frizz-stack` § A real Claude worker), where the keychain is found.

**Every command that starts a Chromium directly carries `--use-mock-keychain`**: a `--headless` screenshot, `--print-to-pdf`, `--dump-dom`, or a script that builds the command line. Chrome saves its "Chrome Safe Storage" key to the login keychain when it starts, so under a sandbox `HOME` every Chrome start raises *"Keychain Not Found — A keychain cannot be found to store "Chrome.""*. 23 Chrome processes did that in two lightbox e2e runs on 2026-10-03, all started by sandboxed workers obeying a prompt that said to use headless Chrome from the command line (maintainer: *"It's still fucking happening"*).

- `scripts/shot.mjs`, `launchHeadless()`, Puppeteer and the chrome-devtools MCP pass the flag already. The rule is for a raw command line you build around the headless shell (`await puppeteer.executablePath({ headless: "shell" })` is its path; the installed Chrome is never the browser, see the section above), and for every prompt you write that asks a sandboxed worker for a browser: the worker runs whatever command it writes, so put the flag — and the launcher — in the prompt.
- **Never give a sandbox `HOME` an empty keychain to make the dialog stop.** Claude Code reads the keychain before `~/.claude/.credentials.json`, and its next token write into an empty keychain deletes that file. With `~/.claude` linked in, that is the maintainer's real file (`update()` in the secure-storage fallback of Claude Code 2.1.288). `frizz-stack` § A real Claude worker covers sandboxes.
- To name the process after the fact: `/usr/bin/log show --last 1h --style compact --predicate 'eventMessage CONTAINS "MacOS error: -25307" OR (process == "SecurityAgent" AND eventMessage CONTAINS "CHECKEDIN")'`. A -25307 alone is not a dialog, because a keychain READ fails the same way and shows nothing. Each dialog is a `SecurityAgent` check-in, and the -25307 line just before it names the process that asked: a Chrome, or a `security` that Claude Code ran to save its token. (In zsh, a bare `log` is a builtin.)

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

# Layers: one stacking order, in `lib/layers.ts`

Anything drawn over the page — a menu, a popover, a sheet, a modal, a toast — takes its layer from [`packages/web/src/lib/layers.ts`](packages/web/src/lib/layers.ts), whose header states the four rules and the bugs behind each (one audit on 2026-11-01 found seven: a toast under the sign-in modal, the rail through the Settings scrim, Settings under a drawer, Escape on ⌘K closing the drawer beneath it, …). In short: no z-index above 20 anywhere else; a panel hanging off a trigger is portaled (Radix's `Portal`, or `ui/AnchoredLayer`), never `absolute` past its parent's edge; and a full-screen layer is a Radix dialog or `ui/ModalSurface`, because a drawer is a Radix layer and a plain `fixed` div loses Escape, the pointer and the focus to it whatever its z. `layers.guard.test.ts` fails on each of these, and `components/stackingOrder.e2e.test.ts` asks a real browser what is on top. A new layer goes into `layers.ts` beside what it must cover, never as a bigger number at the call site.

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

Agents ran in tmux panes once, and the vocabulary outlived the transport by weeks: a `tmux_name` column, a `FRIZZ_LAUNCH_TMUX_SOCKET` launch variable, hundreds of comments in `router.ts`, `tailer.ts` and `dispatch.ts` narrating a pane, and 53 seed scripts opening a dummy pane nothing read. Every agent that read them eventually told the maintainer that stopping Frizz was safe "because the agents are in tmux" — wrong, and saying the wrong reason cost real trust. **That vocabulary was swept out on 2026-08-19.** The column is `thread_name`, the launch variable is gone, no script execs or installs tmux, and `packages/server/src/tmux.ts` has not existed since 2026-08-02. `grep -rn tmux --include='*.ts' packages/server/src` prints what is left, and none of it runs an agent.

What actually happens: a Claude thread is `claude_runtime="broker"`, and `claude-broker-host.ts` forks a daemon with `detached: true, stdio: "ignore"` into its **own process group**. That single fact is the answer to most operational questions — Ctrl-C on the server signals the launcher's group and cannot reach the daemon, so a running turn survives a stop; its events queue in a 20,000-frame backlog rather than dropping while nothing is attached, and the bridge replays them on reconnect. Sub-agents live inside that daemon's SDK session, so they ride along too.

**So: never tell the operator anything about tmux, and never repeat "the agents are in tmux" as a reason a restart is safe.** It is safe, for a different reason, and saying the wrong one has cost real trust here. Three kinds of tmux reference survive on purpose. `isTmuxServer` in `orphan-reaper.ts` refuses to reap a tmux server process, because upgrading from a pre-cutover Frizz can leave one holding panes an operator is still reading. `storage.ts` and `legacy-project-db.ts` read databases written before the cutover: the `tmux_name` column they rename, and `'tmux'` as a transport value that is recognised and never written. And `qr.ts` asks whether the HUMAN's terminal is inside tmux before it draws a QR code there. Everything else that still says tmux is a dated comment saying it is gone, design history under `plans/` (left as a record, not as guidance), or something the sweep missed; treat the last kind as a bug and prefer `git log -S` over believing it.

# There is NO pty. Everything Frizz runs talks over pipes

Nothing the server ships opens a pseudo-terminal. A Claude thread runs in the session broker, a Codex thread in the app-server, an ACP agent over newline-delimited JSON-RPC — all pipes. Provider sign-in runs nothing at all: the sign-in modal behind `/login` shows `claude auth login` / `codex login` for the human to run in their own terminal, then re-reads the credential. Sign-in was the last pty — an embedded terminal on node-pty and the `/term` socket — until 2026-09-24; node-pty publishes no Linux prebuild, so every Linux and WSL install died at boot on `import "node-pty"` ([#42](https://github.com/colinhacks/frizz/pull/42)). The maintainer then chose the command alone over keeping any hosted sign-in, and `/term` went with it.

**So: never propose a pty, node-pty, or "just run it in a terminal" for anything the server does, and never describe sign-in or an agent as running in one.** If a CLI seems to need a TTY, prove it over pipes first — both provider logins were assumed to need one and neither did. `src/package-contents.test.ts` fails if node-pty comes back as a server dependency, and `scripts/verify-linux-package.mjs` (run it in Docker; its header has the command) boots a packed Frizz on a Linux box with no C++ toolchain.

Two things look like exceptions and are not. node-pty is a ROOT `devDependency` for `scripts/verify-product-e2e.mjs` alone, which drives the launcher's interactive readout and never ships. "PTY" in the Codex code (`codex-app-server.ts`, `transcript.ts`) is Codex's own logical terminal handle inside its app-server, not a Frizz process.

# Board nomenclature: "active" means SPINNING, and nothing else

The sidebar's row groups have names the maintainer uses precisely (2026-08-05: *"when I say active, I'm only referring to the things that are currently spinning; the things beneath that, I would refer to as rested, or just items in the queue"*). Use them in code, comments, copy and when reporting back. (The quote says "beneath" because Rested sat below Active when it was said; on 2026-08-08 the two bands SWAPPED position — the cue moved up under the prompt box — and the vocabulary did not change with them.)

Top to bottom:

- **Rested** — the CUE: the top band, directly under the prompt box; the same set as **"the queue"** / "items in the queue", one row per thread waiting on the human, in the order the pane steps through them, each with a right-justified rest time.
- **Active** — the rows below that rule, in practice the ones currently spinning. Never queued, and never a rest time — the rule is drawn on the QUEUE, so a thread the server excused from the queue while it rests lands here too (see `ARCHITECTURE.md`).
- **Snoozed** — the dimmed, labeled park band (an armed timer, a wall-clock snooze, the resting card's event-snooze, a rest its worker called `status: watching`). A limit pause was a member until 2026-08-31; it queues as a failed thread now. It was called **Held** until 2026-08-26; the group key moved with the label, so `sectionOf` returns `"snoozed"` and nothing reads `"held"` any more.
- **Done** — the collapsed archived section.

The trap is that `groups.ts` `sectionOf` returns `"active"` for Active AND Rested rows alike — that key names the `<section>` holding both bands, not the maintainer's word. `partitionActive` splits it (`.running` = Active, `.rested` = Rested), and `inActiveBand` is the one predicate that means Active exactly. Full detail, including why the archived key is `"inactive"` while its label reads Done, in `ARCHITECTURE.md` § Board nomenclature.

# A thread has three surfaces. A feature asked for on one is a feature of the thread

A thread is drawn in the board's pane, in its drawer and on its full-screen page, and a request names whichever one the maintainer was looking at. Build it for the thread. *"Drag a file anywhere onto a card in the queue"* (2026-10-12) was built on the queue card, the board's surface until the one-thread pane replaced it on 2026-11-09, and nowhere else, and the next day's report was that it did not work in full screen (maintainer 2026-10-13: *"Why is there so much … stuff we accidentally implemented just for the cue card, or just for the sidebar drawer, or just for the full screen view? This shouldn't even be structurally possible"*).

- **Thread behaviour goes in the shell every surface mounts, `packages/web/src/components/ThreadSurface.tsx`**, and a host every page needs goes in `components/PageHosts.tsx`. All three draw `ThreadView` (`ChatView.tsx`), through `ThreadPane.tsx`, `ThreadSheet.tsx` and `StandaloneThreadPage.tsx`, and each of those decides layout and nothing else. The queue card, a second component the board drew until the pane, was deleted on 2026-11-10; a brand-new project's first screen is `FirstTaskView.tsx`, which draws no thread. `ThreadSurface.guard.test.ts` and `PageHosts.guard.test.ts` fail on a second copy; if one fails on your change, move the change, not the test. What a transcript message MEANS is the shell's as well: a surface draws one as `<ThreadMessage m index>` and passes `Message` nothing about questions, answers or fences itself. So are the list a surface draws (`useThreadMessages`), the status rung at its tail (`useRuntimeTail`, `<RuntimeStatusSlot>`), an earlier page (`lib/loadEarlier.ts`) and what a thread has running, watched or saved (`lib/threadOps.ts`). `ARCHITECTURE.md` § A thread's surfaces has the map, including which rows a surface shows and where the furniture between them is built.
- **A difference between surfaces is a decision, written down where it is made**: a comment at the fork, with the reason. An absence nobody explained is a bug, and it is yours to close when you find it in what you are touching.
- **Verify on every surface before you call it done.** On a desktop board every thread opens in the pane; the drawer is a phone's thread page, and what a thread link opens over a status list or a full-screen page. `threadSurfaceFileDrop.e2e.test.ts` drives all three on a real stack and is the shape to copy.

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
which Codex reads directly, with a relative symlink at `~/.claude/skills/<name>` (`../../.agents/…`)
that a SessionStart hook keeps current. `~/.codex/skills` needs no link. A global skill must BUNDLE any script it needs beside its `SKILL.md`; it cannot
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
