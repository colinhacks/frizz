import { useEffect, useRef, useState } from "react"
import {
  RECURRING_PROMPT_MAX,
  DEFAULT_RECURRING_PROMPT,
  type ThreadView,
} from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { INK_TRIM_GOAL } from "../lib/iconRhythm.ts"
import { showToast } from "../store.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"
import { Switch } from "./ui/Switch.tsx"

// THE GOAL MARK — `target-arrow` from Tabler Icons 3.46.0 (MIT, https://tabler.io/icons/icon/target-arrow),
// inlined rather than pulled in as a dependency: it is one glyph out of a 5,900-icon package, and this
// file is the only caller. Tabler draws on the SAME grid as lucide — 24 viewBox, 2px stroke, round caps
// and joins — so it sits in the footer strip as one of the family rather than as a foreign mark.
//
// It replaces lucide's `Target`, which the maintainer read as not-a-target at all (2026-08-13: "Targets
// are supposed to have a filled circle in the middle. Maybe you should find a different icon that has an
// arrow sticking out of it"). They are right about the geometry: lucide's `Target` is three CONCENTRIC
// OUTLINES whose innermost ring is a 2-unit circle drawn with a 2-unit stroke — so at 12px the mark
// collapses into an even weave of rings with a HOLE where the bullseye should be. Tabler's centre is a
// 1-unit circle under the same 2-unit stroke, which paints SOLID at any size, and the dart arrives
// through a gap in both arcs so it reads as having hit the mark rather than sitting beside it.
//
// A HAND-DRAWN VERSION SHIPPED HERE FIRST, for a few hours on 2026-08-13, and the maintainer's reply is
// the note worth keeping: "Are you just generating these icons yourself? This does not look like a good
// icon for a target." It was — one ring, an oversized dot and a bare corner for an arrowhead — and beside
// this one it reads as a record button with a stick through it. Reach for a real icon set (Tabler,
// Phosphor, Remix and Bootstrap were all compared here at 12px) before drawing anything.
function GoalMark({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Tabler's paths, byte-for-byte, minus its `M0 0h24v24H0z` sizing rect (React needs no such
          spacer, and a transparent full-box path would break the ink measurements in iconRhythm.ts).
          The bullseye, the inner arc, the outer arc, the dart's fletching, the dart's shaft. */}
      <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M12 7a5 5 0 1 0 5 5" />
      <path d="M13 3.055a9 9 0 1 0 7.941 7.945" />
      <path d="M15 6v3h3l3 -3h-3v-3l-3 3" />
      <path d="M15 9l-3 3" />
    </svg>
  )
}

// THE GOAL PANEL: one glyph in the thread footer holding what this thread is TRYING TO ACHIEVE, which
// frizz re-sends so the operator does not have to type it again.
//
// It was called "the recurring prompt" until 2026-08-11, which named the MECHANISM rather than the
// content and left the panel describing itself by how it is delivered. What an operator writes here is
// the goal; the switches below it are only WHEN it arrives.
//
// ONE piece of text, and up to three independent reasons to send it:
//
//   STOP HOOK  (scheduler SOURCE 5) — every time the thread comes to REST. No clock, nothing to tune:
//     if it stopped, it is prompted. This is the one that drives an effort forward.
//   HEARTBEAT  (scheduler SOURCE 4) — every N minutes, consulting nothing about what the thread is
//     doing, and DELIVERED MID-TURN. This is the one that reaches a thread that never stops.
//
// NEITHER MECHANISM ON IS THE OFF STATE, and that is why this panel has no third master switch. It used to
// be two separate features with two prompts and two enable toggles; the argument for keeping them apart
// rested on a delivery rule that no longer holds (while a beat waited for rest, a schedule could only
// ever fire AT a rest, where the rest trigger had already fired — same words, same instant). Once
// mid-turn delivery pulled them apart, "nudge this whenever it stops, and at least every N minutes even
// if it doesn't" became one intent costing two prompts to express. Maintainer 2026-08-03, on the master
// switch: "we can delete the top-level toggle since you can now achieve that by just disabling both of
// the other two toggles."
//
// The trigger renders ALWAYS, muted when nothing is armed — a control that only appears once its own
// feature is on cannot be used to turn the feature on. That makes it the one permanent child of the
// footer's left cluster, where everything else is a reading that hides itself when it has nothing to say.
export function RecurringPromptControl({ thread }: { thread: ThreadView }) {
  // THREE STATES, not two: shut, the HOVER PREVIEW, and the full panel. A single boolean cannot hold
  // them, because the preview and the panel are the same anchored surface showing different things and
  // dismissed by different gestures.
  const [mode, setMode] = useState<"closed" | "preview" | "full">("closed")
  const trigger = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const armed = thread.recurringPrompt
  // COLOURED IF ANY MECHANISM IS LIVE. The glyph answers one question — "is frizz going to re-prompt
  // this thread on its own?" — and any one of them is a yes.
  const live = armed?.stopHook === true || armed?.heartbeat === true || armed?.postCompaction === true

  // The preview NEVER interrupts the panel: once it is open, crossing the glyph again must not swap the
  // writing surface out from under the pointer on its way there.
  function openPreview() {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setMode((m) => (m === "closed" ? "preview" : m)), HOVER_DELAY_MS)
  }
  function closePreview() {
    clearTimeout(hoverTimer.current)
    setMode((m) => (m === "preview" ? "closed" : m))
  }
  // THE GLYPH IS NOT "OUTSIDE". Radix dismisses on any pointerdown beyond the content, and with no
  // Trigger element that includes the anchor itself — so a click on an open panel would close it and
  // then be re-opened by the handler below, and the panel would refuse to shut. Letting the click
  // through to the button, and only to the button, keeps one gesture with one meaning.
  const keepAnchorClicks = (e: { detail: { originalEvent: Event }; preventDefault: () => void }) => {
    if (trigger.current?.contains(e.detail.originalEvent.target as Node)) e.preventDefault()
  }

  return (
    // ANCHOR + a plain button, NOT PopoverTrigger. A Trigger owns the open state as a TOGGLE, which is
    // exactly wrong here: with the preview already open, a click would read as "it is open, so close it"
    // and the click that is supposed to reach the panel would shut it instead. Owning the state means
    // the click always means the same thing whatever the pointer did on the way in.
    <Popover
      open={mode !== "closed"}
      // Radix's own dismissals — Escape, a click outside — travel through here whether or not there is
      // a Trigger; they only ever mean "shut", never "step back to the preview".
      onOpenChange={(next) => { if (!next) { clearTimeout(hoverTimer.current); setMode("closed") } }}
    >
      <PopoverAnchor asChild>
        <button
          ref={trigger}
          type="button"
          data-recurring-prompt
          data-recurring-prompt-on={live ? "true" : "false"}
          aria-label={live ? "Goal (on)" : "Goal"}
          aria-haspopup="dialog"
          aria-expanded={mode === "full"}
          onClick={() => { clearTimeout(hoverTimer.current); setMode((m) => (m === "full" ? "closed" : "full")) }}
          // POINTER-typed, so a touch tap does not paint a preview the finger is already covering and
          // then have to unpaint it — a touch device goes straight from the tap to the panel.
          onPointerEnter={(e) => { if (e.pointerType === "mouse") openPreview() }}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") closePreview() }}
          // Keyboard reaches the same reading the pointer does: tab to the glyph and the preview says
          // what is armed, exactly as hovering it would.
          onFocus={() => setMode((m) => (m === "closed" ? "preview" : m))}
          onBlur={closePreview}
          className={`flex items-center rounded-md px-0.5 py-0.5 outline-none ${INK_TRIM_GOAL}`}
        >
          {/* A TARGET WITH AN ARROW IN IT (see GoalMark for the geometry and why it is drawn rather
              than imported), and the ONLY surface that says this exists (the rail deliberately carries
              no mark — see groups.ts).

              The mark has now been five things, and each replacement fixed a real misreading. It was a
              square-in-a-circle (`CircleStop`), which in a strip whose other children are live verbs
              read as a stop button — "it seems like clicking it would cause the entire session to stop"
              (maintainer 2026-08-03). It became a `HeartPulse`, which said the true opposite thing:
              something is keeping this thread beating.

              The heartbeat stopped being true on 2026-08-11, when the panel was renamed GOAL. A
              heartbeat names ONE of the three triggers — and not the important one. What the panel
              holds is the thing the thread is trying to achieve, re-sent on whichever triggers the
              operator picked, so the mark is the goal rather than the delivery mechanism. That put
              lucide's `Target` here — and it did not read as one, because its centre is a HOLE where a
              bullseye should be (maintainer 2026-08-13).

              GREY by default and coloured only while something is actually armed: the footer's left
              cluster is a status strip first, so a control with nothing to report has to read as quiet
              as the empty slot it would otherwise leave. Amber, not the app's accent yellow, so it
              reads as a state rather than the focus motif.

              QUIET, NOT DIMMER THAN ITS NEIGHBOURS. This was `text-muted-45` against the meter's and
              the hourglass's `text-muted-60`, and the left cluster consequently read as three marks
              from three different families (maintainer 2026-08-04: "the icon brightnesses and spacing
              look absolutely terrible"). The cluster is one status group, so it takes one tone — the
              armed/idle distinction is carried by the amber, which is the state worth seeing, and not
              by holding the resting glyph a step below the readouts beside it. */}
          <GoalMark size={12} className={live ? "text-attention-90" : "text-muted-60 hover:text-muted"} />
        </button>
      </PopoverAnchor>
      {mode === "preview" ? (
        <PopoverContent
          side="top"
          align="start"
          data-recurring-preview
          onPointerDownOutside={keepAnchorClicks}
          // INERT. The preview is a reading, not a surface: it must never take the pointer, because the
          // pointer's next move is either back out (which dismisses it) or a click on the glyph under
          // it (which opens the panel). A preview that swallowed either would be a trap.
          // `max-w`, NOT `w` — the panel below is a writing surface and takes a fixed column, but this
          // one is a READING and has to be the size of what it says. A goal of three words in a
          // 22rem-wide box reads as a panel that failed to load the rest of itself.
          className="pointer-events-none max-w-[min(22rem,calc(100vw-1.5rem))] p-2.5 text-[11px] leading-snug text-fg"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <GoalPreview armed={armed} />
        </PopoverContent>
      ) : (
        <PopoverContent
          side="top"
          align="start"
          // WIDE, and it takes the whole viewport when the viewport is small. A 21rem cap made this a
          // narrow column for prose that can run to 4000 characters, and on a phone-width screen it was
          // narrower than the space actually available. The panel is a writing surface, so it is sized
          // like one: ~110 columns where there is room, everything-minus-a-margin where there is not.
          className="w-[min(46rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg"
          onPointerDownOutside={keepAnchorClicks}
          // Radix otherwise autofocuses the first focusable child, which is a toggle segment — and a focus
          // ring sitting on "Off" reads as the toggle being SET to off by the act of opening the panel.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <PromptPanel thread={thread} armed={armed} close={() => setMode("closed")} />
        </PopoverContent>
      )}
    </Popover>
  )
}

// Long enough that dragging the pointer ACROSS the strip on the way to the send button does not flash a
// panel over the footer, short enough that deliberately resting on the glyph answers immediately.
const HOVER_DELAY_MS = 260

// WHAT THE HOVER SAYS. Not the panel in miniature and not the whole prompt — the two questions you ask
// a glyph before deciding to click it: is anything armed, and what is it trying to achieve.
//
// This surface existed once before as a plain tooltip that printed the ENTIRE armed prompt, and it was
// removed on 2026-08-02 ("the hover-based popover is silly") because a 4000-character prompt dumped over
// the footer every time the pointer crossed a 12px glyph is not a reading, it is an ambush. The
// maintainer asked for the hover back on 2026-08-13 — "There should be a hover popover, then I should be
// able to click on it to see the full popover" — so it returns CLAMPED and bounded, which is the part
// that was wrong the first time.
function GoalPreview({ armed }: { armed: ThreadView["recurringPrompt"] }) {
  const text = armed?.prompt?.trim()
  const clauses = armed
    ? triggerClauses({
      stopHook: armed.stopHook === true,
      heartbeat: armed.heartbeat === true,
      postCompaction: armed.postCompaction === true,
      seconds: armed.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    })
    : []
  return (
    <div data-recurring-preview-body>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-medium">Goal</span>
        <span className="text-muted-70">
          {clauses.length > 0 ? `sent ${clauses.join(", ")}` : text ? "no trigger is on" : "not set"}
        </span>
      </div>
      {/* FOUR LINES, then an ellipsis — `line-clamp` rather than a character cut, so the clamp lands on
          whatever the panel's own width actually renders instead of on a guessed column count. */}
      <p className={`line-clamp-4 whitespace-pre-wrap ${text ? "text-fg/90" : "text-muted"}`}>
        {text || "Click to write what this thread is trying to achieve."}
      </p>
    </div>
  )
}

// The schedule is a NUMBER OF MINUTES, typed. It began as a dropdown of round presets and that was
// wrong twice over: it decided for the operator which cadences were reasonable (the whole point of
// making the schedule modifiable was that they know and we do not), and it read the interval back in
// mixed units — "Every 2 hr" for a thing whose every other surface counts minutes. Minutes are the unit
// now, everywhere, and any number in range is allowed. (The unit is SPELLED by the house duration
// grammar — `every 90m`, never `every 90 min`; see web/src/lib/durationLabels.ts.)
//
// The bounds are the schema's, restated here only so the input can enforce them at the point of typing:
// a 1 minute floor (a delivery is read at the agent's next tool boundary, so faster buys no promptness)
// and 24 hours.
const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60
const DEFAULT_INTERVAL_SECONDS = 600

interface Draft {
  text: string
  stopHook: boolean
  heartbeat: boolean
  postCompaction: boolean
  seconds: number
}

/** The cadence a draft actually carries, resolved from the STRING in the minutes field rather than from
 *  the last committed number. The field commits on blur, and the draft is read at instants that do not
 *  blur it — Enter in the textarea saves with the minutes field untouched, and Escape removes the input
 *  from the DOM before any blur fires — so reading the committed value alone silently discarded a cadence
 *  the operator had typed and could plainly see. Measured on the running app (under the 2026-08-11
 *  save-on-dismiss regime, and dismissal saves again now): type 55 over a 25-minute schedule, press
 *  Escape, reopen ⇒ still 25.
 *
 *  Out of range, empty or unparseable falls back to what is already stored, which is what makes this safe
 *  to resolve on every draft rather than only on commit. So does the first clause: a cadence the field can
 *  only ROUND (a worker may arm 90 seconds; the field can only say "2") reads back as the number already
 *  stored, so a dismiss that changed nothing writes nothing. */
export function draftIntervalSeconds(minutes: string, seconds: number): number {
  if (minutes === String(Math.round(seconds / 60))) return seconds
  const parsed = Math.round(Number(minutes))
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed)) * 60
    : seconds
}

// THE DRAFT THE SERVER HAS NOT GOT, held outside the panel because the panel unmounts with it. Two ways
// a draft ends up here: a save the server refused (arm a thread whose session has since been replaced:
// a toast names the refusal, and without this slot there is nothing left to retry from once the panel
// closes), and a dismissal with nothing coherent to write yet — toggles flipped under an empty prompt
// on an unarmed thread, which is a preference worth keeping in front of the operator but no goal to
// arm. The next open of that same thread seeds from this instead of the server's row, so the text is
// back in front of the operator.
//
// ONE entry, not a map: it is a rescue, not a draft store, and a single slot cannot grow without bound.
let rescued: { slug: string; draft: Draft } | null = null

/** A draft in the shape the `sent` mirror keeps it — the same fields, with the text under the name the
 *  server row uses. One converter so a new field cannot be added to the draft and silently forgotten by
 *  the mirror, which is what makes the "nothing changed, send nothing" check trustworthy. */
function draftAsSent(d: Draft) {
  return {
    prompt: d.text.trim(),
    stopHook: d.stopHook,
    heartbeat: d.heartbeat,
    postCompaction: d.postCompaction,
    seconds: d.seconds,
  }
}

/** Does this draft match what the `sent` mirror is holding? ONE comparison worn by both callers — the
 *  save (skip the round-trip when nothing changed) and the unmount (write only a draft the server does
 *  not already hold) — so "unchanged" cannot mean two subtly different things. */
function sameAsSent(next: Draft, sent: ReturnType<typeof draftAsSent>): boolean {
  return (next.text.trim() || null) === (sent.prompt || null)
    && next.stopHook === sent.stopHook
    && next.heartbeat === sent.heartbeat
    && next.postCompaction === sent.postCompaction
    && next.seconds === sent.seconds
}

/** Does this panel open PRE-FILLED with the standard sentence rather than empty?
 *
 *  Only for a thread that has nothing armed, because an armed row's own words are the thing to show.
 *  And never for an ARCHIVED one: the server refuses to arm a shelved thread (router
 *  `assertRecurringPromptArmable`), so a seed there would be an invitation to a Save that can only end
 *  in an error toast.
 *
 *  IT SEEDS THE TEXT AND NOTHING ELSE (2026-08-16). It used to switch the stop hook on with it, so the
 *  dismissal that followed (dismissing was the save gesture then) armed the thread — merely opening the
 *  panel to read it was enough. Maintainer: "When you first click the archery target icon, it should not
 *  automatically arm anything. It could show you the default stop hook prompt". So the sentence is a
 *  PREFILL now: it is there to be accepted with one switch instead of typed, it renders muted until a
 *  trigger is on (nothing is being sent yet), and an untouched open has nothing to save — see `sent` in
 *  PromptPanel, which is seeded from this same text so "nothing changed" is true of a panel nobody
 *  touched.
 *
 *  Extracted and exported so the test beside this file can pin all three branches cheaply. Both are
 *  ALSO driven in a real browser — an archived thread's panel opens empty and its dismissal writes
 *  nothing. Watch the selector when you re-check that: `/thread/<slug>` leaves the BOARD rendered
 *  behind the drawer, and a rested thread's queue card carries its own footer, so an unscoped
 *  `querySelector("[data-recurring-prompt]")` finds the board's heart rather than the drawer's and
 *  reports the wrong thread's panel. Scope to `[role=dialog]`. */
export function seedsDefaults(
  thread: Pick<ThreadView, "archived">,
  armed: ThreadView["recurringPrompt"],
): boolean {
  return !thread.archived && !armed
}

/** What will actually happen, as one clause per ARMED trigger. With three of them a nested ternary can
 *  no longer say what is on — and an operator who misreads which trigger they armed waits for a delivery
 *  that is never coming. Empty when nothing is armed; the callers phrase that case themselves. */
function triggerClauses(d: Pick<Draft, "stopHook" | "heartbeat" | "postCompaction" | "seconds">): string[] {
  return [
    d.stopHook ? "at every rest" : null,
    d.heartbeat ? `every ${Math.round(d.seconds / 60)}m` : null,
    d.postCompaction ? "after every compaction" : null,
  ].filter((c): c is string => c !== null)
}

function PromptPanel({ thread, armed, close }: {
  thread: ThreadView
  armed: ThreadView["recurringPrompt"]
  close: () => void
}) {
  // NO `busy` STATE. Under the old save-on-every-edit regime a busy flag put `disabled` on all four
  // switches for every write, and `disabled:opacity-45` is not transitioned, so each click dropped the
  // whole panel to 45% and snapped it back tens of milliseconds later (maintainer 2026-08-12: "there is
  // a terrible render flash everytimem you check one of these fucking toggles"). The controls are
  // local-only while the panel is open — the write happens on the way out — so there is nothing to
  // guard: overlapping writes queue, and the second sees "unchanged" and skips itself.
  // WHAT AN UNARMED PANEL OPENS WITH: the standard text, and EVERY TRIGGER OFF. The reason an operator
  // opens this control is almost always the same one, so the panel writes that sentence for them — but
  // writing it is all it does. Switching a trigger on is the operator's, and until they do the panel has
  // armed nothing and written nothing (maintainer 2026-08-16 — see `seedsDefaults`).
  //
  // NOT on an archived thread — see `seedsDefaults`, which carries the reason and the test.
  const seedDefaults = seedsDefaults(thread, armed)
  const seededText = seedDefaults ? DEFAULT_RECURRING_PROMPT : ""
  // The panel's own draft. Seeded when this MOUNTS (the popover unmounts its content on close, so that is
  // once per open) rather than tracked live, so a board refresh mid-sentence cannot rewrite what the
  // operator is typing or dictating. From the server row — unless the last dismissal of THIS thread's
  // panel failed to save, in which case that draft is what they were last looking at and the row is not.
  const carried = rescued?.slug === thread.id ? rescued.draft : null
  const [text, setText] = useState(carried?.text ?? armed?.prompt ?? seededText)
  const [stopHook, setStopHook] = useState(carried?.stopHook ?? armed?.stopHook ?? false)
  const [heartbeat, setHeartbeat] = useState(carried?.heartbeat ?? armed?.heartbeat ?? false)
  const [postCompaction, setPostCompaction] = useState(carried?.postCompaction ?? armed?.postCompaction ?? false)
  const [seconds, setSeconds] = useState(carried?.seconds ?? armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  // NOTHING IS BEING SENT while every trigger is off, so the words say so themselves rather than sitting
  // there in full-strength text as if they were live. It is the same reading the glyph gives from outside
  // the panel — grey until something is armed — carried onto the surface that holds the words
  // (maintainer 2026-08-16: "It should also appear grayed out if none of the toggles are toggled on").
  const anyTrigger = stopHook || heartbeat || postCompaction
  // The minutes field is a STRING while it is being typed, so a half-typed value ("", "1" on the way to
  // "120") is not immediately clamped out from under the caret. It becomes a number on commit.
  const [minutes, setMinutes] = useState(String(Math.round((carried?.seconds ?? armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) / 60)))
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What the server row is holding (as far as this panel knows), so a save can skip the round-trip when
  // nothing actually changed, and the unmount can tell a draft worth writing from one already stored.
  //
  // SEEDED FROM THE PREFILL, not from the server row, and that inversion IS how "opening the panel arms
  // nothing" is implemented. Until 2026-08-16 this held the row's empty prompt while the draft above held
  // the default sentence, so the panel opened already differing from storage and the dismissal (the save
  // gesture then, and again now) wrote it — which is precisely the auto-arming the maintainer asked to
  // stop. Seeding both from one expression makes an untouched open compute "unchanged" with nothing to
  // save, which is what keeps the dismissal-save from arming a thread whose panel was only ever LOOKED at.
  const sent = useRef({
    prompt: armed?.prompt ?? seededText,
    stopHook: armed?.stopHook ?? false,
    heartbeat: armed?.heartbeat ?? false,
    postCompaction: armed?.postCompaction ?? false,
    seconds: armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  })

  /** THE WHOLE PANEL AS ONE VALUE, which is what every save sends. The cadence comes from the minutes
   *  FIELD (see `draftIntervalSeconds`), so a number typed and never blurred travels with everything else
   *  instead of being dropped by whichever dismissal did not happen to blur it. */
  const draft = (over?: Partial<Draft>): Draft => ({
    text,
    stopHook,
    heartbeat,
    postCompaction,
    seconds: draftIntervalSeconds(minutes, seconds),
    ...over,
  })

  // THE DISMISSAL IS THE SAVE (2026-09-02). This panel's writer has now moved three times, and the
  // regimes are worth telling apart because the middle one is still quoted in old comments. 2026-08-11:
  // dismissal saved, but every switch ALSO wrote itself on its own click — and that per-click half is
  // what the maintainer asked to stop on 2026-08-31 (checking "Stop hook" on a rested thread armed it
  // mid-configuration and the scheduler bumped the thread before the other toggles could be reached),
  // which shipped as an explicit Save button. 2026-09-02 dropped the button ("just have it so that when
  // you click out of the popover, that's when it saves"): the whole panel is a draft while it is open —
  // nothing arms mid-configuration, which is what the button was actually for — and leaving it any way
  // at all (click out, Escape, the trigger again) commits the draft in one write. Enter in the textarea
  // is the same write a close is, just explicit, and it holds the panel open on a refusal.
  //
  // A refused write must not DESTROY: persistNow stashes the draft in the `rescued` slot, so the text
  // is back in front of the operator on the next open. A draft with nothing coherent to write yet —
  // toggles flipped under an empty prompt on an unarmed thread — is stashed the same way rather than
  // sent, because there is no goal to arm until words exist. A clean unmount clears the slot, so a
  // reopen never resurrects a draft the server is already holding.
  const latest = useRef<Draft>(draft())
  latest.current = draft()
  useEffect(() => () => {
    const d = latest.current
    if (sameAsSent(d, sent.current)) {
      if (rescued?.slug === thread.id) rescued = null
      return
    }
    if (d.text.trim() === "" && !armed) {
      rescued = { slug: thread.id, draft: d }
      return
    }
    void persistNow(d)
  }, [])

  // Writes go ONE AT A TIME. Enter and the dismissal can both fire for one gesture (Enter saves, the
  // panel closes, the unmount saves again), so writes are serialised — the second computes "unchanged"
  // once the first lands and skips itself.
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  function persistNow(next: Draft): Promise<boolean> {
    const run = queue.current.catch(() => false).then(async () => {
      const ok = await persistDraft(next)
      // The rescue slot holds one fact: this thread has a draft the server has NOT got. A refusal puts it
      // there; anything that leaves the row matching — a landed write, or a draft that already matched —
      // takes it back out, so a reopen never resurrects text the server is already holding.
      if (ok) { if (rescued?.slug === thread.id) rescued = null }
      else rescued = { slug: thread.id, draft: next }
      return ok
    })
    queue.current = run
    return run
  }

  /** Resolves TRUE when the server row matches this draft — either it already did, or the write landed.
   *  FALSE only on a failed write: the toast names the refusal, and the rescue slot holds the draft —
   *  which is all a dismissal-save can leave behind, and what an Enter-save (which keeps the panel
   *  open on failure) retries from. */
  async function persistDraft(next: Draft): Promise<boolean> {
    const prompt = next.text.trim() || null
    if (sameAsSent(next, sent.current)) return true
    try {
      await rpc.setThreadRecurringPrompt({
        slug: thread.id,
        sessionId: thread.sessionId ?? "",
        prompt,
        stopHook: next.stopHook,
        heartbeat: next.heartbeat,
        postCompaction: next.postCompaction,
        // ALWAYS sent alongside a prompt, even while the schedule trigger is OFF. Gating this on
        // `heartbeat` looked right and silently destroyed data: switching the schedule off sent no
        // cadence, storage cleared the column, and reopening the panel showed the 10-minute default —
        // so an operator who parked a 30-minute schedule got 10 back when they switched it on again,
        // with nothing to indicate their number had been discarded. Caught in the browser, not by a
        // test: every unit here asserted on rows that still had a cadence.
        ...(prompt === null ? {} : { intervalSeconds: next.seconds }),
      })
      sent.current = { ...draftAsSent(next), prompt: prompt ?? "" }
      // The toast names WHAT WILL HAPPEN, not which switch moved. "On"/"off" was legible when there was
      // one toggle per feature and is ambiguous the moment two triggers share a row.
      const clauses = triggerClauses(next)
      showToast(
        prompt === null ? "Goal cleared"
          : clauses.length === 0 ? "Goal saved — no trigger is on, so nothing is sent"
          : `Goal: sent ${clauses.join(", ")}`,
      )
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not save the recurring prompt").slice(0, 100))
      return false
    }
    return true
  }
  // THE ENTER SAVE. The same write the dismissal makes, made explicitly: persist the whole draft, and
  // leave — a landed save is a finished gesture, so the panel closes on it (through the sameAsSent
  // check, so the unmount does not write it twice). A refused one keeps the panel open with everything
  // still in place to retry, which is the one thing Enter buys over just clicking out. A draft with
  // nothing coherent to write — no trimmed prompt, and no armed row to clear by saving the emptied
  // text — only closes; the unmount stashes it.
  function save(): void {
    if (sameAsSent(draft(), sent.current) || (text.trim() === "" && !armed)) { close(); return }
    void persistNow(draft()).then((ok) => { if (ok) close() })
  }
  // Clamp on COMMIT, not on keystroke. An out-of-range or empty field snaps back to something legal and
  // the field is rewritten to match, so what the operator sees is always what the draft carries.
  function commitMinutes(): void {
    const next = draftIntervalSeconds(minutes, seconds)
    setMinutes(String(Math.round(next / 60)))
    setSeconds(next)
  }
  // The far end of the header belongs to the reading, not to a control. Each trigger keeps its own clock,
  // so this names WHICH one last fired rather than implying they share a stamp — and only while exactly
  // one has ever fired, because "last sent at rest" over a row where the schedule fired more recently
  // would be a lie. With more than one stamp it reports the newest instant unqualified.
  const stamps = [
    { at: armed?.lastRestFiredAt, how: "at rest" },
    { at: armed?.lastScheduleFiredAt, how: "on schedule" },
    { at: armed?.lastCompactFiredAt, how: "after a compaction" },
  ].filter((s): s is { at: string; how: string } => s.at !== undefined)
  const newest = stamps.reduce<{ at: string; how: string } | undefined>(
    (best, s) => (best && Date.parse(best.at) >= Date.parse(s.at) ? best : s),
    undefined,
  )
  const lastLabel = newest === undefined ? null
    : stamps.length > 1 ? `Last sent ${formatAgo(newest.at)}`
    : `Last sent ${newest.how} ${formatAgo(newest.at)}`

  return (
    <section data-recurring-panel>
      <div className="mb-2 flex items-center gap-3">
        <span className="font-medium">Goal</span>
        {lastLabel && <span className="ml-auto truncate text-muted-55">{lastLabel}</span>}
      </div>
      {/* ALWAYS EDITABLE. It used to be `readOnly` until a master toggle was on, which made sense while
          that toggle was the feature's on switch. With the switch gone, gating the textarea on "some
          trigger is on" would mean an operator has to decide WHEN to send a prompt before they are
          allowed to write it — backwards. Write first, then pick the triggers. */}
      <textarea
        ref={textarea}
        data-recurring-text
        value={text}
        maxLength={RECURRING_PROMPT_MAX}
        onChange={(e) => setText(e.target.value)}
        // Enter (or ⌘/Ctrl-Enter) saves; Shift/Option-Enter make a newline — the three Enter keys
        // every box shares (2026-08-26). Same write a dismissal makes, made explicitly: same close on
        // success, and the panel stays open to retry on a refusal.
        onKeyDown={(e) => {
          if (shouldSubmitStagedEnter({
            key: e.key,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.nativeEvent.keyCode,
          })) {
            e.preventDefault()
            save()
          }
        }}
        placeholder="What is this thread trying to achieve?"
        // `field-sizing: content` — the browser sizes the box from what is in it. It replaced a flat
        // `rows={4}`, which made a prompt that can run to 4000 chars a four-line peephole you scrolled
        // your own writing through. `min-h`/`max-h` are the only bounds it needs.
        //
        // Deliberately NOT a JS auto-grow (maintainer 2026-08-02: "this should be a browser-native
        // style, you shouldn't need to write JavaScript auto-grow logic"). The measure-and-set version
        // is also the one that broke: driven from an effect it ran with a null ref, because the panel
        // mounts behind a Radix portal a render later, and never ran again. Chromium ≥123.
        // GREY WHILE NOTHING IS ARMED (see `anyTrigger`). Not `disabled` and not `readOnly` — the words
        // stay fully editable, because writing them is what you do BEFORE picking a trigger. The tone is
        // the only thing that changes, and it says the same thing the glyph says from outside: these words
        // are parked, not live.
        className={`field-sizing-content max-h-[28vh] min-h-[4rem] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-snug outline-none placeholder:text-muted-50 focus:border-border-strong ${anyTrigger ? "text-fg" : "text-muted"}`}
      />
      {/* THE THREE MECHANISMS, one per line under the text they all send. They are NAMED — Stop hook,
          Heartbeat, Compaction — rather than described, because those are the names everything else in
          frizz uses for them: the scheduler's passes, the delivery fence prefixes, the trailer on every
          delivered message, and the divider the chat renders. A panel that called them anything else
          would be the only surface with its own vocabulary.

          A THREE-COLUMN GRID (switch · name · gloss), not a flex row. Several mechanisms on one line was
          unreadable — the eye grouped "…it stops [Off|On] every 30 min" and the first control read as a
          separator between the two phrases rather than the end of the first. Stacked, each row says what
          it is and when it fires.

          THE SWITCH LEADS THE ROW, where it used to sit between the name and the gloss. Two reasons, and
          the second is the one that shows: a column of switches down the left edge is the shape every
          settings list has, so it scans as one list of booleans rather than three sentences with a
          control wedged into each; and the name column no longer has to be `auto`-sized against the
          longest label, so adding a row can never shove the controls sideways (which is precisely the
          hazard the Compaction row's comment below had to be written about).

          `items-baseline`, NOT `items-center` — the switch places itself on the text's CAP BAND and needs
          a shared baseline to do it (see ui/Switch.tsx). Centring the boxes instead read 1.45px low in
          the mono font while measuring clean in sans, which is the whole reason the correction is
          computed from `cap` rather than fitted. */}
      <div className="mt-3 grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2.5 gap-y-2">
        <Switch
          testId="stop-hook"
          label="Stop hook"
          checked={stopHook}
          onChange={(next) => {
            setStopHook(next)
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${stopHook ? "text-fg" : "text-muted"}`}>Stop hook</span>
        {/* THE EXCEPTION CLAUSE IS THE TRIGGER'S ACTUAL CONTRACT, not decoration — and it is exactly two
            fences wide now. A rest that signed off with ```done is never bumped, and neither is one parked
            on an ```awaiting naming a wait the scheduler itself owns — a `prs:` PR, a `timers:` row, a
            `shells:` background shell (the plural YAML keys of 2026-08-24; the `pr-watch:`/`timer:`/`human:`
            this clause was written against are all retired). scheduler.ts `restMessageIsSignedOff` in fact
            takes ANY ```awaiting fence, honoured or not, so the caption says "parked on a wait" and names
            no kind. Both ARE the answer to the question the
            stop hook asks.

            A ```question fence USED to be a third exception and no longer is (2026-08-16): the bump fires
            over an unanswered question, and the delivery tells the worker to decide it. So the clause no
            longer says "or is waiting on you" — that promised a hold this trigger stopped honouring, and
            this panel must not be the one surface describing a delivery the scheduler does not make. */}
        <span className="text-muted">every rest — unless it signed off or parked on a wait</span>

        <Switch
          testId="heartbeat"
          label="Heartbeat"
          checked={heartbeat}
          onChange={(next) => {
            setHeartbeat(next)
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${heartbeat ? "text-fg" : "text-muted"}`}>Heartbeat</span>
        {/* THE CADENCE IS CONDITIONAL: the field exists only while the heartbeat is on, because a number
            you cannot act on is a number you have to ignore. The gloss it leaves behind is not decoration
            — without it the row collapses to a name and a switch, the two rows stop being the same shape,
            and the panel jumps every time this is toggled. Same reason the wording stays parallel:
            "every … min, even mid-turn" and "on a clock, even mid-turn" are the same sentence with the
            number removed. */}
        {heartbeat ? (
          <span className="flex items-center gap-1.5 text-muted">
            every
            {/* Sized to its content (4ch fits 1440) with tabular digits, so the box does not twitch as
                the number changes. */}
            <input
              type="number"
              data-recurring-minutes
              inputMode="numeric"
              min={MIN_MINUTES}
              max={MAX_MINUTES}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitMinutes() } }}
              aria-label="Heartbeat interval in minutes"
              className="w-[4.5ch] rounded-md border border-border bg-bg px-1 py-[3px] text-center text-[11px] leading-none tabular-nums text-fg outline-none focus:border-border-strong disabled:opacity-45 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            min, even mid-turn
          </span>
        ) : (
          <span className="text-muted">on a clock, even mid-turn</span>
        )}

        {/* POST-COMPACTION (scheduler SOURCE 7). Named for the event rather than the mechanism, unlike
            its two neighbours, because "compaction" IS the name everything uses for it — there is no
            frizz-coined term to be consistent with. It sits last because it is the only one that fires on
            something the harness does rather than on something the thread or the clock does.

            ONE WORD, not "After compaction". It was measured rather than chosen when the name column led
            the row and sized every switch with it ("After compaction" measured 91.61px of ink in a 93px
            column at 11px/500, dragging both existing switches ~38px right for a preposition the gloss
            already supplies). The switch column leads now, so the measurement no longer binds — but the
            bare noun is still the right label, because it sits with its siblings as one list of names
            (Stop hook · Heartbeat · Compaction) rather than one name and two phrases.

            The gloss carries the INSTRUCTION, not just the timing, because this trigger is useless
            without it: the prompt has to name a doc for the emptied window to be re-grounded ON. */}
        <Switch
          testId="post-compaction"
          label="Compaction"
          checked={postCompaction}
          onChange={(next) => {
            setPostCompaction(next)
            if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
        <span className={`font-medium ${postCompaction ? "text-fg" : "text-muted"}`}>Compaction</span>
        <span className="text-muted">when the context is summarized away — link the doc to re-read</span>

        {/* THERE IS NO FOURTH ROW. An "Autonomous mode" switch sat here under a rule — the inverted face of
            a `pause_on_questions` column that held every trigger while the thread was waiting on the human
            — and it is deleted rather than re-defaulted. Arming a Goal is now the whole of that consent
            (maintainer 2026-08-16: "the stop hook should just fire even when there are open questions,
            unconditionally, and we could just drop the AutonomousMode toggle… If somebody enables the stop
            hook goal, then that kind of implies to me that they don't really want to answer any more
            questions"). A bump that crosses an unanswered question is worded for it — see the shared
            `restPromptMessage` — and the ```done and ```awaiting carve-outs are untouched, because those
            are about the fence answering the trigger rather than about who is waiting on whom. */}
      </div>
      {/* NO SAVE BUTTON, and no explainer paragraph either (2026-08-12: "drop this") — the switches say
          what they do, the toast says what was saved, and the dismissal is the save gesture (see the
          regime history on `latest` above; a button lived here 2026-08-31 → 2026-09-02). */}
    </section>
  )
}
