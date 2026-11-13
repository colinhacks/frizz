import type { Context } from "hono"
import { AskedQuestionSchema, type AskedQuestion, type QuestionAnswer, type RelayAccess, type SocketClientMsg } from "@frizz/shared"
import type { RouterGuard } from "@frizz/rpc/server"
import { accessOf, CALLER_HEADER, recordAudit, requestOriginFrom, withRequestOrigin, type AuditLog } from "./audit.ts"
import { REMOTE_REFUSED_CODE, remoteHostLabel, remoteRefusedMessage } from "./remote-refusal.ts"
import type { AppRouter } from "./router.ts"

// ── WHAT A REMOTE SESSION MAY DO ────────────────────────────────────────────────────────────────────
// Two levels, and the proxy's stamp says which one a request is under (accessOf in audit.ts):
//
//  - FULL CONTROL is what a tab on this machine can do, short of `deny` below. A session through a tunnel or
//    a proxy of the owner's has it, and so does one through the Frizz relay unless the owner said otherwise.
//  - READ AND ANSWER is reading the board and picking listed options on question cards. The owner can choose
//    it for sessions through the Frizz relay, in the R pane, because that relay is the one hop here run by
//    someone else: on 2026-10-08 a backdoored build of it drove a real session and started about 13 workers.
//
// THE REST IS THE MACHINE'S, for every remote session. Minting a sign-in link, signing other devices out and
// the session directory are supervisor routes (MACHINE_ONLY_CONTROL_PATHS in restart-supervisor.ts), because a
// session is not presence on the machine. The read-and-answer setting has no route of any kind: it lives in
// the launcher's saved setup, and only the R pane changes it.
//
// DEFAULT DENY, IN ONE TABLE. `satisfies` below makes a new procedure fail typecheck until someone says
// which side it is on, and a name the table does not hold is refused at runtime. Widening what a remote
// session may do is changing one line here.
//
// ENFORCED WHERE A NAME BECOMES A PROCEDURE. The guard runs inside each route mountRouter registers
// (packages/rpc), so it answers for the procedure that was resolved, however the URL spelled it. A
// middleware reading the path would have to agree with the router about every encoding.
//
// A READ CAN STILL BE A WRITE. Each `allow` below was read for what it starts: several queries here spawn
// a process (`acpAgentModels`, `mcpStatus`, `threadSkills`) or read through this machine's credentials
// (`githubList`), and those are `full`.

type Refusal = string | null

interface GateChecks {
  /** The stored question a remote answer has to be judged against. */
  questionSpec(slug: string, questionId: string): { spec: string } | undefined
  /** Is this a path a remote caller may read? remote-reads.ts. */
  mayRead(path: string): boolean
}

/**
 * - `allow`: every remote session.
 * - `full`: full control only.
 * - A function: full control always. Under read and answer, only for this input: it returns why not, or null,
 *   and runs on parsed input.
 * - `deny`: no remote session.
 */
type RemoteRule = "allow" | "full" | "deny" | ((input: never, checks: GateChecks) => Refusal)

const onThisMachine = (what: string) => `${what} can only be done on ${remoteHostLabel()}.`

export const REMOTE_ACCESS = {
  // Reading the board and its threads.
  board: "allow",
  boardState: "allow",
  boardDeltas: "allow",
  threadBody: "allow",
  threadTranscript: "allow",
  threadTranscriptEarlier: "allow",
  threadSettledQuestions: "allow",
  threadRegisteredDone: "allow",
  threadLocate: "allow",
  pendingInteractions: "allow",
  interactionGet: "allow",
  subAgentTranscript: "allow",
  backgroundShellOutput: "allow",
  backgroundShellActivity: "allow",
  monitorOutput: "allow",
  threadTimer: "allow",
  projectsList: "allow",
  projectsRailCounts: "allow",

  // What the page reads as it loads. None of these takes input that reaches a process.
  settingsGet: "allow",
  dispatchPreferencesGet: "allow",
  runtimeDownloads: "allow",
  codexModels: "allow",
  acpAgents: "allow",
  quota: (input: { force?: unknown } | undefined) => input?.force ? onThisMachine("Refreshing the quota") : null,
  authStatus: (input: { fresh?: unknown } | undefined) => input?.fresh ? onThisMachine("Checking the sign-in again") : null,

  // Files, confined to what remote-reads.ts allows.
  localMarkdown: (input: { path: string }, checks) => checks.mayRead(input.path) ? null : remoteRefusedMessage(),
  localFile: (input: { path: string }, checks) => checks.mayRead(input.path) ? null : remoteRefusedMessage(),
  resolveLocalPaths: "allow", // Filters what it answers itself, since one batch mixes paths. See router.ts.

  // Bookkeeping: the reader's own place on the board. Nothing here starts or changes any work.
  markRead: "allow",
  threadSeen: "allow",
  snoozeAwaitingBackground: "allow",
  setThreadPinned: "allow",
  reorderPinnedThreads: "allow",
  setThreadConsolePinned: "allow",
  reorderConsolePinnedThreads: "allow",
  projectsReorder: "allow",
  // A snooze with a prompt is a message to the worker, sent later: the scheduler resumes the thread with
  // it when the snooze ends, in whatever permission mode that thread runs.
  setThreadSnooze: (input: { prompt?: unknown }) => input.prompt != null ? onThisMachine("Scheduling a message") : null,

  // Picking a listed option on a question card.
  answerQuestions: (input: { slug: string; answers: QuestionAnswer[] }, checks) => remoteAnswerRefusal(input, checks),

  // Starting, steering and settling threads.
  dispatch: "full",
  adoptThread: "full",
  followUp: "full",
  dismissFailedFollowUp: "full",
  setHumanTodo: "full",
  unqueueFollowUp: "full",
  deliverQueuedNow: "full",
  compactThread: "full",
  githubDispatchBatch: "full",
  interactionResolve: "full",
  interactionCancel: "full",
  dismissQuestions: "full",
  subAgentSteer: "full",
  subAgentStop: "full",
  stopBackgroundOp: "full",
  stopMonitor: "full",
  setThreadState: "full",
  setThreadStatus: "full",
  completeThread: "full",
  markComplete: "full",
  repairThread: "full",
  renameThread: "full",
  aiRenameThread: "full",

  // A thread's settings, and what the prompt box asks for to offer them.
  setThreadPermission: "full",
  setThreadProfile: "full",
  upgradeThreadModel: "full",
  setThreadRecurringPrompt: "full",
  threadProfileOptions: "full",
  threadSkills: "full",
  claudeModels: "full",
  acpAgentModels: "full",
  opencodeModels: "full",
  stopThreadTurn: "full",

  // MCP, provider and GitHub sign-ins.
  mcpStatus: "full",
  mcpReload: "full",
  mcpSignIn: "full",
  mcpSignInPoll: "full",
  mcpSignInFinish: "full",
  mcpSignInCancel: "full",
  accountLogout: "full",
  githubPromptDefaults: "full",
  githubStatus: "full",
  githubAccount: "full",
  githubSignInStart: "full",
  githubSignInCancel: "full",
  githubSignOut: "full",
  githubList: "full",
  githubRefPreview: "full",

  // Projects and settings.
  projectAdd: "full",
  projectPick: "full",
  projectPickWarm: "full",
  projectRemove: "full",
  projectRename: "full",
  projectIconPick: "full",
  projectIconPickWarm: "full",
  projectIconSet: "full",
  projectIconClear: "full",
  settingsSet: "full",
  dispatchPreferenceSet: "full",
  openLocalFile: "full",

  // WHAT NO PAGE CALLS. A worker's own surface, which it reaches over its direct path, and a few procedures
  // only scripts use. Refused because a page has no reason to ask, and because several act out of sight: a
  // command watch runs a shell on an existing thread, where `dispatch` puts a new thread on the board.
  steerThread: "deny",
  spawnThread: "deny",
  spawnChild: "deny",
  listThreads: "deny",
  ask: "deny",
  unask: "deny",
  markOwnDone: "deny",
  setOwnThreadTitle: "deny",
  setOwnThreadRecurringPrompt: "deny",
  getOwnThreadRecurringPrompt: "deny",
  setOwnThreadTimer: "deny",
  cancelOwnThreadTimer: "deny",
  listOwnThreadTimers: "deny",
  listOwnThreadActivity: "deny",
  upsertOwnLink: "deny",
  dropOwnLink: "deny",
  addOwnPrWatch: "deny",
  dropOwnPrWatch: "deny",
  listOwnPrWatches: "deny",
  addOwnCommandWatch: "deny",
  dropOwnCommandWatch: "deny",
  listOwnCommandWatches: "deny",
  addOwnMonitor: "deny",
  addOwnWatch: "deny",
  dropOwnWatch: "deny",
  setOwnThreadStopHook: "deny",
  setOwnThreadHeartbeat: "deny",
  setThreadHeartbeat: "deny",
  archiveThread: "deny",
  forgetThread: "deny",
  dismissThread: "deny",
  killAgent: "deny",
  openExternal: "deny",
  settingsReset: "deny",
} satisfies Record<keyof AppRouter, RemoteRule>

/**
 * The rule for one procedure name. A name the table does not hold is refused: this is the runtime half of
 * the type check above, for the name a request made up.
 */
export function remoteRule(name: string): RemoteRule {
  return Object.hasOwn(REMOTE_ACCESS, name) ? (REMOTE_ACCESS as Record<string, RemoteRule>)[name]! : "deny"
}

const refusedCard = (why: string) => `${why}, so it can only be answered on ${remoteHostLabel()}.`

/**
 * A remote answer has to be one a person could give by tapping the card's options: nothing in it that a
 * caller wrote. So every field is checked against the stored question, not only `text`:
 *
 * - `question` is restated to the worker verbatim in its answer, so it has to be the question that was
 *   asked. Left free, it is 4000 characters of prompt delivered as the human's own turn.
 * - `chosen` holds labels, also delivered verbatim, so each has to be one of the listed options.
 * - A question's taken branch is answered whole, positionally, as the card builds it. A branch left off
 *   would let a remote caller take an option past its own danger confirmation.
 */
export function remoteAnswerRefusal(input: { slug: string; answers: readonly QuestionAnswer[] }, checks: Pick<GateChecks, "questionSpec">): Refusal {
  for (const answer of input.answers) {
    const stored = checks.questionSpec(input.slug, answer.questionId)
    const spec = stored && parseSpec(stored.spec)
    if (!spec) return refusedCard("This question can't be read here")
    const refusal = refusalOfNode(spec, answer, answer.questionId, true)
    if (refusal) return refusal
  }
  return null
}

function parseSpec(spec: string): AskedQuestion | undefined {
  try {
    const parsed = AskedQuestionSchema.safeParse(JSON.parse(spec))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function refusalOfNode(node: AskedQuestion, said: QuestionAnswer, rootId: string, root: boolean): Refusal {
  if (node.secret) return refusedCard("This question asks for a secret")
  if (node.danger) return refusedCard("This question is marked as dangerous")
  const options = node.options ?? []
  if (options.length === 0) return refusedCard("This question takes typed text")
  // Every node of one answer carries its root's id: the card builds them that way (web registeredAnswer).
  if (said.questionId !== rootId || said.question !== node.question) return refusedCard("This answer doesn't match its question")
  if (said.text?.trim()) return refusedCard("This answer has typed text in it")
  const labels = new Set(options.map((option) => option.label))
  if (new Set(said.chosen).size !== said.chosen.length || said.chosen.some((label) => !labels.has(label))) {
    return refusedCard("This answer has something in it that isn't one of the options")
  }
  // A root has to say something. A follow-up may be left blank, which the worker reads as "(no answer)".
  if (root && said.chosen.length === 0) return refusedCard("This answer doesn't pick an option")
  if (node.kind !== "multi" && said.chosen.length > 1) return refusedCard("This answer picks more than one option")
  const taken = node.kind === "multi" || said.chosen.length === 0 ? undefined : options.find((option) => option.label === said.chosen[0])
  const asked = taken?.followUps ?? []
  const given = said.followUps ?? []
  if (given.length !== asked.length) return refusedCard("This answer doesn't match its question")
  for (const [index, child] of asked.entries()) {
    const refusal = refusalOfNode(child, given[index]!, rootId, false)
    if (refusal) return refusal
  }
  return null
}

/**
 * The socket messages a remote caller may send. `satisfies` is the table's type check again: a new message
 * fails typecheck until someone says which side it is on. A local file subscription is also confined to
 * what remote-reads.ts allows.
 */
export const REMOTE_SOCKET_MESSAGES = { board: true, sub: true, unsub: true } satisfies Record<SocketClientMsg["t"], boolean>

/**
 * What the caller of a request may do, from the proxy's stamp. See accessOf. Read through
 * requestOriginFrom, the audit trail's own reading, so the gate and the record cannot disagree about
 * who called: above all about a stamp that is present and unreadable, which is the most limited caller
 * and never this machine.
 */
export function callerAccess(stamp: string | undefined): ReturnType<typeof accessOf> {
  return accessOf(requestOriginFrom({ caller: stamp, userAgent: undefined, socketRemote: undefined }))
}

/** Does this stamp name someone who is not on this machine? */
export function isRemoteCaller(stamp: string | undefined): boolean {
  return callerAccess(stamp) !== "local"
}

/** Write down that a remote caller was refused, attributed to who asked. Never fails the refusal. */
export function auditRemoteRefusal(
  audit: AuditLog | undefined,
  request: { stamp: string | undefined; userAgent: string | undefined; socketRemote?: string },
  detail: Record<string, unknown>,
  project: { id: string; dir: string },
): void {
  const origin = requestOriginFrom({ caller: request.stamp, userAgent: request.userAgent, socketRemote: request.socketRemote })
  withRequestOrigin(origin, () => recordAudit(audit, () => ({ action: "remoteRefused", outcome: "refused", project, servedBy: project.id, detail })))
}

/** The refusal a remote caller gets from a route, with its code, written to the audit trail first. */
function refuse(c: Context, audit: AuditLog | undefined, project: { id: string; dir: string }, detail: Record<string, unknown>, message = remoteRefusedMessage()): Response {
  auditRemoteRefusal(audit, {
    stamp: c.req.header(CALLER_HEADER),
    userAgent: c.req.header("user-agent"),
    socketRemote: (c.env as { remoteAddress?: string } | undefined)?.remoteAddress,
  }, detail, project)
  return c.json({ error: message, code: REMOTE_REFUSED_CODE }, 403)
}

export interface RemoteGateOptions extends GateChecks {
  audit: AuditLog | undefined
  project: { id: string; dir: string }
}

/**
 * The guard mountRouter runs for every procedure. It reads the proxy's stamp off the request itself, not
 * through `currentRequestOrigin()`, whose answer with no request in scope is `internal`, a local caller.
 */
export function remoteGate(options: RemoteGateOptions): RouterGuard {
  const accessIn = (c: Context) => callerAccess(c.req.header(CALLER_HEADER))
  return {
    procedure(c, name) {
      const access = accessIn(c)
      if (access === "local") return undefined
      const rule = remoteRule(name)
      if (rule !== "deny" && !(rule === "full" && access === "read-and-answer")) return undefined
      return refuse(c, options.audit, options.project, { procedure: name })
    },
    input(c, name, input) {
      if (accessIn(c) !== "read-and-answer") return undefined
      const rule = remoteRule(name)
      if (typeof rule !== "function") return undefined
      const refusal = (rule as (input: unknown, checks: GateChecks) => Refusal)(input, options)
      return refusal ? refuse(c, options.audit, options.project, { procedure: name }, refusal) : undefined
    },
  }
}

/**
 * The routes outside RPC a remote caller may reach, each named in full. Everything else under `/_frizz` is
 * the machine's for every remote session: the launcher's stop and launch controls, which hold a token no page
 * has, and the health probe. `suffix` is the part after the route prefix, as Hono decoded and routed it.
 */
const REMOTE_ROUTES: ReadonlySet<string> = new Set(["/events", "/project-icon", "/local-visualization", "/local-image", "/local-file"])
/** The prompt box's attachment intake, which writes to disk. */
const FULL_CONTROL_ROUTES: ReadonlySet<string> = new Set(["/attach"])

export function remoteRouteAllowed(suffix: string, access: RelayAccess): boolean {
  return REMOTE_ROUTES.has(suffix) || suffix.startsWith("/rpc/") || (access === "full" && FULL_CONTROL_ROUTES.has(suffix))
}

export function refuseRemoteRoute(c: Context, options: Pick<RemoteGateOptions, "audit" | "project">, route: string): Response {
  return refuse(c, options.audit, options.project, { route })
}
