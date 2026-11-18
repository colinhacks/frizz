import { proxy, useSnapshot } from "valtio"
import type { ChatMessage } from "../hooks.ts"
import { messagePresentationText } from "./messagePresentation.ts"

// THE WORDS THAT STARTED A THREAD, DRAWN AS ITS FIRST MESSAGE BEFORE THE SESSION HAS WRITTEN THEM.
//
// A dispatch answers once the worker's process is up, and the thread opens then (lib/openStartedThread).
// The human's message reaches the transcript only after that: the session writes it to its file when its
// first turn starts, and the tailer folds it a beat later. Until 2026-11-17 the thread view said
// "Session starting…" over an empty column for all of it (maintainer: "it should be totally trivial for
// you just to show the message that the user just sent at the top, followed by the thinking shimmer").
//
// So the tab that sent the prompt keeps it, keyed by the id the board shows the thread under
// (pendingDispatch dispatchedThreadId), and the thread view draws it as the transcript's first message
// while the transcript has no message of the human's yet. It is an ordinary user message, not a queued
// one: it was delivered, as the start of the worker's first turn, and the Working row under it is the
// turn it started. The server's copy then takes its place, at the same height, and nothing moves.
//
// THE SERVER'S COPY KEEPS THE INSTANT THE HUMAN SENT IT. Its own timestamp is when the session wrote it,
// seconds later, and the Working row's clock counts from the message it stands under: on the server's
// instant it read `0s`, `1s`, `2s`, `3s` and then `0s` again the frame the copy landed (recorded on a stack
// whose worker took 3s to start, 2026-11-17). The copy is matched by the words its bubble draws (its
// `displayText`: its `text` is the whole composed prompt, Frizz's orientation above the human's words), so a
// transcript that says something else is left as it is.
//
// Only this tab knows the words; a reload or another device mid-start reads the session file like any
// other thread. The same shape as lib/steering.ts and lib/pendingDispatch.ts: a hint that asserts what the
// server is about to report and yields the moment it does. An entry is a few hundred bytes per thread this
// tab started, so it is kept for the tab's life rather than timed out.

export interface DispatchedPrompt {
  text: string
  /** The instant the human sent it, which dates the bubble and starts the Working row's clock. */
  at: string
}

const prompts = proxy<Record<string, DispatchedPrompt>>({})

/** The dispatch that started thread `id` sent `text` at `at`. */
export function rememberDispatchedPrompt(id: string, text: string, at: string): void {
  prompts[id] = { text, at }
}

export function useDispatchedPrompt(id: string): DispatchedPrompt | undefined {
  return useSnapshot(prompts)[id] as DispatchedPrompt | undefined
}

/** The first message the human sent that has landed, or -1. A queued bubble is not one: a follow-up typed
 *  while the session starts is drawn queued, and lands after the first. */
function firstHumanMessage(messages: readonly ChatMessage[]): number {
  return messages.findIndex((message) => message.role === "user" && !message.queued)
}

const sameWords = (a: string, b: string) => a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim()

/**
 * The transcript as the thread that `prompt` started draws it. While nothing the human sent has landed and
 * the thread is `starting`, the prompt is drawn first. Once the session's copy has landed, that copy keeps
 * the instant the prompt was sent. The same list by identity otherwise, so the memos downstream hold.
 */
export function withDispatchedPrompt(messages: ChatMessage[], prompt: DispatchedPrompt | undefined, starting: boolean): ChatMessage[] {
  if (!prompt) return messages
  const first = firstHumanMessage(messages)
  if (first < 0) return starting ? [{ role: "user", text: prompt.text, at: prompt.at, tools: [], parts: [] }, ...messages] : messages
  const landed = messages[first]
  if (!sameWords(messagePresentationText(landed), prompt.text) || !(Date.parse(landed.at ?? "") > Date.parse(prompt.at))) return messages
  const next = messages.slice()
  next[first] = { ...landed, at: prompt.at }
  return next
}
