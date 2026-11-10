#!/usr/bin/env node
// @ts-check
/**
 * frizzctl — the Frizz command line a worker runs from its own shell. THE worker surface: every
 * capability Frizz hands a worker is a command here, and none of them is a tool in the model's registry.
 *
 * WHY A COMMAND LINE AND NOT TOOLS (maintainer 2026-10-11). Sixteen MCP tools cost about 12k tokens of
 * schema that each provider loads its own way, could not be composed with anything, and had to be
 * mounted three different ways (a `--mcp-config` file, `-c mcp_servers.…`, ACP `session/new`). A command
 * on the worker's PATH is one surface for every provider, composes with `gh`, `jq` and a shell loop,
 * and discloses itself incrementally: `frizzctl --help` is forty lines, and the long reference for a
 * command is printed only when that command's own `--help` is asked for.
 *
 * It is a FRONT-END and nothing else. What each command is, takes and does lives in
 * ../lib/frizz-tools.mjs; this file turns an argv into one handler call and its answer into stdout and
 * an exit code.
 *
 * ARGUMENTS ARRIVE THREE WAYS, and they combine (a flag wins over JSON):
 *   flags       `--for 2h`, `--in-seconds 600`, `--stop-hook` / `--no-stop-hook`; the leading ones may
 *               be bare where the registry says so (`frizzctl title "Fix queue focus"`).
 *   JSON        `--input <file>`, `--input -` for stdin, or a JSON object as the first argument — the
 *               same object the command's schema describes. This is `gh api --input`, and it is what
 *               makes a nested payload or a long one sayable at all.
 *   text files  any text argument also takes `--<name>-file <path|->` — `gh pr create --body-file`.
 *
 * STDIN IS NEVER READ UNLESS `-` ASKS FOR IT. An agent's shell hands a command an open pipe more often
 * than a terminal, and a command that waits on it never returns (`codex exec` does exactly this, and
 * it reads as the command being broken).
 *
 * EXIT CODES: 0 the command did what it says; 1 it failed, or was called wrongly; 2 it REFUSED — a gate
 * that held (`done` with a question still open), so `frizzctl done … || …` can tell the two apart.
 *
 * A RETIRED COMMAND (`ask`, `secret`: a question is a ```question fence since 2026-10-13) is still a
 * command, because the worker that reaches for one is the worker that needs to be told what replaced it.
 * It refuses whatever it is given — no argument is parsed, so no usage error can stand in front of the
 * lesson, and stdin is never read — and its `--help` is the same text. `frizzctl --help` does not list it.
 */
import { readFileSync } from "node:fs"
import { CLI, HANDLERS, Refused, ServerRefusal, TOOLS } from "../lib/frizz-tools.mjs"

const NAME = "frizzctl"
const WIDTH = 100
const GROUPS = ["Sign off", "Waiting", "This thread", "Other threads"]

/** A call that could not be understood, as opposed to one that ran and failed. Same exit code; the
 *  message ends by pointing at the command's own help, because the fix is always in there. */
class UsageError extends Error {}

/** `watch_pr` ⇄ `watch-pr`: a command and a flag are spelled with hyphens, a schema key with underscores.
 *  Either spelling is accepted going in, so a worker that remembers the old tool name is not punished. */
const hyphen = (/** @type {string} */ s) => s.replace(/_/g, "-")
const under = (/** @type {string} */ s) => s.replace(/-/g, "_")

/** @param {string} raw */
function toolNamed(raw) {
  const want = under(raw.toLowerCase())
  return TOOLS.find((t) => t.name === want)
}

/** @param {{ name: string }} tool */
const propsOf = (tool) => /** @type {Record<string, any>} */ (/** @type {any} */ (tool).inputSchema?.properties ?? {})

let stdinTaken = false
/** The text at `source`: a path, or `-` for stdin. @param {string} source @param {string} flag */
function readSource(source, flag) {
  if (source === "-") {
    if (stdinTaken) throw new UsageError(`stdin (\`-\`) can feed only one argument per call, and ${flag} is the second to ask`)
    stdinTaken = true
    try {
      return readFileSync(0, "utf8")
    } catch (err) {
      throw new UsageError(`${flag} - could not read stdin: ${err instanceof Error ? err.message : err}`)
    }
  }
  try {
    return readFileSync(source, "utf8")
  } catch (err) {
    throw new UsageError(`${flag} could not read ${source}: ${err instanceof Error ? err.message : err}`)
  }
}

/** One flag's raw text as the type its schema names. @param {any} tool @param {string} key @param {string} raw */
function coerce(tool, key, raw) {
  const type = propsOf(tool)[key]?.type
  const flag = `--${hyphen(key)}`
  if (type === "integer" || type === "number") {
    const n = Number(raw)
    if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) {
      throw new UsageError(`${flag} takes ${type === "integer" ? "a whole number" : "a number"}, not ${JSON.stringify(raw)}`)
    }
    return n
  }
  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(raw)) return true
    if (/^(false|no|0)$/i.test(raw)) return false
    throw new UsageError(`${flag} is a switch: give it alone, as --no-${hyphen(key)}, or as ${flag}=true|false — not ${JSON.stringify(raw)}`)
  }
  if (type === "array" || type === "object") {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new UsageError(`${flag} takes JSON (${type === "array" ? "an array" : "an object"}): ${err instanceof Error ? err.message : err}`)
    }
  }
  return raw
}

/** Whether a JSON value is of a JSON Schema `type`. @param {unknown} v @param {string | string[]} type @returns {boolean} */
function hasType(v, type) {
  if (Array.isArray(type)) return type.some((t) => hasType(v, t))
  switch (type) {
    case "string": return typeof v === "string"
    case "boolean": return typeof v === "boolean"
    case "number": return typeof v === "number" && Number.isFinite(v)
    case "integer": return Number.isInteger(v)
    case "array": return Array.isArray(v)
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v)
    case "null": return v === null
    default: return true
  }
}

/** The flags a command takes, for the "you wrote a flag it does not have" message. @param {any} tool */
function flagList(tool) {
  const flags = Object.keys(propsOf(tool)).map((k) => `--${hyphen(k)}`)
  return flags.length ? flags.join(", ") : "no arguments at all"
}

/**
 * A JSON payload as the argument object. A bare array, or a single item, is taken to be the command's
 * one array argument where the registry names one (`ask`: a list of questions, or one question) —
 * the wrapper object is pure ceremony there, and a worker that leaves it off meant the obvious thing.
 * An unknown key is REFUSED rather than dropped: `heartbeat` for `heartbeat_seconds` would otherwise
 * arm a goal with no clock and say nothing.
 * @param {any} tool @param {string} text @param {string} what
 */
function jsonInput(tool, text, what) {
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new UsageError(`${what} is not valid JSON: ${err instanceof Error ? err.message : err}`)
  }
  const keys = Object.keys(propsOf(tool))
  const wrap = CLI[tool.name]?.wrap
  if (Array.isArray(value)) {
    if (wrap) return { [wrap]: value }
    throw new UsageError(`${what} must be a JSON object with the command's arguments (${keys.join(", ") || "none"}), not an array`)
  }
  if (value === null || typeof value !== "object") throw new UsageError(`${what} must be a JSON object, not ${JSON.stringify(value)?.slice(0, 40)}`)
  if (wrap && !(wrap in value) && !Object.keys(value).some((k) => keys.includes(k))) return { [wrap]: [value] }
  const unknown = Object.keys(value).filter((k) => !keys.includes(k))
  if (unknown.length) {
    throw new UsageError(
      `${what} has ${unknown.length === 1 ? "a key" : "keys"} \`${NAME} ${hyphen(tool.name)}\` does not take: ` +
      `${unknown.join(", ")}. It takes: ${keys.join(", ") || "nothing"}.`,
    )
  }
  // The type, too, for the reason the key is checked: `{"stop_hook": "false"}` is not false to a
  // handler that tests for `true`, and it would arm a goal with no trigger and say nothing.
  for (const [key, v] of Object.entries(value)) {
    const want = propsOf(tool)[key]?.type
    if (want && !hasType(v, want)) {
      throw new UsageError(`${what}: ${key} must be ${Array.isArray(want) ? want.join(" or ") : want === "integer" ? "a whole number" : `a ${want}`}, not ${JSON.stringify(v)}`)
    }
  }
  return value
}

/**
 * argv → the argument object one handler takes. Nothing is validated beyond SPELLING and TYPE: which
 * arguments are required, and for which action, is the handler's to say, in the words it already has.
 * @param {any} tool @param {string[]} argv
 */
function parseArgs(tool, argv) {
  const props = propsOf(tool)
  const spec = CLI[tool.name] ?? {}
  /** @type {Record<string, unknown>} */
  let fromJson = {}
  /** @type {Record<string, unknown>} */
  const fromFlags = {}
  /** @type {string[]} */
  const bare = []
  let flagsOver = false

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (flagsOver || !tok.startsWith("--")) { bare.push(tok); continue }
    if (tok === "--") { flagsOver = true; continue }
    const eq = tok.indexOf("=")
    const flag = under((eq < 0 ? tok : tok.slice(0, eq)).slice(2).toLowerCase())
    const inline = eq < 0 ? undefined : tok.slice(eq + 1)
    const take = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= argv.length) throw new UsageError(`--${hyphen(flag)} needs a value after it`)
      // `goal start --prompt --post-compaction` left out the prompt; taking the next flag as the text
      // would arm a goal reading "--post-compaction" on the wrong trigger and report success.
      if (/^--[A-Za-z][\w-]*(=.*)?$/.test(argv[i + 1])) {
        throw new UsageError(`--${hyphen(flag)} needs a value, and the next argument is the flag ${argv[i + 1].split("=")[0]}. A value that really begins with "--" is written --${hyphen(flag)}=<value>.`)
      }
      return argv[++i]
    }
    if (flag === "input") {
      fromJson = { ...fromJson, ...jsonInput(tool, readSource(take(), "--input"), "--input") }
    } else if (flag in props) {
      if (props[flag].type !== "boolean") fromFlags[flag] = coerce(tool, flag, take())
      else if (inline !== undefined) fromFlags[flag] = coerce(tool, flag, inline)
      else if (i + 1 < argv.length && /^(true|false)$/i.test(argv[i + 1])) fromFlags[flag] = coerce(tool, flag, argv[++i])
      else fromFlags[flag] = true
    } else if (flag.startsWith("no_") && props[flag.slice(3)]?.type === "boolean") {
      fromFlags[flag.slice(3)] = false
    } else if (flag.endsWith("_file") && props[flag.slice(0, -5)]?.type === "string") {
      fromFlags[flag.slice(0, -5)] = readSource(take(), `--${hyphen(flag)}`)
    } else {
      throw new UsageError(`\`${NAME} ${hyphen(tool.name)}\` has no ${tok.split("=")[0]}. It takes: ${flagList(tool)}.`)
    }
  }

  // A JSON object (or, where the registry allows, an array) as the FIRST bare argument is the payload.
  // Only when it actually parses as one: a title that happens to start with `[` is still a title.
  if (bare.length && /^\s*[[{]/.test(bare[0])) {
    let parsed = false
    try { parsed = typeof JSON.parse(bare[0]) === "object" } catch {}
    if (parsed) fromJson = { ...fromJson, ...jsonInput(tool, /** @type {string} */ (bare.shift()), "the JSON argument") }
  }

  // Bare arguments fill the registry's positional slots in order, skipping any a flag or the JSON
  // already filled — so `--action drop prw_1` and `drop prw_1` mean the same thing.
  const given = { ...fromJson, ...fromFlags }
  /** @type {string[]} */
  const declared = spec.positional ?? []
  const slots = declared.filter((k) => !(k in given))
  // An action's alias takes the slots of the action it stands for: `watch-pr remove prw_1` is `drop prw_1`.
  const extend = (/** @type {unknown} */ lead) => {
    const action = spec.alias?.[String(lead).toLowerCase()] ?? String(lead)
    for (const k of spec.then?.[action] ?? []) if (!(k in given) && !slots.includes(k)) slots.push(k)
  }
  // The action said TWICE, as the leading word and as its flag (`goal start --action start …`). The help
  // shows both spellings, and a worker that had just read it wrote both and was told the command "takes
  // no bare argument here" (seen from a real worker, 2026-11-10). The same action twice is said once;
  // two different ones is the mistake worth naming.
  const lead = declared[0]
  if (lead && lead in given && bare.length && Array.isArray(props[lead]?.enum)) {
    const named = (/** @type {unknown} */ v) => spec.alias?.[String(v).toLowerCase()] ?? String(v)
    if (named(bare[0]) === named(given[lead])) bare.shift()
    else if (props[lead].enum.includes(named(bare[0]))) {
      throw new UsageError(`\`${NAME} ${hyphen(tool.name)}\` was given two ${hyphen(lead)}s, \`${bare[0]}\` and --${hyphen(lead)} ${given[lead]}. Give one.`)
    }
  }
  if (declared[0] && declared[0] in given) extend(given[declared[0]])
  /** @type {Record<string, unknown>} */
  const fromBare = {}
  for (const [n, tok] of bare.entries()) {
    if (n >= slots.length) {
      throw new UsageError(
        slots.length === 0
          ? `\`${NAME} ${hyphen(tool.name)}\` takes no bare argument here, and got ${JSON.stringify(tok)}. Its arguments are flags: ${flagList(tool)}.`
          : `\`${NAME} ${hyphen(tool.name)}\` takes ${slots.length} bare argument${slots.length === 1 ? "" : "s"} here (${slots.join(", ")}), and got an extra ${JSON.stringify(tok)}. Quote a value that has spaces.`,
      )
    }
    fromBare[slots[n]] = coerce(tool, slots[n], tok)
    if (slots[n] === declared[0]) extend(fromBare[slots[n]])
  }
  return { ...fromJson, ...fromBare, ...fromFlags }
}

/** Wrap prose to WIDTH under an indent, paragraph by paragraph. A line that starts with whitespace is
 *  already laid out (a table, a code sample) and is passed through. @param {string} text @param {string} indent */
function wrap(text, indent = "") {
  const out = []
  for (const line of text.split("\n")) {
    if (line.trim() === "" || /^\s/.test(line)) { out.push(line.trim() === "" ? "" : indent + line); continue }
    let row = indent
    for (const word of line.split(/\s+/)) {
      if (row.length > indent.length && row.length + 1 + word.length > WIDTH) { out.push(row); row = indent }
      row += (row.length > indent.length ? " " : "") + word
    }
    out.push(row)
  }
  return out.join("\n")
}

function topHelp() {
  const pad = Math.max(...TOOLS.map((t) => t.name.length)) + 2
  const sections = GROUPS.map((group) => {
    // In the registry's own order within a group, which is the order a worker reaches for them in.
    const rows = Object.entries(CLI).filter(([name, spec]) => spec.group === group && toolNamed(name))
      .map(([name, spec]) => `  ${hyphen(name).padEnd(pad)}${spec.summary}`)
    return rows.length ? `${group}\n${rows.join("\n")}` : ""
  }).filter(Boolean)
  return [
    `${NAME} — the Frizz command line for the worker of one thread.`,
    "Every command acts AS the thread whose worker runs it; there is no way to act as another.",
    "",
    "Usage:",
    `  ${NAME} <command> [arguments]`,
    `  ${NAME} <command> --help      the full reference for one command — read it before its first use`,
    "",
    sections.join("\n\n"),
    "",
    "Arguments arrive three ways, and they combine (a flag wins over JSON):",
    `  flags        ${NAME} watch shell bzvtnt3ig --for 2h`,
    `  JSON         ${NAME} goal start --input goal.json   (--input - reads stdin; a '{…}' first argument works too)`,
    `  text files   any text argument takes --<name>-file <path|->:   ${NAME} done --body-file handoff.md`,
    "",
    "Text holding backticks, $ or quotes goes through a file or a QUOTED heredoc, never a double-quoted",
    "argument: inside double quotes the shell runs `…` and $(…) before this command sees them.",
    `  ${NAME} done --body-file - <<'EOF'`,
    "  - **Fixed the lookup** in `src/resolver.ts`; `npm test` green.",
    "  EOF",
    "",
    "The answer is on stdout. Exit 0: done. 1: failed or misused, and the message says which. 2: refused.",
  ].join("\n")
}

/** One argument's line(s) in a command's help, and those of whatever it nests.
 * @param {string} label @param {any} spec @param {boolean} required @param {string} indent @param {string[][]} outer */
function describeArg(label, spec, required, indent, outer) {
  const type = spec.enum ? spec.enum.join(" | ") : spec.type === "array" ? `JSON array of ${spec.items?.type ?? "value"}s` : spec.type === "object" ? "JSON object" : spec.type
  const lines = [`${indent}${label}  <${type}>${required ? "  (required)" : ""}`]
  if (spec.description) lines.push(wrap(spec.description, `${indent}    `))
  const inner = spec.type === "array" ? spec.items : spec
  const nested = inner?.type === "object" ? inner.properties : undefined
  if (nested) {
    // A schema that nests itself (`ask`: a question's option carries follow-up questions) is described
    // ONCE. Printing it at every depth is three screens of the same paragraphs.
    const shape = Object.keys(nested).sort().join(",")
    const again = outer.find(([, seen]) => seen === shape)
    if (again) {
      lines.push(`${indent}    Each one has the same shape as ${again[0]}, above.`)
    } else {
      const req = new Set(inner.required ?? [])
      for (const [key, sub] of Object.entries(nested)) {
        lines.push(describeArg(key, sub, req.has(key), `${indent}    `, [...outer, [label, shape]]))
      }
    }
  }
  return lines.join("\n")
}

/** @param {any} tool */
function commandHelp(tool) {
  const spec = CLI[tool.name] ?? {}
  const props = propsOf(tool)
  const required = new Set(tool.inputSchema?.required ?? [])
  const command = `${NAME} ${hyphen(tool.name)}`
  const bare = [...(spec.positional ?? []).map((k) => `<${hyphen(k)}>`)]
  const usage = [`  ${command}${bare.length ? ` ${bare.join(" ")}` : ""}${Object.keys(props).length > bare.length ? " [--flags]" : ""}`]
  for (const [lead, more] of Object.entries(spec.then ?? {})) usage.push(`  ${command} ${lead} ${more.map((k) => `<${hyphen(k)}>`).join(" ")}`)
  if (Object.keys(props).length) usage.push(`  ${command} --input <file|->        the arguments below as one JSON object`)
  // A positional argument is listed under its flag, so say it is the bare word too: a reader of
  // `--action <start | stop | get> (required)` under `Usage: … <action>` otherwise writes both.
  const args = Object.entries(props).map(([key, sub]) => {
    const described = describeArg(`--${hyphen(key)}`, sub, required.has(key), "  ", [])
    if (!(spec.positional ?? []).includes(key)) return described
    const [label, ...rest] = described.split("\n")
    return [label, `      The bare <${hyphen(key)}> in the usage above, or this flag.`, ...rest].join("\n")
  })
  const textArgs = Object.entries(props).filter(([, sub]) => sub.type === "string" && !sub.enum).map(([key]) => `--${hyphen(key)}-file`)
  return [
    `${command} — ${spec.summary ?? ""}`,
    "",
    "Usage:",
    usage.join("\n"),
    "",
    wrap(tool.description ?? ""),
    "",
    args.length ? `Arguments:\n${args.join("\n\n")}` : "Arguments: none.",
    ...(textArgs.length ? ["", wrap(`Text from a file or stdin instead of the command line: ${textArgs.join(", ")} <path|->.`)] : []),
    ...(spec.examples?.length ? ["", `Examples:\n${spec.examples.map((e) => e.split("\n").map((l) => `  ${l}`).join("\n")).join("\n\n")}`] : []),
    "",
    `${command} --schema prints the arguments as a JSON Schema.`,
  ].join("\n")
}

/** A retired command's page: its one-line summary, then the text it refuses with — printed as written,
 *  never wrapped, because it carries a fence the worker copies. @param {any} tool */
function retiredHelp(tool) {
  return `${NAME} ${hyphen(tool.name)} — ${CLI[tool.name].summary}\n\n${CLI[tool.name].retired}`
}

/** Whether the arguments ask for help, read the way parseArgs reads them: a `-h` that is a flag's
 *  VALUE (`steer other --message -h`) is the message, not a request for help, and the command must run
 *  rather than print help and exit 0 having sent nothing. Its own pass, with no side effects, so that
 *  `--input - --help` prints help without first reading stdin.
 *  @param {any} tool @param {string[]} argv @returns {"help" | "schema" | undefined} */
function helpAsked(tool, argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === "--") return undefined
    if (tok === "--help" || tok === "-h") return "help"
    if (tok === "--schema") return "schema"
    if (tok.startsWith("--") && !tok.includes("=") && takesValue(tool, under(tok.slice(2).toLowerCase()))) i++
  }
  return undefined
}

/** Whether `--<flag>` consumes the next argument as its value. @param {any} tool @param {string} flag */
function takesValue(tool, flag) {
  const props = propsOf(tool)
  if (flag === "input") return true
  if (flag in props) return props[flag].type !== "boolean"
  return flag.endsWith("_file") && props[flag.slice(0, -5)]?.type === "string"
}

/** @param {string[]} argv @returns {Promise<{ code: number, out?: string }>} */
async function main(argv) {
  const [first, ...rest] = argv
  if (!first || first === "--help" || first === "-h" || first === "help") {
    const about = first === "help" && rest[0] ? toolNamed(rest[0]) : undefined
    if (first === "help" && rest[0] && !about) throw new UsageError(unknownCommand(rest[0]))
    return { code: 0, out: about ? (CLI[about.name]?.retired ? retiredHelp(about) : commandHelp(about)) : topHelp() }
  }
  const tool = toolNamed(first)
  if (!tool) throw new UsageError(unknownCommand(first))
  const retired = CLI[tool.name]?.retired
  if (retired) return rest.includes("--help") || rest.includes("-h") ? { code: 0, out: retiredHelp(tool) } : { code: 2, out: retired }
  const asked = helpAsked(tool, rest)
  if (asked === "help") return { code: 0, out: commandHelp(tool) }
  if (asked === "schema") return { code: 0, out: JSON.stringify(tool.inputSchema, null, 2) }
  let args
  try {
    args = parseArgs(tool, rest)
  } catch (err) {
    if (err instanceof UsageError) err.message += `\nRun \`${NAME} ${hyphen(tool.name)} --help\` for what it takes.`
    throw err
  }
  let answer
  try {
    answer = await HANDLERS[tool.name](args)
  } catch (err) {
    // The server said no, in a sentence it wrote for the worker: a gate that held, like a `Refused` answer.
    if (err instanceof ServerRefusal) return { code: 2, out: `\`${NAME} ${hyphen(tool.name)}\` was refused: ${err.message}` }
    throw new Error(`${NAME} ${hyphen(tool.name)} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return answer instanceof Refused ? { code: 2, out: answer.text } : { code: 0, out: String(answer) }
}

/** Edit distance, for "did you mean". @param {string} a @param {string} b */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** @param {string} raw */
function unknownCommand(raw) {
  const want = under(raw.toLowerCase())
  const near = TOOLS.filter((t) => !CLI[t.name]?.retired && (t.name.includes(want) || want.includes(t.name) || distance(t.name, want) <= 2)).map((t) => hyphen(t.name))
  return (
    `\`${NAME}\` has no command ${JSON.stringify(raw)}.` +
    (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
    `\nCommands: ${TOOLS.filter((t) => !CLI[t.name]?.retired).map((t) => hyphen(t.name)).join(", ")}.\nRun \`${NAME} --help\` for what each one does.`
  )
}

/** Write, THEN exit: a piped stdout is asynchronous, and exiting first truncates a long answer — while
 *  not exiting at all leaves the process up for as long as fetch keeps its socket open.
 * @param {NodeJS.WriteStream} stream @param {string} text @param {number} code */
function finish(stream, text, code) {
  process.exitCode = code
  // A reader that stopped reading (`frizzctl activity | head -1`) is not an error worth a stack trace.
  stream.on("error", () => process.exit(code))
  stream.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(code))
}

main(process.argv.slice(2)).then(
  ({ code, out }) => finish(process.stdout, out ?? "", code),
  (err) => finish(process.stderr, err instanceof Error ? err.message : String(err), 1),
)
