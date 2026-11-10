import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react"

// ONE SEND PER SURFACE (maintainer 2026-10-11: "drop the send answers button and instead have it such
// that you send in your answers using the … button in the bottom right of the prompt box. It's very
// annoying to me that I can't send my answers and submit an additional steer at the same time, so we
// need to unify them").
//
// A surface — a queue card, or a thread's drawer / full page — draws question cards in several places
// and one prompt box under them. The answers staged on those cards and the words in the box now leave
// together, as one turn, through the prompt box's Send. Two things have to cross the tree for that:
//
//   · DOWN to the prompt box: what is staged. Registered questions already share their state through
//     RegisteredAnsweringContext; the fenced ones (```question blocks in a message) are held by the
//     surface's useLiveAnswering, and reach the box through `fenced` here.
//   · UP from the prompt box: the send itself. Enter inside a card's own text box, and the queue card's
//     card-level Enter, must be the SAME send as the button — so the box registers its send on the
//     surface's `composer` handle, and every one of those calls it.
//
// A surface with no prompt box registered (a phone thread page, whose bar has its own answer sheet; a
// stack mounted with no scope above it) has no handle to call, and its cards keep their own send and
// their own "Send answers" button. That fallback is what makes this safe to adopt surface by surface.

/** The fenced answers staged on a surface, ready to ride a send. */
export interface FencedTake {
  /** The answers in their wire form (lib/answering composeAnswerWire). */
  wire: string
  /** Clear the staged picks and drafts — the send has committed locally. */
  onOptimistic: () => void
  /** The send was refused: put them back. */
  onRollback: () => void
}

/** The surface's prompt box, once mounted: the one send. A tiny external store rather than a ref, so a
 *  card can also ASK whether there is one (it decides whether the card still draws its own button). */
export class ComposerSendHandle {
  private send: (() => void) | null = null
  private listeners = new Set<() => void>()
  /** Called by the prompt box on mount with its send, and with null on unmount. */
  set(send: (() => void) | null): void {
    if (this.send === send) return
    const had = this.send !== null
    this.send = send
    if (had !== (send !== null)) for (const listener of this.listeners) listener()
  }
  /** Send through the prompt box. False when there is none — the caller sends its own way. */
  run(): boolean {
    if (!this.send) return false
    this.send()
    return true
  }
  present = (): boolean => this.send !== null
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface SendScope {
  composer: ComposerSendHandle
  /** How many fenced question blocks carry an answer. */
  fencedCount: number
  takeFenced: () => FencedTake | null
}

export const SendScopeContext = createContext<SendScope | null>(null)

// THE HANDLE ALONE, for a reader that asks only whether the prompt box sends. Every transcript message
// asks that (usePromptBoxSends), and the scope above is a new object whenever the staged answers or the
// transcript move, so a message that read the scope rendered again on every push, through its memo:
// over one scripted turn the memo let 18 renders through and the message body rendered 57 times
// (2026-11-10; lib/sameWhileEqual.ts has the whole measurement). The handle is one object for the
// surface's life, so this context's value never changes.
export const ComposerSendContext = createContext<ComposerSendHandle | null>(null)

/** One handle for the life of the surface. Created BEFORE useLiveAnswering, which sends through it. */
export function useComposerSendHandle(): ComposerSendHandle {
  return useState(() => new ComposerSendHandle())[0]
}

export function useSendScope(composer: ComposerSendHandle, fenced: { stagedCount: number; takeAnswers: () => FencedTake | null }): SendScope {
  const { stagedCount, takeAnswers } = fenced
  return useMemo(() => ({ composer, fencedCount: stagedCount, takeFenced: takeAnswers }), [composer, stagedCount, takeAnswers])
}

/** Is a prompt box registered on this handle? For the component that OWNS the scope, which sits above
 *  its own provider and so cannot read the context. */
export function useComposerSendPresent(composer: ComposerSendHandle): boolean {
  return useSyncExternalStore(composer.subscribe, composer.present, absent)
}

const never = () => () => {}
const absent = () => false

/** Does this surface's prompt box send the staged answers? When it does, no card draws a Send of its own. */
export function usePromptBoxSends(): boolean {
  const composer = useContext(ComposerSendContext)
  return useSyncExternalStore(composer?.subscribe ?? never, composer?.present ?? absent, absent)
}
