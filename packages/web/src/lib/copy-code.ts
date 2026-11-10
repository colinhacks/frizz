import { showToast } from "../store.ts"
import { copyTextToClipboard } from "./clipboard.ts"
import { CODE_BLOCK_CLASS, CODE_COPIED_CLASS, CODE_COPY_CLASS, COPY_CODE_LABEL } from "./codeLanguage.ts"
import { CODE_PANEL_CLASS, CODE_TAB_ACTIVE_CLASS } from "./codeTabs.ts"
import { COPY_QUOTE_LABEL, QUOTE_CLASS, QUOTE_COPY_CLASS, QUOTE_SOURCE_ATTR } from "./quoteCopy.ts"

// One delegated listener for every fenced code block and every blockquote (lib/quoteCopy.ts) in every
// sanitized markdown surface (chat, fence and question cards, the plan and doc drawers), for the same
// reason lib/local-file-links.ts is delegated: that prose is injected as an HTML string, so there is no
// React element to hang an onClick on, and the transcript rebuilds those nodes constantly as it
// re-renders and virtualizes.
export function installCodeCopyInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const button = event.target instanceof Element
      ? event.target.closest<HTMLElement>(`.${CODE_COPY_CLASS}, .${QUOTE_COPY_CLASS}`)
      : null
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    void copy(button)
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}

// The `<code>` the button belongs to — `closest` on the wrapper rather than `previousElementSibling`, so
// the pairing survives any future change to the order the two are emitted in. A tabbed block
// (lib/codeTabs.ts) holds one `<pre>` per tab behind a single button, which copies the tab that is open.
function codeOf(button: HTMLElement): HTMLElement | null {
  const block = button.closest(`.${CODE_BLOCK_CLASS}`)
  return block?.querySelector<HTMLElement>(`pre.${CODE_PANEL_CLASS}.${CODE_TAB_ACTIVE_CLASS} code`)
    ?? block?.querySelector<HTMLElement>("pre code")
    ?? null
}

// A quote's Markdown, which the sanitizer minted onto its button — or, for one whose Markdown hides
// something (lib/quoteCopy.ts), the text the quote shows, as a selection of it would copy: `innerText`,
// so paragraphs and line breaks come out as lines and nothing hidden rides along. The buttons in it are
// empty, so they add nothing.
function quoteTextOf(button: HTMLElement): string | null {
  const source = button.getAttribute(QUOTE_SOURCE_ATTR)
  if (source !== null) return source
  const quote = button.closest<HTMLElement>(`.${QUOTE_CLASS}`)
  return quote ? quote.innerText.trim() : null
}

async function copy(button: HTMLElement) {
  const quote = button.classList.contains(QUOTE_COPY_CLASS)
  // `textContent`, so highlight.js's own `<span>`s contribute nothing: what lands on the clipboard is the
  // author's source, byte for byte. The renderer appends exactly one trailing LF (it is what keeps a
  // still-streaming fence's selection behaving); strip it, because a shell command pasted into a terminal
  // with a trailing newline RUNS instead of waiting to be read.
  const text = quote ? quoteTextOf(button) : codeOf(button)?.textContent?.replace(/\n$/, "")
  if (!text) return
  try {
    await copyTextToClipboard(text)
  } catch (error) {
    showToast(`Could not copy ${quote ? "quote" : "code"}: ${(error as Error).message.slice(0, 100)}`, { duration: 7000 })
    return
  }
  flashCopied(button, quote ? COPY_QUOTE_LABEL : COPY_CODE_LABEL)
}

// The button swaps to a check for COPIED_FEEDBACK_MS. No success TOAST: the check is under the pointer
// that just clicked it, and a toast per copy would be pure noise in a transcript full of fences.
// Failures still toast, since a silent no-op there is indistinguishable from a copy.
//
// Keyed by ELEMENT, not by a single module-level timer: two blocks can be copied within the window, and
// the second must not cancel the first block's check. A WeakMap so a node the transcript re-renders away
// takes its entry with it.
const COPIED_FEEDBACK_MS = 1500
const resetTimers = new WeakMap<HTMLElement, number>()

function flashCopied(button: HTMLElement, label: string) {
  button.classList.add(CODE_COPIED_CLASS)
  button.title = "Copied"
  const pending = resetTimers.get(button)
  if (pending !== undefined) window.clearTimeout(pending)
  resetTimers.set(button, window.setTimeout(() => {
    button.classList.remove(CODE_COPIED_CLASS)
    button.title = label
    resetTimers.delete(button)
  }, COPIED_FEEDBACK_MS))
}
