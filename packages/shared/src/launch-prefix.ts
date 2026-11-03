// A LAUNCH PREFIX: a command the operator puts in front of every worker Frizz starts for a runtime, so
// that `op run --env-file .env --` in the Claude Code settings makes each new Claude worker start as
// `op run --env-file .env -- /path/to/claude …`. It is how someone brings their own secret injector,
// token proxy, sandbox or `nice` without Frizz knowing anything about any of them.
//
// The prefix is stored as the text the operator typed and split into words HERE, by the one parser the
// settings field (which shows the error) and the server (which spawns the words) both use, so the two
// can never disagree about what a prefix means.
//
// IT IS NOT RUN IN A SHELL, and that is deliberate. A shell would put quoting, expansion and Windows
// `cmd.exe` semantics between the operator and the argv, and a prefix that works on one machine would
// not on the next. So the words are split the way a POSIX shell splits them — whitespace separates,
// single quotes are literal, double quotes allow `\"` and `\\` — and nothing else happens: no `$VAR`,
// no globs, no pipes. Shell syntax that would silently mean something else is REFUSED with a message
// saying so, rather than reaching the wrapper as a literal `$HOME`. Someone who wants a shell writes one
// in: `sh -c 'export TOKEN="$(cat ~/.token)"; exec "$@"' sh` runs the worker as that script's "$@".
//
// One convenience survives, because nobody types an absolute home path by hand: a word that starts
// with an unquoted `~/` (or is just `~`) expands to the home directory when the caller supplies one.
// The server does; the settings field does not, and shows the `~` as typed.

export const LAUNCH_PREFIX_MAX_LENGTH = 2_048
export const LAUNCH_PREFIX_MAX_WORDS = 64

export type LaunchPrefixParse = { ok: true; argv: string[] } | { ok: false; error: string }

// Outside quotes these mean something to a shell and nothing to Frizz. Each one reaching the wrapper
// as a literal character is a prefix that does something other than what it reads as.
const SHELL_ONLY: Record<string, string> = {
  "$": "variables are not expanded",
  "`": "commands are not substituted",
  "|": "there are no pipes",
  "&": "there is no `&&` or background job",
  ";": "there is no command list",
  "<": "there are no redirects",
  ">": "there are no redirects",
  "(": "there are no subshells",
  ")": "there are no subshells",
}

const WHITESPACE = /\s/u

/** Split a launch prefix into the words Frizz will spawn. Empty or blank text is no prefix (`argv: []`). */
export function parseLaunchPrefix(text: string, options: { home?: string } = {}): LaunchPrefixParse {
  if (text.length > LAUNCH_PREFIX_MAX_LENGTH) {
    return { ok: false, error: `The prefix is longer than ${LAUNCH_PREFIX_MAX_LENGTH} characters.` }
  }
  const argv: string[] = []
  let word = ""
  // A word exists once anything — even an empty pair of quotes — has started it, so `''` is an empty
  // argument rather than nothing.
  let started = false
  // Whether the word so far is a bare `~`, unquoted, at its very start: the only shape that expands.
  let tildeLead = false
  let i = 0
  const finish = () => {
    if (!started) return
    argv.push(tildeLead && options.home !== undefined ? options.home + word.slice(1) : word)
    word = ""
    started = false
    tildeLead = false
  }
  while (i < text.length) {
    const ch = text[i]!
    if (WHITESPACE.test(ch)) {
      finish()
      i++
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return { ok: false, error: "A single quote is never closed." }
      if (tildeLead && word === "~") tildeLead = false
      word += text.slice(i + 1, end)
      started = true
      i = end + 1
      continue
    }
    if (ch === "\"") {
      if (tildeLead && word === "~") tildeLead = false
      started = true
      i++
      let closed = false
      while (i < text.length) {
        const inner = text[i]!
        if (inner === "\"") { closed = true; i++; break }
        // POSIX: inside double quotes a backslash escapes only these; anywhere else it is itself.
        if (inner === "\\" && i + 1 < text.length && "\"\\$`".includes(text[i + 1]!)) {
          word += text[i + 1]
          i += 2
          continue
        }
        word += inner
        i++
      }
      if (!closed) return { ok: false, error: "A double quote is never closed." }
      continue
    }
    if (ch === "\\") {
      // An unquoted backslash escapes whitespace, a quote, a backslash or a shell character, and is
      // otherwise kept as itself — so a Windows path like C:\tools\op.exe survives unquoted.
      const next = text[i + 1]
      if (next !== undefined && (WHITESPACE.test(next) || "'\"\\".includes(next) || next in SHELL_ONLY)) {
        word += next
        started = true
        i += 2
        continue
      }
      word += ch
      started = true
      i++
      continue
    }
    if (ch in SHELL_ONLY) {
      return { ok: false, error: `\`${ch}\` is shell syntax, and the prefix is not run in a shell (${SHELL_ONLY[ch]}). Quote it to pass it literally, or wrap the command in \`sh -c\`.` }
    }
    if (ch === "~" && !started) {
      const next = text[i + 1]
      tildeLead = next === undefined || next === "/" || WHITESPACE.test(next)
    }
    word += ch
    started = true
    i++
  }
  finish()
  if (argv.length > LAUNCH_PREFIX_MAX_WORDS) {
    return { ok: false, error: `The prefix has more than ${LAUNCH_PREFIX_MAX_WORDS} words.` }
  }
  const first = argv[0]
  if (first !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(first)) {
    return { ok: false, error: `\`${first}\` is a variable assignment, which only a shell understands. Start the prefix with \`env\` instead: \`env ${first} …\`.` }
  }
  if (first === "") return { ok: false, error: "The command to run is empty." }
  return { ok: true, argv }
}

/** The argv a runtime is started with once its prefix is applied: the prefix's words, then the runtime's
 *  own command and arguments, unchanged. No prefix ⇒ exactly the runtime's own command. */
export function applyLaunchPrefix(prefix: readonly string[] | undefined, command: string, args: readonly string[]): { command: string; args: string[] } {
  if (!prefix || prefix.length === 0) return { command, args: [...args] }
  const [head, ...rest] = prefix
  return { command: head!, args: [...rest, command, ...args] }
}
