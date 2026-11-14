import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// A THREAD BEHAVIOUR IS WIRED ONCE, IN THE SHELL (components/ThreadSurface.tsx), and never in a surface's
// own component. A thread is drawn in the board's pane, in its drawer and on its full-screen page (all
// three ChatView, since the queue card went on 2026-11-10); until 2026-10-13 the card (TodosView) and
// ChatView each assembled the thread's contexts,
// its answering controller and its send scope by hand, so whatever was added to one was simply absent
// from the other — a file dropped anywhere on a queue card went into its prompt box, and the same drop on
// the drawer or the full-screen page did nothing (maintainer: "This shouldn't even be structurally
// possible"). These pin the structure that makes it so: the pieces below appear in the shell and nowhere
// else, every surface mounts the shell, and the prompt box takes its surface from the shell alone.
//
// If one of these fails on your change, the thing you are adding belongs in ThreadSurface.tsx, where
// every surface gets it. Fixtures and tests are exempt: they mount pieces in isolation on purpose.

const src = fileURLToPath(new URL("../", import.meta.url))
const production = globSync("**/*.{ts,tsx}", { cwd: src })
  .map((file) => file.split("\\").join("/"))
  .filter((file) => !/\.test\.tsx?$/.test(file) && !/-fixture\.tsx$/.test(file))
const sources = new Map(production.map((file) => [file, readFileSync(`${src}/${file}`, "utf8")]))
const filesWith = (needle: string) => [...sources].filter(([, text]) => text.includes(needle)).map(([file]) => file).sort()

const SHELL = "components/ThreadSurface.tsx"

test("the thread's contexts, its answering controller and its drop zone are wired in the shell alone", () => {
  // What the shell provides — a provider anywhere else is a second, partial shell.
  for (const provider of ["ThreadSlugContext.Provider", "QueueDismissContext.Provider", "SendScopeContext.Provider", "ComposerSendContext.Provider", "<RegisteredAnsweringProvider"]) {
    assert.deepEqual(filesWith(provider), [SHELL], `${provider} is mounted by ThreadSurface, for every surface at once`)
  }
  // What the shell calls — each also appears in the module that defines it.
  assert.deepEqual(filesWith("useLiveAnswering("), [SHELL, "lib/answering.ts"].sort())
  assert.deepEqual(filesWith("useSendScope("), [SHELL, "lib/sendScope.tsx"].sort())
  assert.deepEqual(filesWith("useComposerSendHandle("), [SHELL, "lib/sendScope.tsx"].sort())
  assert.deepEqual(filesWith("useFileIntakeHandle("), [SHELL, "lib/fileDrop.ts"].sort())
  // A drop zone is the thread surface's, or a prompt box's own where the box is not a thread's.
  assert.deepEqual(filesWith("useFileDropZone("), ["components/Composer.tsx", SHELL, "lib/fileDrop.ts"].sort())
})

test("every surface that draws a thread's prompt box mounts the shell, once", () => {
  const surfaces = ["components/ChatView.tsx"]
  assert.deepEqual(filesWith("<ThreadSurface").filter((file) => file !== SHELL), surfaces, "a new surface is added here on purpose")
  for (const file of surfaces) {
    const text = sources.get(file)!
    assert.equal((text.match(/useThreadSurface\(/g) ?? []).length, 1, `${file} calls useThreadSurface once`)
    assert.equal((text.match(/<ThreadSurface\b/g) ?? []).length, 1, `${file} mounts one ThreadSurface`)
    // The zone is the shell's: a surface that binds a drag handler of its own has forked it.
    assert.doesNotMatch(text, /\bon(?:Drop|DragOver|DragEnter|DragLeave)=/, `${file} binds no drag handlers of its own`)
  }
  // A page that is one thread's widens that thread's zone to itself (ThreadPageZone) — the shell's
  // element, mounted by the full-screen page and by the board's one-thread pane around its thread and rail,
  // neither of which binds a drag handler of its own. It is defined in a module of its own, which the
  // shell reads its context from, so the pane can mount it at first paint without loading the shell.
  const PAGE_ZONE = "components/ThreadPageZone.tsx"
  const pageZones = ["components/StandaloneThreadPage.tsx", "components/ThreadPane.tsx"]
  assert.deepEqual(filesWith("<ThreadPageZone").filter((file) => file !== SHELL && file !== PAGE_ZONE), pageZones)
  assert.deepEqual(filesWith("useThreadPageZone("), [PAGE_ZONE, SHELL].sort(), "only the shell hands its zone up to the page")
  for (const file of pageZones) assert.doesNotMatch(sources.get(file)!, /\bon(?:Drop|DragOver|DragEnter|DragLeave)=/)
  assert.match(sources.get(SHELL)!, /<div \{\.\.\.root\} \{\.\.\.\(pageZone \? null : zone\)\} data-thread-surface=/, "one zone: a surface whose page took it binds none on its own root")
  // The box is drawn through ThreadActionBar, by ChatView.
  assert.deepEqual(filesWith("<ThreadComposerBox"), ["components/ThreadActionBar.tsx"])
  assert.deepEqual(filesWith("<ThreadActionBar"), ["components/ChatView.tsx"])
})

// WHAT A MESSAGE MEANS — which awaiting fence is settled, which registered question the message carries or
// restates, which answers it pairs with, whether its fenced questions are answerable — was derived three
// times (the queue card and both of the thread view's columns) and handed to Message at four call sites,
// kept alike by tests that grepped each copy for the same line. One of each now.
test("what each transcript message means is derived in the shell alone, and handed to Message in one place", () => {
  // The derivations: called by the shell, and otherwise only inside the module that defines one, or
  // where a sibling rule replays one (settledQuestions replays the placement).
  for (const derive of ["registeredStandingAt(", "settledQuestionPositions("]) {
    assert.deepEqual(filesWith(derive), [SHELL], `${derive} is the shell's call`)
  }
  for (const derive of ["pairAllAnswers(", "unrenderedAnswers("]) {
    assert.deepEqual(filesWith(derive), [SHELL, "lib/answersMessage.ts"], `${derive} is the shell's call`)
  }
  assert.deepEqual(filesWith("placeQuestions("), [SHELL, "lib/settledQuestions.ts"])
  assert.deepEqual(filesWith("useFenceQuestions("), ["components/RegisteredQuestionCards.tsx", SHELL])
  assert.equal((sources.get(SHELL)!.match(/const awaitingCut = /g) ?? []).length, 1)
  for (const [file, text] of sources) if (file !== SHELL) assert.doesNotMatch(text, /const awaitingCut = /, `${file} computes no stale-fence cut of its own`)

  // The hand-over: ThreadMessage, beside Message. Nothing else passes Message what the thread says.
  const chat = sources.get("components/ChatView.tsx")!
  for (const prop of ["shadowedBy={", "settledPlaced={", "fenceQuestions={", "restingCardShown={", "staleAwaiting={"]) {
    assert.deepEqual(filesWith(prop), ["components/ChatView.tsx"], `${prop} is passed in ChatView.tsx alone`)
    assert.equal(chat.split(prop).length - 1, 1, `${prop} is passed once, by ThreadMessage`)
  }
  assert.match(chat, /export function ThreadMessage\(\{ m, index, showSendButton \}/, "it takes the message, its index and what a layout decides — nothing a surface could get wrong")
  // Outside a surface it throws, like the prompt box.
  assert.match(sources.get(SHELL)!, /if \(!transcript\) throw new Error\(/)

  // Every surface draws its transcript through it. A bare Message on a surface is a line that carries no
  // question — a queued bubble, a lifted wake — and takes the message and its pairing only.
  const bare = /^<Message (?:key=\{`[^`]*`\} )?m=\{[^}]+\}(?: paired=\{[^}]+\})? \/>$/
  for (const [file, viaThreadMessage, own] of [["components/ChatView.tsx", 1, 1]] as const) {
    const text = sources.get(file)!
    assert.equal((text.match(/<ThreadMessage\b/g) ?? []).length, viaThreadMessage, `${file} draws its transcript messages through ThreadMessage`)
    const sites = text.match(/<Message [^\n]*?\/>/g) ?? []
    for (const site of sites) assert.match(site, bare, `${file}: ${site}`)
    assert.equal((text.match(/<Message\b/g) ?? []).length, sites.length + own, `${file} has no other Message site`)
  }
})

// WHAT A SURFACE DRAWS, AND WHAT IT READS AROUND IT — the list it draws of its transcript, the status rung
// at that list's tail, an earlier page and the ops a thread lists — were built once per surface until
// 2026-10-14, and two had drifted: the thread view's model read the running background calls the card's
// had taken out, and the line of counts went on listing watches the rail had learned to leave out.
test("the drawn transcript, the status rung, an earlier page and a thread's ops each have one source", () => {
  const surfaces = ["components/ChatView.tsx"]
  // The list (useThreadMessages): its steps are the shell's calls, and each surface calls it once.
  for (const step of ["useTranscriptHeldForBoard(", "useRefusedFences("]) assert.deepEqual(filesWith(step), [SHELL], `${step} is a step of useThreadMessages`)
  for (const step of ["useArrivedQuestions(", "useSettledQuestions("]) assert.deepEqual(filesWith(step), ["components/RegisteredQuestionCards.tsx", SHELL], `${step} is a step of useThreadMessages`)
  assert.deepEqual(filesWith("useThreadMessages("), [...surfaces, SHELL].sort())
  for (const file of surfaces) assert.equal((sources.get(file)!.match(/useThreadMessages\(/g) ?? []).length, 1, `${file} builds its list once`)

  // The status rung (useRuntimeTail, RuntimeStatusSlot): derived and drawn in ChatView, mounted once per surface.
  for (const derive of ["runtimeStatusRung(", "runtimeStatusGapFor(", "<RuntimeStatusLadder"]) assert.deepEqual(filesWith(derive), ["components/ChatView.tsx"])
  const chat = sources.get("components/ChatView.tsx")!
  assert.equal((chat.match(/<RuntimeStatusLadder\b/g) ?? []).length, 1, "the ladder is drawn by the slot alone")
  for (const file of surfaces) assert.equal((sources.get(file)!.match(/<RuntimeStatusSlot\b/g) ?? []).length, 1, `${file} mounts one status slot`)

  // An earlier page (lib/loadEarlier): fetched, checked and merged in one place.
  assert.deepEqual(filesWith("threadTranscriptEarlier("), ["api/contract.ts", "lib/loadEarlier.ts"])
  assert.deepEqual(filesWith("prependEarlierPage("), ["lib/loadEarlier.ts", "lib/transcriptPagination.ts"])

  // A thread's ops (lib/threadOps): nothing that lists them picks its own rows off the thread.
  assert.deepEqual(filesWith("mergeBackgroundShells("), ["lib/threadOps.ts"])
  for (const file of ["components/ChatView.tsx", "components/FocusRail.tsx", "components/QueueOpsSummary.tsx", "lib/queueOpsCounts.ts"]) {
    assert.doesNotMatch(sources.get(file)!, /\.watches\b/, `${file} reads its watches through lib/threadOps`)
  }
})

test("the prompt box takes its surface from the shell and has no way to be handed one", () => {
  const box = sources.get("components/ThreadComposerBox.tsx")!
  assert.match(box, /const \{ fileDrop \} = useThreadSurfaceBox\(\)/)
  assert.equal((box.match(/fileDrop=\{fileDrop\}/g) ?? []).length, 2, "both of its layouts hand the surface's zone to the box")
  // Outside a surface it throws rather than mounting without whatever the shell wires.
  assert.match(sources.get(SHELL)!, /if \(!box\) throw new Error\(/)
})

// WHAT EVERY MESSAGE IS HANDED KEEPS ITS IDENTITY WHILE ITS CONTENT DOES (lib/sameWhileEqual.ts). A
// value derived from the messages is a new object on every push, and as a prop of every message it
// re-rendered all of them: 114 renders over one scripted turn where 18 were needed. No test here can
// count a render, so this pins the places the count was won.
test("nothing handed to every message changes on a push that did not move it", () => {
  const shell = sources.get(SHELL)!
  assert.match(shell, /const openQuestions = useShared\(source\.openQuestions, replaceEqualDeep\)/, "the rows the board hands over are shared by content, once")
  assert.match(shell, /const fenceQuestions = useSameWhileEqual\(useFenceQuestions\(/)
  // The message asks whether the prompt box sends through the handle's own context, never the scope's.
  const sends = sources.get("lib/sendScope.tsx")!
  assert.match(sends.slice(sends.indexOf("export function usePromptBoxSends")), /^export function usePromptBoxSends\(\): boolean \{\n  const composer = useContext\(ComposerSendContext\)/)
  // And it is handed no thread: the board replaces that object on every delta, and the message never read it.
  const view = sources.get("components/ChatView.tsx")!
  const handed = view.slice(view.indexOf("export function ThreadMessage("), view.indexOf("// Exported for the transcripts that are not a thread's own"))
  assert.doesNotMatch(handed, /\bthread=\{/)
})
