import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_PLUGIN_REQUIRED_FILES, assertWorkerPluginClosure } from "./worker-plugin-closure.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const listed = new Set<string>(WORKER_PLUGIN_REQUIRED_FILES);
const listedBoard = [...listed].filter((file) => file.startsWith("board/"));

/** The modules a file statically imports by relative path, as paths from the repository root. */
function relativeImports(file: string): string[] {
  const source = readFileSync(join(root, file), "utf8");
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) =>
    relative(root, resolve(root, dirname(file), match[1]!)),
  );
}

test("this checkout holds every file the worker plugin closure names", () => {
  assertWorkerPluginClosure(root);
});

// The list is what a staged runtime is checked against before it ships. A board module it leaves out
// is one a package can lose and still pass: `index.mjs` imported three the list did not name.
test("every board module a listed board script imports is listed too", () => {
  const seen = new Set<string>();
  const queue = [...listedBoard];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imported of relativeImports(file)) {
      assert.ok(imported.startsWith("board/"), `${file} imports ${imported}, outside board/`);
      assert.ok(listed.has(imported), `${file} imports ${imported}, which the closure does not list`);
      queue.push(imported);
    }
  }
  assert.ok(seen.size >= 7, `walked ${[...seen].join(", ")}`);
});

// `board/` ships whole in every server release. Five modules sat in it for months after the hooks that
// used them were retired (913 lines, a second and older "is this thread resting"), found by whoever
// grepped for rest detection first. A module nothing in the closure reaches does not belong there.
test("board/ holds the closure and its tests, and nothing else", () => {
  const modules = readdirSync(join(root, "board")).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.deepEqual(modules.map((name) => `board/${name}`).sort(), [...listedBoard].sort());
});
