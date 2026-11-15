import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react"
import { rpc, rpcFor, type Api } from "../api/rpc.ts"
import { isConsolePath, projectSlug } from "./base-path.ts"
import { fileRpc } from "./consoleProjects.ts"
import { useProjectScope } from "./projectScope.tsx"

// Clickable inline-code file paths. Agent prose often mentions files in backticks (`~/.claude/CLAUDE.md`,
// `packages/web/src/App.tsx`). When the text of an inline `<code>` resolves to a real file on disk under
// the server's openable roots, we tag it so the app-wide local-file click interceptor opens it in the
// user's editor/default app — same mechanism as a Markdown file link, just discovered from bare code.
//
// The existence check is a server round-trip (the browser can't stat), so this runs as a POST-render
// decoration: classify candidates locally to avoid statting every backtick, batch the unknowns to the
// server, and tag the ones that come back real. Resolutions are cached for the session.

// A bare filename: a stem, then ONE extension that opens with a letter (`cloudflare-ask.md`,
// `package.json`, `App.tsx`). The letter rule is what keeps a version (`1.2`, `v1.2`) and an
// abbreviation (`e.g.`, which ends on its dot) out. A member access (`Promise.resolve`) still matches;
// the server says no and it stays plain code, at the cost of one batched, cached round-trip.
const BARE_FILENAME = /^[\w.@+-]+\.[a-z][a-z0-9]{0,7}$/i

// A Windows path: an optional drive (`C:\`) or UNC (`\\`) prefix, then word-ish segments joined by
// backslashes — `C:\Users\x\a.ts`, `src\a.ts`, `~\.claude\CLAUDE.md`. That is what every file
// reference in a Windows worker's prose looks like, and until the Windows audit (2026-09-11, finding
// 12) none of them ever became a link because the test below asked for a `/`. The segment class is
// deliberately narrow: inline code is full of backslashes that are NOT paths (`\n`, `\d+`, `\\`), and
// each one this admits costs a batched round-trip the server answers with "no". A leading backslash
// that is not a UNC pair is an escape, not a root. An editor `:line[:col]` suffix rides along, as it
// does on a `/` path (the server strips it).
const WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\)?[\w.@+~-]+(?:\\[\w.@+~-]+)*(?::\d+(?::\d+)?)?$/

// A path-like candidate: no whitespace, not a URL, and either home-anchored (`~`), slash-bearing
// (absolute or repo-relative), backslash-joined in the Windows shape above, or a bare filename with an
// extension — the form a worker's question names a file it wrote at the project root in (`it's in
// \`cloudflare-ask.md\``), which reads as a link and, until 2026-08-25, was the one file reference in
// prose that never became one. Bare words and shell commands are excluded so we never stat
// `git status` or `useState`. Length-capped to match the server input bound.
export function isPathCandidate(raw: string): boolean {
  const v = raw.trim()
  if (!v || v.length > 1024 || /\s/.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false // http(s)://, file://, cursor://, mailto:, …
  if (v === "~" || v.startsWith("~/") || v.startsWith("/") || v.includes("/")) return true
  if (v.includes("\\") && WINDOWS_PATH.test(v)) return true
  return BARE_FILENAME.test(v)
}

// WHICH PROJECT A PATH IS RESOLVED IN. A relative path (`src/x.ts`, `README.md`) means a file in the
// directory of the project whose prose names it — the server resolves it against `ctx.project.dir` — so
// the answer depends on who asks, and the same text is a different file in each project. The resolver
// therefore asks the project of the SURFACE that renders the path: on the Console, the card's or
// drawer's <ProjectScope>; anywhere else, the page's own project. Until 2026-10-11 it asked
// `fileRpc(<first path in the batch>)`, which on the Console is the first open project for any relative
// path, so project B's card linked to project A's `README.md` (review finding 3).
//
// `key` partitions the cache by that same project. The cache was keyed by text alone, so an answer for
// one project was served to every other for the rest of the session — on the Console, and before it on
// a switch between two project pages.
export interface ResolveScope {
  key: string
  /** The API that answers for this scope's paths; null for a path this scope cannot place. */
  apiFor: (path: string) => Api | null
}

// An ANCHORED path names its file without a project: absolute, home-rooted, or a Windows drive/UNC.
const ANCHORED_PATH = /^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/

/** The scope a surface's paths resolve in. `project` is its <ProjectScope>; `pathname` is for tests. */
export function resolveScope(project: string | undefined, pathname?: string): ResolveScope {
  if (project) return { key: `project:${project}`, apiFor: () => rpcFor(project) }
  if (!isConsolePath(pathname)) {
    // The page's own project, named so a switch between two project pages keeps their answers apart.
    // (The unprefixed launching page and its `/project/<slug>` alias simply cache twice.)
    return { key: `page:${projectSlug(pathname) ?? ""}`, apiFor: () => rpc }
  }
  // The Console with no project to ask — the Markdown reader, which DrawerStack leaves unscoped. An
  // anchored path is answered alike by any project (one home-rooted gate, server/local-file.ts), so it
  // goes to the one holding it; a relative one has no directory to mean, and stays plain code rather
  // than borrowing an arbitrary project's.
  return { key: "console", apiFor: (path) => (ANCHORED_PATH.test(path) ? fileRpc(path) : null) }
}

// Session cache: `<scope key>\n<candidate text>` → canonical openable path, or null when it doesn't
// resolve to a real file under the gate. `undefined` = not yet asked. Module-scoped so every prose
// surface shares it and a given path is resolved once per project. Files rarely appear/vanish
// mid-session, so stale-none is acceptable.
const cache = new Map<string, string | null>()
const cacheKey = (scope: ResolveScope, text: string) => `${scope.key}\n${text}`

/** What `text` resolved to in `scope`: a path, null for "not a file", undefined while unasked. */
export function resolvedLocalFile(scope: ResolveScope, text: string): string | null | undefined {
  return cache.get(cacheKey(scope, text))
}

// Candidates a batch is out for right now. A second surface that finds the same path while the first
// surface's batch is in flight must not send it again — a question card's context, its options and its
// footnote each decorate their own element, and one path routinely appears in two of them.
const inflight = new Set<string>()

// The re-tag signal every mounted hook subscribes to: bumped whenever a batch lands with new answers,
// so EVERY surface re-runs its decoration — not only the one whose batch it was. A hook that waited
// on a path another hook had in flight is what this exists for; it never sent a request of its own,
// so nothing else would ever tell it the answer arrived.
let version = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const readVersion = () => version

// Matches the server's `resolveLocalPaths` input cap (router.ts). Candidates are chunked to this size so
// a path-heavy message (a big file listing in one prose block) can't blow the cap and lose EVERY link;
// each chunk resolves — or fails — independently.
const RESOLVE_BATCH = 128

// Resolve the not-yet-known candidates via batched queries; bumps `version` if any new answer landed. A
// chunk that fails its round-trip (e.g. an older server without the route) caches its own candidates as
// unresolved so they stay plain code until the next reload — without dropping the chunks that succeeded.
// Every chunk goes to ONE project's API, so a batch is grouped by the API each path is asked of.
export async function resolveUnknown(scope: ResolveScope, paths: string[]): Promise<void> {
  const wanted = [...new Set(paths)].filter((p) => !cache.has(cacheKey(scope, p)) && !inflight.has(cacheKey(scope, p)))
  if (!wanted.length) return
  for (const p of wanted) inflight.add(cacheKey(scope, p))
  const byApi = new Map<Api | null, string[]>()
  for (const p of wanted) {
    const api = scope.apiFor(p)
    byApi.set(api, [...(byApi.get(api) ?? []), p])
  }
  const chunks: { api: Api | null; paths: string[] }[] = []
  for (const [api, group] of byApi)
    for (let i = 0; i < group.length; i += RESOLVE_BATCH) chunks.push({ api, paths: group.slice(i, i + RESOLVE_BATCH) })
  const batches = await Promise.all(chunks.map(async ({ api, paths: chunk }) => {
    try {
      if (!api) throw new Error("no project to resolve against")
      return (await api.resolveLocalPaths({ paths: chunk })).resolved
    } catch {
      return chunk.map((input) => ({ input, path: null }))
    }
  }))
  let changed = false
  for (const resolved of batches) {
    for (const r of resolved) {
      const key = cacheKey(scope, r.input)
      if (!cache.has(key)) { cache.set(key, r.path); changed = true }
    }
  }
  for (const p of wanted) inflight.delete(cacheKey(scope, p))
  if (!changed) return
  version += 1
  for (const listener of listeners) listener()
}

function decorate(code: Element, openPath: string): void {
  code.setAttribute("data-local-path", openPath)
  // Drags out as its file (lib/localFileDrag.ts), as a link would. Like a link, it is then selected by
  // a double-click rather than by a drag that starts inside it.
  code.setAttribute("draggable", "true")
  code.setAttribute("title", `Open ${openPath}`)
  code.classList.add("local-file-code")
}

// Post-render decoration hook: after `html` is committed into `ref`, tag inline-code file references that
// resolve to real files. Runs in a LAYOUT effect so cached hits re-tag before paint (no flicker) when
// `html` changes — React replaced the innerHTML, wiping prior tags. Also re-runs after any batch
// resolves (via the shared `version`). Block code (inside `<pre>`) is left alone.
export function useLocalFileCodeLinks(ref: RefObject<HTMLElement | null>, html: string): void {
  const seen = useSyncExternalStore(subscribe, readVersion, readVersion)
  const project = useProjectScope()
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    // Captured here, at render, not after the round-trip: the page can move while a batch is out.
    const scope = resolveScope(project)
    const unknown: string[] = []
    for (const code of root.querySelectorAll("code")) {
      if (code.closest("pre")) continue // block code, not an inline reference
      // Code that is already the LABEL of a reference — [`draft.md`](/some/where/draft.md), or the
      // local-file button the sanitizer minted from it — is spoken for: the author chose its
      // destination. Tagging it would nest a second `data-local-path` inside the first, and the click
      // interceptor's `closest()` would find the inner one and open whatever a `draft.md` at the
      // project root happens to be, instead of the file the link names.
      if (code.closest("a, [data-local-path]")) continue
      const raw = (code.textContent ?? "").trim()
      if (!isPathCandidate(raw)) continue
      const resolved = resolvedLocalFile(scope, raw)
      if (resolved === undefined) unknown.push(raw)
      else if (resolved) decorate(code, resolved)
    }
    if (unknown.length) void resolveUnknown(scope, unknown)
  }, [ref, html, seen, project])
}
