#!/usr/bin/env node
// Tag a published release and create its GitHub release WITH ITS NOTES — the releaser's last step, run
// from its own `gh` session once release.yml is green (AGENTS.md § Cutting a release). Every release
// gets one, server-only releases included.
//
//   nub scripts/tag-release.mjs --notes-file notes.md                    the shell, root package.json's version
//   nub scripts/tag-release.mjs frizz-server --notes-file notes.md       the server, packages/server-release's
//   nub scripts/tag-release.mjs frizz-server 0.15.28 --notes-file notes.md
//
// RELEASE NOTES ARE REQUIRED (maintainer 2026-10-16: "You should start publishing release notes with each
// one. That's important."). Until then a shell release carried one line pointing at npm and a server
// release got nothing at all, so nobody could tell what 0.15.25–0.15.27 changed. A release is never
// created without `--notes-file`; the script appends the npm link itself. Given notes for a release that
// already exists, it replaces that release's notes, so a re-run is how notes are corrected.
//
// AND THEY ARE NOTES, NOT A PARAGRAPH (the same day, of 0.15.28's two unlinked bullets: "absolutely
// fucking terrible. They don't link to the relevant commits or PRs"). Draft them with
// `scripts/release-notes.mjs`, which links every change to its commit and pull request and closes on a
// compare link. Notes still carrying its DRAFT line, or missing a commit/PR link or the compare link,
// are refused before anything is written.
//
// Tags: the shell is `vX.Y.Z` (its tags predate the server's), the server `frizz-server-vX.Y.Z`. A server
// release is never marked GitHub's "Latest": that badge names what `npx frizz` installs, which is the shell.
//
// WHY THIS IS NOT IN THE WORKFLOW (maintainer 2026-10-12). release.yml tagged the shell itself until
// GitHub refused it: a workflow's own token may not create a ref whose commit carries a different
// `.github/workflows/` than the run's checkout, and the shell is tagged at npm's recorded gitHead,
// which a later run routinely is not (frizz 0.13.13, tagged by a run whose own commit had changed
// release.yml). The releaser's `gh` session holds the workflow scope, so the tag is made here instead,
// and the workflow keeps no write access to the repository at all.
//
// The target is npm's recorded gitHead, never a local checkout, and an existing tag is never moved:
// a re-run reports what is already there and creates only what is missing.
import { execGh } from "./lib/gh-command.mjs"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { publishedGitHead } from "./published-git-head.mjs"

const PACKAGES = {
  frizz: { manifest: "package.json", tag: (v) => `v${v}`, latest: true },
  "frizz-server": { manifest: "packages/server-release/package.json", tag: (v) => `frizz-server-v${v}`, latest: false },
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const notesAt = args.indexOf("--notes-file")
const notesFile = notesAt === -1 ? undefined : args[notesAt + 1]
if (notesAt !== -1 && !notesFile) throw new Error("--notes-file needs a path")
const positional = notesAt === -1 ? args : args.filter((_, i) => i !== notesAt && i !== notesAt + 1)
const pkg = positional[0] && !/^\d/.test(positional[0]) ? positional.shift() : "frizz"
const spec = PACKAGES[pkg]
if (!spec) throw new Error(`not a released package: ${pkg} (one of ${Object.keys(PACKAGES).join(", ")})`)
const version = positional[0] ?? JSON.parse(readFileSync(join(root, spec.manifest), "utf8")).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`)
const tag = spec.tag(version)
const notes = notesFile === undefined ? undefined : readFileSync(notesFile, "utf8").trim()
if (notes === "") throw new Error(`${notesFile} is empty; a release's notes say what changed`)
if (notes !== undefined) {
  const faults = [
    notes.includes("<!-- DRAFT") && "it still carries release-notes.mjs's DRAFT line: rewrite the drafted bullets, then delete it",
    !/github\.com\/[^/\s]+\/[^/\s]+\/(commit|pull)\//.test(notes) && "it links no commit or pull request",
    !/github\.com\/[^/\s]+\/[^/\s]+\/compare\//.test(notes) && "it has no compare link to the previous release",
  ].filter(Boolean)
  if (faults.length) throw new Error(`${notesFile} is not release notes yet: ${faults.join("; ")}. Draft them with scripts/release-notes.mjs`)
}

const gh = (args, input) => execGh("Publish a Frizz release's tag and notes", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim()
const ghOk = (args) => { try { gh(args); return true } catch { return false } }

const repo = process.env.FRIZZ_RELEASE_REPO ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
const releaseExists = ghOk(["release", "view", tag, "--repo", repo])
// Checked before anything is written, so a run that would leave a bare tag behind writes nothing.
if (!releaseExists && notes === undefined) {
  throw new Error(`${tag} has no GitHub release yet, and one is never created without notes: pass --notes-file`)
}
// Fails closed: no served version, or one with no gitHead, is never tagged.
const gitHead = await publishedGitHead(pkg, version, { registry: process.env.FRIZZ_NPM_REGISTRY, timeoutMs: 30_000 })

let existing
try { existing = gh(["api", `repos/${repo}/git/ref/tags/${tag}`, "--jq", ".object.sha + \" \" + .object.type"]) } catch { existing = undefined }
if (existing) {
  const [sha, type] = existing.split(" ")
  const target = type === "tag" ? gh(["api", `repos/${repo}/git/tags/${sha}`, "--jq", ".object.sha"]) : sha
  if (target !== gitHead) throw new Error(`${tag} already points at ${target}, not npm's ${gitHead}; it is never moved`)
  console.log(`${tag} is already tagged at ${gitHead}`)
} else {
  const object = gh(["api", "-X", "POST", `repos/${repo}/git/tags`, "--input", "-", "--jq", ".sha"],
    JSON.stringify({ tag, message: `${pkg} v${version}`, object: gitHead, type: "commit" }))
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "--input", "-", "--jq", ".ref"],
    JSON.stringify({ ref: `refs/tags/${tag}`, sha: object }))
  console.log(`tagged ${tag} at ${gitHead}`)
}

const body = notes === undefined ? undefined : `${notes}\n\nPublished to npm: https://www.npmjs.com/package/${pkg}/v/${version}\n`
if (releaseExists) {
  if (body === undefined) console.log(`the ${tag} release already exists`)
  else {
    gh(["release", "edit", tag, "--repo", repo, "--notes-file", "-"], body)
    console.log(`replaced the ${tag} release's notes`)
  }
} else {
  gh(["release", "create", tag, "--repo", repo, "--title", `${pkg} v${version}`, "--notes-file", "-",
    `--latest=${spec.latest}`, "--verify-tag"], body)
  console.log(`created the ${tag} GitHub release`)
}
