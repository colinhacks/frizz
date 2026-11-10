// The worker-plugin closure: the files a `runtime/` tree MUST carry for a dispatched worker to be
// whole, and the assertion that says so loudly at build time.
//
// It lives in its own module because TWO build paths stage that tree and both must hold the same
// opinion about it: `artifacts.ts` (the frizz-dev promoted artifact, `~/.frizz/builds/<digest>/runtime`)
// and `scripts/prepare-package.mjs` (the published package, `<pkg>/runtime`). Each used to keep its own
// hand-copy of the list, so widening the closure meant editing both — and the two were only ever in
// agreement between the first edit and the second. Widening it used to mean typing the same string
// into the artifact builder, the pack script and four test fixtures, and a worker whose plugin lacks
// a file degrades in SILENCE, which is precisely the failure this assertion exists to prevent.
//
// Narrowing it is the same hazard pointed the other way: a file the list still names but the tree no
// longer holds fails NOTHING until `prepack` runs, so the break surfaces at the release. Reverting
// the Stop hook left `stop-fence.mjs` and `transcript-usage.mjs` here after both were deleted, and
// the tree could not be packed until this list caught up. When a listed file goes, it goes here too —
// as `bin/browser-mcp.mjs` + `bin/browser-mcp-tools.json` did on 2026-08-26 with the browser mount
// they served (packages/server/src/backend/types.ts).
//
// THIS LIST DESCRIBES THIS BUILD'S WORKER AND NOTHING ELSE, so never assert it against a tree built
// from source that is not yours. Update & Restart is exactly that situation — the RUNNING build stages
// the NEW checkout — and asserting there deadlocked the update the first time the list narrowed: the
// same 2026-08-26 deletion above left every earlier instance refusing to update, naming a file the new
// source was right not to have. The rule the build path follows now: the list travels with the tree.
// `artifacts.ts` runs `scripts/assert-worker-plugin-closure.mjs` out of the captured SNAPSHOT rather
// than importing this module, and skips the closure half of `readFrizzArtifact` for an artifact it
// just built. Boot-path reads and prepack still import it directly, because there the list and the
// tree come from one checkout.
//
// `scripts/*.mjs` imports this .ts directly, as publish-manifest.mjs already does with its own half.
import { existsSync } from "node:fs";
import { join } from "node:path";

// The worker contract used to ship as markdown under runtime/prompts/ and get read at dispatch time;
// it is now compiled into the server bundle (workerPrompt.ts), so a promoted artifact carries no
// prompt closure. Old artifacts that still list prompts/ files remain valid (extra runtimeFiles are
// harmless); nothing reads them.
export const WORKER_PLUGIN_REQUIRED_FILES = [
  "cc-worker/.claude-plugin/plugin.json",
  "cc-worker/hooks/session-seed.mjs",
  "cc-worker/hooks/agent-bind.mjs",
  "cc-worker/bin/frizz",
  "cc-worker/bin/frizz-update",
  // The worker command line: its launcher, the front-end the launcher runs, and the registry both the
  // front-end and the legacy MCP front-end import. Since 2026-10-11 this is how a worker asks, waits
  // and signs off, so a tree without any one of the three dispatches workers that can do none of it.
  "cc-worker/bin/frizzctl",
  "cc-worker/bin/frizzctl.mjs",
  "cc-worker/lib/frizz-tools.mjs",
  // The board scripts the server shells out to (`index.mjs`, `thread-update.mjs`), the two modules the
  // plugin's hooks import, and everything those four import in turn. Until 2026-11-10 the last three
  // were missing, so a tree without `ownership.mjs` passed this check and failed at its first board
  // read. `worker-plugin-closure.test.ts` keeps the list equal to the directory.
  "board/config.mjs",
  "board/agent-bindings.mjs",
  "board/index.mjs",
  "board/thread-update.mjs",
  "board/ownership.mjs",
  "board/agent-status.mjs",
  "board/decisions.mjs",
] as const;

/** Throw unless `root` (a staged `runtime/` tree, or the repo root it mirrors) holds every entry. */
export function assertWorkerPluginClosure(root: string): void {
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    if (!existsSync(join(root, file)))
      throw new Error(`Frizz worker plugin closure is missing ${file}`);
  }
}
