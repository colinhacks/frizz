import assert from "node:assert/strict"
import test from "node:test"
import { applyEvent, newTailState } from "./tailer.ts"
import { closeHumanSteps, foldHumanSteps, humanStepId, humanTodoView, HUMAN_STEPS_MAX, type HumanStep, type HumanTodoTick } from "./human-todos.ts"

const SIGN_IN = "Sign in to npm."
const SIGN_IN_TITLE = "Sign in to npm"
const APPROVE = "Approve the publish."
const MERGE = "Merge the release PR."

const tick = (text: string, done_at: number | null, reported_at: number | null = null): HumanTodoTick => ({ item_id: humanStepId(text), done_at, reported_at })
const items = (...texts: string[]) => texts.map((text) => ({ text }))
const shown = (steps: readonly HumanStep[], ticks: readonly HumanTodoTick[] = [], options?: { finished?: boolean }) =>
  humanTodoView(steps, ticks, options).map((todo) => [todo.text, todo.done, todo.staged])

test("the same words are the same item, however they are wrapped", () => {
  assert.equal(humanStepId("Sign  in\nto npm. "), humanStepId(SIGN_IN))
  assert.notEqual(humanStepId(SIGN_IN), humanStepId(APPROVE))
})

test("a later fence adds to the list, in the order things were handed over", () => {
  const first = foldHumanSteps([], items(SIGN_IN), 10)
  const second = foldHumanSteps(first, items(SIGN_IN, APPROVE), 20)
  assert.deepEqual(shown(second), [[SIGN_IN, false, false], [APPROVE, false, false]])
})

test("the newest steps drop an unticked item they leave out, and keep a ticked one", () => {
  const first = foldHumanSteps([], items(SIGN_IN, APPROVE), 10)
  const second = foldHumanSteps(first, items(MERGE), 20)
  assert.deepEqual(shown(second), [[MERGE, false, false]], "the worker moved on from both")
  assert.deepEqual(shown(second, [tick(SIGN_IN, 15, 16)]), [[SIGN_IN, true, false], [MERGE, false, false]], "what was done stays on the list")
})

test("a tick is staged until a send reports it, and unticking a reported one stages that", () => {
  const steps = foldHumanSteps([], items(SIGN_IN), 10)
  assert.deepEqual(shown(steps, [tick(SIGN_IN, 15)]), [[SIGN_IN, true, true]])
  assert.deepEqual(shown(steps, [tick(SIGN_IN, 15, 16)]), [[SIGN_IN, true, false]])
  assert.deepEqual(shown(steps, [tick(SIGN_IN, null, 16)]), [[SIGN_IN, false, true]])
  assert.deepEqual(shown(steps, [tick(SIGN_IN, null)]), [[SIGN_IN, false, false]], "ticked and unticked before anyone heard: nothing to say")
})

test("every box one send reported carries that send's instant, and a report the worker has been re-listed past carries none", () => {
  const steps = foldHumanSteps(foldHumanSteps([], items(SIGN_IN, APPROVE), 10), items(MERGE, APPROVE), 20)
  const view = humanTodoView(steps, [tick(SIGN_IN, 15, 30), tick(APPROVE, 25, 30), tick(MERGE, 26)])
  assert.deepEqual(view.map((todo) => [todo.text, todo.reportedAt]), [[SIGN_IN, 30], [APPROVE, 30], [MERGE, undefined]], "the send at 30 carried the box from the earlier rest along with this one's")
  const relisted = foldHumanSteps(steps, items(SIGN_IN), 40)
  assert.equal(humanTodoView(relisted, [tick(SIGN_IN, 15, 30)])[0].reportedAt, undefined, "listed again after the report: that report no longer stands")
})

test("listing a step the worker heard was done reopens it, and a tick it never heard survives the re-post", () => {
  const relisted = foldHumanSteps(foldHumanSteps([], items(SIGN_IN), 10), items(SIGN_IN), 30)
  assert.deepEqual(shown(relisted, [tick(SIGN_IN, 15, 20)]), [[SIGN_IN, false, false]], "the sign-in did not take")
  assert.deepEqual(shown(relisted, [tick(SIGN_IN, 15)]), [[SIGN_IN, true, true]], "a worker re-posting on a timer has not said the tick was wrong")
  assert.deepEqual(shown(relisted, [tick(SIGN_IN, 40, 20)]), [[SIGN_IN, true, true]], "ticked again after it reopened, and the worker has not heard that one")
})

test("a step's body rides with its title, and the newest fence listing it says what the body is", () => {
  const first = foldHumanSteps([], [{ text: SIGN_IN, body: "Use the **bot** account." }, { text: APPROVE }], 10)
  assert.deepEqual(humanTodoView(first, []).map((todo) => [todo.text, todo.body]), [[SIGN_IN, "Use the **bot** account."], [APPROVE, undefined]])
  const second = foldHumanSteps(first, [{ text: SIGN_IN, body: "Use the owner account." }, { text: APPROVE }], 20)
  assert.equal(second[0].id, first[0].id, "a new body is the same item")
  assert.deepEqual(humanTodoView(second, []).map((todo) => todo.body), ["Use the owner account.", undefined])
  assert.equal(foldHumanSteps(second, [{ text: SIGN_IN }], 30)[0].body, undefined, "and a fence that writes none takes it away")
})

test("a typed Done closes what its rest listed, with no tick behind it, until the step is listed again", () => {
  const listed = foldHumanSteps([], items(SIGN_IN, APPROVE), 10)
  const closed = closeHumanSteps(listed, [SIGN_IN, APPROVE], 10)
  assert.deepEqual(shown(closed), [[SIGN_IN, true, false], [APPROVE, true, false]])
  assert.deepEqual(shown(foldHumanSteps(closed, items(SIGN_IN), 20)), [[SIGN_IN, false, false], [APPROVE, true, false]])
})

test("a signed-off thread owes nothing, and keeps what was done", () => {
  const steps = foldHumanSteps([], items(SIGN_IN, APPROVE), 10)
  assert.deepEqual(shown(steps, [tick(SIGN_IN, 15, 16)], { finished: true }), [[SIGN_IN, true, false]])
})

test("the list is bounded, and the oldest items no fence lists go first", () => {
  let steps: HumanStep[] = foldHumanSteps([], items("keep me"), 1)
  for (let i = 0; i < HUMAN_STEPS_MAX + 5; i++) steps = foldHumanSteps(steps, items("keep me", `step ${i}`), i + 2)
  assert.equal(steps.length, HUMAN_STEPS_MAX)
  assert.equal(steps[0].text, "keep me", "still listed, so it outlives items older fences named")
  assert.equal(steps.at(-1)?.text, `step ${HUMAN_STEPS_MAX + 4}`)
})

// The fold, through the same normalized events a Codex thread sends.
const assistant = (at: string, text: string) => ({ kind: "assistant-text", at, text, final: true }) as Parameters<typeof applyEvent>[1]
const human = (at: string, text: string) => ({ kind: "user-message", at, text, synthetic: false }) as Parameters<typeof applyEvent>[1]
const newFoldState = () => newTailState("human-todos", "sid", "/nowhere.jsonl")
const listOf = (state: { humanSteps?: HumanStep[] }) => state.humanSteps ?? []
const fence = (...steps: string[]) => `\`\`\`awaiting\nsteps:\n${steps.map((s) => `  - ${s}`).join("\n")}\n\`\`\``

test("the fold settles a rest on steps when it ends, and a reply of Done closes it", () => {
  const state = newFoldState()
  applyEvent(state, assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN)))
  assert.equal(state.humanSteps, undefined, "still resting: nothing has settled")
  applyEvent(state, human("2026-11-09T10:01:00.000Z", "Which account?"))
  assert.deepEqual(listOf(state).map((s) => [s.text, s.listed, s.closedAt]), [[SIGN_IN, true, undefined]])
  applyEvent(state, assistant("2026-11-09T10:02:00.000Z", fence(SIGN_IN, APPROVE)))
  applyEvent(state, human("2026-11-09T10:03:00.000Z", "Done\n\nUsed the bot account."))
  assert.deepEqual(listOf(state).map((s) => s.closedAt), Array(2).fill(Date.parse("2026-11-09T10:02:00.000Z")))
})

test("a fence opened with four backticks carries a code block in a step's body onto the list", () => {
  const state = newFoldState()
  const steps = ["steps:", "  - Sign in to npm", "", "    ```sh", "    npm login --auth-type=web", "    ```", "  - Approve the publish"].join("\n")
  applyEvent(state, assistant("2026-11-09T10:00:00.000Z", `Tagged.\n\n\`\`\`\`awaiting\n${steps}\n---\nThe publish is next.\n\`\`\`\``))
  assert.deepEqual(state.lastFence?.body, "The publish is next.", "the inner code block does not close the fence")
  applyEvent(state, human("2026-11-09T10:01:00.000Z", "Which account?"))
  assert.deepEqual(listOf(state).map((s) => [s.text, s.body]), [[SIGN_IN_TITLE, "```sh\nnpm login --auth-type=web\n```"], ["Approve the publish", undefined]])
})

test("a fence a later message replaced never lands on the list", () => {
  const state = newFoldState()
  applyEvent(state, assistant("2026-11-09T10:00:00.000Z", fence(SIGN_IN)))
  applyEvent(state, assistant("2026-11-09T10:00:05.000Z", "Actually, I can do that myself."))
  applyEvent(state, human("2026-11-09T10:01:00.000Z", "OK"))
  assert.equal(state.humanSteps, undefined)
})
