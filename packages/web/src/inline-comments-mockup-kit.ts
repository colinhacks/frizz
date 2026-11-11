import type { ChatMessage } from "./hooks.ts"

// Behind the inline-comment mockup sheet (inline-comments-mockup-fixture; queue-dock-mockup-fixture
// shared it until the queue card went, 2026-11-10): the fixture transcript, the comment seeds, the wire text a sent steer carries, and the anchoring +
// highlight engine. Not shipped UI.
//
// ANCHORS are character offsets over a root's own text, skipping the sheets' UI (`data-ic-ui`).
// HIGHLIGHTS are painted with the CSS Custom Highlight API, not <mark> elements: agent prose is innerHTML
// React owns, and a wrapper spliced into its text nodes would be torn out on the next render. A Range
// over the existing text survives — which is also the honest implementation route.

// The prose renderer asks the server to turn inline-code file paths into links. This sheet has no server
// behind it (it also opens from file://), so those lookups answer "not found" locally instead of erroring.
const serverFetch = window.fetch.bind(window)
window.fetch = (input, init) =>
  (input instanceof Request ? input.url : String(input)).includes("/_frizz/") ? Promise.resolve(new Response("", { status: 404 })) : serverFetch(input, init)

// ── the transcript every frame shows ──────────────────────────────────────────────────────────────

function prose(sourceId: string, lines: string[]): ChatMessage {
  const text = lines.join("\n")
  return { sourceId, role: "assistant", tools: [], text, parts: [{ kind: "text", text }] }
}

export const MESSAGES: ChatMessage[] = [
  {
    sourceId: "u1",
    role: "user",
    tools: [],
    parts: [],
    text: "The resolver cache hands back the wrong module when two packages share a name. Find out why and fix it.",
  },
  {
    sourceId: "a1",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      { kind: "text", text: "Reading the resolver and its cache first." },
      {
        kind: "tools",
        tools: [
          { name: "Read", detail: "src/resolver/cache.ts" },
          { name: "Grep", detail: "cacheKey" },
          { name: "Read", detail: "src/resolver/index.ts" },
          { name: "Bash", detail: "nub run test resolver", desc: "Run the resolver tests" },
        ],
      },
    ],
  },
  prose("a2", [
      "Found it. `src/resolver/cache.ts` keys every entry on the **package name** alone, so `@acme/utils` and a nested `utils` both land on the key `utils`. Whichever resolves first wins, and every later lookup gets the wrong module.",
      "",
      "The plan:",
      "",
      "1. Key the cache on the normalized id — the package name plus its resolved directory.",
      "2. Drop the `byName` fast path, since it is the thing that collides.",
      "3. Add a regression test with two packages that share a name.",
  ]),
  {
    sourceId: "a3",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      { kind: "text", text: "The change itself is one line:\n\n```ts\nconst key = `${pkg.name}@${realpath(pkg.dir)}`\n```" },
      {
        kind: "tools",
        tools: [
          { name: "Edit", detail: "src/resolver/cache.ts" },
          { name: "Edit", detail: "src/resolver/index.ts" },
          { name: "Write", detail: "src/resolver/resolver.test.ts" },
          { name: "Bash", detail: "nub run test", desc: "Run the full suite" },
        ],
      },
    ],
  },
  prose("a4", [
      "Done.",
      "",
      "- Fixed the cache collision in `src/resolver/cache.ts` — the lookup now keys on the normalized id.",
      "- Removed the `byName` fast path.",
      "- Added a regression test; `nub run test` is green: 412 passed, 1 skipped.",
      "- Bumped `CACHE_VERSION` to 7, so the first run after this rebuilds the cache from scratch.",
  ]),
]

export interface Seed { quote: string; text: string; status?: "draft" | "pending" | "sent" }

export const S1: Seed = { quote: "Removed the byName fast path", text: "Put it back, keyed on the normalized id too — it saves about 40ms on a cold start." }
export const S2: Seed = { quote: "412 passed, 1 skipped", text: "Which test is skipped, and why? Nothing in this suite should skip." }
export const S3: Seed = { quote: "Bumped CACHE_VERSION to 7", text: "Do not bump the version — that makes every user rebuild their cache. Migrate the old keys instead." }
export const SEEDS = [S1, S2, S3]
export const NOTE = "Approach looks right. Three things before you call it done:"

// What the worker reads. The prompt box text is the note on top; the comments follow in TRANSCRIPT order
// (not the order they were written), each opening with the passage it is about as a blockquote — the
// shape ⌘I's selected context already uses (lib/composerContext.ts), so a quote reads as quotation in
// the transcript too.
export function wireText(note: string, items: readonly { quote: string; text: string }[]): string {
  const quoted = (q: string) => q.split("\n").map((line) => `> ${line}`).join("\n")
  const blocks = items.map((it) => `${quoted(it.quote)}\n\n${it.text}`)
  const head = `Comments on the transcript (${items.length}) — each quotes the passage it is about:`
  return [note.trim(), items.length ? `${head}\n\n${blocks.join("\n\n")}` : ""].filter(Boolean).join("\n\n")
}
export interface Box { left: number; top: number; width: number; height: number }

export function inUi(node: Node | null): boolean {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)
  return Boolean(el?.closest("[data-ic-ui]"))
}

export function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (inUi(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

export function rangeToOffsets(root: HTMLElement, r: Range): [number, number] | null {
  let pos = 0
  let start = -1
  let end = -1
  for (const t of textNodes(root)) {
    const len = t.data.length
    if (r.intersectsNode(t)) {
      if (start < 0) start = pos + (r.startContainer === t ? r.startOffset : 0)
      end = pos + (r.endContainer === t ? r.endOffset : len)
    }
    pos += len
  }
  return start < 0 || end <= start ? null : [start, end]
}

export function offsetsToRange(root: HTMLElement, start: number, end: number): Range | null {
  let pos = 0
  let started = false
  const r = document.createRange()
  for (const t of textNodes(root)) {
    const len = t.data.length
    if (!started && start < pos + len) {
      r.setStart(t, start - pos)
      started = true
    }
    if (started && end <= pos + len) {
      r.setEnd(t, end - pos)
      return r
    }
    pos += len
  }
  return null
}

export function fullText(root: HTMLElement): string {
  return textNodes(root).map((t) => t.data).join("")
}

/** Trim whitespace off a selection's ends, so a triple-click does not quote a trailing newline. */
export function trimmed(root: HTMLElement, [start, end]: [number, number]): [number, number] {
  const text = fullText(root)
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return [start, end]
}

export function boxesOf(root: HTMLElement, r: Range): Box[] {
  const o = root.getBoundingClientRect()
  return [...r.getClientRects()]
    // A range across blocks also reports the blocks' own border boxes; keep the line boxes.
    .filter((b) => b.width > 0.5 && b.height > 0.5 && b.height < 48)
    .map((b) => ({ left: b.left - o.left, top: b.top - o.top, width: b.width, height: b.height }))
}

// One registry per paint kind, shared by every frame on the sheet (CSS.highlights is per-document).
// `soft` / `soft-active` are the queue-dock sheet's reading of a pending comment: a light highlighter
// fill and nothing else, the comment itself in a hover popover.
export type PaintKind = "sent" | "pending" | "soft" | "fakesel" | "draft" | "soft-active" | "active"
export const PAINT_ORDER: PaintKind[] = ["sent", "pending", "soft", "fakesel", "draft", "soft-active", "active"]
export const HIGHLIGHTS = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
export const paints = new Map<string, Partial<Record<PaintKind, Range[]>>>()
export function repaint() {
  if (!HIGHLIGHTS) return
  PAINT_ORDER.forEach((kind, i) => {
    const h = new Highlight(...[...paints.values()].flatMap((p) => p[kind] ?? []))
    h.priority = i
    CSS.highlights.set(`ic-${kind}`, h)
  })
}

export const HIGHLIGHT_CSS = `
::highlight(ic-pending) {
  background-color: color-mix(in srgb, var(--color-accent) 13%, transparent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
  text-decoration-thickness: 1.5px;
}
::highlight(ic-draft), ::highlight(ic-active) {
  background-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
  text-decoration: underline;
  text-decoration-color: var(--color-accent);
  text-decoration-thickness: 2px;
}
::highlight(ic-sent) {
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-muted) 80%, transparent);
  text-decoration-thickness: 1.5px;
}
::highlight(ic-fakesel) { background-color: color-mix(in srgb, var(--color-accent) 22%, transparent); }
/* A highlighter, not a selection: literal yellow in both palettes (light mode's accent is blue). */
:root { --ic-soft: rgb(232 185 35 / 0.17); --ic-soft-active: rgb(232 185 35 / 0.34); }
:root[data-theme="light"] { --ic-soft: rgb(250 214 60 / 0.3); --ic-soft-active: rgb(250 204 21 / 0.55); }
::highlight(ic-soft) { background-color: var(--ic-soft); }
::highlight(ic-soft-active) { background-color: var(--ic-soft-active); }
[data-ic-root] { text-underline-offset: 0.24em; }
[data-ic-slot] { margin-top: 8px; }
`

