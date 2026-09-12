import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, FileText, Loader2, Paperclip, X } from "lucide-react"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, isAllowedAttachmentName, type ThreadSkill } from "@frizz/shared"
import { showToast } from "../store.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { splitProseByTokens } from "../lib/composerContext.ts"
import { shouldInterruptSubmitComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter } from "../lib/composerKeyboard.ts"
import { queueComposerHandlesOptionEnter } from "../lib/queueComposerKeyboard.ts"
import { RAIL_ACTION_OFFSET, RAIL_PAPERCLIP_OFFSET, RAIL_PAPERCLIP_PLAIN_OFFSET, RAIL_RESERVE_PLAIN, RAIL_RESERVE_WITH_ACTION, RAIL_SEND_OFFSET } from "../lib/iconRhythm.ts"
import { apiBase } from "../lib/base-path.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { basename } from "../lib/paths.ts"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. ⌘/Ctrl-Enter submits
// (2026-08-26); every other Enter — plain, Shift, Option — keeps the browser's native newline, with a
// no-op fallback for Chromium's macOS Option-Enter quirk. Queue retains its separately-owned
// Option-Enter handling. Escape BLURS
// (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag for per-card input targeting (TodosView queries [data-surface="queueComposer"]).
// Upload a dropped/pasted/picked file and return its server-side absolute path. The path goes INTO the
// message text: workers open it with their Read/file tool; the chat renders images via /local-image and
// non-image files as an openable chip. The shared extension allowlist (images, docs/text/code, office,
// data and archive formats) is enforced server-side too — the /attach route is the trust gate.
async function uploadAttachment(file: File, name: string): Promise<string | null> {
  // The project this upload is FOR, resolved before the file is read rather than after. `apiBase()`
  // answers for whatever the address bar says at the instant it is called, and reading a large file is
  // long enough for the operator to switch projects: the attachment then landed in the state directory
  // of a project the message was never going to, while the message itself went to the thread they
  // started from. Anything read across an await has to be captured on THIS side of it.
  const base = apiBase()
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
  minHeight = 44,
  maxHeight = 220,
  autoFocus,
  busy,
  footer,
  leftAction,
  contextTokens,
  slashSuggest,
  onInterruptSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  // Pure data- tag on the textarea (e.g. TodosView targets [data-surface="queueComposer"] to focus a
  // card's input). No focus registry behind it anymore.
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
  // A small action rendered just LEFT of the send button (the dispatch composer's GitHub-picker icon).
  // Only surfaces that pass it get it; reply/queue composers omit it.
  leftAction?: React.ReactNode
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
  // waiting message actually IS: a ↑ on the queued bubble itself (UserBubble's push-now control), which
  // needs no message payload because the send is already in the provider's queue. The shortcut stays
  // because it is a real send path with muscle memory behind it — only the picture was wrong.
  onInterruptSubmit?: () => void
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)

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
    // surface can still clear the draft externally — the queue card's "Send answers" button.)
    // Best-effort heuristic, not airtight: typing NEW text after such an external clear makes the
    // draft non-empty again before the upload lands, and the path then joins that newer draft.
    const baseValue = valueRef.current
    setUploading(true)
    const paths: string[] = []
    try {
      for (const { file, name } of allowed) {
        const path = await uploadAttachment(file, name)
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

  const hasContent = value.trim().length > 0
  // ONE rail slot. Reserving it must track what is actually rendered — the padding/offset classes below
  // key off `railAction`, and a truthy element that renders null would carve out an empty hole (the bug
  // GithubTrigger's `useGithubTriggerVisible` exists to prevent). Its only filler now is `leftAction`
  // (the dispatch composer's GitHub picker); interrupt-and-send gave up its button here and kept only
  // ⌘/Ctrl-Enter — see the `onInterruptSubmit` prop doc.
  const railAction = leftAction ?? null

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
    const canSend = hasContent && !busy && !uploading
    if (shouldSubmitComposerEnter(keyboardEvent, canSend)) {
      // A plain Enter is the ordinary send. Shift/Option-Enter and IME confirmations retain the
      // native textarea behavior, so they cannot accidentally submit or lose their newline.
      e.preventDefault()
      e.stopPropagation()
      onSubmit()
      return
    }
    // ⌘/Ctrl-Enter — the FORCED send. With a worker mid-turn it preempts what the worker is doing so
    // the message is read now instead of when the current command finishes; with nothing to
    // interrupt it is the same send as Enter, so the chord always means "send now". Disjoint by
    // construction from the plain-Enter send above and the Option-Enter newline repair below.
    if (shouldInterruptSubmitComposerEnter(keyboardEvent, canSend)) {
      e.preventDefault()
      e.stopPropagation()
      ;(onInterruptSubmit ?? onSubmit)()
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
      // Climb out: blur the textarea and STOP the event — the same physical keypress must not also
      // reach App's window handler and pop a drawer. The NEXT Esc, at rest, unwinds normally.
      // Mid-IME-composition Esc is the IME's own cancel — leave it to the editor, don't blur.
      e.preventDefault()
      e.stopPropagation()
      el.blur()
    }
    // Arrow keys just move the caret — no boundary semantics (the nav walk they used to drive is gone).
  }

  return (
    // Focused = the accent (yellow) border: the visual handoff from the nav chevron to the box.
    // While a file drags over, the border dashes and a hint overlay appears (screenshot intake).
    <div
      className={`group relative rounded-xl border bg-bg transition-colors focus-within:border-accent ${
        dragging ? "border-dashed border-accent" : "border-border"
      }`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void takeFiles(e.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg/80 text-[12px] text-muted">
          Drop file to attach
        </div>
      )}
      {/* The skills menu, floated ABOVE the box (the composer lives at the bottom of its surface, so
          up is the direction with room). Rows are text-only — a name and its one-line description —
          which keeps this out of icon-ink territory entirely. Mousedown is prevented on every row for
          the same reason as the send button: choosing a suggestion must never blur the textarea. */}
      {suggestOpen && (
        <div
          ref={suggestListRef}
          data-slash-menu
          className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.name}
              type="button"
              data-suggest-index={i}
              onMouseDown={(e) => e.preventDefault()}
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
      )}
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
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] px-3.5 ${footer ? "py-2.5 pb-3" : `py-2.5 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`} text-[13px] leading-relaxed text-transparent`}
          >
            {backdropSegments}
          </div>
        )}
        <textarea
          id={id}
          ref={taRef}
          onScroll={backdropSegments ? syncContextScroll : undefined}
          data-surface={surface}
          value={prose}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => setProse(e.target.value)}
          onKeyDown={onKeyDown}
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
          style={{ minHeight, maxHeight }}
          // With a footer strip the box is an INSET-FOOTER layout: the strip below already reserves the
          // vertical band the floating buttons occupy, so the text runs FULL width (no right rail carved
          // out of every line). Without a footer the box is a single compact row and the right padding is
          // what keeps text from sliding under the floating paperclip/send buttons. `relative` keeps the
          // caret and text painting above the marker backdrop behind it.
          className={`relative block w-full resize-none bg-transparent px-3.5 ${footer ? "py-2.5 pb-3" : `py-2.5 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`} text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60`}
        />
      </div>
      {/* Attachment chips along the bottom row — one square tile per attached file (image thumbnail or
          file-type icon), each removable. The paths still live in `value`; these tiles just render them
          instead of the raw absolute-path text. Reserve the right rail so tiles never slip under the
          paperclip/send buttons on the last row. */}
      {attachments.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 px-3 pb-2 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`}>
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
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text.
          Inset = 6px (px-1.5 pb-1.5) so the leftmost readout chip's rounded-md (6px) bottom-left
          corner reads CONCENTRIC with the box's rounded-xl (12px): inner radius (6) = outer (12) −
          inset (6), i.e. both arcs share a center. At the old px-2 (8px) the chip's corner sat 2px
          inside the box arc and read misaligned. */}
      {/* Reserve the right-side action rail. Without this, three shrinkable readouts can extend under
          the absolutely positioned GitHub/send buttons on narrow composers. */}
      {footer && <div className={`flex min-w-0 flex-wrap items-center gap-1 pl-1.5 pb-1.5 ${railAction ? RAIL_RESERVE_WITH_ACTION : RAIL_RESERVE_PLAIN}`}>{footer}</div>}
      {/* THE RIGHT RAIL, right to left: send, then the optional rail action, then the paperclip. The
          offsets are NOT an even 36px pitch any more — they are derived from each button's INK, which
          is the only thing the eye measures the rail by. Send is a FILLED square, so its ink is its
          whole 28px box; the paperclip paints 13px of its 28 and the GitHub mark 12.75, so an even
          pitch put 22.25px of clear space between the two icons against 15.75px between the GitHub
          mark and send — "the attachment icon and the GitHub icon feel further apart than the GitHub
          icon and the up arrow" (maintainer 2026-08-04). The derivation and the residual are in
          lib/iconRhythm.ts; the rows above reserve the leftmost button's box edge + 8px so prose keeps
          its clearance off the rail either way. */}
      {railAction && <div className={`absolute bottom-2 ${RAIL_ACTION_OFFSET} flex items-center`}>{railAction}</div>}
      {/* Attach: a hidden file input driven by the paperclip. Sits in the right rail LEFT of the send
          button (and left of any railAction), so it never overlaps the mode/model footer or the send
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
        className={`absolute bottom-2 ${railAction ? RAIL_PAPERCLIP_OFFSET : RAIL_PAPERCLIP_PLAIN_OFFSET} flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-[color,background-color] enabled:hover:bg-panel-2/70 enabled:hover:text-fg disabled:opacity-50`}
      >
        {uploading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Paperclip size={15} strokeWidth={2} />}
      </button>
      <button
        type="button"
        // Prevent the mousedown default so clicking Send never blurs the textarea (the repo's idiom for
        // every submit affordance that sits beside a live input). Focus then never leaves the box on the
        // click path, so there is nothing to restore — and a surface that blurs on send stays in charge.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSubmit}
        // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
        disabled={!hasContent || busy || uploading}
        title="Send (Enter · ⌘⏎ sends now)"
        aria-label="Send"
        className={`absolute bottom-2 ${RAIL_SEND_OFFSET} flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
          // Active = neutral-bright (light-on-dark) primary, NOT accent — yellow stays the focus motif.
          hasContent && !busy && !uploading
            ? "bg-fg text-bg hover:opacity-90 active:scale-95"
            : "bg-panel-2 text-muted"
        }`}
      >
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
      </button>
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
