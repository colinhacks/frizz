---
name: gh
description: The gh-CLI playbook for a frizz worker that can reach GitHub (invoke as frizz:gh). Load this whenever your effort touches GitHub — reading or triaging an issue or PR, reviewing a diff, checking CI/release status, or searching issues/PRs — to use `gh` eagerly and correctly, whether plain `gh` is signed in, reads with Frizz's read-only credential while writes go through Keyward (`keyward --reason "…" -- gh …`), or is signed out behind Keyward: the read-vs-write boundary (never comment/label/close/merge unless the human asks), concrete read recipes, Keyward's failure lines and what to do on each, and waiting on CI and reviews with `frizzctl watch-pr add` / `watch-issue add`. The session-seed hook injects a pointer here naming the mode: `⟦gh available, read-only⟧`, `⟦gh available⟧` or `⟦gh available through Keyward⟧`.
version: 0.3.0
metadata:
  internal: true
---

# frizz:gh — the gh-CLI playbook

You are a **frizz worker in a GitHub repo, and `gh` can reach GitHub** — the session-seed hook checked before pointing you here. `gh` is the fastest path to issue / PR / CI / release context — reach for it before guessing, and prefer it over scraping the web UI or reasoning from memory.

This skill is the full playbook the injected block summarizes: **which of three modes you are in**, the **read-vs-write boundary**, concrete **read recipes**, and how to **wait on CI and reviews** until the next actionable event.

## Three modes: read-only, signed in, or through Keyward

The injected block names your mode.

- **`⟦gh available, read-only⟧` — plain `gh` reads with Frizz's own credential.** No Touch ID, and it works while the screen is locked. Run the read recipes below as written. A write, or a read past what the credential holds, fails; that one command then runs as `keyward --reason "…" -- gh …` (see **Reads and writes in read-only mode**).
- **`⟦gh available⟧` — plain `gh` is signed in.** Run the recipes below as written.
- **`⟦gh available through Keyward⟧` — plain `gh` is signed OUT, by design.** Keyward is the human's Secure Enclave vault. It hands `gh` their token in `GH_TOKEN` for one run, and only for that run. Run **every** recipe below with this prefix:

  ```bash
  keyward --reason "<what this command is for, in a sentence>" -- gh issue view 123 -R OWNER/REPO --comments
  ```

  `gh` must be the first word after `--`: Keyward reads only that word, so `keyward -- npx gh …` is not recognised. The reason is shown on the human's Touch ID sheet, so write what they need to recognise the job; a run without `--reason` is refused before anything is asked. Otherwise the exit code is gh's own.

### Reads and writes in read-only mode

The credential is a user token from Frizz's GitHub App, whose permissions are all read-only: issues, pull requests, checks, commit statuses, workflow runs and repo metadata. It can never exceed them, whatever the human can do.

- **A write fails with GitHub's own error**: `Resource not accessible by integration`, HTTP 403. That is this credential doing its job. Once the human has asked for the write, rerun that one command through Keyward.
- **A read can fail the same way, so try Keyward before you conclude anything.** Source through the API (`gh api repos/…/contents/…`) is not covered; read the checkout where you can. A private repo on an account where Frizz's App is not installed reads as `Could not resolve to a Repository` or HTTP 404, exactly as if it did not exist.
- **Don't route reads through Keyward by default.** Each burst costs the human a touch that a plain read does not.
- **Scripts need nothing.** The bundled monitors and any script you run read with plain `gh`. One that writes calls `keyward --reason "…" -- gh …` itself, as this repo's do through `scripts/lib/gh-command.mjs`.

### Working under Keyward

Everything here applies to any command you run through Keyward, in read-only mode too.

- **One Touch ID covers this repository's gh runs for 10 minutes**, ending early when the screen locks or the Mac sleeps. Batch your gh reads into one burst (the issue, its comments, the linked PR, its checks) rather than spreading them across the task, so each burst costs the human one touch.
- **Nothing is released while the screen is locked.** That includes the first run of a burst.
- **Don't check sign-in with `gh auth status`.** It describes plain `gh`, not what Keyward would release. The injected block already tells you which mode you are in; to find out whether a release works, run the command you need.
- **Never run `gh auth token`, with or without Keyward.** Keyward does not read the arguments, so nothing refuses it, and it prints the human's token into your transcript for good.
- **Only `gh` itself is signed in.** `keyward -- node script.mjs` hands the script NOTHING, and there is no form that does. A script that needs GitHub runs `keyward --reason "…" -- gh …` itself each time it calls gh; this repo's own scripts do, through `scripts/lib/gh-command.mjs`, so run those plainly. The bundled `ci-watch.mjs` / `review-watch.mjs` do not, because a poll cannot wait on a Touch ID: where plain `gh` is signed out, use `frizzctl watch-pr` for those waits.

### What a refusal looks like

Each of these is printed on stderr and exits 1:

| stderr | What it means | What to do |
| --- | --- | --- |
| `keyward: not released: screen locked` (also `not at the console`, `screen state unreadable`) | Nobody is at the Mac to approve. | **Stop and report it to the human.** |
| `keyward: not released: declined or authentication failed` | The human said no, or Touch ID failed. | **Stop and report it to the human.** |
| `keyward: no gh sign-in …` | Keyward holds no GitHub sign-in on this Mac. | Stop and report it; the human has to make one. |
| a refusal naming the missing `--reason` | Nothing was asked; a reason is required. | Add `--reason "…"` and run it again. |

**On any stderr line starting `keyward: not released:`, stop and report it to the human. Never retry.** A locked screen does not clear because you asked again, and a decline was the human's answer. Say which command you were trying to run and why, then carry on with whatever does not need GitHub, or come to rest saying what is blocked on it.

## The one hard rule — READ freely, WRITE only when asked

`gh` can mutate the repo, and your token has the scopes to do it. **Do not.** Unless the human **explicitly asks in this session**, you are strictly read-only:

- **NEVER** comment, review, approve, request-changes, label, assign, milestone, edit, close, reopen, merge, or push — no state change of any kind on GitHub.
- Your deliverable is your **final message** (a findings write-up, a review, a recommendation) — NOT a GitHub post. Producing the review in-session is the job; posting it is a separate action the human authorizes.
- If posting would genuinely help, don't just do it — **ask** with a two-option `kind: choice` question in a ` ```question ` fence ("Post this review to the PR" / "Keep it in-session only", the recommended one first), then rest. When the destructive edge is real (a force-merge, a close), that's the same question with `danger: true`.
- When the human HAS asked you to write, do exactly the scoped thing and report the resulting URL — nothing extra.

There is no server-side enforcement of this; the boundary is yours to hold.

## Read recipes

Always scope with `-R OWNER/REPO` so a command is dir-independent, and prefer `--json <fields>` (+ `-q <jq>`) so you pull exactly what you need. The recipes are written as plain `gh`. In `⟦gh available through Keyward⟧` mode, prefix each with `keyward --reason "…" -- `, and run related ones back to back so one Touch ID covers them.

**Issues**
```bash
gh issue view N -R OWNER/REPO --comments                          # full thread, human-readable
gh issue view N -R OWNER/REPO --json title,body,labels,state,url  # structured
gh issue list -R OWNER/REPO --search "sort:updated-desc" --json number,title,url,updatedAt --limit 30
gh issue list -R OWNER/REPO --search "sort:reactions-desc is:open" --json number,title,url --limit 30
```

**PRs + diffs**
```bash
gh pr view N -R OWNER/REPO --json title,body,state,labels,files,additions,deletions,url
gh pr diff N -R OWNER/REPO                # the unified diff
gh pr checks N -R OWNER/REPO              # CI check rollup for the PR
gh pr view N -R OWNER/REPO --comments     # review threads + conversation
```
Read the changed files **in context**, not just the hunks — `gh pr diff` shows what changed, but correctness lives in the surrounding code.

**Reading ONE review (what a `frizzctl watch-pr` wake hands you)**

A wake permalink ending `#pullrequestreview-<id>` is a **review**, and a review's `body` is routinely
**empty** — review apps (pullfrog, coderabbit) and humans doing an inline pass put every word in the
review's *inline comments*. Reading the body and concluding the review is empty is the wrong turn here.
One endpoint answers it in one call:

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews/REVIEW_ID/comments \
  --jq '.[] | "\(.path):\(.line // .original_line // "file")\n\(.body)\n"'
```

Do **not** sweep `…/pulls/N/comments` and filter by `pull_request_review_id` — it pulls the whole PR's
history to find a handful of lines. Add the review's own body only if you need it
(`gh api repos/OWNER/REPO/pulls/N/reviews/REVIEW_ID --jq .body`). A `#issuecomment-<id>` permalink is
the other shape and *does* carry its substance in its body:
`gh api repos/OWNER/REPO/issues/comments/ID --jq .body`.

**`--paginate` is the default for any list endpoint.** `gh api` returns **30** items per page and caps
`per_page` at **100**, silently — a truncated page reads exactly like "that's all there is," so a
missing `--paginate` becomes a wrong answer rather than an error.

**CI / runs / releases**
```bash
gh run list -R OWNER/REPO --branch BRANCH --limit 10
gh run view RUN_ID -R OWNER/REPO --log-failed        # just the failing step logs
gh release view -R OWNER/REPO                         # latest release
```

**Search (across issues/PRs)**
```bash
gh search issues -R OWNER/REPO "crash on startup" --state open --json number,title,url --limit 30
gh search prs --repo OWNER/REPO "author:@me" --json number,title,url --limit 30
```
Use search to find duplicates, related work, and prior art before you conclude something is novel.

**Raw API** for anything the porcelain doesn't cover:
```bash
gh api repos/OWNER/REPO/commits/SHA/check-runs --jq '.check_runs[] | {name, conclusion}'
gh api "repos/OWNER/REPO/issues?state=open&labels=bug&per_page=50" --jq '.[] | {number, title, html_url}'
```

## Keep GitHub automation active

CI, automated review, releases, merge queues, and already-authorized merge progression are work you
can observe; they do not earn a blind `awaiting` fence. Keep a live wait attached to the thread and
continue when it reports.

### Wait on a PR or an issue with `frizzctl watch-pr` / `watch-issue`

This is the way to wait on CI and reviews, in both modes:

```bash
frizzctl watch-pr add OWNER/REPO#NUMBER --for 6h       # your own PR; MONTHS (180d) for someone else's
frizzctl watch-issue add OWNER/REPO#NUMBER --for 30d
```

Frizz's SERVER runs these watches on its own read-only GitHub credential. They need no `gh` sign-in
from you, keep running while the screen is locked and across restarts, and cost no Touch ID. Register
the PR, then rest with it in the fence's `prs:` list (`prs: [OWNER/REPO#NUMBER]`) and the same long
`for:`: Frizz baselines current reviews/comments and wakes you on CI turning green or red and on ANY
new review or comment after registration — bot or human. The registration creates the wait; the fence
only declares it. A GitHub ISSUE — a reporter you asked for a reproduction, a maintainer you asked to
triage — is `frizzctl watch-issue add`, named in the fence's `issues:` list: it wakes you on every later
comment, on a label or assignee change, and when the issue closes. `frizzctl watch-pr --help` has the rest.

If a specific external human reviewer/approver is the only remaining gate, that is a question for the
human (a ` ```question ` fence) — waiting on a person is never a park. The dashboard operator's own
go/no-go remains a registered question. If the next check deliberately belongs at a named wall-clock
instant, set a durable timer with `frizzctl timer set` and park with its id in your fence's `timers:` list.

### Watching inside a turn — only where plain `gh` can read

Sometimes you want the verdict inside the turn you are in, not as a wake after a rest: a CI run you
are about to read the logs of. That takes a session-bound monitor, and it needs a plain `gh` that can
read, which read-only mode has. **In `⟦gh available through Keyward⟧` mode, don't: the monitors and a
`gh run watch` loop cannot authenticate there.** Register `frizzctl watch-pr add` and rest instead.

Before launching any CI/review monitor, inspect project-local `AGENTS.md`, active skills, repository
docs, `package.json` scripts, and declared monitor tooling. Prefer an explicit project-local monitor
only if it documents terminal semantics for this gate. Validate its absolute command and terminal
event/exit contract before launch. If declared tooling is missing, invalid, or has no terminal
semantics, stop and report that configuration error; never silently shadow it with a Frizz script, and
never execute a monitor merely because its filename looks plausible.

When no project monitor is declared, the bundled fallback scripts are
`<this-skill-dir>/scripts/ci-watch.mjs` and `review-watch.mjs`. They are generated byte-for-byte from
Frizz's canonical `monitors/` source and require only Node plus a signed-in plain `gh`. Their stdout is
`frizz.github-monitor/v1` NDJSON: `status` means keep waiting; `terminal` is a verdict. They join
exact-head workflow runs with PR checks, keeping `ACTION_REQUIRED` pending, and baseline every review
and comment so any new one wakes — bot or human, with no actor
filter. A GitHub/auth error is terminal exit 3; SIGINT/SIGTERM produces terminal
`cancelled` and exit 130. A `--once` pending/baseline snapshot is deliberately non-terminal exit 0.
For CI, retries are collapsed only within the same workflow name and event; distinct exact-head events
such as `push` and `pull_request` both contribute to the aggregate verdict.

- One-shot completion: launch `Bash` with `run_in_background: true`, for example
  `gh run watch RUN_ID -R OWNER/REPO --exit-status` or a repo watcher that exits when all PR checks
  settle. The completion task-notification re-invokes you. Diagnose/fix on red; continue the authorized
  release/merge path on green.
- State transitions: use native `Monitor` with a quiet loop that prints only changes or the terminal
  event. It is the Claude adapter for the selected script; do not make a sub-agent the monitor
  abstraction.
  Finite monitors run up to one hour; `persistent: true` runs until `TaskStop` or the Claude session
  ends. Stop a watch once its gate is obsolete.
- A background Bash launch exposes an output-file path. Use `Read` on that path only for diagnostics;
  `TaskOutput` is deprecated. Do not fake waiting with `echo waiting` or sleep-only Bash calls.

Both mechanisms are session-bound: they die with the session, and a rest does not wait on them. A wait
you rest on is `frizzctl watch-pr` / `watch-issue`.

## Fitting gh work into your thread type

- **Investigating an issue** (a research thread): reproduce → trace to `file:line` (cite every load-bearing claim) → recommend the smallest correct fix; read the full thread and linked issues/PRs with `gh` for context. Don't implement — stop at the recommendation. Handback = findings in your final message.
- **Reviewing a PR** (an audit thread): read the diff AND the files in context, verify correctness/edges/tests, check CI (`gh pr checks`), then produce a review (blocking issues vs nits, each citing `file:line`) as your final message. Approve/merge only if explicitly asked.

In both cases: read-only on GitHub unless told otherwise, and the review/findings live in your session, not in a GitHub post.
