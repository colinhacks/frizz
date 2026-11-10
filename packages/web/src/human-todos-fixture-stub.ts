import type { BoardSnapshot, HumanTodo } from "@frizz/shared"
import { store } from "./store.ts"

// The server's half of the human's to-do list, for the browser fixtures: a fixture's board is static, so
// without this a tick would last only as long as the tab's own optimistic copy of it.

export const fixtureTodos = (steps: readonly string[]): HumanTodo[] =>
  steps.map((text, i) => ({ id: `step-${i}`, text, done: false, staged: false }))

export function fixtureSetHumanTodo(body: { slug: string; id: string; done: boolean }): void {
  if (!store.board) return
  store.board = {
    ...store.board,
    threads: store.board.threads.map((thread) => thread.id !== body.slug ? thread : {
      ...thread,
      humanTodos: thread.humanTodos?.map((todo) => (todo.id === body.id ? { ...todo, done: body.done, staged: body.done } : todo)),
    }),
  } as BoardSnapshot
}

/** The board moving the list under the tab: a later rest listing a step again reopens its box. */
export function fixtureReopenHumanTodo(slug: string, id: string): void {
  if (!store.board) return
  store.board = {
    ...store.board,
    threads: store.board.threads.map((thread) => thread.id !== slug ? thread : {
      ...thread,
      humanTodos: thread.humanTodos?.map((todo) => (todo.id === id ? { ...todo, done: false, staged: false } : todo)),
    }),
  } as BoardSnapshot
}
