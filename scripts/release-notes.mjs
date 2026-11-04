#!/usr/bin/env node
// Draft a release's notes from the commits it ships — the releaser's starting point for step 7 of
// AGENTS.md § Cutting a release. It prints Markdown; the releaser rewrites the drafted sections in the
// product's words, keeps every link, deletes the DRAFT line, and hands the file to tag-release.mjs.
//
//   nub scripts/release-notes.mjs frizz-server > notes.md            the server version in its manifest
//   nub scripts/release-notes.mjs frizz-server 0.15.28 > notes.md
//   nub scripts/release-notes.mjs frizz 0.13.14 --to release > notes.md   before npm serves it
//
// WHY (maintainer 2026-10-16, of 0.15.28's two hand-written bullets: "Your release notes were absolutely
// fucking terrible. They don't link to the relevant commits or PRs, do they?"). Every item links its
// commit and, when it came through one, its pull request and author; the full commit list rides
// collapsed under them; a compare link closes the notes. That is the shape GitHub's own generated notes
// and Keep a Changelog share. GitHub's generator itself cannot be used: it lists merged PRs, and most
// of this repo lands on `main` without one.
//
// THE RANGE is npm's: from the gitHead of the newest version npm serves below this one, to this
// version's gitHead (or `--to <ref>` before it is served). `--from <ref>` overrides the start.
// A shell's notes count only the commits that touch the shell (`src/` outside tests, the root
// package.json), since everything else ships in frizz-server.
import { execFileSync } from "node:child_process"
import { execGh } from "./lib/gh-command.mjs"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { publishedGitHead } from "./published-git-head.mjs"

const DRAFT_MARKER = "<!-- DRAFT"

const MANIFESTS = { frizz: "package.json", "frizz-server": "packages/server-release/package.json" }
const SHELL_PATHS = /^(src\/(?!.*\.test\.)|package\.json$)/
// Which drafted section a conventional commit type lands in. The rest are listed only in the full
// collapsed list: refactors, tests, docs, chores and probes change nothing a user sees.
const SECTIONS = [["feat", "Added"], ["fix", "Fixed"], ["perf", "Faster"]]

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const gitDir = process.env.FRIZZ_RELEASE_GIT_DIR ?? root
const registry = process.env.FRIZZ_NPM_REGISTRY ?? "https://registry.npmjs.org/"

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const value = args[at + 1]
  if (!value) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}
const toRef = flag("--to")
const fromRef = flag("--from")
const pkg = args[0] && !/^\d/.test(args[0]) ? args.shift() : "frizz-server"
if (!MANIFESTS[pkg]) throw new Error(`not a released package: ${pkg} (one of ${Object.keys(MANIFESTS).join(", ")})`)
const version = args[0] ?? JSON.parse(readFileSync(join(root, MANIFESTS[pkg]), "utf8")).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`)

const git = (...a) => execFileSync("git", ["-C", gitDir, ...a], { encoding: "utf8" }).trim()
const gh = (...a) => execGh(`Draft release notes for ${pkg} ${version}`, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const repo = process.env.FRIZZ_RELEASE_REPO ?? gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
const owner = repo.split("/")[0]

const semver = (v) => v.split(".").map(Number)
const below = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false }

// The previous release: the newest version npm serves below this one that recorded a gitHead.
async function previousRelease() {
  const response = await fetch(new URL(encodeURIComponent(pkg), registry))
  if (!response.ok) throw new Error(`${pkg}: HTTP ${response.status} reading its versions`)
  const versions = Object.values((await response.json()).versions ?? {})
    .filter((m) => below(m.version, version) && /^[0-9a-f]{40}$/.test(m.gitHead ?? ""))
    .sort((a, b) => (below(a.version, b.version) ? 1 : -1))
  if (!versions.length) throw new Error(`npm serves no ${pkg} version below ${version} with a gitHead; pass --from`)
  return versions[0]
}

const previous = fromRef ? undefined : await previousRelease()
const from = fromRef ? git("rev-parse", fromRef) : previous.gitHead
const to = toRef ? git("rev-parse", toRef) : await publishedGitHead(pkg, version, { registry, timeoutMs: 30_000 })
const fromLabel = previous ? `${pkg}@${previous.version}` : from.slice(0, 8)

// Commits a merged pull request brought in belong to it, so a branch commit links its PR too.
const prOf = new Map()
for (const line of git("log", "--merges", "--format=%H %s", `${from}..${to}`).split("\n").filter(Boolean)) {
  const [sha, ...subject] = line.split(" ")
  const pr = /^Merge pull request #(\d+) from /.exec(subject.join(" "))?.[1]
  if (pr) for (const c of git("rev-list", `${sha}^1..${sha}^2`).split("\n").filter(Boolean)) prOf.set(c, Number(pr))
}

const commits = git("log", "--no-merges", "--format=%H%x09%s", `${from}..${to}`).split("\n").filter(Boolean)
  .map((line) => { const [sha, subject] = line.split("\t"); return { sha, subject } })
  .filter((c) => !/^chore\(release\):/.test(c.subject))
  .filter((c) => pkg !== "frizz" || git("show", "--name-only", "--format=", c.sha).split("\n").some((p) => SHELL_PATHS.test(p)))
  .map((c) => {
    const squashed = /\s\(#(\d+)\)$/.exec(c.subject)
    const pr = squashed ? Number(squashed[1]) : prOf.get(c.sha)
    const m = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(c.subject.replace(/\s\(#\d+\)$/, ""))
    return { ...c, pr, type: m?.[1], text: m ? m[3] : c.subject }
  })

const authors = new Map()
for (const pr of new Set(commits.map((c) => c.pr).filter(Boolean))) {
  try { authors.set(pr, gh("api", `repos/${repo}/pulls/${pr}`, "--jq", ".user.login")) } catch { /* a PR number from another repo's history */ }
}

const short = (sha) => sha.slice(0, 7)
const commitLink = (sha) => `[\`${short(sha)}\`](https://github.com/${repo}/commit/${sha})`
const prLink = (pr) => `[#${pr}](https://github.com/${repo}/pull/${pr})`
const credit = (c) => {
  if (!c.pr) return ""
  const who = authors.get(c.pr)
  return ` in ${prLink(c.pr)}${who && who !== owner ? ` by @${who}` : ""}`
}
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1)

const out = [
  `${DRAFT_MARKER}: rewrite each drafted bullet in the product's words (what someone running Frizz notices), merge or drop`,
  `     bullets that are one change, keep every link, then delete this line. tag-release.mjs refuses notes that still carry it. -->`,
  "",
]
for (const [type, title] of SECTIONS) {
  const group = commits.filter((c) => c.type === type)
  if (!group.length) continue
  out.push(`## ${title}`, "", ...group.map((c) => `- ${sentence(c.text)}${credit(c)} (${commitLink(c.sha)})`), "")
}
if (!SECTIONS.some(([type]) => commits.some((c) => c.type === type))) {
  out.push("Internal changes only: nothing someone running Frizz would notice.", "")
}
const contributors = [...new Set(commits.map((c) => authors.get(c.pr)).filter((who) => who && who !== owner))]
if (contributors.length) {
  out.push("## Contributors", "", ...contributors.map((who) => `- @${who} (${[...new Set(commits.filter((c) => authors.get(c.pr) === who).map((c) => c.pr))].map(prLink).join(", ")})`), "")
}
out.push(
  "<details>",
  `<summary>All ${commits.length} commit${commits.length === 1 ? "" : "s"}</summary>`,
  "",
  ...commits.map((c) => `- ${commitLink(c.sha)} ${c.subject.replace(/\s\(#\d+\)$/, "")}${c.pr ? ` (${prLink(c.pr)})` : ""}`),
  "",
  "</details>",
  "",
  `**Full changelog**: [${fromLabel}...${pkg}@${version}](https://github.com/${repo}/compare/${from}...${to})`,
)
console.log(out.join("\n"))
