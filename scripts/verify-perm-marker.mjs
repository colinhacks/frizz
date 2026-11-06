// End-to-end proof for the PermissionRequest policy hook + the tailer's default marker reader,
// exercised against the REAL hook file and REAL fs — no mocks of either.
//
// It (1) runs cc-worker/hooks/perm-policy.mjs exactly as Claude Code would (payload on stdin, env set)
// and asserts each policy outcome emits the right decision AND records it on the marker, and (2) meets
// the tailer's side of the contract: only a DEFERRED marker counts as a human block.
//
// Usage: nub scripts/verify-perm-marker.mjs   (exit 0 = all green)
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { permMarkerPath, permRequestDir, PERM_DIR_ENV } from "../packages/server/src/project.ts"
import { markerDecision } from "../packages/server/src/tailer.ts"

const HOOK = resolve(import.meta.dirname, "../cc-worker/hooks/perm-policy.mjs")
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`) }

const state = mkdtempSync(join(tmpdir(), "permmarker-"))
const project = { stateDir: state }
const permDir = permRequestDir(project)
const slug = "demo-thread"

// Run the hook the way Claude Code does: JSON payload on stdin, FRIZZ_THREAD + FRIZZ_PERM_DIR in env.
function runHook(payload, env = {}) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: slug, [PERM_DIR_ENV]: permDir, FRIZZ_PERM_POLICY: "auto", ...env },
  })
}
const marker = () => JSON.parse(readFileSync(permMarkerPath(project, slug), "utf8"))
const bash = (command, over = {}) => ({
  session_id: "sid", transcript_path: "/x.jsonl", cwd: "/x", prompt_id: "p1",
  permission_mode: "bypassPermissions", hook_event_name: "PermissionRequest",
  tool_name: "Bash", tool_input: { command, description: "d" }, ...over,
})

try {
  // 1. ALLOW — the ordinary unattended-worker path: approve, and say so on the marker.
  const out = JSON.parse(runHook(bash("touch x")) || "{}")
  check("allow: emits an allow decision", out.hookSpecificOutput?.decision?.behavior === "allow", JSON.stringify(out.hookSpecificOutput?.decision))
  check("allow: echoes tool_input back as updatedInput", out.hookSpecificOutput?.decision?.updatedInput?.command === "touch x")
  const m1 = marker()
  check("allow: marker records decision + rule + reason", m1.decision === "allow" && m1.rule === "worker-autonomy" && !!m1.reason, `${m1.decision}/${m1.rule}`)
  check("allow: marker records the command it decided about", m1.command === "touch x", m1.command)
  check("allow: marker keeps the legacy fields", m1.slug === slug && m1.tool === "Bash" && m1.promptId === "p1" && Number.isFinite(Date.parse(m1.at)))
  check("allow: the tailer reads this as NOT a human block", markerDecision(m1) === "allow")

  // 2. DENY — catastrophic deletes, in several shapes, including hidden behind a `cd &&`.
  for (const cmd of ["rm -rf /", "rm -rf ~", "cd /tmp && rm -fr $HOME", "sudo rm -rf /usr"]) {
    const d = JSON.parse(runHook(bash(cmd)) || "{}")
    check(`deny: refuses \`${cmd}\``, d.hookSpecificOutput?.decision?.behavior === "deny" && typeof d.additionalContext === "string")
  }
  const m2 = marker()
  check("deny: marker records the deny + rule", m2.decision === "deny" && m2.rule === "catastrophic-delete", `${m2.decision}/${m2.rule}`)
  check("deny: the tailer reads this as NOT a human block", markerDecision(m2) === "deny")
  const disk = JSON.parse(runHook(bash("dd if=/dev/zero of=/dev/disk2 bs=1m")) || "{}")
  check("deny: refuses a raw disk write", disk.hookSpecificOutput?.decision?.behavior === "deny" && marker().rule === "raw-disk-write")

  // 3. NOT over-blocking — ordinary destructive-looking work must still sail through.
  for (const cmd of ["rm -rf node_modules", "rm -rf ./dist", "rm -rf /tmp/scratch-123", "git push origin HEAD:main", "npm publish --tag canary"]) {
    const a = JSON.parse(runHook(bash(cmd)) || "{}")
    check(`allow: does NOT over-block \`${cmd}\``, a.hookSpecificOutput?.decision?.behavior === "allow")
  }

  // 4. DEFER — a deliberately restrictive mode gets its prompts back (emit nothing).
  const deferred = runHook(bash("touch y", { permission_mode: "default" }))
  check("defer: restrictive permission_mode emits NOTHING (prompt is raised)", deferred === "", JSON.stringify(deferred))
  const m3 = marker()
  check("defer: marker records the defer + rule", m3.decision === "defer" && m3.rule === "restrictive-mode", `${m3.decision}/${m3.rule}`)
  check("defer: the tailer reads this AS a human block", markerDecision(m3) === "defer")

  // Auto mode's classifier answers almost everything itself, so what reaches the hook is what auto mode
  // handed back to a person. Approving it here would turn a refusal into a retry count.
  const escalated = runHook(bash("touch y", { permission_mode: "auto" }))
  check("defer: what auto mode leaves for a person emits NOTHING (prompt is raised)", escalated === "", JSON.stringify(escalated))
  check("defer: the marker names auto-escalation", marker().decision === "defer" && marker().rule === "auto-escalation", `${marker().decision}/${marker().rule}`)

  for (const mode of ["acceptEdits", "plan", "some-future-mode"]) {
    check(`defer: \`${mode}\` emits NOTHING (unknown must mean ask)`, runHook(bash("touch y", { permission_mode: mode })) === "" && marker().rule === "restrictive-mode")
  }

  // 4b. BYPASS IS NOT RESTRICTIVE — it asked for nothing to be checked, so a prompt Claude Code still
  // raises under it is approved, behind the same two refusals.
  const bypass = JSON.parse(runHook(bash("touch y", { permission_mode: "bypassPermissions" })) || "{}")
  check("allow: bypassPermissions is approved, not handed to a human", bypass.hookSpecificOutput?.decision?.behavior === "allow" && marker().rule === "worker-autonomy", marker().rule)
  const bypassRm = JSON.parse(runHook(bash("rm -rf ~", { permission_mode: "bypassPermissions" })) || "{}")
  check("deny: bypassPermissions still refuses a catastrophic delete", bypassRm.hookSpecificOutput?.decision?.behavior === "deny" && marker().rule === "catastrophic-delete")

  // 4c. THE WORKER'S OWN FRIZZ COMMAND is approved in a restrictive mode too, in the one shape Claude
  // Code's `Bash(frizzctl:*)` rule does not carry: a quoted heredoc. The shapes it must NOT approve are
  // pinned in packages/server/src/perm-policy-hook.test.ts.
  const asking = "frizzctl ask --input - <<'EOF'\n{\"question\":\"Ship it?\"}\nEOF"
  const own = JSON.parse(runHook(bash(asking, { permission_mode: "default" })) || "{}")
  check("allow: a restrictive thread's own `frizzctl … <<'EOF'` is approved", own.hookSpecificOutput?.decision?.behavior === "allow" && marker().rule === "own-frizzctl", marker().rule)
  check("defer: …and the same line with something after the heredoc is not", runHook(bash(`${asking}\ntouch y`, { permission_mode: "default" })) === "" && marker().rule === "restrictive-mode", marker().rule)

  // 5. DEFER — the review-policy escape hatch, without changing how workers launch.
  const review = runHook(bash("touch z"), { FRIZZ_PERM_POLICY: "review" })
  check("defer: FRIZZ_PERM_POLICY=review emits NOTHING", review === "")
  check("defer: marker names the review rule", marker().rule === "review-policy", marker().rule)

  // 6. Back-compat: an OLD observe-era marker (no `decision`) still reads as a block.
  check("back-compat: a decision-less marker is treated as deferred", markerDecision({ decision: undefined }) === "defer")
  check("back-compat: an unrecognized decision is treated as deferred", markerDecision({ decision: "wat" }) === "defer")

  // 7. Single file per slug — a later request overwrites, never accumulates.
  check("exactly one marker file exists for the slug", readdirSync(permDir).filter((f) => f === `${slug}.json`).length === 1)

  // 8. ExitPlanMode is skipped entirely (deny-plan owns it; never a real human block).
  rmSync(permDir, { recursive: true, force: true })
  const plan = runHook(bash("x", { tool_name: "ExitPlanMode" }))
  let planWrote = false
  try { readFileSync(permMarkerPath(project, slug), "utf8"); planWrote = true } catch {}
  check("ExitPlanMode writes NO marker and emits nothing", planWrote === false && plan === "")

  // 9. FAIL-SAFE gates. A hook that can APPROVE must fall back to ASKING, never to allowing.
  const noThread = runHook(bash("touch x"), { FRIZZ_THREAD: "" })
  check("no FRIZZ_THREAD → inert (never decides a foreign session)", noThread === "")
  const bad = execFileSync("node", [HOOK], {
    input: "{ not json", encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: slug, [PERM_DIR_ENV]: permDir },
  })
  check("unparseable payload → emits nothing (defers to the human)", bad === "")
  // No marker dir: the decision must still be made and emitted — telemetry loss never stalls a worker.
  const noDir = JSON.parse(runHook(bash("touch x"), { [PERM_DIR_ENV]: "" }) || "{}")
  check("no FRIZZ_PERM_DIR → still decides (marker is telemetry, not a gate)", noDir.hookSpecificOutput?.decision?.behavior === "allow")

  // 10. Corrupt/half-written marker → reader degrades to undefined (fail-safe), never throws.
  mkdirSync(permDir, { recursive: true })
  writeFileSync(permMarkerPath(project, slug), "{ not json")
  let threw = false, val
  try { val = (() => { try { return JSON.parse(readFileSync(permMarkerPath(project, slug), "utf8")) } catch { return undefined } })() } catch { threw = true }
  check("a corrupt marker file is ignored, never throws", threw === false && val === undefined)
} finally {
  rmSync(state, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
