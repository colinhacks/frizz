import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"

test("quiet transcript events use the same regular light-grey scale as activity rows", () => {
  // 14px is the ASSISTANT PROSE size (`.md-body`), which these rows deliberately match — they were a
  // 13px second scale interleaved with the prose, and tone (not size) is what makes them recede.
  assert.equal(TRANSCRIPT_META_LABEL_CLASS, "text-[14px] leading-5 text-muted")

  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  // The quiet event line's own root takes the shared class BARE — no interpolated tail to drift with —
  // and renders its text verbatim as the root's only child.
  assert.match(source, /className=\{TRANSCRIPT_META_LABEL_CLASS\}>\{text\}<\/div>/, "event line must consume the shared metadata-label class and render its text verbatim")
})

test("minimal tool activity is settled history with no live shimmer or spinner indentation", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function MinimalToolActivity[\s\S]*?\n}/)?.[0]
  assert.ok(block, "MinimalToolActivity must exist")
  assert.match(block, /settledToolActivityLabel\(total, editedFileCount\(tools\)\)/, "settled batches render the completed summary, including how many files the run edited")
  assert.match(block, /data-tool-activity-state="settled"/, "every historical disclosure is settled presentation")
  assert.doesNotMatch(block, /shimmer-text/, "the historical disclosure must never own the live shimmer")
  assert.match(block, /className=\{`group flex w-full[^`]*gap-1/, "the disclosure keeps the full row click target and a compact label gap")
  // The focus ring's padding is cancelled in layout, so the digest is the same 20px line as the live
  // Working row it replaces when a run settles — with it counted, the settle moved the transcript 3px.
  assert.match(block, /className=\{`[^`]*-my-0\.5 py-0\.5/, "the disclosure's focus-ring padding must not take layout height")
  // It consumes the shared scale rather than restating one: this row alternates with "Thought for Ns"
  // in a single column, and the two drifted apart while the size was copied here by hand.
  assert.match(block, /\$\{TRANSCRIPT_META_LABEL_CLASS\}/, "the disclosure must consume the shared metadata-label class")
  assert.doesNotMatch(block, /text-\[1[0-9]px\]/, "and must not restate its own type scale")
  assert.match(block, /data-tool-activity-label[\s\S]*className="min-w-0 truncate text-muted"/, "the label shrinks before the adjacent chevron")
  assert.match(block, /data-tool-activity-chevron[^\n]*transcriptMetaChevronClass\(expanded\)/, "the adjacent chevron takes the column's shared, measured treatment")
  assert.doesNotMatch(block, /ml-auto/, "the chevron must stay beside the digest label instead of jumping to the far edge")
  assert.doesNotMatch(block, /frizz-tool-spinner|data-running-indicator|w-2\.5/, "no spinner or reserved mark slot may indent the label")
})

test("the current gerund replaces Thinking in the exact bottom shimmer span", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/export function WorkingIndicator[\s\S]*?\n}/)?.[0]
  assert.ok(block, "WorkingIndicator must exist")
  assert.match(block, /data-working-indicator/, "the runtime tail needs a stable browser-QA target")
  // The generic reading names what the model is DOING with the turn — composing its next move — not
  // that the session is alive, which the reader can already see (maintainer 2026-08-01: "Do you think
  // it makes more sense to change it to 'thinking'?"). It also carries the run's count, so the gap
  // between two calls reads as progress rather than a stall (maintainer 2026-08-08) — the wording lives
  // in lib/toolActivity.thinkingToolActivityLabel, never inline here.
  assert.match(block, /<span className="[^"]*shimmer-text">\{activityLabel \?\? thinkingToolActivityLabel\(total\)\}<\/span>/, "tool activity and the generic reading must use the exact same shimmer element")
  assert.doesNotMatch(block, /"Thinking…"/, "the generic reading's wording belongs to the shared label helper, not a literal in the row")
  assert.doesNotMatch(block, /"Working…"/, "the generic reading is Thinking, not Working")
  assert.equal((block.match(/shimmer-text/g) ?? []).length, 1, "the runtime tail must have one shimmer treatment")
  // ONE LINE, always. The label TRUNCATES rather than wrapping (maintainer 2026-07-31: "prevent the
  // actual gerund from ever breaking onto two lines. It should get truncated instead") — a live status
  // reading that grows taller as a path lengthens makes the whole transcript tail jump.
  assert.match(block, /<span className="min-w-0 truncate shimmer-text"/, "the label truncates to one line")
  assert.doesNotMatch(block, /break-words/, "and never wraps")
  assert.match(block, /\{durationLabel\}/, "the runtime tail still reads its own elapsed time")
  assert.match(block, /<span className="shrink-0 whitespace-nowrap [^"]*">\{durationLabel\}<\/span>/, "the elapsed reading never breaks mid-value or shrinks")
})

test("the live shimmer is the same disclosure as the settled digest, one moment earlier", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const live = source.match(/export function WorkingIndicator[\s\S]*?\n}/)?.[0]
  const settled = source.match(/function MinimalToolActivity[\s\S]*?\n}/)?.[0]
  assert.ok(live && settled, "both disclosures must exist")

  // Clicking the shimmer opens the run it is standing in for — the calls history withholds while the
  // turn runs, rendered through the SAME router the settled digest uses, so the reader sees mid-flight
  // exactly what the digest will show afterwards.
  assert.match(live, /aria-expanded=\{expanded\}/, "the live row is a real disclosure control")
  assert.match(live, /ToolRailRows/, "and opens onto the run's individual tool rows")
  assert.match(live, /data-working-chevron/, "with a chevron marking it as openable")
  // Only when there IS a run: at the opening of a turn nothing has been called yet, and a chevron over
  // an empty panel is a control that does nothing.
  assert.match(live, /\{expandable && \(/, "the chevron appears only when a run exists")

  // ONE treatment for every chevron in the quiet column — the digest, the reasoning toggle and the live
  // row alternate in a single column, so each placing its own offset by hand is how they drifted (two
  // vertical offsets, two tones, and a horizontal rhythm nobody had measured: 9.06px of INK where the
  // CSS said 4px). transcriptMetaChevronClass owns it now, with the readings that set it.
  const reasoning = source.match(/function ReasoningBlock[\s\S]*?\n}/)?.[0]
  assert.ok(reasoning, "ReasoningBlock must exist")
  for (const [name, block] of [["live shimmer", live], ["settled digest", settled], ["reasoning", reasoning]] as const) {
    assert.match(block, /transcriptMetaChevronClass\(/, `the ${name} chevron must consume the shared treatment`)
    // A hand-placed nudge beside it is the drift coming back: the correction belongs in the constant,
    // where the measurement that justifies it lives.
    assert.doesNotMatch(block, /(-)?translate-y-\[|top-\[calc|self-center/, `the ${name} chevron must not re-place itself by hand`)
    // `align-self: baseline` has nothing to align against in an `items-center` row, and lands ~1px off
    // in silence. Every row carrying this chevron aligns on the baseline.
    assert.match(block, /items-baseline/, `the ${name} row must give the chevron a baseline to sit on`)
  }
})

test("the chevron's vertical correction is derived from the font, not fitted to one", () => {
  const source = readFileSync(new URL("../lib/transcriptMetaLabels.ts", import.meta.url), "utf8")
  // The prose font is a SETTING (html[data-font]), so this column ships against two different cap
  // heights. `1cap` is whatever the resolved font's cap height is, which is why the correction survives
  // the flip; a hand-fitted em constant measured under mono rode visibly high under sans.
  assert.match(source, /translate-y-\[calc\(0\.5em_-_0\.5cap\)\]/, "the lift must be 0.5em - 0.5cap, computed per font")
  assert.match(source, /self-baseline/, "…measured from the text baseline the glyph synthesises")
  assert.doesNotMatch(source, /-translate-y-\[0\.\d+em\]/, "no hand-fitted vertical constant may come back")
  // The horizontal trims are pure viewBox geometry (8/24 units of paint across, 14/24 when rotated), so
  // they are font-independent and stay literal — one per orientation, never one shared.
  assert.match(source, /-mx-\[0\.333em\]/, "closed: a third of the box is dead space per side")
  assert.match(source, /-mx-\[0\.208em\]/, "open: the rotated ink is wider, so less of the box is dead")
})

test("codex reasoning toggle is a peer of quiet metadata labels", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function ReasoningBlock[\s\S]*?\n}/)?.[0]
  assert.ok(block, "ReasoningBlock must exist")
  // Same regular light-grey line as "Thought for Ns" — not a bespoke uppercase treatment.
  assert.match(block, /className=\{`\$\{TRANSCRIPT_META_LABEL_CLASS\}[^`]*self-start/, "reasoning toggle must consume the shared metadata-label class")
  assert.doesNotMatch(block, /uppercase|tracking-wide|petite-caps|text-\[\d+px\]|text-muted\/\d/, "reasoning toggle must not reintroduce a bespoke label type/color")
})
