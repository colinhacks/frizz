// The board reads two row fields on every open thread's every build through helpers that skip zod
// (board.ts permissionModeOf, snoozeInstantOf): zod's failure path built an error object per absent value
// per build. Their answers must be the schemas' own, over every shape a column can hold.
import { test } from "node:test"
import assert from "node:assert/strict"
import { PermissionMode } from "@frizz/shared"
import { resolvePendingPermission, resolveSessionPermission } from "./board.ts"

const VALUES = [null, undefined, "", "auto", "default", "acceptEdits", "plan", "bypassPermissions", "Auto", "bypass", " plan", "dontAsk", "toString", "__proto__"]

test("a pending permission reads exactly as the PermissionMode schema parses it", () => {
  for (const value of VALUES) {
    const parsed = PermissionMode.safeParse(value)
    assert.equal(resolvePendingPermission({ permission_pending: value as string | null }), parsed.success ? parsed.data : undefined, JSON.stringify(value))
  }
})

test("a session's permission mode is the schema's reading of both columns, for every pairing", () => {
  for (const backend of ["claude", "codex", "opencode"] as const) {
    for (const saved of VALUES) {
      for (const pending of VALUES) {
        const row = { backend, spawned_at: "2026-07-01T00:00:00.000Z", permission_mode: saved as string | null, permission_pending: pending as string | null, permission_set_at: null }
        // The reference: the schema decides which values are modes at all.
        const s = PermissionMode.safeParse(saved)
        const got = resolveSessionPermission(row)
        if (!s.success) assert.equal(got, undefined, `${backend} ${JSON.stringify(saved)}/${JSON.stringify(pending)}: no saved mode, no telemetry`)
        else assert.ok(got !== undefined, `${backend} ${JSON.stringify(saved)}: a saved mode resolves`)
      }
    }
  }
})
