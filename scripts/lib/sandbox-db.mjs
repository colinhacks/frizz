// WHERE A SANDBOX'S DATABASE IS — the one answer, for every seed and verify script.
//
// Frizz kept one SQLite file per project until 2026-08-27 (`~/.frizz/projects/<id>/ui.db`); the
// singleton made that a vestige of the one-server-per-repo era and it became ONE file for the machine
// at `~/.frizz/ui.db`, every row tagged with its `project_id` (packages/server/src/frizz-db.ts).
//
// Fifty-three scripts under `scripts/` each carried their own hand-written copy of the old path — three
// different spellings of it — so the cutover moved the database and left every one of them throwing
// "no ui.db under …/.frizz/projects — is the stack booted?" against any current sandbox. That is the
// same failure as the awaiting card's two renderers, one layer down: a fact duplicated by hand in N
// places, and the source of truth moved out from under all of them. The fix is not to sweep the new
// path into fifty-three files, which rebuilds the problem — it is for the fact to have one home.
//
// The PRE-CUTOVER layout is still read, so a sandbox kept from an older build still seeds.

import { execFileSync } from "node:child_process"
import { existsSync, globSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Resolve a sandbox HOME's database and the project rows belong to.
 *
 * @param {string} home - the sandbox HOME an adhoc stack printed (`--home=…`).
 * @returns {{ db: string, stateDir: string, projectId: string, hasProjectId: boolean, unified: boolean }}
 *   `db` the file to hand `sqlite3`; `stateDir` the project's own directory, which still holds the
 *   broker records and sockets under BOTH layouts; `projectId` the launcher's id (its directory name);
 *   `hasProjectId` whether the `session` table carries the column, so a caller's INSERT can supply it
 *   on the unified schema and omit it on the legacy one.
 * @throws if the stack has not booted far enough to have created either.
 *
 * ONE project per sandbox is assumed: `projectId` is the FIRST directory under `projects/`, which is
 * the launcher's own for every adhoc stack a seed runs against. A caller that boots a multi-project
 * stack knows which id it wants and should name it rather than discover it here — resolving by cwd
 * needs `registry.json`, and a helper that guesses in that case is worse than one that does not try
 * (see scripts/seed-question-at-current-rest.mjs, which takes its id as an argument).
 */
export function resolveSandboxDb(home) {
  if (!home) throw new Error("resolveSandboxDb: no --home given")
  const unifiedDb = join(home, ".frizz/ui.db")
  const unified = existsSync(unifiedDb)
  const db = unified ? unifiedDb : globSync(join(home, ".frizz/projects/*/ui.db"))[0]
  if (!db) throw new Error(`no ui.db under ${home}/.frizz — is the stack booted?`)
  // The broker records, sockets and per-project state live under `projects/<id>/` in BOTH layouts; only
  // the database moved. Under the legacy one that directory is the database's own parent.
  const stateDir = unified ? globSync(join(home, ".frizz/projects/*"))[0] : join(db, "..")
  if (!stateDir) throw new Error(`no project state dir under ${home}/.frizz/projects — is the stack booted?`)
  const projectId = basename(stateDir)
  const hasProjectId = execFileSync("sqlite3", [db, "PRAGMA table_info(session)"], { encoding: "utf8" }).includes("|project_id|")
  return { db, stateDir, projectId, hasProjectId, unified }
}

/**
 * The `project_id` column and its value for a `session` INSERT, as a prefix pair — empty strings on the
 * legacy schema, so one template literal works against both:
 *
 *   `INSERT INTO session (${cols}slug, …) VALUES (${vals}'${slug}', …)`
 *
 * @param {{ projectId: string, hasProjectId: boolean }} resolved - from `resolveSandboxDb`.
 */
export function sessionProjectColumns({ projectId, hasProjectId }) {
  return hasProjectId ? { cols: "project_id, ", vals: `'${projectId}', ` } : { cols: "", vals: "" }
}
