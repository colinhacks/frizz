// DOWNLOAD AN UPDATE'S RUNTIMES WHILE THE RELEASE BEFORE IT STILL SERVES (2026-11-15).
//
// An update used to stop the running server and then start the new one, which fetched whatever new
// Claude Code or Codex its release pins before it would serve: on a slow connection that was the
// whole board down for the whole download (ten minutes on the maintainer's, 2026-11-15). The launcher
// now runs THIS, out of the new release's own package, between installing that release and stopping
// the old one. It runs the new release's code, so the pins are the new release's pins, whatever
// launcher started it.
//
// The launcher starts the package's ordinary entry, `dist/dev-child.js`, with
// FRIZZ_PROVISION_RUNTIMES_ONLY=1, and only for a release whose package.json declares
// `frizzServer.provisionRuntimes` (src/server-release.ts): an older release would ignore the variable
// and boot a whole second server. It answers on stdout, one JSON object per line:
//
//   {"type":"plan","runtimes":{"claude":{"label":"2.1.325","present":true},"codex":{…}}}
//   {"type":"download", …RuntimeDownload}            while a pin downloads
//   {"type":"done"}                                  everything the new release needs is on disk
//   {"type":"error","message":"…"}                   and a non-zero exit
//
// A backend this machine is signed out of is left out, exactly as its boot would leave it.
import { shouldDeferRuntimes, prepareRuntimes, provisionedBinary, runtimeCoordinates, runtimesRoot, CLAUDE_BIN_ENV, CODEX_BIN_ENV, RUNTIMES_MODE_ENV } from "./runtimes.ts"

export const PROVISION_RUNTIMES_ONLY_ENV = "FRIZZ_PROVISION_RUNTIMES_ONLY"

export type ProvisionAheadEvent =
  | { type: "plan"; runtimes: Partial<Record<"claude" | "codex", { label: string; present: boolean }>> }
  | ({ type: "download" } & import("./runtimes.ts").RuntimeDownload)
  | { type: "done" }
  | { type: "error"; message: string }

export async function runProvisionAhead(write: (line: string) => void = (line) => process.stdout.write(line)): Promise<number> {
  const emit = (event: ProvisionAheadEvent) => write(`${JSON.stringify(event)}\n`)
  try {
    const defer = await shouldDeferRuntimes()
    const root = runtimesRoot()
    const plan: Extract<ProvisionAheadEvent, { type: "plan" }>["runtimes"] = {}
    if (process.env[RUNTIMES_MODE_ENV] !== "path") {
      for (const backend of ["claude", "codex"] as const) {
        if (defer[backend] || process.env[backend === "claude" ? CLAUDE_BIN_ENV : CODEX_BIN_ENV]) continue
        const coordinates = runtimeCoordinates(backend)
        if (coordinates) plan[backend] = { label: coordinates.label, present: provisionedBinary(backend, root, coordinates.label) !== undefined }
      }
    }
    emit({ type: "plan", runtimes: plan })
    await prepareRuntimes({ defer, root, onDownload: (download) => emit({ type: "download", ...download }) })
    emit({ type: "done" })
    return 0
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) })
    return 1
  }
}
