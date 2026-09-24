# Worker norms for this repo

## Work independently, see it through

When you're given a task, own it end to end. Make the reasonable calls yourself and drive the work
all the way to completion — don't stop halfway to ask for direction the task already implies, and
don't hand back a plan where a finished change was asked for. Come back to the human only for
genuinely human-owned decisions (product/security posture, destructive or irreversible actions) or a
real blocker.

## Decide and proceed — signal the call, don't stall on it

When the task underspecifies something, your default is to DECIDE, not to ask. A reversible call
costs minutes to redo; a round-trip to the human costs hours — so the bar for stopping is high, and it
clears only when a wrong guess would be both costly and hard to undo.

- **Proceed on any call you can reverse, and on any call you hold with high confidence.** If it's
  derivable from the code, the conventions, or ordinary engineering judgment, it's yours — make it and
  keep moving rather than handing back a question you could have answered.
- **Give the human some indication of the approach you took, as you take it.** When you proceed on a
  judgment call, name the direction you chose (and the notable alternative you passed on) so they can
  course-correct early. A confident call the human can see is fine; a silent one they can't catch is not.
- **Reserve questions for the genuinely human-owned and irreversible** — product or security posture,
  destructive or irreversible actions, external-facing commitments, or a fork where a wrong pick is
  expensive to unwind. Those earn a round-trip; little else does.
- **Account for your decisions in the results summary.** Whenever you report back, explain the calls
  you made along the way — the assumptions, the forks you resolved, the alternatives you rejected — so
  the human reads your reasoning off the summary instead of reverse-engineering it from the diff.
  Tersely, and in the write-up's prose — see below for where each part goes.

## The final write-up: verdict first, then only what the verdict cannot carry

The human reads your last message in a queue, hours later, with none of your context. **The first
line must answer "did it work?" — nothing may precede it.** Not a root cause, not a clever opening,
not a narrative. Open with one of these four tokens, bolded, then the outcome in the same line:

| token | means | sign-off |
| --- | --- | --- |
| **Fixed** | done and landed on local `main` | ` ```done ` |
| **Fixed, except** | landed, but something named is still open | bare rest |
| **Not fixed** | investigated, nothing landed — say what's next | bare rest |
| **Needs you** | blocked on a human-owned call | `mcp__frizz__ask`, then rest normally |

**None of these apply while the instruction still has parts left — then you do not write up at all,
you keep working in the same turn.** This table is for a turn that has genuinely ended; reaching for
it early is the most common way an effort dies half-finished. A verified milestone, a green test run
and a long turn are not endings. Neither is announcing the next step, and neither is writing it into
your scratch directory — notes are optional crash insurance, never a handoff, and writing "next: X"
when the human asked for X is not progress on X. Two rows above describe INCOMPLETE work resting; both mean
"nothing further is possible right now", never "I stopped at a good spot".

The token and the sign-off must agree; the sign-off is the glance-level signal and the token is its
one-line caption. `**Fixed** — the divider now shows the child's description, `749a37b` on `main`.`

**A pending question does not stop a rest, and `mcp__frizz__ask` IS the sign-off.** Register the question, write the `**Needs you**` handoff, and come to rest normally. Frizz draws every open question at the rest it was asked, whether the write-up mentions it or not — the card draws itself, so the handoff carries the reasoning around the ask, never a copy of it (prose that restates a registered question draws nothing, and the free-form ` ```question ` fence is retired — a fence with a question in its body is plain prose, not a card and not a sign-off). To place a registered question inside the prose, write an EMPTY fence naming its id — ` ```question qst_ab12cd34 ` on one line, ` ``` ` on the next; one marker per question, and a question with no marker renders at the tail of the rest. `unask` the ones that no longer matter.

**`**Fixed**` is for work that LANDED, not for work you concluded.** An investigation whose output is a recommendation — merge this, decline that, post this comment, pick one of these two — is `**Needs you**`, because the act it recommends is still ahead of it and a ` ```done ` card files the recommendation away unread. Same for a draft you wrote but did not send, and for follow-up work you discovered: DO it first — dispatch a sub-agent, whose result comes back to you, so it lands on your card — and ASK second. `mcp__frizz__spawn_thread` is the LAST resort, for an effort that genuinely cannot ride on your card, because a spawned thread reports only to the maintainer and nothing it learns returns to you or its siblings.

Then, in this order and nothing else: **what the human must do** (a restart, a re-pull, a follow-up
they own), the **judgment calls** worth catching, and what you deliberately did NOT do. Root cause,
measurements and evidence tables earn their place only when they change what the human does next —
otherwise they belong in your scratch directory, which is where the durable account lives. A screenshot is
evidence, not narration: embed the decisive one or two, not the set.

**The prose and the fenced card must not repeat each other.** They are two surfaces, not one message
written twice. The CARD is the ledger — one bullet per deliverable, what shipped and where, linked,
nothing else. The PROSE is only what a ledger cannot hold: reasoning, caveats, the thing they have to
do. If a sentence would read the same in either, it belongs in exactly one of them.

**And nothing in a finished handoff points vaguely forward.** "One thing to carry forward…", "a follow-up could…", "someone should add a changelog line before this ships" — a forward-reference parked in a dismissal card is clutter: too weak for anyone to act on, too present to ignore, and archived unread. Every such thought resolves four ways and there is no fifth — do it (a sub-agent reports back to you), ask about it with `mcp__frizz__ask`, spawn it onto its own card as a last resort, or DROP it. What is not worth a card is not worth a sentence. A thing the maintainer must do NOW is not a dangling idea; that is the handoff, and it has its own slot above.

(Written 2026-07-31 after a handoff opened on root cause and buried the verdict under a differential
table, two screenshots and a decision list — every fact was present and the maintainer still had to
ask "is this fixed or not?", then: "avoid redundancy with your plain text breakdown and your done
card.")

## Verify end-to-end — test the whole, not the parts

Every change you land needs to be VERIFIED, and the verification has to be proportionate to the change.
The question is always the same one: what would actually make me confident this works? Answer it
honestly, do that thing, and say in the handoff what you did.

**Scale it.** A feature, a new surface, a seam between processes, anything whose runtime behavior you
cannot predict from the code — exercise the real thing in the real runtime and observe the real outcome;
nothing else counts. A small, well-understood fix in code you have read, pinned by a test at the level
the bug actually lives at, is DONE when that test is green and you have re-read the diff. Do not spend a
maintainer's hour booting a stack to re-confirm something you already know; do not skip the stack because
booting it is tedious. The failure mode runs in both directions and only judgment tells them apart.

- **Testing the real thing is the PRIMARY confidence mechanism — adversarial review is a supplement,
  never a substitute, and never a reason to reach for a reviewer instead of a test.** If a change CAN
  be exercised end-to-end, do THAT first; do not dispatch a self-review or a fresh-context reviewer as
  a headline step in place of actually running it. A review only reasons about the code; a test
  observes the runtime — and the runtime is the authority. When you catch yourself spinning up an
  adversarial review of something you could instead just run, STOP and run it. Reserve review for what
  you genuinely cannot execute yet (e.g. an unbuilt design), and even then treat its findings as
  hypotheses to VERIFY by testing — not as verification. A reviewed plan is not a tested change.
- Testing the pieces in isolation is NOT end-to-end, and when the change SPANS pieces that distinction
  is the whole ballgame. A passing unit test, a mock, a typecheck, or a hand-driven PROXY (e.g. invoking
  a CLI yourself with the flags the server *would* have passed, and concluding the server-spawned path
  works) proves the parts — not the whole. The seam between the parts is exactly where the bug lives. If
  a feature spawns/injects/renders something, drive the REAL spawned/injected/rendered thing and confirm
  the observable result: the tool actually shows up in a real worker's registry and is callable; the page
  actually renders in a real browser; the request actually succeeds against a real server. "I verified
  the components" is how a broken feature ships. (A fix that lives INSIDE one piece — a projection, a
  parser, a predicate — is a different case: a test at that level is the right level, not a stand-in.)
- If genuine end-to-end testing is truly infeasible, that does NOT lower the bar — it raises it. Do a
  rigorous ADVERSARIAL self-review: attack your own assumptions, enumerate every way the change could
  fail in the real runtime, and trace the full path yourself end to end. Then dispatch a fresh-context
  reviewer to do the same against your diff.
- Never present an isolated or proxy check as if it were end-to-end. In your handoff, state plainly
  what you actually exercised and what you could NOT, and why. "It should work" is not "it works" —
  do not claim a thing is verified or done when you have only verified a stand-in for it.

## Dial in the visuals yourself — "it renders" is not "it looks right"

For UI work, running the thing is only half the gate. The other half is JUDGING what you rendered, and
it is the half that keeps getting skipped — this section exists because alignment defects have had to be
pointed out repeatedly on work that was otherwise finished and verified.

**Load the `visual-review` skill** the moment you place an icon, glyph, emoji, badge, chip, or counter
beside text, and before you call any new UI correct. It carries the ink-measurement routine, the
per-glyph numbers it produced, and the instrument bug that makes a naive baseline probe report ~3x the
real error. The two rules to internalize:

- **You are the first reviewer of your own screenshot.** Taking the shot is not reviewing the shot. Read
  it back and hunt for what is wrong with it — a glyph riding high or low, one mark visually heavier than
  its neighbours, something colliding or clipping at a narrow width. Capture at a scale where the detail
  is actually judgeable (a 40px component inside a 1400px frame cannot be reviewed). If you would not
  ship it to a design-conscious colleague without a caveat, fix the caveat instead of writing it.
- **Icon-beside-text alignment is an INK problem, and every glyph differs.** `items-center` centers a
  glyph's BOX on the flex line, but the eye aligns ink: a digit has no descender so its ink rides high,
  an SVG's ink sits wherever its path falls inside its viewBox, an emoji ignores your font size. One
  shared nudge therefore cannot fix a cluster — measure each glyph, correct each in `em` so it tracks
  the font size, then re-measure and confirm the residual is ~0. Leave sub-pixel offsets alone.

**And every UI change gets an OPTICAL SPACING PASS before you call it done** — load `optical-spacing`, measure with `scripts/ink-gaps.mjs`, and only then say it looks right. No threshold, no "this is just a one-line row". TWO MARKS ON ONE LINE ARE A ROW: a label and its chevron, a gerund and its clock. A `gap` spaces BOXES and a small glyph is mostly empty box — lucide's chevron paints 4.67 of its 14 box px — so `gap-1`/`gap-2` drew **9.06px and 13.00px** of ink here while the CSS read 4 and 8, and nothing in the source looked wrong (maintainer 2026-08-05: *"Fix the fucking optical spacing on that chevron"*). See AGENTS.md § Every UI change gets an optical spacing pass for the full rule and the instrument's overlap caveat.

And when the pattern already exists in a real product — GitHub, Linear, this app's own components — go
measure the real one and mirror it rather than designing from taste. Reading the real DOM settles in one
call what two rounds of guessing will not.

## Git: land on local `main` — NEVER open a pull request

**This repo does NOT use pull requests. At all. Ever.** This section OVERRIDES frizz's default
worktree/branch/PR discipline in full: wherever the base contract tells you to "open a PR and report
its URL," do the exact opposite — the finished work lands in this machine's local `main`, and it never
touches GitHub as a PR.

**Who this binds: whoever is working in a checkout that can push to `colinhacks/frizz`** — which is every frizz worker, because frizz dispatches you into the maintainer's own machine. Frizz is open source, so an outside contributor working from a fork is the one case this section does not reach: they cannot push here, and a pull request from their fork is the only way to offer a change. That is not you.

- **NEVER open a pull request. NEVER run `gh pr create` (or any equivalent — the GitHub UI, a push
  that opens a PR, anything).** Not for a typo, not for a one-line fix, not for a big feature — there
  is no size threshold and no exception. If you find yourself about to create a PR, STOP: in this repo
  that is always the wrong move. This is the single most-violated rule here — treat any impulse to
  "open a PR for review" as a bug in your own plan and correct it before acting.
- **Don't push a branch to the remote to stage a review either.** The remote plays no part in landing work. Reading GitHub (issues, PRs, CI) is fine; creating or pushing a PR is not. The one push that is not staging a review is a RELEASE: `release` is a fast-forward pointer into `main`, and pushing it selects the commit that ships — a maintainer then dispatches the workflow against it. When asked to cut one, follow `AGENTS.md` § Cutting a release, which is the whole procedure.
- **The default is to work directly on `main` and commit there.** A small, self-contained change needs
  no branch and no worktree — edit, verify, commit on `main`, done.
- **Use a git worktree freely whenever you want isolation** — messy in-progress work, isolated and
  end-to-end testing, spinning up a disposable dev server, anything you'd rather keep off the shared
  tree. Create it on a local branch (`git worktree add <dir> -b <slug>`), do the work and the testing
  there, and commit as you go.
- **A worktree branch is scratch space, not a destination — YOU own landing it.** At the END of the
  development effort, once the work is done and you hold HIGH CONFIDENCE, merge that branch straight
  back into local `main` yourself (`git switch main && git merge <slug>`) and remove the worktree.
  Getting the work onto `main` is your responsibility, not the human's — never leave a branch
  stranded, and never hand back a branch for the human to merge.
- Commit as you go: small, frequent commits at each coherent checkpoint, not one big commit at the
  end. Committed work can't be clobbered.
- Always commit your completed work before you rest. Uncommitted work is unfinished work.
- Each sub-agent commits its own work before returning; don't collect a helper's diff and commit it
  on its behalf.
- **Git hygiene does NOT matter — only landing on `main` does, and a busy/dirty shared tree is never a
  reason to stall.** Many agents (and the human) work against the same `main` in parallel, constantly,
  in the same working tree, so `main` moves under you and the tree is often dirty with someone else's
  in-progress edits. Do not wait it out and do not report it as "blocked": commit whatever is in the
  tree first (`git add -A && git commit -m "wip: snapshot in-flight work"` is fine — committing another
  agent's uncommitted changes to unblock your own merge is EXPECTED here, not a violation), then merge
  your branch in and resolve conflicts favoring a correct build of your change. A messy history, a WIP
  commit mixing several agents' work, an ugly merge — all fine. The ONLY hard rules: never `git stash`
  in the shared tree (it corrupts concurrent agents), and never force-discard someone's COMMITTED work.
  A slightly messy history is fine; lost work is not. Keep merging into `main`.
