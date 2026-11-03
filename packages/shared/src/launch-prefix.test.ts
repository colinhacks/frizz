import { test } from "node:test"
import assert from "node:assert/strict"
import { applyLaunchPrefix, parseLaunchPrefix } from "./launch-prefix.ts"

const argv = (text: string, home?: string) => {
  const parsed = parseLaunchPrefix(text, home === undefined ? {} : { home })
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error)
  return parsed.argv
}
const error = (text: string) => {
  const parsed = parseLaunchPrefix(text)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(text)} to be refused`)
  return parsed.ok ? "" : parsed.error
}

test("blank text is no prefix", () => {
  assert.deepEqual(argv(""), [])
  assert.deepEqual(argv("   \t\n "), [])
})

test("words split on whitespace, the way the shell would", () => {
  assert.deepEqual(argv("op run --env-file .env --"), ["op", "run", "--env-file", ".env", "--"])
  assert.deepEqual(argv("  aws-vault\texec  work  --  "), ["aws-vault", "exec", "work", "--"])
})

test("single quotes are literal, double quotes allow \\\" and \\\\", () => {
  assert.deepEqual(argv(`sh -c 'export A="$(cat x)"; exec "$@"' sh`), ["sh", "-c", `export A="$(cat x)"; exec "$@"`, "sh"])
  assert.deepEqual(argv(`env "GREETING=hello world" "say \\"hi\\"" "a\\\\b" "\\$HOME" "c\\d"`), ["env", "GREETING=hello world", `say "hi"`, "a\\b", "$HOME", "c\\d"])
  assert.deepEqual(argv(`tool ''`), ["tool", ""])
  assert.deepEqual(argv(`tool a'b c'd`), ["tool", "ab cd"])
})

test("an unquoted backslash escapes only what needs escaping, so a Windows path survives", () => {
  assert.deepEqual(argv(String.raw`C:\tools\op.exe run --`), [String.raw`C:\tools\op.exe`, "run", "--"])
  assert.deepEqual(argv(String.raw`my\ tool a\$b`), ["my tool", "a$b"])
})

test("a leading ~ expands only when a home is given, and only unquoted", () => {
  assert.deepEqual(argv("~/bin/inject --", "/Users/me"), ["/Users/me/bin/inject", "--"])
  assert.deepEqual(argv("env HOME_COPY=~ ~", "/Users/me"), ["env", "HOME_COPY=~", "/Users/me"])
  assert.deepEqual(argv("'~/bin/inject'", "/Users/me"), ["~/bin/inject"])
  assert.deepEqual(argv("~other/bin", "/Users/me"), ["~other/bin"])
  assert.deepEqual(argv("~/bin/inject"), ["~/bin/inject"])
})

test("shell syntax is refused rather than passed through as a literal", () => {
  for (const text of ["op run --env-file=$HOME/.env --", "a | b", "a && b", "a; b", "a > log", "a `b`", "(a)"]) {
    assert.match(error(text), /not run in a shell/)
  }
  // Quoted, the same characters are just characters.
  assert.deepEqual(argv(`printf '%s|%s' "a;b"`), ["printf", "%s|%s", "a;b"])
})

test("a leading variable assignment points at env", () => {
  assert.match(error("ANTHROPIC_BASE_URL=http://localhost:8080"), /Start the prefix with `env` instead/)
  assert.deepEqual(argv("env ANTHROPIC_BASE_URL=http://localhost:8080"), ["env", "ANTHROPIC_BASE_URL=http://localhost:8080"])
})

test("unclosed quotes, an empty command and oversized prefixes are refused", () => {
  assert.match(error("sh -c 'exec"), /single quote/)
  assert.match(error(`sh -c "exec`), /double quote/)
  assert.match(error("'' run"), /empty/)
  assert.match(error("x ".repeat(65)), /more than 64 words/)
  assert.match(error("x".repeat(2_049)), /longer than 2048/)
})

test("applying a prefix puts the runtime's command after the prefix's words, unchanged", () => {
  assert.deepEqual(applyLaunchPrefix(["op", "run", "--"], "/bin/claude", ["--resume", "id"]), { command: "op", args: ["run", "--", "/bin/claude", "--resume", "id"] })
  assert.deepEqual(applyLaunchPrefix([], "/bin/claude", ["-p"]), { command: "/bin/claude", args: ["-p"] })
  assert.deepEqual(applyLaunchPrefix(undefined, "codex", ["app-server"]), { command: "codex", args: ["app-server"] })
})
