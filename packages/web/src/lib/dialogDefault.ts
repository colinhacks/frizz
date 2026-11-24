import { shouldSubmitStagedEnter, type ComposerKeyboardEvent } from "./composerKeyboard.ts"

// ENTER PRESSES A DIALOG'S DEFAULT BUTTON, the white one, wherever the focus is in the dialog (maintainer
// 2026-11-24, of "End this session?": "When this or any other popover is showing on the screen and I
// press Enter, then the default button should be triggered, the white one. In all cases"). Until then
// Radix put the focus on the first control in the dialog, the header's ×, so Enter closed the dialog
// instead of answering it.
//
// ui/Dialog does two things with the button its footer marks `data-dialog-default`: it takes the focus
// when the dialog opens (unless the dialog places it itself, on a text field), and an Enter that nothing
// else in the dialog answers presses it. What answers Enter itself keeps it: another button (Tab to
// Cancel and Enter is Cancel), a link, a text box, a text field in a form (which submits that form, and
// the form's submit is the default). A checkbox, the dialog's body text and the dialog itself have no
// Enter of their own, so there it is the default's.
//
// A destructive button (red: Delete project, Sign out) is never marked: Enter is the reflex that answers
// a dialog without reading it, and those are the ones to read.

export const DIALOG_DEFAULT_ATTRIBUTE = "data-dialog-default"
export const DIALOG_DEFAULT_SELECTOR = `[${DIALOG_DEFAULT_ATTRIBUTE}]`

/** The focused element, as far as Enter cares. */
export type EnterTarget = {
  tag: string
  /** An `<input>`'s `type`. */
  type?: string
  role?: string | null
  editable?: boolean
  /** An `<input>` inside a form, where Enter submits it. */
  inForm?: boolean
}

// Inputs Enter means nothing to.
const ENTERLESS_INPUTS = new Set(["checkbox", "radio", "range", "color", "hidden"])
const OWN_ENTER_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox", "tab", "switch", "listbox", "textbox"])

/** Whether the focused element answers Enter itself, so the dialog's default must not. */
export function ownsEnter(target: EnterTarget): boolean {
  const tag = target.tag.toLowerCase()
  if (target.editable) return true
  if (target.role && OWN_ENTER_ROLES.has(target.role)) return true
  if (tag === "button" || tag === "a" || tag === "textarea" || tag === "select" || tag === "summary") return true
  if (tag === "input") return !ENTERLESS_INPUTS.has((target.type ?? "text").toLowerCase()) && target.inForm === true
  return false
}

/** Enter, ⌘/Ctrl-Enter: the keys that send everywhere else (lib/composerKeyboard). Not Shift or Option,
 *  not an IME confirmation, not a held key, not one something already answered. */
export function isDefaultEnter(event: ComposerKeyboardEvent & { repeat?: boolean; defaultPrevented?: boolean }): boolean {
  return !event.repeat && !event.defaultPrevented && shouldSubmitStagedEnter(event)
}

export function enterTargetOf(element: Element): EnterTarget {
  const input = element instanceof HTMLInputElement ? element : null
  return {
    tag: element.tagName,
    type: input?.type,
    role: element.getAttribute("role"),
    editable: element instanceof HTMLElement && element.isContentEditable,
    inForm: input ? input.form !== null : undefined,
  }
}

/** The enabled default button inside `content`, if it has one. */
export function dialogDefaultButton(content: Element): HTMLButtonElement | null {
  const button = content.querySelector<HTMLButtonElement>(DIALOG_DEFAULT_SELECTOR)
  return button && !button.disabled ? button : null
}
