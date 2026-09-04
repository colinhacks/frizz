// THE FILES A SHELL COMMAND WRITES, read off the command text itself.
//
// The edited-files rail derived its rows from Edit/Write/MultiEdit tool calls alone, so a worker that
// wrote through the shell wrote invisibly (maintainer 2026-09-04, on a real doc a nub thread authored
// with `cat > .frizz/sandbox-direction-decisions.md <<'MD'`: "Frizz failed to detect this file … I
// don't see that file showing up in the sidebar"). That is not a worker going off-contract — Claude
// Code's `auto` permission mode instructs the worker to "make file changes with sed, heredocs, or
// short scripts, rather than using the dedicated Read, Edit, or Write tools", and it is the mode the
// maintainer's own threads run in. Frizz cannot switch that instruction off, so the readout has to
// read the shell instead of wishing it away.
//
// WHY THIS IS A TOKENIZER AND NOT A REGEX. A `>` is a redirect only OUTSIDE quotes and outside a
// heredoc body, and workers ship a great deal of inline JavaScript and Python through Bash. Over the
// maintainer's own 160,045 real Bash calls, a `>`-matching regex found 74,062 targets, and the bulk of
// the relative ones were arrow functions and comparisons inside `node -e '…'` payloads — `console.log`,
// `JSON.parse`, `l.startsWith` all "written" thousands of times. Walking the string with quote and
// heredoc state removes that class entirely: the same corpus yields 77,541 real redirect targets, of
// which 39,180 are `/dev/null` and 27,525 are `/tmp`, leaving 9,219 genuine file writes.
//
// It is deliberately a reader of ONE command string, with no filesystem access and no notion of a
// project: what counts as interesting is the caller's call (see server/edited-files.ts).

// A file a command writes: `path` exactly as the command spelled it, plus the `cd` target in force at
// that point when the command set one. A relative `path` is resolved by the caller against `base` when
// there is one, and against its own default when there is not.
export type ShellWriteTarget = {
  path: string
  // The `cd` argument in force for this write, when the command performed one. Absent when the command
  // never changed directory, in which case the caller's own default cwd applies. Itself possibly
  // relative (`cd packages/web`), so the caller resolves it the same way.
  base?: string
  // The target ran to the end of the command text with no terminator after it. A capped command (see
  // transcript.ts COMMAND_CAP) can sever a path mid-token and leave something that parses as complete,
  // so a caller holding a TRUNCATED command drops these rather than naming half a file.
  atEnd?: boolean
}

// Commands that write a file named in their ARGUMENTS rather than after a redirect. `sed -i` and
// `perl -pi` are named by `auto` mode's own instruction, and `tee` is how a worker writes a file and
// echoes it in one call. `rm`/`mv`/`cp` stay out: the rail lists what a worker WROTE, and not
// inspecting them is a standing decision this change does not revisit.
const IN_PLACE_EDITORS = new Set(["sed", "perl", "tee"])

// Shell metacharacters that end one simple command and start the next.
function isOperatorChar(c: string): boolean {
  return c === ";" || c === "&" || c === "|" || c === "(" || c === ")"
}

// A token the shell would expand before the command ever ran — there is no honest path to report.
function isUnresolvable(token: string): boolean {
  return token.includes("$") || token.includes("`") || token.includes("*") || token.includes("?")
}

type Token = { text: string; quoted: boolean; atEnd: boolean }

// One simple command: its words, and the files it redirects onto.
type SimpleCommand = { argv: Token[]; redirects: Token[] }

// Split a command string into simple commands, honouring single quotes, double quotes, backslash
// escapes and heredoc bodies. Heredoc bodies are SKIPPED rather than tokenized — they are content the
// command writes, not shell the command runs, and a markdown body full of `>` blockquotes would
// otherwise read as a hundred redirects.
function parseSimpleCommands(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  let argv: Token[] = []
  let redirects: Token[] = []
  let text = ""
  let quoted = false
  let started = false
  let redirectPending = false
  // An input redirect's operand is a file the command READS. It has to be swallowed rather than left
  // in argv, or `tee out.txt < in.txt` reports `in.txt` as something the worker wrote.
  let inputPending = false
  // Heredoc tags opened on the line being read; their bodies are consumed at the newline that ends it.
  let pendingHeredocs: { tag: string; strip: boolean }[] = []
  const n = command.length
  let i = 0

  const endToken = (atEnd: boolean) => {
    if (!started) return
    const token = { text, quoted, atEnd }
    if (redirectPending) {
      redirects.push(token)
      redirectPending = false
    } else if (inputPending) {
      inputPending = false
    } else {
      argv.push(token)
    }
    text = ""
    quoted = false
    started = false
  }
  const endCommand = () => {
    endToken(false)
    if (argv.length || redirects.length) commands.push({ argv, redirects })
    argv = []
    redirects = []
    redirectPending = false
    inputPending = false
  }

  while (i < n) {
    const c = command[i]

    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      started = true
      quoted = true
      if (close < 0) {
        text += command.slice(i + 1)
        i = n
        break
      }
      text += command.slice(i + 1, close)
      i = close + 1
      continue
    }

    if (c === '"') {
      let j = i + 1
      started = true
      quoted = true
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < n) {
          text += command[j + 1]
          j += 2
        } else {
          text += command[j]
          j++
        }
      }
      i = j < n ? j + 1 : n
      continue
    }

    if (c === "\\" && i + 1 < n) {
      // A backslash-newline is a line continuation, not a character.
      if (command[i + 1] === "\n") {
        i += 2
        continue
      }
      text += command[i + 1]
      started = true
      i += 2
      continue
    }

    if (c === "\n") {
      endCommand()
      i++
      // Every heredoc opened on the line just ended takes its body from here.
      for (const heredoc of pendingHeredocs) {
        while (i < n) {
          let eol = command.indexOf("\n", i)
          if (eol < 0) eol = n
          const line = command.slice(i, eol)
          i = eol < n ? eol + 1 : n
          if ((heredoc.strip ? line.replace(/^\t+/, "") : line).trim() === heredoc.tag) break
        }
      }
      pendingHeredocs = []
      continue
    }

    if (c === "<") {
      // `<<TAG` / `<<-TAG` opens a heredoc; `<<<` is a herestring and `<` a plain input redirect, and
      // neither writes anything.
      if (command[i + 1] === "<" && command[i + 2] !== "<") {
        let j = i + 2
        let strip = false
        if (command[j] === "-") {
          strip = true
          j++
        }
        while (j < n && (command[j] === " " || command[j] === "\t")) j++
        const quote = command[j] === "'" || command[j] === '"' ? command[j] : ""
        if (quote) j++
        let tag = ""
        while (j < n && /[A-Za-z0-9_]/.test(command[j])) {
          tag += command[j]
          j++
        }
        if (quote && command[j] === quote) j++
        if (tag) {
          endToken(false)
          pendingHeredocs.push({ tag, strip })
          i = j
          continue
        }
      }
      endToken(false)
      i++
      // `<<<` is a herestring: its operand is inline data, not a filename to swallow.
      const herestring = command[i] === "<" && command[i + 1] === "<"
      while (i < n && command[i] === "<") i++
      if (!herestring) inputPending = true
      continue
    }

    if (c === ">") {
      endToken(false)
      let j = i + 1
      if (command[j] === ">") j++
      // `>&2`, `2>&1` and `>&-` duplicate a descriptor; no file is named.
      if (command[j] === "&") {
        i = j + 1
        while (i < n && /[0-9-]/.test(command[i])) i++
        continue
      }
      redirectPending = true
      i = j
      continue
    }

    if (isOperatorChar(c)) {
      endCommand()
      i++
      continue
    }

    if (c === " " || c === "\t") {
      endToken(false)
      i++
      continue
    }

    // An `N>` fd prefix is part of the operator, not of the word before it.
    text += c
    started = true
    i++
  }

  endToken(true)
  if (argv.length || redirects.length) commands.push({ argv, redirects })
  return commands
}

// The command word, with any leading `env VAR=x` / `sudo` and `VAR=x` assignments stepped over, and a
// path-qualified name (`/usr/bin/sed`) reduced to its basename.
function commandWord(argv: readonly Token[]): { word: string; rest: Token[] } {
  let index = 0
  while (index < argv.length) {
    const raw = argv[index].text
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw) && !argv[index].quoted) {
      index++
      continue
    }
    const base = raw.slice(raw.lastIndexOf("/") + 1)
    if (base === "env" || base === "sudo" || base === "command" || base === "nice") {
      index++
      continue
    }
    return { word: base, rest: argv.slice(index + 1) }
  }
  return { word: "", rest: [] }
}

// The file operands of an in-place editor. `sed`/`perl` only write when an in-place flag is present;
// `tee` always does. The script is whatever `-e`/`-f` carried, or else the first bare word — every
// bare word after that is a file. BSD `sed -i ''` passes its backup suffix as a separate operand,
// which is why the suffix is consumed with the flag.
function inPlaceTargets(word: string, rest: readonly Token[]): Token[] {
  const files: Token[] = []
  let inPlace = word === "tee"
  let scriptSeen = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    const raw = token.text
    if (!token.quoted && raw.startsWith("-") && raw !== "-") {
      if (word !== "tee" && /^-[a-zA-Z]*i/.test(raw)) {
        inPlace = true
        // GNU takes the suffix glued on (`-i.bak`); BSD takes it as the next word.
        if (raw === "-i" && rest[i + 1] && !rest[i + 1].text.startsWith("-") && rest[i + 1].quoted && rest[i + 1].text === "") i++
      }
      if (/^-[a-zA-Z]*[ef]$/.test(raw)) {
        scriptSeen = true
        i++
      }
      continue
    }
    if (word !== "tee" && !scriptSeen) {
      scriptSeen = true
      continue
    }
    files.push(token)
  }
  return inPlace ? files : []
}

/**
 * Every file the command writes, in the order the command writes them.
 *
 * Redirect targets are taken from ANY command, not a whitelist of writers: `printf … > f`,
 * `jq … > f.json` and `nub build > out.log` all write, and on the measured corpus every surviving
 * redirect target outside `/dev/null` and `/tmp` was a genuine file. Targets the shell would have had
 * to expand (`$VAR`, a backtick, a glob) are dropped — there is no honest path to show for them.
 *
 * A `cd` performed by the command is tracked so that `cd packages/web && cat > a.ts` reports
 * `packages/web/a.ts` rather than a path that resolves somewhere the worker never wrote. A `cd` whose
 * own argument cannot be resolved (`cd "$dir"`, `cd -`) makes every RELATIVE write after it unknowable,
 * and those are dropped rather than guessed: a missing row costs a glance, a wrong row costs trust.
 */
export function shellWriteTargets(command: string): ShellWriteTarget[] {
  const out: ShellWriteTarget[] = []
  let base: string | undefined
  let baseUnknown = false

  for (const simple of parseSimpleCommands(command)) {
    const { word, rest } = commandWord(simple.argv)

    // The in-place reading is gated on the command WORD, not on the flags: `-i` means in-place to
    // `sed` and `perl` and means ignore-case to `grep`, so reading flags first turned every
    // `grep -rln -i … tests/windows .github/workflows` into three files the worker never wrote.
    const targets = [...simple.redirects, ...(IN_PLACE_EDITORS.has(word) ? inPlaceTargets(word, rest) : [])]
    for (const target of targets) {
      const path = target.text.trim()
      if (!path || isUnresolvable(path)) continue
      const relative = !path.startsWith("/") && !path.startsWith("~")
      if (relative && baseUnknown) continue
      out.push({
        path,
        ...(relative && base !== undefined ? { base } : {}),
        ...(target.atEnd ? { atEnd: true } : {}),
      })
    }

    // `cd` is resolved AFTER this command's own writes, which is the order the shell runs them in.
    if (word === "cd") {
      const argument = rest.find((t) => t.text !== "-" && !t.text.startsWith("-"))?.text
      if (!argument || isUnresolvable(argument) || argument === "-") {
        baseUnknown = true
        base = undefined
      } else {
        // `cd a && cd b` lands in `a/b`, so a relative hop composes onto the base already in force
        // instead of replacing it. The caller normalizes (`..` and all) when it resolves.
        const relativeHop = !argument.startsWith("/") && !argument.startsWith("~")
        base = relativeHop && base !== undefined ? `${base}/${argument}` : argument
        baseUnknown = false
      }
    }
  }

  return out
}
