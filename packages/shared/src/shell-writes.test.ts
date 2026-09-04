import { test } from "node:test"
import assert from "node:assert/strict"
import { shellWriteTargets } from "./shell-writes.ts"

const paths = (command: string) => shellWriteTargets(command).map((t) => (t.base ? `${t.base}::${t.path}` : t.path))

test("a heredoc redirect names the file it writes — the reported case", () => {
  // Verbatim shape of the call that went missing (nub thread a5d33c0a, 2026-09-04).
  const command = "cd /Users/colinmcd94/Documents/projects/nub; cat > .frizz/sandbox-direction-decisions.md <<'MD'\n# Notes\nsome > text\nMD\necho done"
  assert.deepEqual(paths(command), ["/Users/colinmcd94/Documents/projects/nub::.frizz/sandbox-direction-decisions.md"])
})

test("a heredoc BODY is content, not shell — its redirects and quotes never parse", () => {
  const command = "cat > doc.md <<'EOF'\n> a blockquote\ncmd > not-a-file.txt\nit's a quote that never closes\nEOF"
  assert.deepEqual(paths(command), ["doc.md"])
})

test("quoted payloads are inert: an arrow function is not a redirect", () => {
  // The failure that makes a regex unusable here — `=>` and `>` inside inline JS read as redirects.
  assert.deepEqual(paths(`node -e 'const f = a => a > 1; console.log(f(2))'`), [])
  assert.deepEqual(paths(`node -e "const f = a => a > 1" > out.json`), ["out.json"])
})

test("descriptor plumbing writes nothing", () => {
  assert.deepEqual(paths("ls foo 2>/dev/null | head -3"), ["/dev/null"])
  assert.deepEqual(paths("run 2>&1 | tee -a /tmp/x.log"), ["/tmp/x.log"])
  assert.deepEqual(paths("echo hi >&2"), [])
  assert.deepEqual(paths("build >out.log 2>&1"), ["out.log"])
})

test("append, herestring and plain input redirects", () => {
  assert.deepEqual(paths("echo x >> notes.md"), ["notes.md"])
  assert.deepEqual(paths("cat <<< 'hi' > a.txt"), ["a.txt"])
  assert.deepEqual(paths("sort < in.txt > out.txt"), ["out.txt"])
})

test("in-place editors are recognized by their command word, never by a bare -i flag", () => {
  assert.deepEqual(paths("sed -i '' -e 's/a/b/' src/app.ts"), ["src/app.ts"])
  assert.deepEqual(paths("sed -i.bak 's/a/b/' a.ts b.ts"), ["a.ts", "b.ts"])
  assert.deepEqual(paths("perl -pi -e 's/a/b/' lib/x.pl"), ["lib/x.pl"])
  assert.deepEqual(paths("tee out.txt < in.txt"), ["out.txt"])
  // `sed` without an in-place flag only reads.
  assert.deepEqual(paths("sed -n '1,5p' src/app.ts"), [])
  // `-i` means ignore-case here; these are search roots, not files anyone wrote.
  assert.deepEqual(paths('grep -rln -i "lowbox" tests/windows .github/workflows'), [])
  assert.deepEqual(paths("ssh -i ~/.ssh/key -o StrictHostKeyChecking=no host"), [])
})

test("a `cd` moves the base, composes, and when unknowable drops relative writes only", () => {
  assert.deepEqual(paths("cd packages/web && cat > a.ts"), ["packages/web::a.ts"])
  assert.deepEqual(paths("cd a && cd b && echo x > c.txt"), ["a/b::c.txt"])
  // The write happens BEFORE the cd on its right.
  assert.deepEqual(paths("echo x > first.txt; cd sub; echo y > second.txt"), ["first.txt", "sub::second.txt"])
  // An unresolvable cd makes relative targets unknowable — dropped, not guessed at.
  assert.deepEqual(paths('cd "$TMP" && echo x > rel.txt && echo y > /abs/keep.txt'), ["/abs/keep.txt"])
  assert.deepEqual(paths("cd - ; echo x > rel.txt"), [])
})

test("targets the shell would have expanded carry no honest path", () => {
  assert.deepEqual(paths("echo x > $OUT"), [])
  assert.deepEqual(paths("echo x > `mktemp`"), [])
  assert.deepEqual(paths("rm -f build/*.log; echo x > out-*.txt"), [])
})

test("a quoted target keeps its spaces; env and sudo prefixes are stepped over", () => {
  assert.deepEqual(paths(`cat > "my notes.md"`), ["my notes.md"])
  assert.deepEqual(paths("FOO=1 sed -i 's/a/b/' x.ts"), ["x.ts"])
  assert.deepEqual(paths("sudo /usr/bin/sed -i 's/a/b/' /etc/hosts"), ["/etc/hosts"])
})

test("a target that runs to the end of the text is flagged, so a truncated command can drop it", () => {
  assert.deepEqual(shellWriteTargets("echo x > cut/off/pa").at(-1)?.atEnd, true)
  assert.equal(shellWriteTargets("echo x > done.txt\n").at(-1)?.atEnd, undefined)
})
