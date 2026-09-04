# React render performance — 2026-09-04, measured

Written after the queue-card jitter fix (`b90997c8`) prompted "you need to deeply investigate all React rendering performance issues like this". It is a record at a point in time, not a description of how Frizz works now; read [`plans/README.md`](README.md) first. Its companion is [`plans/performance-2026-09.md`](performance-2026-09.md), which covers the SERVER, the bundle and first load; this one covers only what happens in the browser after the app is up.

Every number here came from an instrument. The one thing this document most wants to prevent is the next reader re-deriving the plausible wrong version of the headline, so the disproved readings are kept beside the ones that survived.

## The headline: the once-a-second stall is a DEV-SERVER ARTIFACT

A board of 600 threads (571 archived, 29 queued — the shape of the maintainer's real board) with four agents writing to their JSONL once a second, so the server pushes a board delta about once a second. Same sandbox HOME, same board, same churn, same instrument, same page, one variable: which build is behind the URL.

| build | DOM mutations / 12s | mutation batches | long tasks | long-task ms | worst |
| --- | --- | --- | --- | --- | --- |
| Vite dev | 554 | 82 | 11 | 713 | 71ms |
| production (`startServer({dev:false})` over a `vite build`) | 598 | 83 | **0** | **0** | **0** |

The mutation counts are the liveness control: both pages are receiving and applying the same deltas, so the production reading is not a dead page. Production held 721 animation frames in 12s with **none** over 32ms.

**The maintainer's Frizz is a production build** — the global `frizz` CLI resolves into `~/.frizz/builds/<hash>/runtime/…`, a promoted artifact. So the ~80ms task that fires once a second is something an agent sees on `nub run dev` and the operator never sees at all. Every dev-build render cost in this document is inflated by `jsxDEV`, per-commit prop diffing (`addObjectDiffToProperties`), owner stacks (`createTask`) and `logComponentRender`, which together were 34% of busy time in a CPU profile and are absent from the shipped bundle.

Repeated in every heavy state that could be constructed, all on the production build, all with the board churning:

| state | long tasks / 12s | frames > 32ms | mutation batches |
| --- | --- | --- | --- |
| queue, 29 cards | 0 | 0 / 721 | 83 |
| thread drawer open over the live board | 0 | 1 / 721 | 77 |
| `/thread/<slug>/full`, a 400-tool-call transcript | 0 | 0 / 721 | 1 |

## What IS true, and is build-independent: the render COUNT

Measured with the repo's own `?scan=1` instrument ([`packages/web/src/perf-scan.ts`](../packages/web/src/perf-scan.ts) → `window.__frizzScan`), 10s windows, no StrictMode (`main.tsx` disables it, so nothing is doubled):

- **Four churning agents: 24,141 component renders in 10s — 2,414/s.**
- The same board with nothing churning: 4,230 in 10s. So ~83% of the render work is the board delta.
- `TodosView` itself renders ~2/s quiet and ~1.2/s under churn; `QueueCard` 11 and 93 respectively.
- **One `QueueCard` re-render costs roughly 300 component renders.** 4,230 renders followed 11 card renders on the quiet board; 24,141 followed 93 under churn.

The 300 is the number worth remembering. It is not the card's own markup — it is the Radix scaffolding around its controls. Per 10s under churn: `Tooltip` 1,250, `Presence` 1,369, `Popper`/`PopperProvider`/`PopperAnchor`/`Primitive.div` 997 each, `Primitive.button` 904, `TooltipTrigger`/`TooltipPortal` 625 each, then `Menu`, `Dialog`, `DropdownMenu` and their providers. A card carries a header action strip, a footer, a composer with two selector pills and a "Mark as done" button, and every one of those is a Radix trigger dragging a provider, an anchor, a portal and a `Presence` behind it.

**Nothing was done about this, on purpose.** In production those 2,414 renders per second do not cost a frame. Memoizing the card's chrome would be a large diff across many components, justified by a number that only exists on the dev server.

## The jitter fix's stated mechanism was wrong, and the corrected one is on the wire

`b90997c8` said the queue card's 276px mid-fade collapse came from the optimistic bubble becoming "the human's most recent turn". It cannot have: [`lastHumanTurnIndex`](../packages/web/src/lib/messagePresentation.ts) skips `m.queued`, and has since `9f570461`, an ancestor of the fix.

Logged websocket frames beside the card's height, against a real dispatched worker, on the pre-fix code:

```
t+27ms   477 -> 535   the optimistic bubble is appended
t+159ms               a /ws transcript push arrives, 9 messages where the card held 8
t+170ms  535 -> 439   the window re-cuts; the history goes behind "Load earlier messages"
t+341ms  unmount
```

The re-cut is the worker's own echo of the injected message — the LANDED, un-`queued` user record — arriving over the socket seconds before the board drops the card. The control: a SIMULATED worker never echoes, and reproduces the +58 and never the collapse. The fix works either way, but the difference is not cosmetic: the bubble is ours to withhold and the push is not, so anything built on the wrong version would aim at the wrong write. Corrected in the comment at [`TodosView.tsx`](../packages/web/src/components/TodosView.tsx).

**There is no `threadTranscript` RPC in that window.** The transcript is PUSHED over `/ws`; an HTTP-response listener sees only `markRead`. That cost one wrong theory here and will cost the next one too.

## Open — the one uncovered instance of the SAME defect, and it is not a performance bug

**A queue card re-cuts its window on a human turn the card did not send.** The transcript freeze is gated on `leaving`, which only `resolve()` sets, which only the card's own controls call. A steer sent from the thread drawer, from `/full`, from a second tab — or frizz's own delivery of a registered-question answer, which [`messagePresentation.ts`](../packages/web/src/lib/messagePresentation.ts) deliberately counts as the human — lands the same push, re-cuts the same window, and the card's departure follows seconds later. Identical visible sequence to the bug that was fixed, reached through a door the fix does not cover.

It is left open because the obvious repair is a PRODUCT change, not a rendering one: make the queue treat "steered from anywhere" as leaving, which [`lib/steering.ts`](../packages/web/src/lib/steering.ts) already records for the rail (`markSteered` runs on every surface's send). That would dismiss the card the instant the steer commits instead of when the board catches up — better, probably, but it is a change to what dismissal MEANS and belongs to whoever owns that decision.

## Measured and dismissed — do not re-investigate these

- **`useNowMs` is not a render source worth touching.** [`lib/liveClock.ts`](../packages/web/src/lib/liveClock.ts) is one page-wide 30s timer, wall-clock-aligned, with subscribers sharing it. Nine components use it and none owns a private interval.
- **`queueCardPropsEqual`'s `JSON.stringify` is not hot.** The `previous.thread === next.thread` check short-circuits it, and valtio's delta application preserves identity for untouched threads, so the stringify only runs on a card whose payload genuinely changed. Two-thirds of the queue bails out on identity alone every push.
- **The list derivations are small.** In a 12s CPU profile of the churning dev board: `groups.ts` 23.7ms total (~2ms/s), `TodosView.tsx` 14.2ms (~1.2ms/s), all of valtio 160.6ms (~13ms/s). A static audit predicted "15,000-25,000 `Date.parse` per second" from the unmemoized `sectionThreads` sort; the profile puts the whole file an order of magnitude below that. The pattern is real, the magnitude was not.
- **`react-scan`'s `unnecessary` column still reads nothing.** `trackUnnecessaryRenders` is inert in 0.5.7 (a module constant nothing assigns), so `judged` is 0 and the avoidable-render question is UNMEASURED, not answered. `perf-scan.ts` already says so; it is repeated here because a dump showing `unnecessary: 0` is the most inviting wrong reading in the whole instrument.
- **A `useBoard()` call cannot legally be moved below an early return.** A static audit proposed that for `CommandPalette`, which subscribes to the board while closed. It would break the rules of hooks. The legal version is splitting the body into a child that only mounts when open, and it buys one component render per board delta.

## The instruments, if this is picked up again

All under `.frizz/threads/c633d7a0-0826-4791-8cc2-ec3c9682f077/` at the time of writing — scratch, not tracked, and reproducible from this description if they are gone.

- `seed-big-board.mjs` — 600 simulated threads at the real archived/queued ratio, with realistic `lastAssistant` lengths (short strings flatter every comparator measurement).
- `churn.mjs` — appends a tool call to N threads on a timer, which is what a real worker does and what makes the server push deltas.
- `probe-renders.mjs` — `?scan=1` render counts + long tasks + frames + layout shifts, per scenario.
- `probe-cpu.mjs` — a CDP V8 profile aggregated by self time and by source file. Do NOT run it with `?scan=1`: react-scan walks the fiber tree on every commit and you measure the instrument.
- `prod-stack.mjs` — the same disposable stack as `scripts/adhoc-stack.mjs` but `dev:false` over a `vite build`. Without this every reading in this area is wrong by the dev overhead.
- `probe-wire.mjs` — websocket frames logged beside an element's height on one clock. This is the one that settled the mechanism above.
