// Map a Claude tool-permission request (the SDK's canUseTool escalation) to a frizz InteractionStore
// entry, and map the human's decision back to a ClaudePermissionDecision. Under permissionMode "auto"
// the SDK's model classifier auto-approves the safe/common majority BEFORE canUseTool — so canUseTool
// fires only for the genuinely risky minority the classifier escalates. Those are exactly the ones that
// belong in front of a human, so the broker journals each as a provider-neutral approval interaction
// (provider.kind "claude") and gates the tool on the dashboard decision — the SDK-typed equivalent of
// what an interactive `claude` surfaces in its terminal, but as a clean approve/deny card instead of a
// worker wedged on a prompt nobody can see.
//
// ONE tool on that channel is not an authorization request at all: AskUserQuestion. See the second
// half of this file — it renders a question card and returns the ANSWER, not a grant.
import { homedir } from "node:os"
import {
  INTERACTION_PROTOCOL_VERSION,
  InteractionRequest,
  NOTES_FIELD_SUFFIX,
  type InteractionField,
  type InteractionRequest as InteractionRequestType,
  type InteractionValues,
} from "@frizz/shared"
import { redactCredentialSyntax } from "../credential-redaction.ts"
import { validatePermissionDecision } from "./claude-agent-sdk-protocol.ts"
import type { ClaudeJson, ClaudeJsonObject, ClaudePermissionDecision, ClaudePermissionRequest } from "./claude-agent-sdk-protocol.ts"

// The decision IDs the frizz web CANONICALIZES for a permission-approval card (typedInteractions.ts
// specFor): the security verb is a fixed vocabulary, not provider-chosen, so an unrecognized id renders
// NO button ("N advertised choices cannot be safely… shown"). `grant-turn` = approve-once, `deny` = deny.
export const CLAUDE_PERMISSION_DECISIONS = {
  allow: "grant-turn",
  deny: "deny",
} as const

// The two decisions every Claude tool-approval offers. Durable/session-scoped grants are a later
// refinement; a single-turn grant/deny is the safe, complete first contract. Labels come from the web's
// canonical spec ("Grant for turn" / "Deny"); the ones here are the provider-context fallback.
const ALLOWED_DECISIONS: InteractionRequestType["allowedDecisions"] = [
  { id: CLAUDE_PERMISSION_DECISIONS.allow, semantic: "approve", label: "Grant for turn", description: "Allow this tool call to run once." },
  { id: CLAUDE_PERMISSION_DECISIONS.deny, semantic: "deny", label: "Deny", description: "Block this tool call." },
]

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `~`-shorten a path for the prompt — putting the directory in front of the command only pays off if it
 *  stays narrow. (`src/readout.ts` has the CLI's own copy; the server package cannot import the root
 *  project without a circular project reference, and this is four lines of pure string work.)
 *  The remainder after the home prefix may open with either separator: a Windows cwd is
 *  `C:\Users\op\proj`, and requiring `/` left every Windows path at full length (Windows audit
 *  2026-09-11, finding 14). Exported, with the home injectable, so both spellings are pinned. */
export function tildePath(path: string, home: string = homedir()): string {
  if (!path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === "" ? "~" : /^[\\/]/.test(rest) ? `~${rest}` : path
}

// The argument that says WHAT a tool call will do, in the order the tools that actually escalate carry
// it. It leads the preview on its own; everything else follows as a labelled line.
const SUBJECT_KEYS = ["command", "file_path", "notebook_path", "path", "url", "pattern", "query", "prompt"]

// InteractionPreview is bounded on THREE axes (16k chars, 24k UTF-8 bytes, 256 lines), and a request
// that overruns any of them fails to parse — which would turn a display problem into a DENIED tool
// call. These caps are low enough that the byte bound is unreachable even for all-3-byte text, so no
// separate byte clamp is needed. Same reasoning caps the message below InteractionDescription's 8k.
const PREVIEW_MAX_CHARS = 6_000
const PREVIEW_MAX_LINES = 200

/** Render a tool input as the text a human reads instead of the JSON a machine reads: the subject
 *  argument verbatim (newlines intact — a heredoc is unreadable escaped), then the rest as `key: value`.
 *  `shown` is prose the card already displays, so the arg carrying it is dropped rather than repeated. */
function inputPreview(input: Record<string, unknown> | undefined, shown: string | undefined): string {
  if (!input) return ""
  const subject = SUBJECT_KEYS.find((key) => typeof input[key] === "string" && input[key] !== "")
  const lines = Object.entries(input)
    .filter((entry) => entry[0] !== subject && entry[1] !== "" && entry[1] !== null && entry[1] !== shown)
    .map((entry) => `${entry[0]}: ${typeof entry[1] === "string" ? entry[1] : JSON.stringify(entry[1])}`)
  if (subject) lines.unshift(String(input[subject]))
  const text = redactCredentialSyntax(lines.join("\n\n")).split("\n")
  return clip(text.length > PREVIEW_MAX_LINES ? `${text.slice(0, PREVIEW_MAX_LINES).join("\n")}\n…` : text.join("\n"), PREVIEW_MAX_CHARS)
}

// HOW LONG AN APPROVAL MAY HOLD A TURN. A permission escalation blocks the tool call, and the tool call
// blocks the whole turn, so an unanswered card does not stall one marginal command — it stalls the
// thread. The journal measured what that costs (2026-10-02, 18 Claude cards, every one on a
// bypassPermissions thread, where the CLI's own safety checks still escalate heredoc and out-of-tree
// shell scripts): 8 of 11 approvals landed inside 2.6m, and the rest sat 15–53m, with a dismissed one at
// 59m — the turn frozen the whole time, usually on a throwaway `/tmp` script the work could route
// around. So the card carries a deadline: past it the call is DENIED (fail closed, never auto-approved)
// with CLAUDE_PERMISSION_LAPSED_MESSAGE, and the agent carries on with everything that did not need it.
// Five minutes covers an operator who is watching; one who is not loses five minutes instead of hours.
export const CLAUDE_PERMISSION_DEADLINE_MS = 5 * 60_000

/** The deny an unanswered approval gets at its deadline. It must stop the model from doing the two things
 *  it does with a bare deny — waiting, or retrying the identical call into another card. */
export const CLAUDE_PERMISSION_LAPSED_MESSAGE =
  "Nobody approved this tool call in time, so it was denied automatically. The operator is not watching " +
  "right now — do not wait for them and do not retry the same call. Carry on with the rest of the work, " +
  "taking a route that needs no approval where one exists (the Write/Edit tools instead of a shell heredoc, " +
  "a path inside the project instead of an outside directory). If the work genuinely cannot proceed without " +
  "this exact call, finish everything else first, then say what is blocked and why in your final message."

// WHEN `auto` WAS ASKED FOR AND DID NOT START. Claude Code starts a session in `default` (its Manual mode)
// when auto mode is unavailable: a settings file or an organization turned it off, the model does not
// support it, or it is temporarily off for everyone. Nothing tells the thread. Every action then needs a
// person, which reads as a broken thread unless the card says why, so it does. Frizz does not fall back to
// bypass on its own: that would quietly remove the check the operator was told they had.
export const CLAUDE_AUTO_UNAVAILABLE_NOTE =
  "Auto mode isn't available in this session, so Claude Code is asking before each action. It can be off in " +
  "settings or for the organization, unsupported on this model, or temporarily off. Setting Permissions to " +
  "Bypass stops these cards, and Bypass checks nothing."

/** The journal's key for a Claude request: the SDK's own id, which a re-delivery after a reconnect repeats.
 *  The daemon's frame id is a different string, so this is what finds the card already on screen. */
export function claudeProviderRequestId(request: Pick<ClaudePermissionRequest, "requestId">): string {
  return clip(request.requestId, 500)
}

/** Build the durable interaction request for a Claude tool-permission escalation, or return null when it
 *  can't be represented (never blocks the daemon — the caller falls back to a decision hook).
 *  `expiresAt` is the card's deadline (see CLAUDE_PERMISSION_DEADLINE_MS); null means none. */
export function buildClaudePermissionInteraction(
  request: ClaudePermissionRequest,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
  expiresAt: string | null = null,
  note?: string,
): InteractionRequestType | null {
  const tool = request.toolName || "tool"
  // A shell command is shown the way a terminal shows it: the working directory becomes the prompt in
  // front of the command instead of a muted line under it, and the title says what is about to happen
  // rather than naming the tool twice. Only a tool that actually takes a `command` earns that layout —
  // a file path or an MCP argument sitting behind a `❯` would claim to be a shell line and isn't.
  const command = typeof request.input?.command === "string" ? request.input.command : ""
  const title = clip(command ? "Run a command?" : `Approve ${tool}?`, 150)
  // Say the WHY once and the WHAT once. The tool name is already the title, so it is not repeated as
  // prose, as a "requested permission", or as a resource label — the card carries each fact one time.
  const description = request.description ? clip(redactCredentialSyntax(request.description), 1_000) : ""
  const message = clip(
    [description, request.blockedPath ? `Blocked path: ${clip(request.blockedPath, 500)}` : "", note ?? ""].filter(Boolean).join("\n\n"),
    2_000,
  )
  // The input is UNTRUSTED provider text; redact credential syntax and bound it hard before it ever
  // reaches a card. It is display-only and is never parsed or executed by frizz.
  const preview = inputPreview(request.input, request.description)
  const parsed = InteractionRequest.safeParse({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text",
    provider: { kind: "claude", name: "Claude session broker" },
    source: { kind: "tool", id: clip(request.toolUseId || tool, 500), label: clip(tool, 150) },
    owner: {
      projectId: owner.projectId,
      threadSlug: owner.threadSlug,
      sessionId: owner.sessionId,
      // The broker has no codex-style turn/item ids; the requestId uniquely identifies this escalation
      // within the session and is what the daemon answers against, so it anchors both.
      turnId: clip(request.requestId, 500),
      itemId: clip(request.requestId, 500),
      sessionEpoch: 0,
      capabilityRevision: 0,
    },
    providerRequestId: claudeProviderRequestId(request),
    allowedDecisions: ALLOWED_DECISIONS,
    payload: {
      kind: "permission-approval",
      title,
      // `permission` is the card's readable identity, the way Codex's is "network+filesystem". It was
      // the requestId, which put a bare UUID on screen and told the operator nothing.
      permission: singleLine(tool, 250, "tool"),
      ...(message ? { message } : {}),
      ...(preview ? { preview } : {}),
      ...(command
        ? { promptLabel: singleLine(tildePath(owner.cwd), 250, "~", false) }
        : { workingDirectoryLabel: clip(owner.cwd, 2_000) }),
    },
    expiresAt,
  })
  return parsed.success ? parsed.data : null
}

/** Map a resolved interaction's decision id to the Claude decision the daemon applies. Anything that is
 *  not an explicit approve is treated as a deny — fail closed. */
export function claudePermissionDecisionFor(decisionId: string | undefined): ClaudePermissionDecision {
  if (decisionId === CLAUDE_PERMISSION_DECISIONS.allow || decisionId === "grant-session") return { behavior: "allow" }
  return { behavior: "deny", message: "The operator denied this tool call." }
}

// ---------------------------------------------------------------------------------------------
// AskUserQuestion — the agent ASKING, not the agent asking for authority
// ---------------------------------------------------------------------------------------------
// AskUserQuestion arrives on the very same canUseTool channel as a Bash approval, but it is not an
// authorization request at all: the tool's whole purpose is to collect a CHOICE, and the SDK contract is
// that the permission decision CARRIES that choice back in `updatedInput`. Answering it with a bare
// `{behavior:"allow"}` — which is what the generic approval card above produces — hands the model an
// empty answer set, and claude's own tool-result mapper then tells it verbatim "The user did not answer
// the questions." (read out of the 2.1.220 binary), so it re-asks. Hence a real question card here, and
// a decision that carries the answer.
//
// THE ANSWER CONTRACT, from claude 2.1.220's own tool schema — `answers: record(string, string)`,
// described as "question text -> answer string; multi-select answers are comma-separated":
//   { behavior: "allow", updatedInput: { questions, answers: { [FULL QUESTION TEXT]: "Label" } } }
// The key is the COMPLETE QUESTION TEXT. Its result mapper looks each answer up by that text and only
// reports "your questions have been answered" when the value is EXACTLY an advertised option label (or,
// for multiSelect, ", "-joined advertised labels); anything else degrades to "the user answered: …" and
// a missing key reads as unanswered. So the question text and the option labels travel VERBATIM from
// the tool input to the decision and are never round-tripped through the display-sanitized copy.
export const CLAUDE_ASK_USER_QUESTION_TOOL = "AskUserQuestion"

// Card decision ids, canonicalized by the web the same way the approval ids are (typedInteractions.ts
// specFor → "Send answer" / "Decline"). `answer` is the only semantic permitted to carry field values.
export const CLAUDE_QUESTION_DECISIONS = { answer: "answer", decline: "decline" } as const

const QUESTION_DECISIONS: InteractionRequestType["allowedDecisions"] = [
  { id: CLAUDE_QUESTION_DECISIONS.answer, semantic: "answer", label: "Send answer", description: "Send these answers back to the agent." },
  { id: CLAUDE_QUESTION_DECISIONS.decline, semantic: "decline", label: "Decline", description: "Tell the agent nobody answered, so it decides for itself." },
]

// The tool caps questions at 1-4 and options at 2-4. Accept some slack (a later build could widen them)
// but stay bounded — this is untrusted provider input.
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 16
// An answers KEY is the full question text, and claude-agent-sdk-protocol's boundedJson rejects any
// object key over 256 UTF-8 bytes. A question longer than that can never be answered through this
// channel, so it is rejected HERE (→ a deny that says why) rather than at the far end, where the throw
// would surface as a failed permission callback and take the turn with it.
const MAX_QUESTION_KEY_BYTES = 256

const encoder = new TextEncoder()
// Mirrors the shared interaction protocol's UNSAFE_TEXT class (and claude-agent-sdk-protocol's). Text
// bound for a CARD is scrubbed of it, because the zod schemas reject it outright. Text bound for the
// PROVIDER is never rewritten — it is REJECTED, since an answer key must match the provider's bytes.
const UNSAFE_TEXT_SOURCE = "[\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]"
const SCRUB_UNSAFE_TEXT = new RegExp(UNSAFE_TEXT_SOURCE, "gu")
const HAS_UNSAFE_TEXT = new RegExp(UNSAFE_TEXT_SOURCE, "u")

// claude 2.1.220's own sentinel for "the operator left notes but picked no option" — its result mapper
// special-cases this exact string (`if (!f || f === "(notes only)") return true`) so a notes-only answer
// is not scored as an unadvertised pick. Matching it is what makes frizz's free-text box native rather
// than a frizz-shaped approximation.
const CLAUDE_NOTES_ONLY = "(notes only)"

const CLAUDE_QUESTION_DECLINED =
  "The operator did not answer this question from the frizz dashboard. Do not ask it again with this tool — " +
  "decide with the information you already have, or raise it in your final message."

/** A question frizz could not represent EXACTLY (see parseClaudeAskUserQuestion). Denied with a redirect
 *  to the structured ```question fence rather than downgraded to an approval card, whose bare allow the
 *  model reads as unanswered. (It redirected to the free-form fence until 2026-09-11, then to `frizzctl
 *  ask` until 2026-10-13.) */
export const CLAUDE_ASK_DENY_MESSAGE =
  "Frizz could not render this question as a card. Ask it in a ```question fence in your own message " +
  "instead — `id:`, `kind:`, a one-line `question:`, `options:` with a one-line trade-off each and the " +
  "recommended one first, and the context below a `---` line (`frizzctl ask --help` shows the whole " +
  "grammar). The operator answers it from the queue and the reply arrives as your next user message."

/** The card went away without an answer: the operator dismissed it, the turn was interrupted, the session
 *  was replaced — or, the common one, they sent a FOLLOW-UP instead of answering, which supersedes the
 *  question. In every case the next user message is the thing to read; re-asking with this tool is not. */
export const CLAUDE_ASK_WITHDRAWN_MESSAGE =
  "This question was withdrawn before anyone answered it — most likely because the operator sent a message " +
  "instead. Read their next message and follow it. Do not ask this again with this tool; if you still need " +
  "the decision, ask it in a ```question fence in your own message."

function displayText(value: string, max: number, fallback: string, redact = true): string {
  const scrubbed = (redact ? redactCredentialSyntax(value) : value).replace(SCRUB_UNSAFE_TEXT, "").trim()
  return scrubbed === "" ? fallback : clip(scrubbed, max)
}

function singleLine(value: string, max: number, fallback: string, redact = true): string {
  return displayText(value.replace(/[\r\n]+/gu, " "), max, fallback, redact)
}

// Text that is MATCHED by the provider (an answer key, an answer value) is accepted verbatim or not at
// all: rewriting it would turn an exact pick into a near-miss the model reads as freeform prose.
function providerText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value === "") return null
  if (encoder.encode(value).byteLength > maxBytes) return null
  return HAS_UNSAFE_TEXT.test(value) ? null : value
}

// Text that is only ever DISPLAYED (a header chip, an option's rationale) is scrubbed instead. It is
// never matched against anything, so a stray control byte in it must not sink an otherwise answerable
// question — which it did until a hostile-input test caught it.
function proseText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined
  const scrubbed = value.replace(SCRUB_UNSAFE_TEXT, "").trim()
  return scrubbed === "" ? undefined : clip(scrubbed, maxChars)
}

export interface ClaudeAskQuestion {
  /** VERBATIM provider text — the answers-object key. Never sanitized, only accepted or rejected. */
  question: string
  /** Display-only, so it is SCRUBBED rather than rejected (falls back to the question text). */
  header: string
  /** `label` is VERBATIM too: it is the answer VALUE the tool matches against. `description` is
   *  display-only and scrubbed. */
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

export interface ClaudeAskSpec {
  questions: ClaudeAskQuestion[]
  /** The original `input.questions` array, echoed back untouched in `updatedInput` when that is safe. */
  raw: ClaudeJson
}

/** Parse an AskUserQuestion tool input into the bounded shape both the card and the answer need, or
 *  null when it cannot be represented as a question — in which case the caller denies with an
 *  explanation rather than showing an approval card the model will read as "unanswered". */
export function parseClaudeAskUserQuestion(input: unknown): ClaudeAskSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const raw = (input as Record<string, unknown>).questions
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null
  const questions: ClaudeAskQuestion[] = []
  const seenQuestions = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const question = providerText(row.question, MAX_QUESTION_KEY_BYTES)
    if (question === null) return null
    // A key JSON.parse would treat specially cannot round-trip through the decision's bounded clone.
    if (question === "__proto__" || question === "constructor" || question === "prototype") return null
    // The tool itself requires unique question texts; a duplicate would make the answers object
    // ambiguous (one key, two questions), so it is not representable either.
    if (seenQuestions.has(question)) return null
    seenQuestions.add(question)
    const rawOptions = row.options
    if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS) return null
    const options: ClaudeAskQuestion["options"] = []
    const seenLabels = new Set<string>()
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return null
      const optionRow = rawOption as Record<string, unknown>
      // The label is the ANSWER VALUE, so it must also survive the card's option-value schema
      // unchanged (single line, ≤1000 chars): anything else means the choice could not be echoed back
      // exactly, and an inexact echo reads to the model as a freeform answer rather than a pick.
      const label = providerText(optionRow.label, 1_000)
      if (label === null || label.length > 1_000 || /[\r\n]/u.test(label)) return null
      if (seenLabels.has(label)) return null
      seenLabels.add(label)
      const description = proseText(optionRow.description, 1_000)
      options.push(description === undefined ? { label } : { label, description })
    }
    const header = proseText(row.header, 160) ?? question
    questions.push({ question, header, options, multiSelect: row.multiSelect === true })
  }
  return { questions, raw: raw as ClaudeJson }
}

function askFields(spec: ClaudeAskSpec): InteractionField[] {
  return spec.questions.map((question, index) => {
    // The option DESCRIPTION is where the tool puts the trade-off ("Beta — ships weekly, may break"),
    // and the card renders only `option.label`, so fold it in rather than dropping it. The option
    // VALUE stays the provider's exact label, because that is what the answer has to echo.
    const options = question.options.map((option) => ({
      value: option.label,
      label: singleLine(option.description ? `${option.label} — ${option.description}` : option.label, 160, option.label, false),
    }))
    const base = {
      id: `q${index}`,
      label: singleLine(question.header, 160, `Question ${index + 1}`),
      description: displayText(question.question, 4_000, "Claude asked for a decision."),
      // NOT required: the card offers the same free-text escape a ```question fence does, and an
      // operator who only types ("neither — do X instead") has answered without picking an option.
      // "at least one of pick/notes" is enforced where the decision is built, not per field.
      required: false,
      secret: false,
    }
    return [
      question.multiSelect
        ? { ...base, input: "multi-select" as const, options }
        : { ...base, input: "select" as const, options },
      // The free-text half of the same question. It is a SEPARATE field because the store validates a
      // select's value against the advertised options — which is right, and which free text by
      // definition is not. The pairing convention (`q<i>` + `q<i>` + NOTES_FIELD_SUFFIX) is what the
      // web reads to fold the two back into one question card.
      {
        id: `q${index}${NOTES_FIELD_SUFFIX}`,
        label: singleLine(question.header, 160, `Question ${index + 1}`),
        input: "multiline" as const,
        required: false,
        secret: false,
        maxLength: 4_000,
      },
    ]
  }).flat()
}

/** Build the durable interaction request for an AskUserQuestion call, or null when it cannot be
 *  represented (→ the caller denies with an explanation). */
export function buildClaudeQuestionInteraction(
  spec: ClaudeAskSpec,
  request: ClaudePermissionRequest,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
): InteractionRequestType | null {
  const title = spec.questions.length === 1
    ? singleLine(spec.questions[0]!.header, 150, "Claude question")
    : "Claude questions"
  const parsed = InteractionRequest.safeParse({
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    contentFormat: "plain-text",
    provider: { kind: "claude", name: "Claude session broker" },
    // "agent", the same source kind codex's request-user-input uses, so ONE card reads identically for
    // both providers: this is the agent talking, not a tool asking for authority.
    source: { kind: "agent", id: "claude-ask-user-question", label: "Claude" },
    owner: {
      projectId: owner.projectId,
      threadSlug: owner.threadSlug,
      sessionId: owner.sessionId,
      turnId: clip(request.requestId, 500),
      itemId: clip(request.toolUseId || request.requestId, 500),
      sessionEpoch: 0,
      capabilityRevision: 0,
    },
    providerRequestId: claudeProviderRequestId(request),
    allowedDecisions: QUESTION_DECISIONS,
    payload: { kind: "agent-question", title, fields: askFields(spec) },
    expiresAt: null,
  })
  return parsed.success ? parsed.data : null
}

// A faithful but MINIMAL rebuild of the questions array, used when echoing the provider's original
// fails the decision's JSON bounds — an oversized option `preview` is the plausible case, since previews
// carry HTML mockups and the per-string cap is 16 KB. It still satisfies the tool's own input schema, so
// the answer still lands; only the preview/annotation extras are dropped.
function minimalQuestions(spec: ClaudeAskSpec): ClaudeJson {
  return spec.questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
    multiSelect: question.multiSelect,
  }))
}

/** Map a resolved question interaction to the Claude decision the daemon applies. `answer` becomes the
 *  SDK's `{questions, answers}` updatedInput; everything else denies with a reason the model can act on.
 *  The built decision is validated against the SAME protocol bounds the daemon will apply, so a decision
 *  that could not survive the wire degrades to a deny HERE instead of throwing THERE — where a rejected
 *  permission callback takes the turn with it. */
export function claudeQuestionDecisionFor(
  spec: ClaudeAskSpec,
  decisionId: string | undefined,
  values: InteractionValues | undefined,
): ClaudePermissionDecision {
  if (decisionId !== CLAUDE_QUESTION_DECISIONS.answer) return { behavior: "deny", message: CLAUDE_QUESTION_DECLINED }
  const answers: Record<string, string> = {}
  const annotations: Record<string, { notes: string }> = {}
  for (const [index, question] of spec.questions.entries()) {
    const value = values?.[`q${index}`]
    // "multi-select answers are comma-separated" — claude 2.1.220's own schema description, and its
    // result mapper splits on exactly ", " when checking the answer against the advertised labels.
    const picked = value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value)
    const notesValue = values?.[`q${index}${NOTES_FIELD_SUFFIX}`]
    const notes = typeof notesValue === "string" ? notesValue.trim() : ""
    if (picked === "" && notes === "") continue
    // The SDK's own shape for "the operator typed something as well as (or instead of) picking":
    // free text rides `annotations[question].notes`, and a notes-only answer takes claude's own
    // NOTES_ONLY sentinel in `answers`. Both are read by the result mapper — the presence of notes
    // is precisely what makes it tell the model to read the answer carefully rather than treating a
    // matched label as a clean pick. This is why free text is native here and not a frizz convention.
    answers[question.question] = picked === "" ? CLAUDE_NOTES_ONLY : picked
    if (notes !== "") annotations[question.question] = { notes }
  }
  if (Object.keys(answers).length === 0) return { behavior: "deny", message: CLAUDE_QUESTION_DECLINED }
  const hasNotes = Object.keys(annotations).length > 0
  for (const questions of [spec.raw, minimalQuestions(spec)]) {
    const updatedInput: ClaudeJsonObject = { questions, answers: { ...answers } }
    if (hasNotes) updatedInput.annotations = { ...annotations }
    try {
      return validatePermissionDecision({ behavior: "allow", updatedInput })
    } catch { /* fall through to the rebuilt, minimal echo */ }
  }
  return {
    behavior: "deny",
    message: "Frizz could not return the operator's answer in a form this tool accepts. Ask the question in your final message instead.",
  }
}
