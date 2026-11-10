import {
  CODE_CLAMPED_CLASS,
  CODE_EXPAND_CLASS,
  CODE_LONG_CLASS,
  longBlockLabel,
  rememberLongBlock,
} from "./codeClamp.ts"
import { CODE_BLOCK_CLASS } from "./codeLanguage.ts"

// One delegated listener for the show-all button under every long code block in every sanitized
// markdown surface, for the reason lib/copy-code.ts is delegated: the block is injected as an HTML
// string (lib/codeBlock.ts), so there is no React element to hang a handler on.
//
// The click moves the live DOM itself and records the choice (rememberLongBlock), which is what the
// next render of the same block reads. Nothing re-renders for it.
export function installCodeExpandInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${CODE_EXPAND_CLASS}`) : null
    if (!button) return
    // The button follows the `<pre>` it opens; a tabbed block has one such pair per long tab.
    const pre = button.previousElementSibling
    const code = pre?.matches(`pre.${CODE_LONG_CLASS}`) ? pre.querySelector("code") : null
    if (!pre || !code) return
    event.preventDefault()
    event.stopPropagation()

    const open = pre.classList.contains(CODE_CLAMPED_CLASS)
    pre.classList.toggle(CODE_CLAMPED_CLASS, !open)
    // The renderer appends one LF to the source; without it this is the text the block was keyed by.
    const text = (code.textContent ?? "").replace(/\n$/, "")
    button.setAttribute("aria-expanded", String(open))
    button.textContent = longBlockLabel(text.split("\n").length, open)
    rememberLongBlock(text, open)
    // Shutting a block from its foot leaves the reader below where the block now ends. Bring its top
    // back; `nearest` does nothing when the block is already in view.
    if (!open) button.closest(`.${CODE_BLOCK_CLASS}`)?.scrollIntoView({ block: "nearest" })
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}
