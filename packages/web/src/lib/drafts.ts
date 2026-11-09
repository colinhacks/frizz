import { useCallback, useMemo, useSyncExternalStore } from "react"
import { subscribe, useSnapshot } from "valtio"
import { store, threadSnapshotBySlug } from "../store.ts"
import { projectPathDir, subscribeLocalPathBase } from "./localPathBase.ts"
import { useProjectScope } from "./projectScope.tsx"
import { splitThreadKey } from "./threadKey.ts"

// A DRAFT BELONGS TO ITS BOX, NOT TO THE TAB IT WAS TYPED IN. Drafts live in localStorage, so every tab
// on this origin reads and writes ONE set: they survive React unmounts, a reload and a browser restart,
// and a thread's prompt box holds the same words on the queue card, in the drawer and on its /full
// page whichever tab each is in.
//
// They were per-tab sessionStorage until 2026-10-11. The fullscreen door is a real link, so ⌘-click,
// middle-click and "open in new tab" put /full in a NEW tab — and a new tab starts with an empty
// sessionStorage, as does a /full tab that was already open (maintainer 2026-10-11: "The stuff that I
// type into the prompt box when it's in the queue does not transfer over if I open that same queue card
// in full-screen view"). Measured on a real stack before the move: typed into the queue card, then the
// door in the same tab → the words are there; the same href in a second tab → "".
//
// Sharing has two halves. A tab that OPENS reads what is stored. A tab that is ALREADY open hears the
// `storage` event the browser sends every other tab on a write (wired at the bottom of this section),
// so typing in one tab shows in the other, and a send in one empties the box in both instead of
// leaving the sent words behind to be sent twice.
//
// Keep this schema tiny and text-only; server records, credentials and secret interaction fields must
// never enter this cache — it is on disk now, and it outlives the tab.
export const DRAFT_STORAGE_KEY = "frizz-drafts:v1"
export const DRAFT_SCHEMA_VERSION = 1
const MAX_ENTRIES = 80
const MAX_VALUE_BYTES = 512 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
// sessionStorage ended with its tab; localStorage has no end of its own. A draft nobody has touched for
// this long is dropped the next time a tab reads the store, so words typed for a thread long since
// archived do not sit on disk until 80 newer drafts happen to push them out.
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const encoder = new TextEncoder()

export type DraftSnapshot = { version: 1; entries: Record<string, { value: string; touchedAt: number }> }
type Listener = () => void
type DraftStorage = Pick<Storage, "getItem" | "setItem">
type LegacyDraftStorage = Pick<Storage, "getItem" | "removeItem">

function bytes(value: string): number { return encoder.encode(value).byteLength }
function empty(): DraftSnapshot { return { version: DRAFT_SCHEMA_VERSION, entries: {} } }
export function parseDraftSnapshot(raw: string | null): DraftSnapshot {
  if (!raw) return empty()
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== DRAFT_SCHEMA_VERSION) return empty()
    const entries = (value as { entries?: unknown }).entries
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return empty()
    const valid: DraftSnapshot["entries"] = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry?.value !== "string" || typeof entry?.touchedAt !== "number" || !Number.isFinite(entry.touchedAt)) continue
      if (key.length > 512 || bytes(entry.value) > MAX_VALUE_BYTES) continue
      valid[key] = { value: entry.value, touchedAt: entry.touchedAt }
    }
    return { version: DRAFT_SCHEMA_VERSION, entries: valid }
  } catch { return empty() }
}

function bounded(snapshot: DraftSnapshot): DraftSnapshot {
  const kept = Object.entries(snapshot.entries)
    .filter(([, entry]) => entry.value && bytes(entry.value) <= MAX_VALUE_BYTES)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
  const entries: DraftSnapshot["entries"] = {}
  for (const [key, entry] of kept) {
    if (Object.keys(entries).length >= MAX_ENTRIES) break
    entries[key] = entry
    if (bytes(JSON.stringify({ version: DRAFT_SCHEMA_VERSION, entries })) > MAX_SNAPSHOT_BYTES) delete entries[key]
  }
  return { version: DRAFT_SCHEMA_VERSION, entries }
}

function unexpired(snapshot: DraftSnapshot, now = Date.now()): DraftSnapshot {
  const entries: DraftSnapshot["entries"] = {}
  for (const [key, entry] of Object.entries(snapshot.entries)) if (now - entry.touchedAt <= DRAFT_TTL_MS) entries[key] = entry
  return { version: DRAFT_SCHEMA_VERSION, entries }
}

// Reading the property can itself throw (a browser set to block site data), and a page without storage
// still has to be typed into: the store then keeps to this tab's memory, as it does under Node.
function browserStorage(area: "localStorage" | "sessionStorage"): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window[area] } catch { return undefined }
}

export class DraftStore {
  // `snapshot` is the current tab's complete controlled-input source of truth. Persistence is a
  // bounded projection of it: quota or a hard persisted-value cap must never blank a textarea that
  // the user is actively editing.
  private snapshot: DraftSnapshot = empty()
  private listeners = new Set<Listener>()
  private readonly storage: DraftStorage | undefined
  // The exact string this tab last read from or wrote to storage. Any OTHER string there is another
  // tab's write — which is the whole test `adopt` makes, so the keystrokes where nothing moved cost a
  // string compare rather than a parse.
  private persistedRaw: string | null = null
  // Keys whose state HERE is not what storage holds: a value the bounded projection had to leave out,
  // or a write storage refused. Another tab's snapshot must neither blank those nor bring back one
  // this tab cleared, so they are the one thing `adopt` keeps from memory.
  private unpersisted = new Set<string>()
  constructor(storage: DraftStorage | undefined = browserStorage("localStorage"), legacy?: LegacyDraftStorage) {
    this.storage = storage
    this.adopt(this.read())
    if (legacy) this.migrate(legacy)
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get(key: string): string { return this.snapshot.entries[key]?.value ?? "" }
  set(key: string, value: string): void {
    // READ, THEN WRITE. Every write stores the WHOLE snapshot, so a tab writing from a stale one would
    // erase the draft another tab just typed and put back the one it just sent. The `storage` event
    // keeps an open tab current, but an event is a thing that can be missed (a page restored from the
    // back/forward cache never got its); re-reading here makes the write correct either way.
    const adopted = this.adopt(this.read())
    if (!value && !this.snapshot.entries[key]) {
      if (adopted) this.emit()
      return
    }
    const entries = { ...this.snapshot.entries }
    if (!value) delete entries[key]
    else entries[key] = { value, touchedAt: Date.now() }
    this.commit({ version: DRAFT_SCHEMA_VERSION, entries }, [key])
  }
  clear(key: string): void { this.set(key, "") }
  /** Another tab may have written: take what it stored, and tell this tab's fields if there was any. */
  refresh = (): void => { if (this.adopt(this.read())) this.emit() }
  private read(): string | null {
    try { return this.storage?.getItem(DRAFT_STORAGE_KEY) ?? null } catch { return null }
  }
  private emit(): void { for (const listener of this.listeners) listener() }
  private adopt(raw: string | null): boolean {
    // A MISSING key is not news. A store this app wrote is at least `{"version":1,"entries":{}}`, so
    // null means storage was emptied from under the page, and that never blanks a box someone is
    // typing in; the next write puts the snapshot back.
    if (raw === null || raw === this.persistedRaw) return false
    this.persistedRaw = raw
    const entries = unexpired(parseDraftSnapshot(raw)).entries
    for (const key of this.unpersisted) {
      const mine = this.snapshot.entries[key]
      if (mine) entries[key] = mine
      else delete entries[key]
    }
    this.snapshot = { version: DRAFT_SCHEMA_VERSION, entries }
    return true
  }
  private commit(next: DraftSnapshot, touched: readonly string[]): boolean {
    this.snapshot = next
    // A too-large value remains in this tab's memory and subscribers see it immediately. `bounded`
    // excludes it from the stored snapshot, instead of replacing the controlled input with "".
    const stored = bounded(next)
    const raw = JSON.stringify(stored)
    let persisted = false
    if (this.storage) {
      try {
        this.storage.setItem(DRAFT_STORAGE_KEY, raw)
        this.persistedRaw = raw
        this.unpersisted = new Set(Object.keys(next.entries).filter((key) => !stored.entries[key]))
        persisted = true
      } catch { for (const key of touched) this.unpersisted.add(key) }
    }
    this.emit()
    return persisted
  }
  // ONE-TIME BRIDGE (2026-10-11). Drafts were per-tab sessionStorage until this build, so the tab that
  // loads it may be holding words typed a minute ago under the old home. Fold them in — the newer copy
  // of a key wins — and retire the old key only once they are stored. Delete this, and the `legacy`
  // parameter, once no tab from before the move can still be open.
  private migrate(legacy: LegacyDraftStorage): void {
    let raw: string | null = null
    try { raw = legacy.getItem(DRAFT_STORAGE_KEY) } catch { return }
    if (raw === null) return
    const entries = { ...this.snapshot.entries }
    const moved: string[] = []
    for (const [key, entry] of Object.entries(unexpired(parseDraftSnapshot(raw)).entries)) {
      if (entries[key] && entries[key].touchedAt >= entry.touchedAt) continue
      entries[key] = entry
      moved.push(key)
    }
    if (moved.length > 0 && !this.commit({ version: DRAFT_SCHEMA_VERSION, entries }, moved)) return
    try { legacy.removeItem(DRAFT_STORAGE_KEY) } catch {}
  }
}

export const draftStore = new DraftStore(browserStorage("localStorage"), browserStorage("sessionStorage"))

// THE LIVE HALF OF SHARING: a write in one tab reaches the tabs that are already open. The browser
// sends `storage` to every OTHER same-origin document, never to the writer, so adopting it cannot echo.
// `pageshow` covers the one document that event skips — a page coming back out of the back/forward
// cache, which was not live to receive it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const onStorage = (event: StorageEvent) => { if (event.key === DRAFT_STORAGE_KEY) draftStore.refresh() }
  window.addEventListener("storage", onStorage)
  window.addEventListener("pageshow", draftStore.refresh)
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener("pageshow", draftStore.refresh)
  })
}

// Put words back into a draft WITHOUT losing what is already there — the one rule every "give the
// operator their text back" path shares (an unqueued send, a failed send, a failed bubble's Edit).
// The returned text goes ABOVE the existing draft, separated by a blank line: it was written first,
// and whatever is in the box was typed after it. The composer's rollback used to restore only into an
// EMPTY box and silently drop the failed message otherwise.
//
// Already present verbatim → nothing to add (a second rollback of the same send, or an Edit of words
// the rollback already put back).
export function mergeIntoDraft(key: string, text: string): void {
  if (!text) return
  const existing = draftStore.get(key)
  if (existing.includes(text)) return
  draftStore.set(key, existing ? `${text}\n\n${existing}` : text)
}

export function projectDraftScope(projectDir: string | undefined): string {
  return encodeURIComponent(projectDir || "unresolved-project")
}

// ONE THREAD, ONE KEY, WHICHEVER PAGE ITS BOX IS ON. The Console names a thread `<project>~<slug>`
// (lib/threadKey.ts) where its project's own page names it `<slug>`, and its merged board has no
// `projectDir` — so a reply typed on a Console card was stored under `unresolved-project` + the key,
// and the card's fullscreen door opened the project's /full page on an EMPTY box; a send there left the
// sent words on the Console card to be sent again (review finding 5). A Console surface passes its
// project's real directory (useProjectDir, from its <ProjectScope>), and here the key loses its project
// prefix, so both pages address the identical `<dir>:<bare slug>` entry. A key with no directory to go
// with it keeps the prefix: two projects' `fix-auth` must not meet under `unresolved-project`.
function draftSlug(projectDir: string | undefined, slug: string): string {
  return encodeURIComponent(projectDir ? splitThreadKey(slug)?.slug ?? slug : slug)
}
function threadDraftScope(projectDir: string | undefined, slug: string): string {
  return `${projectDraftScope(projectDir)}:${draftSlug(projectDir, slug)}`
}

export const draftKey = {
  dispatch: (projectDir: string | undefined) => `dispatch:${projectDraftScope(projectDir)}:new`,
  followUp: (projectDir: string | undefined, slug: string, sessionId?: string) => `followup:${threadDraftScope(projectDir, slug)}:${encodeURIComponent(sessionId ?? "unowned")}`,
  adopt: (projectDir: string | undefined, slug: string) => `adopt:${threadDraftScope(projectDir, slug)}`,
  answer: (projectDir: string | undefined, slug: string, sessionId: string | undefined, messageId: string, block: number) => `answer:${threadDraftScope(projectDir, slug)}:${encodeURIComponent(sessionId ?? "unowned")}:${encodeURIComponent(messageId)}:${block}`,
  interaction: (projectDir: string | undefined, projectId: string, slug: string, sessionId: string, epoch: number, id: string, field: string) => `interaction:${projectDraftScope(projectDir)}:${encodeURIComponent(projectId)}:${draftSlug(projectDir, slug)}:${encodeURIComponent(sessionId)}:${epoch}:${encodeURIComponent(id)}:${encodeURIComponent(field)}`,
  // A REGISTERED question's free-text box. Keyed by the question's own durable id and its node path in
  // the follow-up tree — no session or epoch, because a registered question outlives the session that
  // asked it (that is the whole point of it being a row), and a half-typed answer must survive the
  // worker restarting under it.
  question: (projectDir: string | undefined, slug: string, id: string, path: string) => `question:${threadDraftScope(projectDir, slug)}:${encodeURIComponent(id)}:${encodeURIComponent(path)}`,
  // The same node's staged option picks (lib/registeredPicks encodes them). The text key plus a suffix,
  // so picks share its exact project/thread/question/path scope; the encoded path never holds a `:`.
  questionPick: (projectDir: string | undefined, slug: string, id: string, path: string) => `${draftKey.question(projectDir, slug, id, path)}:picks`,
  // There is no `settings:` key: the Settings drawer autosaves, so the server IS its draft store. A
  // sessionStorage mirror could only ever hold the ~500ms of typing the debounce has not written yet,
  // and it outlived the save — a stale entry that reappeared over the stored value on the next open.
}

/**
 * The directory a draft is scoped by: the page's project's, or on the Console the project of the
 * surface's <ProjectScope> — the Console's merged board has none of its own (see threadDraftScope).
 */
export function useProjectDir(): string | undefined {
  const project = useProjectScope()
  const read = useCallback(() => (project ? projectPathDir(project) : ""), [project])
  const scoped = useSyncExternalStore(subscribeLocalPathBase, read, read)
  const boardDir = useSnapshot(store).board?.projectDir
  return scoped || boardDir
}
// Read off the live board's snapshot by table rather than through a tracked view of it: a tracked read
// of the threads array costs proxy-compare a pass over every slot each time a delta replaces it, which a
// board's Done history makes long (hooks.ts useThreadSnapshot). A string, so only a new session re-renders.
const onStoreChange = (notify: () => void) => subscribe(store, notify)
export function useThreadSessionId(slug: string): string | undefined {
  return useSyncExternalStore(onStoreChange, () => threadSnapshotBySlug(slug)?.sessionId)
}
// SUBSCRIBE TO THE VALUE, NEVER TO THE SNAPSHOT OBJECT. `commit` replaces `this.snapshot` wholesale on
// every keystroke, so a hook whose `getSnapshot` returns that object re-renders on EVERY edit to ANY
// draft anywhere in the app — and `useLiveAnswering` calls `useDraftValues` from TodosView, near the top
// of the board tree, so one keystroke in the composer re-rendered the entire board: every queue card,
// every Radix tooltip/popover/menu under it. Measured before this change: 1096 React renders and 47ms of
// render work for ONE character typed into the composer.
//
// `useSyncExternalStore` bails out when `getSnapshot` returns an Object.is-equal value, so returning the
// key's own STRING makes an unrelated field's edit a genuine no-op instead of an app-wide render.
export function useDraft(key: string): readonly [string, (value: string) => void, () => void] {
  const read = useCallback(() => draftStore.get(key), [key])
  const value = useSyncExternalStore(draftStore.subscribe, read, read)
  const set = useCallback((next: string) => draftStore.set(key, next), [key])
  const clear = useCallback(() => draftStore.clear(key), [key])
  return [value, set, clear] as const
}

// A form can expose several independently addressed text fields. One subscription keeps duplicate
// representations (queue card + drawer) coherent without serializing the form object itself.
//
// Same rule as useDraft, one step harder: the subscribed value has to collapse SEVERAL keys into one
// Object.is-comparable primitive. JSON of exactly these keys does that — it changes when one of THEM
// changes and not otherwise — and doubles as the memo key, so the returned Map also keeps a stable
// identity for whatever downstream memoization depends on it.
export function useDraftValues(keys: readonly string[]): ReadonlyMap<string, string> {
  const read = useCallback(
    () => JSON.stringify(Object.fromEntries(keys.map((key) => [key, draftStore.get(key)]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is rebuilt every render by every
    // caller; the JOINED key list is the real dependency, and it is what the callers keep stable.
    [keys.join(" ")],
  )
  const serialized = useSyncExternalStore(draftStore.subscribe, read, read)
  return useMemo(() => new Map(Object.entries(JSON.parse(serialized) as Record<string, string>)), [serialized])
}
