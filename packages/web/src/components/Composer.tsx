import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Plus, X } from "lucide-react"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, isAllowedAttachmentName, type ThreadSkill } from "@frizz/shared"
import { showToast } from "../store.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { splitProseByTokens } from "../lib/composerContext.ts"
import { isForcedSendChord, shouldInterruptSubmitComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter } from "../lib/composerKeyboard.ts"
import { queueComposerHandlesOptionEnter } from "../lib/queueComposerKeyboard.ts"
import { composerRail, MIC_GLYPH, PAPERCLIP_GLYPH, PROMPT_BOX_CORNER, PROMPT_FOOTER_ROW, PROMPT_ROW_INSET, PROMPT_ROW_INSET_SINGLE_LINE, RAIL_MARK_SQUARE, SEND_SOLO_WIDTH, SEND_SPLIT_WIDTH } from "../lib/iconRhythm.ts"
import type { SendMode } from "../lib/sendMode.ts"
import { SendSplitButton } from "./SendSplitButton.tsx"
import { useDictation } from "../lib/dictation.ts"
import { prefs } from "../lib/prefs.ts"
import { DictationLevel } from "./DictationLevel.tsx"
import { apiBase, projectApiBase } from "../lib/base-path.ts"
import { useProjectScope } from "../lib/projectScope.tsx"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { basename } from "../lib/paths.ts"
import { useKeyboardInset } from "../lib/keyboardInset.ts"
import { useFileDropZone, type SurfaceFileDrop } from "../lib/fileDrop.ts"
import { AnchoredLayer, aboveAnchor } from "./ui/AnchoredLayer.tsx"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. ⌘/Ctrl-Enter submits
// (2026-08-26); every other Enter — plain, Shift, Option — keeps the browser's native newline, with a
// no-op fallback for Chromium's macOS Option-Enter quirk. Queue retains its separately-owned
// Option-Enter handling. Escape BLURS
// (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag the e2e tests target a surface's textarea by.
// Upload a dropped/pasted/picked file and return its server-side absolute path. The path goes INTO the
// message text: workers open it with their Read/file tool; the chat renders images via /local-image and
// non-image files as an openable chip. The shared extension allowlist (images, docs/text/code, office,
// data and archive formats) is enforced server-side too — the /attach route is the trust gate.
async function uploadAttachment(file: File, name: string, project: string | undefined): Promise<string | null> {
  // The project this upload is FOR, resolved before the file is read rather than after. `apiBase()`
  // answers for whatever the address bar says at the instant it is called, and reading a large file is
  // long enough for the operator to switch projects: the attachment then landed in the state directory
  // of a project the message was never going to, while the message itself went to the thread they
  // started from. Anything read across an await has to be captured on THIS side of it.
  // On the Console the page names no project, so the composer's own scope does (lib/projectScope.tsx).
  const base = project ? projectApiBase(project) : apiBase()
  const buf = await file.arrayBuffer()
  let bin = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const res = await fetch(`${base}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data: btoa(bin) }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { path?: string }
  return json.path ?? null
}

// Where a `/` suggestion came FROM, in this repo's own vocabulary rather than either harness's. Claude
// says `projectSettings`/`userSettings`, codex says `repo`/`user`; the server normalizes both to the
// shared enum and this names them the way the docs and the maintainer do — a skill in the checkout is
// "project", one in the home directory is "global" (see CLAUDE.md § project-local skills). Rendered in
// petite caps: a metadata tag the eye can skip, not more description to read.
const SKILL_SOURCE_LABEL: Record<NonNullable<ThreadSkill["source"]>, string> = {
  project: "project",
  user: "global",
  builtin: "built-in",
  plugin: "plugin",
}

// A staged context reference in the prose is the literal `@guide.md:3` token the ⌘I flow splices in
// at the caret (lib/composerContext.ts) — the chip's own label, so the text reads as the chip. The
// BACKDROP below paints the pill behind each staged token; the token itself is ordinary textarea
// text, which is what lets it sit at ANY position in the prose, wrap with it, and be edited like
// text (the previous chips-in-an-overlay system could only open the first line, which put every
// reference at the box's start regardless of the caret — maintainer 2026-09-02: "the context chip
// still shows up at the beginning of the prompt box instead of where the cursor currently exists";
// a numbered `[^1]` in between read as plumbing — 2026-09-03: "worse than just rendering the chip
// inline").

// THE PHONE LAYOUTS (below the 700px breakpoint; the caller decides, with useIsMobile). Same draft,
// same attachment intake, same keyboard rules, same send — only the shell around the textarea differs.
//
//   "bar"  — a thread's bottom bar (the approved phone design, 2026-09-30). At rest it is ONE row: a
//            round + (attach), a pill field, and one verb on the right. The verb follows the draft: with
//            text it is Send; with none it is whatever the caller passes as `idlePrimary` (the thread's
//            Done), or a disabled ↑. Focus or text opens the field into a box whose second row carries
//            the + , the caller's `tools` (the model chip) and the verb. `override` is the seam for a
//            bar that is not a prompt at all — see PhoneBarApi.
//   "page" — the new-thread page: the textarea fills the space it is given, and the tool row (+ and
//            `tools`) sits under it. The page's own header carries the send.
//
// Both ride the software keyboard: a spacer under the bar, sized by useKeyboardInset, lifts it onto
// the keyboard while the panel above shrinks.
export interface PhoneBarApi {
  /** Switch the bar back to the prompt and focus it (opens the keyboard: call it from a tap). */
  editReply: () => void
}

export type PhoneComposerLayout =
  | {
      layout: "bar"
      tools?: ReactNode
      // The verb when the draft is empty. `compact` is true inside the open box's toolbar (36px),
      // false in the resting row (42px).
      idlePrimary?: (compact: boolean) => ReactNode
      // THE ANSWER SEAM. When set, the resting bar renders this INSTEAD of its row — a thread with open
      // questions shows [keyboard] + "Answer N questions" there. The textarea stays mounted (hidden),
      // so `editReply` can focus it inside the same tap and iOS still raises the keyboard; once the
      // field has focus or text, the ordinary prompt row returns, and the override comes back when it
      // is empty and blurred again.
      override?: (api: PhoneBarApi) => ReactNode
      // Long-press (≈500ms) on Send. Only passed where interrupt-and-send is allowed
      // (canInterruptAndSend); without it a long press is an ordinary send.
      onLongPressSend?: () => void
    }
  | { layout: "page"; tools?: ReactNode }

const LONG_PRESS_MS = 500
// The skills menu's placement: from the box's left edge, a share of its width, 6px above it (below when
// the top has no room).
const SUGGEST_PLACEMENT = aboveAnchor(6)

// HOLDING THE BAR OPEN. The open box's toolbar is only there while the field has focus or text — but a
// control in it that opens a sheet (the model chip) closes the keyboard first, which blurs an empty
// field, which would unmount the toolbar and the sheet it just opened along with it. A toolbar control
// calls `hold(true)` for as long as its sheet is up, and the bar stays open until it lets go.
export const PhoneBarHoldContext = createContext<((held: boolean) => void) | null>(null)

// THE THREAD PROMPT BOX'S SEND — passed by ThreadComposerBox, absent on the dispatch composer (which
// keeps the ↑ square: it starts a thread, and has nothing to steer or queue behind). With it the rail's
// Send is the split button (SendSplitButton), and the box can send with NO text of its own: `staged`
// counts the answers waiting on the question cards around it, which this same send carries.
export interface ComposerSendControl {
  mode: SendMode
  onMode: (mode: SendMode) => void
  /** There is something to queue behind (a turn in flight, or messages already queued) — the only time
   *  the menu's two rows differ. */
  running: boolean
  staged: number
  /** The agent can read a message inside a running turn; absent means it can. */
  steerable?: boolean
}

// Auto-grow: reset to auto, then snap to content height clamped at maxHeight.
function snapHeight(el: HTMLTextAreaElement, maxHeight: number): void {
  el.style.height = "auto"
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
}

export function Composer({
  value,
  onChange,
  onSubmit,
  surface,
  placeholder,
  id,
  minHeight: minHeightProp,
  maxHeight = 157,
  autoFocus,
  busy,
  footer,
  railLead,
  contextTokens,
  slashSuggest,
  onInterruptSubmit,
  send,
  phone,
  onUploadingChange,
  fileDrop,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  // Pure data- tag on the textarea, which the e2e tests target a surface's input by. No focus registry
  // behind it anymore.
  surface: string
  placeholder?: string
  id?: string
  minHeight?: number
  maxHeight?: number
  autoFocus?: boolean
  // While busy the textarea is locked and the send button spins — used for the New-thread dispatch
  // round-trip so the composer commits instantly instead of sitting live during the spawn.
  busy?: boolean
  // Rendered INSIDE the box along its bottom edge (the dispatch form's inline mode/model/effort
  // readouts). The textarea auto-grows above it; the footer strip is always reserved.
  footer?: React.ReactNode
  // STAGED CONTEXT — the `@` tokens the ⌘I flow has staged on this thread. Drives the backdrop pill
  // behind each staged token in the prose (an unstaged `@thing` the user happened to type stays
  // plain text) and the atomic Backspace that deletes a whole token. The pill IS the chip: there is
  // no roster of chips anywhere else in the box — a legend row along the bottom edge was tried and
  // cut (maintainer 2026-09-03: "we DONT NEED THE CHIPS AT THE BOTTOM … just the inline chip"), so
  // removing a reference is deleting its text. Order-irrelevant; empty/omitted disables both.
  contextTokens?: string[]
  // A control at the rail's LEFT end, beyond the paperclip — the thread composer's Goal
  // (ThreadComposerBox). It owns its own popover; this component only places it.
  railLead?: React.ReactNode
  // SKILLS TYPEAHEAD. When set, a draft that is exactly one `/`-led token opens a suggestion menu of
  // the thread's invocable skills above the box (fetched lazily, once, on first trigger). The list is
  // whatever the thread's own harness reports — the caller owns sourcing entirely; this component only
  // renders and completes. Surfaces without a session to ask (the dispatch composer) omit it and the
  // whole affordance is inert.
  slashSuggest?: () => Promise<ThreadSkill[]>
  // INTERRUPT AND SEND — what the FORCED chord (⌘/Ctrl-Enter) does while the thread's worker is
  // mid-turn AND its runtime can be preempted; the caller owns that policy entirely. When it is not
  // set, the same chord is an ordinary send, so ⌘-Enter never goes dead (three Enter keys everywhere:
  // Enter sends, Shift/Option-Enter newlines, ⌘/Ctrl-Enter forces — maintainer 2026-08-26).
  //
  // KEYBOARD ONLY — there is deliberately no button here. It used to render a ⚡ in the rail, and the
  // bolt was the wrong picture of the thing (maintainer, 2026-08-03: "we need to drop the lightning
  // bolt icon to mean force push. That doesn't make any sense."). Preempting is now offered where the
  // waiting messages actually ARE: one Send now under the queued run (ChatView QueuedSendNow), which
  // needs no message payload because the send is already in the provider's queue. The shortcut stays
  // because it is a real send path with muscle memory behind it — only the picture was wrong. With the
  // box EMPTY the same chord presses that Send now (lib/sendNowKey), so ⌘⏎ always means "send now".
  onInterruptSubmit?: () => void
  // See ComposerSendControl. Desktop layouts only; the phone bar keeps its own primary button.
  send?: ComposerSendControl
  // A phone layout (see PhoneComposerLayout). Absent everywhere above the phone breakpoint.
  phone?: PhoneComposerLayout
  // For a surface whose send lives OUTSIDE this box (the phone's new-thread page puts Start in its
  // header): an upload in flight must hold that send too, as it holds Enter and ↑ here.
  onUploadingChange?: (uploading: boolean) => void
  // THE SURFACE IS THE DROP ZONE. A thread's surface — its queue card, drawer or full-screen page —
  // takes a file dropped anywhere on it (ThreadSurface, lib/fileDrop), so this box binds no drop handlers
  // of its own there: it draws its drop hint while `over` and registers its intake on `intake`. Absent
  // (a box that is not a thread's: the dispatch form, a sub-agent's steer), the box itself is the zone.
  fileDrop?: SurfaceFileDrop
}) {
  // ONE LINE OF TEXT, by default. Over a footer row that is 10px above the line, the 21px line and 8px below
  // it, so the line and the row stand apart by about what stands above the line (lib/iconRhythm.ts, the prompt
  // box's bottom row). It was 44px there, with 12px under the line; those 4px and the 5px the footer row gave
  // back are the extra space the maintainer read on 2026-11-07.
  const minHeight = minHeightProp ?? (footer ? 40 : 44)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  // The project an attachment is uploaded to, on the Console (undefined on a project's page).
  const project = useProjectScope()

  // Attachment paths live INSIDE the draft `value` (trailing lines) so submit, draft persistence, and
  // the worker/transcript pipeline stay untouched — but the box PRESENTS them as chips, not raw path
  // text. Split the value into the prose the textarea shows and the trailing attachment paths shown as
  // chips; recombine on every edit so the parent's `value` remains "prose + trailing paths" exactly.
  const { prose, attachments } = useMemo(() => splitComposerValue(value), [value])
  const attachmentPaths = attachments.map((a) => a.path)
  // Latest committed value, readable from an async callback that outlived its render. `takeFiles`
  // awaits the upload, so by the time it commits, `value`/`prose`/`attachmentPaths` in its closure may
  // be stale (the user typed, or another intake landed); it re-derives from this ref instead.
  const valueRef = useRef(value)
  valueRef.current = value
  // Synchronous in-box edits funnel through here: the textarea edits prose (paths unchanged); chip
  // removal edits the path list (prose unchanged). Either way the parent gets the rejoined value.
  const setProse = (nextProse: string) => onChange(joinComposerValue(nextProse, attachmentPaths))
  const setPaths = (nextPaths: string[]) => onChange(joinComposerValue(prose, nextPaths))

  // Attachment intake: drag-and-drop, paste, or the paperclip file picker. Each allowed file's absolute
  // path (returned by /attach) is appended to the message on its own line — images render as inline
  // blocks in the transcript, non-image docs as an openable chip, and the worker opens either with its
  // Read/file tool. An allowed file is any image by MIME (a pasted screenshot often has an empty/generic
  // name — the MIME check preserves the original image-paste behavior) OR any allowlisted file by name
  // (everything the picker's `accept` surfaces). The /attach route re-validates as the trust gate.
  async function takeFiles(files: FileList | File[] | null) {
    if (!files) return
    // Serialize intake: the paperclip button is disabled while uploading, but drop/paste are not, so a
    // second batch could race the first and clobber it (both commit against the same pre-upload base).
    // Reject the concurrent batch with feedback instead — uploads are quick; the user can re-drop.
    if (uploading) {
      showToast("An upload is already in progress — try again in a moment")
      return
    }
    // Effective upload name: the file's real name, else — for a nameless image paste — one derived
    // from its actual MIME subtype. The old blanket `"pasted.png"` fallback stored a TIFF/JPEG paste
    // as lying .png bytes (broken thumbnail, misled worker Read). The name then goes through the SAME
    // shared allowlist the server enforces, so nothing uploads only to 400, and every rejection gets
    // a toast instead of the old silent drop (dropping an unsupported file or image did nothing).
    const named = [...files].map((f) => {
      const sub = f.type.startsWith("image/") ? f.type.slice("image/".length).toLowerCase() : ""
      const ext = sub === "jpeg" ? "jpg" : sub === "svg+xml" ? "svg" : sub
      return { file: f, name: f.name || (ext ? `pasted.${ext}` : "") }
    })
    const typed = named.filter(({ name }) => {
      if (isAllowedAttachmentName(name)) return true
      showToast(`${name || "File"}: unsupported file type`)
      return false
    })
    if (!typed.length) return
    // Reject an oversized file up front with a clear message (the server would 400 anyway — surface it
    // instead of silently dropping). MB is base-10 to match how the OS reports file sizes; floor, so
    // the stated max is never larger than what the server actually accepts.
    const allowed = typed.filter(({ file, name }) => {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        showToast(`${name} is too large (max ${Math.floor(ATTACHMENT_MAX_BYTES / 1e6)} MB)`)
        return false
      }
      return true
    })
    if (!allowed.length) return
    // Snapshot the draft at intake: if it is non-empty now but EMPTY when the upload lands, the
    // message was sent (or the draft deliberately cleared) mid-upload — committing the path then
    // would plant an orphan chip that silently rides along with the user's NEXT, unrelated message.
    // Discard with a toast instead. (Enter/Send inside this box are gated on `uploading`, but a
    // surface can still clear the draft externally — a question card's own Enter, which sends this box.)
    // Best-effort heuristic, not airtight: typing NEW text after such an external clear makes the
    // draft non-empty again before the upload lands, and the path then joins that newer draft.
    const baseValue = valueRef.current
    setUploading(true)
    const paths: string[] = []
    try {
      for (const { file, name } of allowed) {
        const path = await uploadAttachment(file, name, project)
        // A null means /attach rejected it (decode/write failure — the type allowlist already ran
        // client-side above). Don't leave the user guessing why nothing appeared.
        if (path) paths.push(path)
        else showToast(`Could not attach ${name}`)
      }
    } finally {
      setUploading(false)
    }
    if (paths.length && baseValue !== "" && valueRef.current === "") {
      showToast("Attachment discarded — the message was sent before the upload finished")
      requestAnimationFrame(() => taRef.current?.focus())
      return
    }
    // Commit against the LATEST value (valueRef), not this callback's render-time closure — the user
    // may have typed, or a prior intake committed, while the upload was in flight. Re-derive prose +
    // existing paths from the freshest value and append this batch, so nothing typed/attached mid-upload
    // is clobbered. The paperclip picker (and, on some browsers, drop/paste) pull focus off the textarea;
    // restore it after the async upload settles so the user can keep typing without re-clicking the box.
    if (paths.length) {
      const latest = splitComposerValue(valueRef.current)
      onChange(joinComposerValue(latest.prose, [...latest.attachments.map((a) => a.path), ...paths]))
    }
    requestAnimationFrame(() => taRef.current?.focus())
  }

  // Drag-and-drop intake: the box's own zone, or the surface's (see `fileDrop`). The surface reaches
  // `takeFiles` through its handle, by a ref, because the function closes over this render's draft.
  const ownDrop = useFileDropZone((files) => void takeFiles(files))
  const dragging = fileDrop ? fileDrop.over : ownDrop.over
  const takeFilesRef = useRef(takeFiles)
  takeFilesRef.current = takeFiles
  const intake = fileDrop?.intake
  useEffect(() => {
    if (!intake) return
    intake.set((files) => void takeFilesRef.current(files))
    return () => intake.set(null)
  }, [intake])

  // Auto-grow on every value change. A first layout pass
  // can precede font settlement or a narrow drawer's final width, leaving scrollHeight stale and the
  // last wrapped line hidden beneath the in-box controls. Recheck on the next frame and when fonts
  // settle so the textarea always owns enough height for its actual wrapped content.
  useLayoutEffect(() => {
    let active = true
    const resize = () => {
      const el = taRef.current
      if (!el || !active) return
      snapHeight(el, maxHeight)
    }
    resize()
    const frame = requestAnimationFrame(resize)
    void document.fonts?.ready.then(resize)
    const el = taRef.current
    let width = el?.clientWidth ?? 0
    // A responsive drawer can rewrap a preserved draft without changing its value. Observe width
    // only (not height, which this effect itself owns) and recompute from the new scrollHeight.
    let resizeFrame: number | undefined
    const observer = el ? new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width)
      if (nextWidth === width) return
      width = nextWidth
      // Writing `height` while ResizeObserver is delivering causes Chromium's loop warning. Run the
      // measurement in the next frame: the composer still tracks a drawer rewrap, without a browser
      // console error for every narrow-width resize.
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    }) : undefined
    if (el) observer?.observe(el)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer?.disconnect()
    }
    // Footer PRESENCE (not node identity) is the layout signal: it flips the textarea's bottom
    // padding class. Some call sites rebuild the footer JSX every parent render (each board tick on
    // an open thread), and depending on the node itself tore down and rebuilt the ResizeObserver +
    // fonts.ready hook on every one of those renders for zero layout change.
  }, [value, maxHeight, Boolean(footer)])

  // THE TOKEN BACKDROP: a metrics-identical mirror of the prose, absolutely positioned behind the
  // (transparent-backgrounded) textarea, in which everything renders as TRANSPARENT text except that
  // each staged `@` token gets a pill background. Because the mirror carries the same font,
  // padding, line height and wrapping as the textarea, the pill lands exactly under the token
  // wherever it sits — any line, any wrap — which is the whole trick: the pill is paint, the token is
  // text, and the textarea keeps owning editing, caret and selection. The pill decorations are
  // strictly zero-layout (background, box-shadow ring, and `-mx`/`px` pairs that cancel) so the
  // mirror's advance widths can never drift from the textarea's.
  const stagedTokens = useMemo(() => contextTokens ?? [], [contextTokens])
  const backdropSegments = useMemo(() => {
    if (stagedTokens.length === 0) return null
    const runs = splitProseByTokens(prose, stagedTokens)
    if (!runs.some((run) => run.token)) return null
    return runs.map((run, i) =>
      run.token ? (
        // The vertical pad is free (vertical padding on an inline box never moves layout); the
        // horizontal pad is bought back by the negative margin so the advance width is untouched.
        <span key={i} className="rounded bg-panel-2 py-0.5 -mx-0.5 px-0.5 ring-1 ring-inset ring-border">
          {run.text}
        </span>
      ) : (
        run.text
      ),
    )
  }, [prose, stagedTokens])

  // The mirror rides the textarea's own scroll position (a textarea at maxHeight scrolls its
  // content; the backdrop must pan with it or the pills detach from their tokens).
  const syncContextScroll = () => {
    const el = taRef.current
    const backdrop = contextRef.current
    if (el && backdrop) backdrop.scrollTop = el.scrollTop
  }
  useLayoutEffect(syncContextScroll)

  // The browser BLURS a focused element the instant it becomes `disabled`, so every `busy` window
  // evicts the caret and the user must re-click the box to keep typing. A focusout whose target is
  // ALREADY disabled is exactly that eviction and nothing else (a user-initiated blur always fires
  // while the element is still enabled), so it is the precise signal for taking focus back once the
  // box unlocks — and it is why a surface that deliberately blurs on send (the queue card dissolving
  // itself) is honored rather than fought: that blur lands while still enabled and never arms this.
  // The listener must be NATIVE: React does not dispatch synthetic events for disabled form controls,
  // so `onBlur` never sees this one (verified in a real browser — the synthetic handler stays silent
  // while the native focusout fires with disabled=true). Note `busy` is not only the send round-trip:
  // it also tracks board-derived control state, so this can fire on a lock the user never initiated.
  const evictedRef = useRef(false)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onFocusOut = () => { evictedRef.current = el.disabled }
    el.addEventListener("focusout", onFocusOut)
    return () => el.removeEventListener("focusout", onFocusOut)
  }, [])
  useEffect(() => {
    if (busy || !evictedRef.current) return
    evictedRef.current = false
    // Restore only INTO THE VACUUM the eviction left — never steal focus back from somewhere the user
    // deliberately moved while the box was locked. The vacuum is <body> when the composer sits on the
    // page, but inside a modal drawer Radix's focus scope catches the eviction on the dialog container
    // instead; both are ANCESTORS of the box, which is exactly what a deliberate destination is not.
    const el = taRef.current
    const active = document.activeElement
    // preventScroll: this restore can land seconds after the send (a dispatch waits out session
    // startup), by which time the user may have scrolled far away — taking focus back must not yank
    // the page with it.
    if (el && (!active || active.contains(el))) el.focus({ preventScroll: true })
  }, [busy])

  // SKILLS TYPEAHEAD state. `skillItems` is the harness's list, fetched once on the first `/` trigger
  // (null = not asked yet; [] = asked, nothing to offer — including a fetch that failed, which must
  // read as "no suggestions", never as an error the operator has to dismiss). `dismissedFor` records
  // the exact draft an Escape closed the menu over, so it stays closed until the draft CHANGES —
  // without it the menu would reopen on the very next render.
  const [skillItems, setSkillItems] = useState<ThreadSkill[] | null>(null)
  // The highlighted row, REMEMBERED WITH THE DRAFT IT WAS CHOSEN OVER: the filtered list under it
  // changes with every keystroke, so a highlight belongs to one draft and reads as row 0 for any
  // other. Derived, not reset by an effect — `useEffect(() => setSuggestSel(0), [prose])` looked free
  // (same value, no re-render) but it was not: once the fiber carries any pending lane React skips
  // the same-value bailout, so every keystroke's effect enqueued a DefaultLane update that a fast
  // burst of keystrokes starved; the root then ended every sync commit with that lane still pending,
  // React's nested-update counter climbed one per keystroke, and a 50-keystroke burst (a multi-line
  // draft on /full, 2026-08-28) threw "Maximum update depth exceeded" twice per run.
  const [suggestSelFor, setSuggestSelFor] = useState<{ prose: string; index: number }>({ prose: "", index: 0 })
  const suggestSel = suggestSelFor.prose === prose ? suggestSelFor.index : 0
  const setSuggestSel = (next: number | ((current: number) => number)) =>
    setSuggestSelFor({ prose, index: typeof next === "function" ? next(suggestSel) : next })
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  // Active while the draft is exactly one `/`-led token — the shape of a skill invocation still being
  // typed. A space (arguments have begun) or a newline closes it.
  const slashActive = Boolean(slashSuggest) && /^\/\S*$/.test(prose)
  useEffect(() => {
    if (!slashActive || skillItems !== null) return
    let live = true
    // Errors resolve to "asked, nothing to offer": the caller decides whether to retry on a later
    // trigger by handing this component a fresh mount (drawer reopen) — a typeahead never toasts.
    void slashSuggest!().then(
      (items) => { if (live) setSkillItems(items) },
      () => { if (live) setSkillItems([]) },
    )
    return () => { live = false }
  }, [slashActive, skillItems, slashSuggest])
  const suggestions = useMemo(() => {
    if (!slashActive || !skillItems || dismissedFor === prose) return []
    const query = prose.slice(1).toLowerCase()
    // Prefix matches first (what completion usually wants), then substring matches — those are what
    // surface a namespaced skill (`frizz:gh`) from its bare name.
    const starts = skillItems.filter((s) => s.name.toLowerCase().startsWith(query))
    const contains = skillItems.filter((s) => !s.name.toLowerCase().startsWith(query) && s.name.toLowerCase().includes(query))
    return [...starts, ...contains]
  }, [slashActive, skillItems, dismissedFor, prose])
  const suggestOpen = suggestions.length > 0
  // The DISTINCT source labels in the list on screen, which every row then reserves room for (see the
  // sizer in the menu below). Empty when no visible suggestion reports a source — a harness that says
  // nothing must not cost the descriptions a column of width.
  const suggestSourceLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const s of suggestions) if (s.source) labels.add(SKILL_SOURCE_LABEL[s.source])
    return [...labels]
  }, [suggestions])
  // Keep the highlighted row in view when arrowing through a list taller than the menu.
  const suggestListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    suggestListRef.current?.querySelector(`[data-suggest-index="${suggestSel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [suggestSel])
  function acceptSuggestion(item: { name: string }) {
    const next = `/${item.name} `
    setProse(next)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.length, next.length))
  }

  // DICTATION (lib/dictation.ts): the microphone beside Send, on the desktop layout only — a phone's
  // keyboard carries its own. It writes into the prose at the caret (or at the end, when the box was
  // not focused), and any edit that is not its own ends it: typing, sending, Escape.
  const { dictation: dictationEnabled } = useSnapshot(prefs)
  const dictation = useDictation({
    read: () => {
      const el = taRef.current
      const current = el?.value ?? prose
      const focused = el !== null && document.activeElement === el
      return { prose: current, start: focused ? el.selectionStart : current.length, end: focused ? el.selectionEnd : current.length }
    },
    write: (next, caret) => {
      setProse(next)
      requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret))
    },
    enabled: dictationEnabled,
  })
  const micShown = !phone && dictation.state !== "unsupported"
  const submit = () => {
    dictation.cancel()
    onSubmit()
  }

  const hasContent = value.trim().length > 0
  // Something to send: words in the box, or — on a thread composer — an answer staged on a card.
  const armed = hasContent || (send?.staged ?? 0) > 0
  // Where each rail mark sits, and the padding every text row keeps clear of the absolutely-placed rail.
  const rail = composerRail({ lead: Boolean(railLead), mic: micShown, sendWidth: send && !phone ? (send.steerable === false ? SEND_SOLO_WIDTH : SEND_SPLIT_WIDTH) : undefined })
  // On the footer row's inset, or centred on the one line of a box with no footer row.
  const railBottom = footer ? PROMPT_ROW_INSET : PROMPT_ROW_INSET_SINGLE_LINE

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const keyboardEvent = {
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    }
    // The open skills menu claims its keys FIRST — above all Enter (accept, not send) and Escape
    // (close the menu, not blur; the blur branch below must not see this keypress). Modified Enter
    // deliberately falls through: ⌘-Enter mid-name is the operator overriding the menu, not using it.
    if (suggestOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        setSuggestSel((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1
          return (current + delta + suggestions.length) % suggestions.length
        })
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        acceptSuggestion(suggestions[suggestSel] ?? suggestions[0])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setDismissedFor(prose)
        return
      }
    }
    // A staged `@` token deletes as ONE token — the editor convention for a reference the user placed
    // as a unit. Only a bare Backspace with a collapsed caret sitting immediately after a STAGED
    // token (a hand-typed `@thing` is ordinary text); a selection, a modifier, or any other position
    // keeps native editing. The staged item itself is dropped by the caller's token-presence sweep
    // once the token is gone (ThreadComposerBox). The run split is the same one the backdrop uses,
    // so the token that deletes is exactly the one wearing a pill.
    if (e.key === "Backspace" && !e.altKey && !e.ctrlKey && !e.metaKey && stagedTokens.length > 0 && el.selectionStart === el.selectionEnd) {
      const caret = el.selectionStart
      const last = splitProseByTokens(el.value.slice(0, caret), stagedTokens).at(-1)
      if (last?.token) {
        e.preventDefault()
        const start = caret - last.text.length
        setProse(el.value.slice(0, start) + el.value.slice(caret))
        requestAnimationFrame(() => el.setSelectionRange(start, start))
        return
      }
    }
    if (queueComposerHandlesOptionEnter(surface, e.key, e.altKey)) {
      // Option-Enter inserts a newline EXPLICITLY (Claude Code muscle memory). Merely exempting it
      // from submit is not enough: on macOS Chrome, Option-Enter in a textarea inserts nothing
      // natively, so we splice the newline at the caret ourselves and restore the caret after the
      // controlled re-render.
      e.preventDefault()
      e.stopPropagation()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      setProse(el.value.slice(0, start) + "\n" + el.value.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      return
    }
    // `!uploading` closes a confirmed data-loss race: a send while /attach is in flight used to ship
    // the prose WITHOUT the pending attachment, whose path then landed in the cleared composer and
    // silently rode along with the next unrelated message. Typing stays enabled during upload (the
    // commit re-derives from valueRef); only SENDING waits for the attachment to land.
    const canSend = armed && !busy && !uploading
    if (shouldSubmitComposerEnter(keyboardEvent, canSend)) {
      // A plain Enter is the ordinary send. Shift/Option-Enter and IME confirmations retain the
      // native textarea behavior, so they cannot accidentally submit or lose their newline.
      e.preventDefault()
      e.stopPropagation()
      submit()
      return
    }
    // ⌘/Ctrl-Enter — the FORCED send. With a worker mid-turn it preempts what the worker is doing so
    // the message is read now instead of when the current command finishes; with nothing to
    // interrupt it is the same send as Enter, so the chord always means "send now". Disjoint by
    // construction from the plain-Enter send above and the Option-Enter newline repair below.
    if (shouldInterruptSubmitComposerEnter(keyboardEvent, canSend)) {
      e.preventDefault()
      e.stopPropagation()
      dictation.cancel()
      ;(onInterruptSubmit ?? onSubmit)()
      return
    }
    // With the box EMPTY the chord is left to bubble: the thread's surface reads it as Send now under
    // the queued messages (lib/sendNowKey). So while the box holds anything it cannot send yet — an
    // upload in flight, a busy runtime — the chord is still the box's, and marked taken here: words typed
    // and a ⌘⏎ must never push the queue through in their place. Marked, not stopped: the queue card's
    // own handler still sees it, as it did before Send now had a key.
    if (armed && isForcedSendChord(keyboardEvent)) {
      e.preventDefault()
      return
    }
    if (shouldRestoreOptionEnterNewline(keyboardEvent)) {
      // Do NOT prevent the modifier path: first allow the browser to insert its native newline.
      // Chromium/macOS sometimes leaves the DOM unchanged, so repair only that no-op on the next
      // frame; browsers that did insert keep their value and never take this branch.
      const before = el.value
      const start = el.selectionStart ?? before.length
      const end = el.selectionEnd ?? start
      requestAnimationFrame(() => {
        if (el.value !== before) return
        setProse(before.slice(0, start) + "\n" + before.slice(end))
        requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      })
    }
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      // While dictating, the first Escape only stops listening — the box keeps focus and the text.
      if (dictation.state === "listening") {
        e.preventDefault()
        e.stopPropagation()
        dictation.cancel()
        return
      }
      // On the /full page the key is not ours: Escape there always leaves fullscreen (DrawerStack's
      // `onEscapeAtRest`), and a blur first would make the reader press it twice with nothing visible
      // happening the first time. The draft is persisted, so the drawer or card it lands in shows it.
      // A drawer opened OVER /full is portaled outside this column and still climbs out below.
      if (e.currentTarget.closest("[data-standalone-thread]")) return
      // Climb out: blur the textarea and STOP the event — the same physical keypress must not also
      // reach App's window handler and pop a drawer. The NEXT Esc, at rest, unwinds normally.
      // Mid-IME-composition Esc is the IME's own cancel — leave it to the editor, don't blur.
      e.preventDefault()
      e.stopPropagation()
      el.blur()
    }
    // Arrow keys just move the caret — no boundary semantics (the nav walk they used to drive is gone).
  }

  // The skills menu, floated ABOVE the box (the composer lives at the bottom of its surface, so up is
  // the direction with room; ui/AnchoredLayer flips it below when the box sits too near the window's
  // top). Rows are text-only — a name and its one-line description — which keeps this out of icon-ink
  // territory entirely. Mousedown is prevented on every row for the same reason as the send button:
  // choosing a suggestion must never blur the textarea. Shared by every layout.
  //
  // PORTALED, and shown only while the textarea has focus. It was `absolute bottom-full z-20` inside the
  // box until 2026-11-01, where its z ranked only inside the composer's surface — a card footer is
  // sticky z-10, a drawer footer z-10 — so the drawer's jump-to-latest pill (z-20 over the transcript)
  // painted across its rows, and a box near the window's top opened it off the screen (lib/layers.ts
  // rule 2). Out of the surface it outranks anything opened after it, so it has to close when the
  // textarea lets go of focus, as every popover does; its keys only ever reached it with focus anyway.
  const [focused, setFocused] = useState(false)
  const suggestMenu = suggestOpen && focused ? (
      <AnchoredLayer place={SUGGEST_PLACEMENT}>
        <div
          ref={suggestListRef}
          data-slash-menu
          // On the list, not each row: a press on its padding or its scrollbar would blur the box too,
          // and the menu closes with focus.
          onMouseDown={(e) => e.preventDefault()}
          className="max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.name}
              type="button"
              data-suggest-index={i}
              onClick={() => acceptSuggestion(s)}
              onMouseEnter={() => setSuggestSel(i)}
              // px-3.5 matches the textarea's own text inset, so the completed `/name` lands exactly
              // under the row that offered it.
              className={`flex w-full items-baseline gap-2 px-3.5 py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">/{s.name}</span>
              {s.description && <span className="min-w-0 truncate text-[11px] text-muted">{s.description}</span>}
              {/* The source column. One WIDTH for every row, including the rows with no source to
                  show — otherwise an unlabelled row's description truncates 50px further right than
                  its neighbours' and the list reads ragged. The width is reserved by stacking every
                  label in the list invisibly under the real one, so the BROWSER measures it: a
                  hand-fitted px constant would be right in one of this app's two fonts and wrong in
                  the other (AGENTS.md). Measured ink gap from the truncated description ahead of it:
                  13.16px against 8.87px between a name and its own description — the tag reads as a
                  separate column, which is what it is. */}
              {suggestSourceLabels.length > 0 && (
                <span className="ml-auto grid shrink-0 text-[10px]">
                  {suggestSourceLabels.map((label) => (
                    <span key={label} aria-hidden className="petite-caps invisible col-start-1 row-start-1">{label}</span>
                  ))}
                  <span className="petite-caps col-start-1 row-start-1 text-right text-muted-70">
                    {s.source ? SKILL_SOURCE_LABEL[s.source] : ""}
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
      </AnchoredLayer>
  ) : null

  // ── The phone layouts ────────────────────────────────────────────────────────────────────────────
  // Hooks first and unconditionally, so a window that crosses the breakpoint keeps its hook order.
  // (`focused` is declared above, with the skills menu that reads it too.)
  const [held, setHeld] = useState(false)
  const phoneRootRef = useRef<HTMLDivElement>(null)
  const keyboardInset = useKeyboardInset(phoneRootRef, Boolean(phone))
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressedRef = useRef(false)
  useEffect(() => () => clearTimeout(pressTimerRef.current), [])
  const onUploadingChangeRef = useRef(onUploadingChange)
  onUploadingChangeRef.current = onUploadingChange
  useEffect(() => { onUploadingChangeRef.current?.(uploading) }, [uploading])

  if (phone) {
    const canSend = hasContent && !busy && !uploading
    // The textarea's type is 16px on a phone, not the mockup's 15.5: iOS Safari zooms the whole page
    // into any focused field set below 16px, and the desktop's 13px would do exactly that.
    const page = phone.layout === "page"
    // THE BAR opens (a box with a toolbar) while the field has focus or anything in it, and is a single
    // row otherwise. The textarea is the SAME element in both — every child before it keeps its slot (a
    // `false` holds one) — so opening the box never remounts it and never costs the caret.
    const expanded = !page && (focused || held || hasContent || attachments.length > 0)
    // Resting, the field is a 42px pill: 40px of textarea inside its 1px border, one 20px line.
    const typeClass = page
      ? "px-[18px] py-[14px] text-[17px] leading-[25px]"
      : expanded
        ? "px-3 pt-[10px] pb-1 text-[16px] leading-[22px]"
        : "px-[14px] py-[10px] text-[16px] leading-[20px]"
    const textareaBox = page ? { minHeight, maxHeight } : expanded ? { minHeight: 44, maxHeight: 176 } : { minHeight: 40, maxHeight: 40 }
    const fileInput = (
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
    )
    // The + is the paperclip's own path: the same hidden file input, the same intake.
    const attachButton = (size: 36 | 42) => (
      <button
        type="button"
        data-phone-attach
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        className={`relative flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-fg active:bg-hover disabled:opacity-45 ${
          size === 42 ? "size-[42px]" : "size-[36px] after:absolute after:-inset-[4px] after:content-['']"
        }`}
      >
        {uploading ? <Loader2 size={17} strokeWidth={2.2} className="animate-spin" /> : <Plus size={size === 42 ? 19 : 17} strokeWidth={2.2} />}
      </button>
    )
    const textarea = (
      <div className={page ? "relative flex flex-1 flex-col" : "relative"}>
        {backdropSegments && (
          <div
            ref={contextRef}
            aria-hidden
            data-composer-context-backdrop
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] ${typeClass} text-transparent`}
          >
            {backdropSegments}
          </div>
        )}
        <textarea
          id={id}
          ref={taRef}
          data-1p-ignore
          onScroll={backdropSegments ? syncContextScroll : undefined}
          data-surface={surface}
          data-claims-escape
          value={prose}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => setProse(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
            if (files.length) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          style={textareaBox}
          // `flex-1` on the page: the textarea's snapped height is its basis, and it grows to fill the
          // page, so a tap anywhere on the blank page below the prompt lands in it.
          className={`relative block w-full resize-none bg-transparent ${typeClass} text-fg outline-none placeholder:text-faint scrollbar-none disabled:opacity-60 ${page ? "flex-1" : ""}`}
        />
      </div>
    )
    const attachmentRow = attachments.length > 0 && (
      <div className={`flex flex-wrap gap-1.5 ${page ? "px-[18px] pb-3" : "px-3 pb-1"}`}>
        {attachments.map((a, i) => (
          <AttachmentChip
            key={`${a.path}-${i}`}
            attachment={a}
            disabled={busy}
            onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
          />
        ))}
      </div>
    )
    // Under the bar: the strip the keyboard covers (0 without one), else the device's home-indicator
    // inset. Inside this root, so the panel above shrinks rather than the bar floating over it.
    const keyboardSpacer = keyboardInset > 0 ? <div aria-hidden data-keyboard-spacer style={{ height: keyboardInset }} /> : null

    if (page) {
      return (
        <div ref={phoneRootRef} data-phone-composer="page" className={`flex min-h-0 flex-1 flex-col ${keyboardInset > 0 ? "" : "pb-[env(safe-area-inset-bottom)]"}`}>
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-none">
            {suggestMenu}
            {textarea}
            {attachmentRow}
          </div>
          <div data-phone-tool-row className="flex min-w-0 shrink-0 items-center gap-2 px-2.5 py-2">
            {attachButton(36)}
            {phone.tools}
          </div>
          {fileInput}
          {keyboardSpacer}
        </div>
      )
    }

    const override = !expanded && phone.override ? phone.override({ editReply: () => taRef.current?.focus() }) : null
    const sendButton = (compact: boolean) => (
      <button
        type="button"
        data-phone-send
        // Keep the caret: pressing Send must not blur the field (the desktop send's own rule).
        onMouseDown={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={() => {
          longPressedRef.current = false
          clearTimeout(pressTimerRef.current)
          if (!canSend || !phone.onLongPressSend) return
          const fire = phone.onLongPressSend
          pressTimerRef.current = setTimeout(() => {
            longPressedRef.current = true
            navigator.vibrate?.(12)
            fire()
          }, LONG_PRESS_MS)
        }}
        onPointerUp={() => clearTimeout(pressTimerRef.current)}
        onPointerLeave={() => clearTimeout(pressTimerRef.current)}
        onPointerCancel={() => clearTimeout(pressTimerRef.current)}
        onClick={() => {
          // The long press already sent; the click that ends it must not send again.
          if (longPressedRef.current) {
            longPressedRef.current = false
            return
          }
          onSubmit()
        }}
        disabled={!canSend}
        title={phone.onLongPressSend ? "Send · hold to send now" : "Send"}
        aria-label="Send"
        // The ↑ is solid whenever it is the verb; with nothing to send it is the same disc, dimmed.
        // `[-webkit-touch-callout:none]` + `select-none`: a long press must not raise iOS's callout.
        className={`relative flex shrink-0 select-none items-center justify-center rounded-full bg-fg text-bg [-webkit-touch-callout:none] disabled:opacity-35 ${
          compact ? "size-[36px] after:absolute after:-inset-[4px] after:content-['']" : "size-[42px]"
        }`}
      >
        {busy ? <Loader2 size={compact ? 17 : 19} strokeWidth={2.4} className="animate-spin" /> : <ArrowUp size={compact ? 17 : 19} strokeWidth={2.4} />}
      </button>
    )
    const primary = (compact: boolean) => (hasContent ? sendButton(compact) : (phone.idlePrimary?.(compact) ?? sendButton(compact)))

    return (
      <div ref={phoneRootRef} data-phone-composer="bar" data-phone-composer-open={expanded ? "" : undefined} className="relative bg-bg">
        <div className={`px-2.5 pt-2 ${keyboardInset > 0 ? "pb-2.5" : "pb-[max(10px,env(safe-area-inset-bottom))]"}`}>
          {override && <div data-phone-bar-override className="flex min-w-0 items-end gap-2">{override}</div>}
          <div
            // Hidden, not unmounted, under an override: `editReply` focuses this textarea inside the
            // tap that asked for it, which is what makes iOS raise the keyboard at all.
            className={override ? "pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0" : "flex min-w-0 items-end gap-2"}
          >
            {!expanded && attachButton(42)}
            <div
              className={`relative min-w-0 flex-1 border border-border-strong bg-panel ${
                expanded ? "rounded-[20px] pb-2" : "rounded-[21px]"
              }`}
            >
              {suggestMenu}
              {textarea}
              {expanded && attachmentRow}
              {expanded && (
                <div data-phone-composer-toolbar className="flex min-w-0 items-center gap-2 px-2 pt-1">
                  {attachButton(36)}
                  <PhoneBarHoldContext.Provider value={setHeld}>{phone.tools}</PhoneBarHoldContext.Provider>
                  <span className="flex-1" />
                  {primary(true)}
                </div>
              )}
            </div>
            {!expanded && primary(false)}
          </div>
          {fileInput}
        </div>
        {keyboardSpacer}
      </div>
    )
  }

  return (
    // Focused = the accent border: the visual handoff from the nav chevron to the box.
    // While a file drags over, the border dashes and a hint overlay appears (screenshot intake).
    // `data-composer-box` is the bordered box itself: the Goal panel spans exactly its two edges.
    <div
      data-composer-box
      className={`group relative ${PROMPT_BOX_CORNER} border bg-bg transition-colors focus-within:border-accent ${
        dragging ? "border-dashed border-accent" : "border-border"
      }`}
      {...(fileDrop ? {} : ownDrop.handlers)}
    >
      {dragging && (
        <div className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center ${PROMPT_BOX_CORNER} bg-bg/80 text-[12px] text-muted`}>
          Drop file to attach
        </div>
      )}
      {suggestMenu}
      {/* The textarea and its marker backdrop share one box: the wrapper is a plain block (no layout
          change from the bare textarea), the mirror fills it behind the transparent-backgrounded
          textarea, and the padding/typography class string is IDENTICAL on both by construction —
          any drift between them detaches every pill from its token. */}
      <div className="relative">
        {backdropSegments && (
          <div
            ref={contextRef}
            aria-hidden
            data-composer-context-backdrop
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] px-3.5 ${footer ? "pt-2.5 pb-2" : "py-2.5"} text-[13px] leading-relaxed text-transparent`}
            style={footer ? undefined : { paddingRight: rail.reserve }}
          >
            {backdropSegments}
          </div>
        )}
        <textarea
          id={id}
          ref={taRef}
          // 1Password's extension offers to create an SSH key on any bare textarea it focuses; this is
          // its documented opt-out. Every prose textarea in the app carries it.
          data-1p-ignore
          onScroll={backdropSegments ? syncContextScroll : undefined}
          data-surface={surface}
          // Escape here BLURS (onKeyDown below; on /full it leaves fullscreen instead); the enclosing
          // ThreadSheet reads this to leave the key to us instead of dismissing itself on the same press.
          data-claims-escape
          value={prose}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => {
            // Typing takes the box back from dictation (lib/dictation.ts).
            dictation.cancel()
            setProse(e.target.value)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            // Any file item claims the whole paste (preventDefault) — deliberately. An image paste
            // usually carries a junk text/html or filename text/plain fallback that must NOT be
            // inserted as text. Known trade-off: a genuinely mixed text+file clipboard loses its text
            // half; revisit only with a heuristic that can tell the fallback from real prose.
            const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
            if (files.length) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          style={{ minHeight, maxHeight, paddingRight: footer ? undefined : rail.reserve }}
          // With a footer strip the box is an INSET-FOOTER layout: the strip below already reserves the
          // vertical band the floating buttons occupy, so the text runs FULL width (no right rail carved
          // out of every line). Without a footer the box is a single compact row and the right padding is
          // what keeps text from sliding under the floating paperclip/send buttons. `relative` keeps the
          // caret and text painting above the marker backdrop behind it.
          className={`relative block w-full resize-none bg-transparent px-3.5 ${footer ? "pt-2.5 pb-2" : "py-2.5"} text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60`}
        />
      </div>
      {/* Attachment chips along the bottom row — one square tile per attached file (image thumbnail or
          file-type icon), each removable. The paths still live in `value`; these tiles just render them
          instead of the raw absolute-path text. Reserve the right rail so tiles never slip under the
          paperclip/send buttons on the last row. */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2" style={{ paddingRight: rail.reserve }}>
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.path}-${i}`}
              attachment={a}
              disabled={busy}
              onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text. Its
          controls are 24px on the 7px inset (8px from the box's outer edge), below and to the left, and the
          rail's marks stand on the same inset below and to the right, so the model chip and Send each sit in
          their corner with an arc that shares the box's centre (lib/iconRhythm.ts PROMPT_ROW_INSET). The chip
          sat 9px from the left and 12px from the bottom, and Send 9px from both, until 2026-11-07. */}
      {/* Reserve the right-side action rail. Without this, three shrinkable readouts can extend under
          the absolutely positioned paperclip/send buttons on narrow composers. */}
      {footer && <div className={`flex min-w-0 flex-wrap items-center gap-1 ${PROMPT_FOOTER_ROW}`} style={{ paddingRight: rail.reserve }}>{footer}</div>}
      {/* Outlined controls keep 8px between edges; prose reserves the same clearance. */}
      {railLead && <div className="absolute flex items-center" style={{ right: rail.right.lead, bottom: railBottom }}>{railLead}</div>}
      {/* Attach: a hidden file input driven by the paperclip. Sits in the right rail LEFT of the send
          button, so it never overlaps the mode/model footer or the send
          affordance. Accept is the shared extension allowlist; the /attach route re-validates. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        // With no rail action the paperclip TAKES the rail-action slot — at its OWN offset, not the
        // rail action’s, because it paints 1px less dead space on that side (lib/iconRhythm.ts).
        style={{ right: rail.right.paperclip, bottom: railBottom }}
        className={`icon-focus-outline absolute flex ${RAIL_MARK_SQUARE} items-center justify-center text-muted transition-[color,background-color] enabled:hover:bg-hover-strong enabled:hover:text-fg disabled:opacity-50`}
      >
        {uploading ? <Loader2 {...PAPERCLIP_GLYPH} className="animate-spin" /> : <Paperclip {...PAPERCLIP_GLYPH} />}
      </button>
      {micShown && (
        <button
          type="button"
          data-dictation={dictation.state}
          // Keep the caret where it is: dictation inserts there (the send button's own rule).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            // Starting from outside the box: dictate at the end of the draft, with the caret there, so
            // whatever is typed next follows the spoken words.
            const el = taRef.current
            if (dictation.state === "idle" && el && document.activeElement !== el) {
              el.focus({ preventScroll: true })
              el.setSelectionRange(el.value.length, el.value.length)
            }
            void dictation.toggle()
          }}
          disabled={busy || dictation.state === "installing" || dictation.state === "starting"}
          aria-pressed={dictation.state === "listening"}
          title={
            dictation.state === "listening"
              ? "Stop dictation"
              : dictation.state === "installing"
                ? "Downloading the on-device speech model…"
                : dictation.state === "starting"
                  ? "Starting the microphone…"
                  : "Dictate — transcribed on this device"
          }
          aria-label={dictation.state === "listening" ? "Stop dictation" : "Dictate"}
          style={{ right: rail.right.mic, bottom: railBottom }}
          // Listening swaps the GLYPH for live level bars at full foreground, never a fill: a filled square
          // is ink edge to edge, and at this slot's box gap it would sit ~6px off the paperclip's ink
          // instead of ~14. (A red, pulsing microphone was tried first and rejected, 2026-10-08.)
          className={`icon-focus-outline absolute flex ${RAIL_MARK_SQUARE} items-center justify-center transition-[color,background-color] enabled:hover:bg-hover-strong disabled:opacity-50 ${
            dictation.state === "listening" ? "text-fg" : "text-muted enabled:hover:text-fg"
          }`}
        >
          {dictation.state === "installing" || dictation.state === "starting" ? (
            <Loader2 {...MIC_GLYPH} className="animate-spin" />
          ) : dictation.state === "listening" && dictation.stream ? (
            <DictationLevel stream={dictation.stream} />
          ) : (
            <Mic {...MIC_GLYPH} />
          )}
        </button>
      )}
      {send ? (
        <SendSplitButton
          // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
          armed={armed && !busy && !uploading}
          busy={busy}
          mode={send.mode}
          running={send.running}
          steerable={send.steerable !== false}
          right={rail.right.send}
          bottom={railBottom}
          onMode={send.onMode}
          onSend={submit}
          onMenuClosed={() => taRef.current?.focus({ preventScroll: true })}
        />
      ) : (
      <button
        type="button"
        // Prevent the mousedown default so clicking Send never blurs the textarea (the repo's idiom for
        // every submit affordance that sits beside a live input). Focus then never leaves the box on the
        // click path, so there is nothing to restore — and a surface that blurs on send stays in charge.
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
        disabled={!hasContent || busy || uploading}
        title="Send (Enter · ⌘⏎ sends now)"
        aria-label="Send"
        // Never `transition-all`: it animates box-shadow, which holds the focus edge back (styles.css).
        style={{ right: rail.right.send, bottom: railBottom }}
        className={`icon-focus-outline absolute flex ${RAIL_MARK_SQUARE} items-center justify-center transition-[color,background-color,opacity,scale] ${
          // Primary actions use neutral contrast; the accent marks focus.
          hasContent && !busy && !uploading
            ? "bg-fg text-bg hover:opacity-90 active:scale-95"
            : "bg-panel-2 text-muted"
        }`}
      >
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
      </button>
      )}
    </div>
  )
}

// One attached file as a compact square tile. An image renders a /local-image thumbnail (object-cover,
// the same gated route the transcript uses); a document renders a bordered tile with a file glyph and
// its extension. A broken image (route 4xx / missing file) falls back to the document tile so a stale
// path is never a blank square. The × removes just this path from the draft. `title` carries the full
// path so the raw location is still one hover away.
function AttachmentChip({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: { path: string; kind: "image" | "file" }
  disabled?: boolean
  onRemove: () => void
}) {
  const [broken, setBroken] = useState(false)
  const base = basename(attachment.path)
  const ext = (base.includes(".") ? base.split(".").pop()! : "").toUpperCase()
  const asImage = attachment.kind === "image" && !broken
  return (
    <div className="group/att relative h-11 w-11" title={base}>
      {asImage ? (
        <img
          src={localImageUrl(attachment.path)}
          alt={base}
          onError={() => setBroken(true)}
          className="h-11 w-11 rounded-md border border-border object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-panel-2 px-1">
          <FileText size={15} strokeWidth={2} className="shrink-0 text-muted" />
          {/* `-mx-1` cancels the tile's px-1 for the LABEL only: the inset is there to give the icon
              air, and spending it on the badge too left 34px of the tile's 44 for text. At 8px caps
              that is ~5.5px a character, so a seven-letter extension clipped to "PARQ…" — measured
              39px needed against 34px available, once .parquet/.sqlite3 became attachable. The icon
              keeps its inset; the label now gets the full 42px and every extension up to seven
              characters fits. */}
          {ext && <span className="-mx-1 max-w-[calc(100%+0.5rem)] truncate text-[8px] font-medium leading-none text-muted-80">{ext}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={`Remove ${base}`}
        aria-label={`Remove ${base}`}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/att:opacity-100 disabled:hidden"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}
