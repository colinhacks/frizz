// The client's view of the server's RPC surface — the ONE declaration every browser call site is
// checked against.
//
// WHY THIS FILE IS SEPARATE FROM rpc.ts (and why it may only contain types + plain data):
// it is compiled a SECOND time, by the server package's typecheck, where `packages/server/src/
// rpc-contract.ts` proves — procedure by procedure — that every declaration below is EXACTLY the
// zod `input`/`output` of the real router. That is the structural gate that replaced the old
// hand-mirroring hazard: a server schema change the client does not satisfy now fails
// `npm run typecheck` instead of surfacing as a runtime toast in the operator's face
// ("Couldn't finish: sessionId: Required").
//
// The gate only works while this module stays importable from a NODE program with no DOM lib and no
// browser globals. So: `import type` only, no runtime imports, no `location`/`fetch`/`window`, and
// nothing but the `PROCEDURES` data table as a value. Transport concerns (fetch, RpcCallOpts, the
// Proxy) live in rpc.ts, which is browser-only and never enters the server program.
import type {
  BoardSnapshot,
  Settings,
  DispatchInput,
  AdoptThreadInput,
  AdoptThreadResult,
  FollowUpInput,
  UnqueueFollowUpInput,
  UnqueueFollowUpResult,
  DeliverQueuedNowInput,
  DeliverQueuedNowResult,
  RenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadSkillsInput,
  ThreadSkillsResult,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  SetThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptResult,
  SetOwnThreadTitleInput,
  SetOwnThreadTitleResult,
  GetOwnThreadRecurringPromptInput,
  OwnThreadRecurringPromptResult,
  SetOwnThreadStopHookInput,
  SetOwnThreadHeartbeatInput,
  SetOwnThreadTimerInput,
  SetOwnThreadTimerResult,
  CancelOwnThreadTimerInput,
  CancelOwnThreadTimerResult,
  ListOwnThreadTimersInput,
  ListOwnThreadActivityInput,
  OwnThreadActivityResult,
  OwnThreadTimersResult,
  ThreadPluginReloadResult,
  SetThreadPinnedInput,
  SetThreadSnoozeInput,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  GithubStatus,
  GithubListResult,
  GithubBatchInput,
  GithubBatchResult,
  GithubRefPreviewResult,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  AccountLoginStartInput,
  AccountLoginStartResult,
  AccountLoginStatusInput,
  AccountLoginStatusResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
  CompletionHold,
  ProjectCard,
  ThreadLocation,
  DirectoryPickResult,
  AddOwnPrWatchInput,
  AddOwnWatchInput,
  AddOwnWatchResult,
  DropOwnWatchInput,
  DropOwnWatchResult,
  AskInput,
  AskResult,
  MarkOwnDoneInput,
  MarkOwnDoneResult,
  UnaskInput,
  UnaskResult,
  AnswerQuestionsInput,
  AnswerQuestionsResult,
  DismissQuestionsInput,
  DismissQuestionsResult,
  AddOwnPrWatchResult,
  DropOwnPrWatchInput,
  DropOwnPrWatchResult,
  ListOwnPrWatchesInput,
  OwnPrWatchesResult,
} from "@frizz/shared"

// Per-call transport options — declared here (not in rpc.ts) only because two procedures name it in
// their signature. It is a CLIENT-side extension: the drift gate compares `Parameters<…>[0]`, so an
// extra trailing optional argument is deliberately invisible to it.
export interface RpcCallOpts {
  signal?: AbortSignal
}

export interface Api {
  board(): Promise<BoardSnapshot>
  threadBody(input: { slug: string }): Promise<{ markdown: string }>
  threadTranscript(input: { slug: string }): Promise<TranscriptPage>
  threadTranscriptEarlier(input: TranscriptEarlierInput): Promise<TranscriptPage>
  // `steerable` is the server's answer to "can this child be prompted right now" — a broker-backed
  // claude thread's own live Agent-tool child, and nothing else. The drawer renders its prompt box
  // if and only if this is true; the client never re-derives the policy.
  subAgentTranscript(input: { slug: string; id: string }): Promise<{ messages: TranscriptMessage[]; state: "running" | "stale" | "done" | "gone"; steerable: boolean; steerNote: string | null; stoppable: boolean; stopNote: string | null }>
  // Deliver a steer INTO one running sub-agent's own conversation (not the thread's main turn).
  // Throws when the child settled first — see the router's subAgentSteer for why that must fail loudly.
  subAgentSteer(input: { slug: string; id: string; message: string; deliveryId?: string }): Promise<{ delivered: boolean }>
  // Ends the child AND its whole live subtree — a stop names one task, and the provider's registry is
  // flat, so anything less orphans the grandchildren. `descendantsStopped` counts the extra tasks
  // ended; `note` narrates the fan-out, including any descendant that could NOT be stopped.
  subAgentStop(input: { slug: string; id: string }): Promise<{ stopped: boolean; descendantsStopped: number; note: string | null }>
  backgroundShellOutput(input: { slug: string; id: string }): Promise<{ command: string | null; output: string; truncated: boolean; state: "running" | "done" | "gone"; stoppable: boolean; stopNote: string | null }>
  // The ops strip's live output counter, batched over every shell row it is showing. `lines: null` is
  // "no readable output yet" (a shell still between its tool_use and its launch ack) — never zero, and
  // never an omission, which would stop the poll before the path ever arrived.
  backgroundShellActivity(input: { slug: string; ids: string[] }): Promise<{ shells: { id: string; lines: number | null; running: boolean }[] }>
  // The × on a live sub-agent / background-shell row. It MEANS stop: the server tries the real
  // provider control first and only then retires the row. `stopped` says whether work was actually
  // terminated; `note` is why it could not be, when there is a reason worth telling the operator —
  // without it the row would vanish while the child kept running, which is the whole bug this
  // endpoint replaced. `dismissed:false` when the id was no longer live to retire. The stop covers the
  // child's whole live SUBTREE (`descendantsStopped` counts the rest), because stopping only the named
  // row left its grandchildren running and still reporting into this thread.
  stopBackgroundOp(input: { slug: string; id: string }): Promise<{ stopped: boolean; dismissed: boolean; note: string | null; descendantsStopped: number }>
  // Scoped typed requests are read/answered only for the current registered session. There is
  // deliberately no browser create method: provider adapters alone can journal a request.
  pendingInteractions(input: ListInteractionsInput): Promise<ListInteractionsResult>
  interactionGet(input: GetInteractionInput): Promise<GetInteractionResult>
  interactionResolve(input: ResolveInteractionInput): Promise<ResolveInteractionResult>
  interactionCancel(input: CancelInteractionInput): Promise<CancelInteractionResult>
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  adoptThread(input: AdoptThreadInput): Promise<AdoptThreadResult>
  // `opts` carries the send deadline. A follow-up is the one mutation that can be held open
  // indefinitely by a server-side wait, and it runs inside a per-slug FIFO — see
  // lib/eagerComposerSubmission.ts DELIVERY_SEND_TIMEOUT_MS for what that costs without one.
  followUp(input: FollowUpInput, opts?: RpcCallOpts): Promise<void>
  unqueueFollowUp(input: UnqueueFollowUpInput): Promise<UnqueueFollowUpResult>
  // The ↑ on a queued bubble: stop waiting and make the worker read what is already queued. No message
  // payload — see DeliverQueuedNowInput.
  deliverQueuedNow(input: DeliverQueuedNowInput): Promise<DeliverQueuedNowResult>
  setThreadPermission(input: SetThreadPermissionInput): Promise<SetThreadPermissionResult>
  threadProfileOptions(input: ThreadProfileOptionsInput): Promise<ThreadProfileOptionsResult>
  // The composer's `/` typeahead: the thread's invocable skills, as its own harness reports them.
  // Any failure (no live session, a legacy row) means "no suggestions", never a surfaced error.
  threadSkills(input: ThreadSkillsInput): Promise<ThreadSkillsResult>
  setThreadProfile(input: SetThreadProfileInput): Promise<SetThreadProfileResult>
  markRead(input: { slug: string }): Promise<void>
  // Opening a thread records read/seen telemetry only. Queue membership is lifecycle-driven and is
  // never cleared by viewing a resting thread. No-op for a foreign thread (no registry row).
  threadSeen(input: { slug: string }): Promise<void>
  // The ONLY writer of a session thread's open|archived lifecycle (the done fence mutates nothing).
  setThreadState(input: { slug: string; state: "open" | "archived" }): Promise<void>
  // Completes an inactive session immediately. A live provider shell reports that confirmation is
  // required; the caller must opt into its termination before the row can move to Done. `hold` carries
  // WHY it declined — the executing turn and/or the named live sub-agents/shells — for the dialog to name.
  // `sessionId` binds the click to the session the tab was looking at: a stale tab fails closed rather
  // than completing whatever now owns the slug.
  completeThread(input: { slug: string; sessionId: string; terminateLive?: boolean }): Promise<{ needsConfirmation: boolean; hold?: CompletionHold }>
  setThreadSnooze(input: SetThreadSnoozeInput): Promise<void>
  // Pin/unpin the thread out of the rail's band system (the pinned band at the top of the rail).
  setThreadPinned(input: SetThreadPinnedInput): Promise<void>
  // THE RECURRING PROMPT, armed entirely from the footer panel: one text, and up to two triggers
  // (every rest, and/or every N minutes). Text, triggers and cadence travel together — they are one row.
  setThreadRecurringPrompt(input: SetThreadRecurringPromptInput): Promise<void>
  // The WORKER-facing counterpart, called by `mcp__frizz__goal` rather than by this client.
  // Declared here because rpc-contract.ts proves the two procedure NAME SETS are equal — an RPC the
  // client cannot name is one nothing checks the shape of. No browser call site uses it.
  setOwnThreadRecurringPrompt(input: SetOwnThreadRecurringPromptInput): Promise<SetOwnThreadRecurringPromptResult>
  // The READ half of the same tool (`action: "get"`), so a worker can see the row before it overwrites
  // it — after a compaction, or after the human edited the text in the footer panel.
  getOwnThreadRecurringPrompt(input: GetOwnThreadRecurringPromptInput): Promise<OwnThreadRecurringPromptResult>
  // THE WORKER NAMING ITS OWN THREAD, called by `mcp__frizz__title`. Declared here for the drift gate
  // alone — the browser's rename verbs are `renameThread` / `aiRenameThread`, which lock the name.
  setOwnThreadTitle(input: SetOwnThreadTitleInput): Promise<SetOwnThreadTitleResult>
  // THE PR WATCHER REGISTRY, called by `mcp__frizz__watch_pr` rather than by this client. Declared here
  // for the same reason as its neighbours: rpc-contract.ts proves the two procedure NAME SETS are equal,
  // so an RPC the client cannot name is one nothing checks the shape of. No browser call site uses these.
  addOwnPrWatch(input: AddOwnPrWatchInput): Promise<AddOwnPrWatchResult>
  dropOwnPrWatch(input: DropOwnPrWatchInput): Promise<DropOwnPrWatchResult>
  listOwnPrWatches(input: ListOwnPrWatchesInput): Promise<OwnPrWatchesResult>
  // THE WORKER'S OWN WATCHES on its own running work, called by `mcp__frizz__watch` / `unwatch`. Same
  // story as the PR watchers above: declared for the drift gate, never called from the browser.
  addOwnWatch(input: AddOwnWatchInput): Promise<AddOwnWatchResult>
  dropOwnWatch(input: DropOwnWatchInput): Promise<DropOwnWatchResult>
  // THE WORKER'S REGISTERED QUESTIONS. `ask`/`unask` are the worker's and are declared here for the
  // drift gate alone; the two below ARE called from the browser — they are what the question card does.
  ask(input: AskInput): Promise<AskResult>
  unask(input: UnaskInput): Promise<UnaskResult>
  // The worker's gated completion verb. Declared here for the drift gate's sake — the browser never
  // calls it, exactly as it never calls `ask`.
  markOwnDone(input: MarkOwnDoneInput): Promise<MarkOwnDoneResult>
  // The card's Send: every question it holds an answer for, in ONE call, because a per-question send
  // would half-wake a turn.
  answerQuestions(input: AnswerQuestionsInput): Promise<AnswerQuestionsResult>
  // The card's ×. It never wakes the worker — the human dismissing questions is almost always
  // dismissing several in a row, so a wake per click would be a turn per click; the worker is told at
  // its next wake instead. Refused server-side for a danger-tagged question, which the card also does
  // not offer it on.
  dismissQuestions(input: DismissQuestionsInput): Promise<DismissQuestionsResult>
  // THE SUPERSEDED WORKER PROCEDURES, declared here only so the drift gate can see them. A worker's MCP
  // server outlives every frizz restart, so a session dispatched before the stop hook and the heartbeat
  // merged is still POSTing these names; the router aliases them onto the one recurring-prompt row
  // (`applyLegacyWorkerTrigger`). No browser call site uses them, and none should — the gate proves the
  // two procedure NAME SETS are equal, so an alias the client cannot name is an alias nothing checks.
  setOwnThreadStopHook(input: SetOwnThreadStopHookInput): Promise<void>
  setOwnThreadHeartbeat(input: SetOwnThreadHeartbeatInput): Promise<void>
  setThreadHeartbeat(input: SetOwnThreadHeartbeatInput): Promise<void>
  // THE ONE-OFF TIMERS, called by `mcp__frizz__timer` rather than by this client. Declared here for the
  // same reason as the worker procedures above — the drift gate proves the two procedure NAME SETS are
  // equal, so an RPC the client cannot name is one nothing checks the shape of. All three are mutations
  // because the worker's MCP server POSTs every call; `listOwnThreadTimers` reads nothing and is one
  // anyway. No browser call site uses them.
  setOwnThreadTimer(input: SetOwnThreadTimerInput): Promise<SetOwnThreadTimerResult>
  cancelOwnThreadTimer(input: CancelOwnThreadTimerInput): Promise<CancelOwnThreadTimerResult>
  listOwnThreadTimers(input: ListOwnThreadTimersInput): Promise<OwnThreadTimersResult>
  listOwnThreadActivity(input: ListOwnThreadActivityInput): Promise<OwnThreadActivityResult>
  // In-place plugin reload for a broker-backed Claude thread — the alternative to a hard restart.
  reloadThreadPlugins(input: { slug: string; sessionId: string }): Promise<ThreadPluginReloadResult>
  // Event-snooze the awaiting-background card: hide it until the thread's own background work returns
  // (the parent comes to a NEW rest). No deadline and no scheduler — the board re-surfaces it the moment
  // rested_at advances. `sessionId` binds the click to the session the tab was looking at.
  snoozeAwaitingBackground(input: { slug: string; sessionId: string }): Promise<void>
  // Hard-delete: drop a stalled/exited phantom's registry row and tombstone its transcript id.
  // Refused for a genuinely live session — archive that one instead.
  forgetThread(input: { slug: string }): Promise<void>
  // Server-authoritative, shell-safe provider resume command for a registered Frizz-owned session.
  // A live Frizz-owned runtime is deliberately unavailable: a second provider client is uncoordinated.
  threadTerminalCommand(input: { slug: string }): Promise<{ command: string | null; mode: "attach" | "resume" | "unavailable"; reason: string | null }>
  openExternal(input: { url: string }): Promise<void>
  openLocalFile(input: { path: string; image?: boolean }): Promise<{ action: "opened" | "copy"; path: string }>
  // A disk-local Markdown file's source, for the built-in reader drawer. Openable-root gated and
  // extension-locked server-side; `truncated` marks a file cut at the read ceiling.
  localMarkdown(input: { path: string }): Promise<{ path: string; markdown: string; truncated: boolean }>
  localFile(input: { path: string }): Promise<{ path: string; text: string; truncated: boolean }>
  // Classify path references (as they appear in inline code) → canonical openable path, or null when the
  // candidate doesn't resolve to a real file under the server's openable roots. Drives clickable inline code.
  resolveLocalPaths(input: { paths: string[] }): Promise<{ resolved: { input: string; path: string | null }[] }>
  markComplete(input: { slug: string }): Promise<void>
  setThreadStatus(input: { slug: string; status: "active" | "planning" | "planned" | "needs-human" | "blocked" | "done" | "dismissed" }): Promise<void>
  dismissThread(input: { slug: string }): Promise<void>
  repairThread(input: { file: string }): Promise<{ slug: string }>
  archiveThread(input: { slug: string }): Promise<void>
  killAgent(input: { slug: string }): Promise<void>
  renameThread(input: RenameThreadInput): Promise<void>
  aiRenameThread(input: { slug: string }): Promise<AiRenameThreadResult>
  // The selectable Codex models + per-model effort options, read server-side from the authoritative
  // ~/.codex/models_cache.json (never a hand-maintained list). The model picker's Codex section and its
  // effort dropdown are driven by this; a tiny client fallback covers the loading/no-cache state.
  codexModels(): Promise<CodexModel[]>
  // Provider subscription quota (5h + weekly windows) for the sidebar status bar. `force` bypasses
  // the shared freshness window for an explicit user recheck.
  quota(input?: { force?: boolean }, opts?: RpcCallOpts): Promise<QuotaSnapshot>
  // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from quota's
  // overloaded "unavailable" — reports only whether a credential exists. Never rejects.
  authStatus(input?: undefined, opts?: RpcCallOpts): Promise<AuthSnapshot>
  accountLogout(input: AccountLogoutInput): Promise<AccountLogoutResult>
  // Slice B login utility: start/attach/inspect/cancel the restricted `claude auth login` terminal.
  accountLoginStart(input: AccountLoginStartInput): Promise<AccountLoginStartResult>
  accountLoginStatus(input: AccountLoginStatusInput): Promise<AccountLoginStatusResult>
  accountLoginCancel(input: AccountLoginStatusInput): Promise<Record<never, never>>
  // Machine-scoped: the registry is one file, so the grid reads the same from every project.
  // Which project owns a thread slug. Every URL from the per-project era is unprefixed, so a
  // bookmark that named its project by PORT now resolves against whichever project launched the
  // server — this is how the page finds the thread instead of reporting it missing.
  threadLocate(input: { slug: string }): Promise<ThreadLocation[]>
  projectsList(): Promise<ProjectCard[]>
  // Registering a folder as a project — the grid phantom card. Same authority as running `frizz`
  // there and strictly less: it resolves an id and writes the index, and dispatches nothing.
  // Opens the machine NATIVE folder picker, server-side, and adds what comes back. The browser API
  // withholds absolute paths on purpose, and a project is a path — so the picker cannot live here.
  projectPick(input: Record<never, never>): Promise<DirectoryPickResult>
  projectAdd(input: { path: string }): Promise<ProjectCard>
  // The rail's squares. `projectIconSet` takes base64 from a browser file input (the bytes land in the
  // project's state dir, never in its working tree); clearing hands the square back to the automatic
  // scan, which is also what draws it in the first place — see server/project-icon.ts.
  // The rail's manual order: the whole list of ids, because the client has just laid the squares out
  // and an index pair would have to be replayed against a server order that may already differ.
  projectsReorder(input: { ids: string[] }): Promise<ProjectCard[]>
  // Delete a project: Frizz's record of it, never the folder it names. Without `deleteData` this only
  // forgets the registry entry and closes the project, so adding the folder back restores the same
  // board; with it, the project's live workers are stopped and everything Frizz holds for it is
  // removed. The project Frizz is RUNNING from is refused — see the router.
  projectRemove(input: { id: string; deleteData?: boolean }): Promise<{ removed: boolean; deletedData: boolean; stoppedWorkers: number }>
  // Queue size per OPEN project, keyed by project id — the rail's badges. A project with no board on
  // this server is absent (no honest count without one), which the rail draws as no badge rather than
  // as zero. The server opens every registered project within about a second of boot, so that is a transient
  // state and not the "you have not clicked into it yet" it used to be — see server/tenant-prime.ts.
  projectsQueueCounts(): Promise<Record<string, number>>
  // Opens the machine's native image picker ALREADY IN the project's directory, then stores what
  // comes back. The browser input cannot be aimed anywhere, which is the whole reason this exists.
  projectIconPick(input: { id: string }): Promise<DirectoryPickResult>
  projectIconSet(input: { id: string; name: string; data: string }): Promise<ProjectCard>
  projectIconClear(input: { id: string }): Promise<ProjectCard>
  settingsGet(): Promise<Settings>
  settingsSet(input: Settings): Promise<Settings>
  // Takes an empty object, not nothing: the router declares `input: z.object({})` (a mutation always
  // has an input schema), and the transport posts `{}` for it.
  settingsReset(input: Record<never, never>): Promise<Settings>
  dispatchPreferencesGet(): Promise<DispatchPreferences>
  dispatchPreferenceSet(input: SetDispatchPreferenceInput): Promise<DispatchPreferences>
  // The shipped GitHub batch-dispatch prompt template — the Settings UI prefills its editor from this
  // and resets to it (an empty githubPrompt setting = the server default). One template, issues and PRs.
  githubPromptDefaults(): Promise<{ prompt: string }>
  // GitHub-first batch dispatch. Detection (installed/inRepo/nameWithOwner) is cached server-side;
  // `authed` is re-checked live per call. githubList reads the repo's issues/PRs; githubDispatchBatch
  // hydrates each selected item fresh + spins up one thread per item (sequential, reuses dispatch).
  githubStatus(): Promise<GithubStatus>
  githubList(input: { kind: "issues" | "prs"; sort: "recent" | "reactions"; page?: number; perPage?: number }): Promise<GithubListResult>
  githubDispatchBatch(input: GithubBatchInput): Promise<GithubBatchResult>
  // Hovercards for the `#123` / commit-hash anchors the autolinker mints in prose. ONE call carries
  // every reference on the page so a hover reads out of the client's store instead of the network;
  // `refresh` revalidates the few the reader is actually pointing at. See lib/githubHovercards.ts.
  githubRefPreview(input: { refs: string[]; refresh?: boolean }): Promise<GithubRefPreviewResult>
}

export type ProcType = "query" | "mutation"

// The GET-vs-POST decision for every procedure. It drifts exactly as silently as the types do — a
// query flipped to a mutation server-side turns every client call into a 404/405 — so the same gate
// compares this table against each procedure's `_tag`. `as const` keeps the literal types the gate
// needs; the `satisfies` keeps it exhaustive over `Api`.
export const PROCEDURES = {
  board: "query",
  threadBody: "query",
  threadTranscript: "query",
  threadTranscriptEarlier: "query",
  subAgentTranscript: "query",
  subAgentSteer: "mutation",
  subAgentStop: "mutation",
  backgroundShellOutput: "query",
  backgroundShellActivity: "query",
  stopBackgroundOp: "mutation",
  pendingInteractions: "query",
  interactionGet: "query",
  interactionResolve: "mutation",
  interactionCancel: "mutation",
  dispatch: "mutation",
  adoptThread: "mutation",
  followUp: "mutation",
  unqueueFollowUp: "mutation",
  deliverQueuedNow: "mutation",
  setThreadPermission: "mutation",
  threadProfileOptions: "query",
  threadSkills: "query",
  setThreadProfile: "mutation",
  markRead: "mutation",
  threadSeen: "mutation",
  setThreadState: "mutation",
  completeThread: "mutation",
  setThreadSnooze: "mutation",
  setThreadPinned: "mutation",
  setThreadRecurringPrompt: "mutation",
  setOwnThreadRecurringPrompt: "mutation",
  setOwnThreadTitle: "mutation",
  addOwnPrWatch: "mutation",
  dropOwnPrWatch: "mutation",
  listOwnPrWatches: "mutation",
  addOwnWatch: "mutation",
  dropOwnWatch: "mutation",
  ask: "mutation",
  unask: "mutation",
  markOwnDone: "mutation",
  answerQuestions: "mutation",
  dismissQuestions: "mutation",
  getOwnThreadRecurringPrompt: "mutation",
  setOwnThreadStopHook: "mutation",
  setOwnThreadHeartbeat: "mutation",
  setThreadHeartbeat: "mutation",
  setOwnThreadTimer: "mutation",
  cancelOwnThreadTimer: "mutation",
  listOwnThreadTimers: "mutation",
  listOwnThreadActivity: "mutation",
  reloadThreadPlugins: "mutation",
  snoozeAwaitingBackground: "mutation",
  forgetThread: "mutation",
  threadTerminalCommand: "query",
  openExternal: "mutation",
  openLocalFile: "mutation",
  localMarkdown: "query",
  localFile: "query",
  resolveLocalPaths: "query",
  markComplete: "mutation",
  setThreadStatus: "mutation",
  dismissThread: "mutation",
  repairThread: "mutation",
  archiveThread: "mutation",
  killAgent: "mutation",
  renameThread: "mutation",
  aiRenameThread: "mutation",
  codexModels: "query",
  quota: "query",
  authStatus: "query",
  accountLogout: "mutation",
  accountLoginStart: "mutation",
  accountLoginStatus: "query",
  accountLoginCancel: "mutation",
  threadLocate: "query",
  projectsList: "query",
  projectPick: "mutation",
  projectAdd: "mutation",
  projectsReorder: "mutation",
  projectRemove: "mutation",
  projectsQueueCounts: "query",
  projectIconPick: "mutation",
  projectIconSet: "mutation",
  projectIconClear: "mutation",
  settingsGet: "query",
  settingsSet: "mutation",
  settingsReset: "mutation",
  dispatchPreferencesGet: "query",
  dispatchPreferenceSet: "mutation",
  githubPromptDefaults: "query",
  githubStatus: "query",
  githubList: "query",
  githubDispatchBatch: "mutation",
  githubRefPreview: "query",
} as const satisfies Record<keyof Api, ProcType>
