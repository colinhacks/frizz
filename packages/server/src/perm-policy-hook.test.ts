import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Drives the REAL cc-worker/hooks/perm-policy.mjs the way Claude Code does: one PermissionRequest
// payload on stdin, the worker's environment, and whatever it prints is its decision. Printing NOTHING
// is a decision too — the prompt is raised and a human answers it.
const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/perm-policy.mjs")

interface Verdict { behavior: "allow" | "deny" | "ask"; rule: string }

function decide(command: string, permissionMode = "default"): Verdict {
  const permDir = mkdtempSync(join(tmpdir(), "perm-policy-"))
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: "sid", transcript_path: "/x.jsonl", cwd: "/x", prompt_id: "p1",
      permission_mode: permissionMode, hook_event_name: "PermissionRequest",
      tool_name: "Bash", tool_input: { command, description: "d" },
    }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: "thread-under-test", FRIZZ_PERM_DIR: permDir, FRIZZ_PERM_POLICY: "auto" },
  })
  assert.equal(result.status, 0, result.stderr)
  const marker = JSON.parse(readFileSync(join(permDir, "thread-under-test.json"), "utf8"))
  const behavior = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.decision.behavior : "ask"
  return { behavior, rule: marker.rule }
}

const QUESTION = '{"question":"Ship the `beta` build?","options":[{"label":"Yes","description":"go"},{"label":"No","description":"wait"}]}'

// A thread a human moved to `default` gets every prompt back — and still has to be able to ask them a
// question, which is a JSON body through a heredoc: the one form Claude Code's own `Bash(frizzctl:*)`
// rule does not carry (measured, `_live_broker_frizzctl.mts`).
test("a worker's own frizzctl command fed by a quoted heredoc is approved in a restrictive mode", () => {
  for (const command of [
    `frizzctl ask --input - <<'EOF'\n${QUESTION}\nEOF`,
    `frizzctl ask --input - <<'EOF'\n${QUESTION}\nEOF\n`,
    `  frizzctl done --body-file - <<'FRIZZ_BODY'\nLanded on \`main\`.\n\n- **Fixed** it; \`rm -r build && make\` is green.\nEOF\n$(not run)\nFRIZZ_BODY`,
    `frizzctl spawn-thread --model opus --effort high --prompt-file - <<'EOF'\nAudit the resolver.\nEOF`,
    `frizzctl steer fix-queue-focus --message-file=- <<'EOF'\nThe cache key is the normalized id.\nEOF`,
    `frizzctl <<'EOF'\n{}\nEOF`,
  ]) {
    for (const mode of ["default", "acceptEdits", "plan"]) {
      assert.deepEqual(decide(command, mode), { behavior: "allow", rule: "own-frizzctl" }, `${mode}: ${command}`)
    }
  }
})

// Every one of these is a command line that could run something other than frizzctl, or one whose
// shape this hook cannot prove. Each must be left to the human, exactly as before the rule existed.
test("anything that is not provably that one shape is still left for a human", () => {
  const body = `\n${QUESTION}\nEOF`
  for (const command of [
    // The delimiter is not quoted, so the body is expanded: `$(…)` in it runs.
    `frizzctl ask --input - <<EOF\n$(touch pwned)\nEOF`,
    `frizzctl ask --input - <<"EOF"${body}`,
    `frizzctl ask --input - <<-'EOF'${body}`,
    // Something after the heredoc word, on the line the shell does interpret.
    `frizzctl ask --input - <<'EOF'; touch pwned${body}`,
    `frizzctl ask --input - <<'EOF' && touch pwned${body}`,
    `frizzctl ask --input - <<'EOF' | sh${body}`,
    `frizzctl ask --input - <<'EOF' > /etc/hosts${body}`,
    `frizzctl ask --input - <<'A' <<'B'\nx\nA\nB`,
    // Something after the terminator.
    `frizzctl ask --input - <<'EOF'${body}\ntouch pwned`,
    `frizzctl ask --input - <<'EOF'${body}\n\n  touch pwned\n`,
    // No terminator the shell would accept: the "body" swallows nothing, or everything.
    `frizzctl ask --input - <<'EOF'\n${QUESTION}\n EOF`,
    `frizzctl ask --input - <<'EOF'\n${QUESTION}\nEOF `,
    `frizzctl ask --input - <<'EOF'\n${QUESTION}`,
    `frizzctl ask --input - <<'EOF'\r\n${QUESTION}\r\nEOF`,
    // An argument the shell interprets.
    `frizzctl ask $(touch pwned) <<'EOF'${body}`,
    "frizzctl ask `touch pwned` <<'EOF'" + body,
    `frizzctl ask "$HOME" <<'EOF'${body}`,
    `frizzctl ask 'quoted' <<'EOF'${body}`,
    `frizzctl ask {a,b} <<'EOF'${body}`,
    `frizzctl ask ~root <<'EOF'${body}`,
    `frizzctl ask * <<'EOF'${body}`,
    `frizzctl ask \\\n --input - <<'EOF'${body}`,
    `frizzctl ask --input\t- <<'EOF'${body}`,
    // Not frizzctl, or not only frizzctl.
    `frizzctlx ask --input - <<'EOF'${body}`,
    `/tmp/elsewhere/frizzctl ask --input - <<'EOF'${body}`,
    `./frizzctl ask --input - <<'EOF'${body}`,
    `PATH=/tmp/elsewhere frizzctl ask --input - <<'EOF'${body}`,
    `sudo frizzctl ask --input - <<'EOF'${body}`,
    `touch pwned; frizzctl ask --input - <<'EOF'${body}`,
    `touch pwned\nfrizzctl ask --input - <<'EOF'${body}`,
    `cat <<'EOF' | frizzctl ask --input -${body}`,
    // Blanks the shell does not treat as blanks: each makes a word, so a different program runs.
    `\u00a0frizzctl ask --input - <<'EOF'${body}`,
    `\ufefffrizzctl ask --input - <<'EOF'${body}`,
    `frizzctl ask --input - <<'EOF'${body}\n\u00a0`,
    `frizzctl ask --input - <<'EOF'${body}\n\f`,
    // No heredoc at all: Claude Code's own rule carries these, and this hook adds nothing to it.
    `frizzctl title "Fix queue focus"`,
    `frizzctl title x && touch pwned`,
  ]) {
    assert.deepEqual(decide(command), { behavior: "ask", rule: "restrictive-mode" }, JSON.stringify(command))
  }
})

// The rule is an addition to the table, not a way round it.
test("the two refusals still come first, and an unattended worker is still approved as before", () => {
  assert.deepEqual(decide("frizzctl done --body-file - <<'EOF'\nrm -rf /\nEOF"), { behavior: "deny", rule: "catastrophic-delete" })
  assert.deepEqual(decide("touch x", "bypassPermissions"), { behavior: "allow", rule: "worker-autonomy" })
  assert.deepEqual(decide(`frizzctl ask --input - <<'EOF'\n${QUESTION}\nEOF`, "auto"), { behavior: "allow", rule: "own-frizzctl" })
  assert.deepEqual(decide("touch x"), { behavior: "ask", rule: "restrictive-mode" })
})

// Auto mode's classifier answers almost everything itself; a request reaches this hook because auto mode
// handed it back: an `ask` rule, a protected path, or the fallback after repeated refusals. Approving those
// here turned a refusal into a retry count, so they go to a person, and the refusals still come first.
test("what auto mode leaves for a person is never approved by the hook", () => {
  assert.deepEqual(decide("git push --force origin main", "auto"), { behavior: "ask", rule: "auto-escalation" })
  assert.deepEqual(decide("rm -rf /", "auto"), { behavior: "deny", rule: "catastrophic-delete" })
})
