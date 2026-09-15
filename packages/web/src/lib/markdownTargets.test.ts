import { test } from "node:test"
import assert from "node:assert/strict"
import { isLocalMarkdownFile, localFileDir, localImageUrl, localImageUrlForTarget, localMarkdownTarget, resolveRelativeLocalPath } from "./markdownTargets.ts"

test("absolute POSIX and file URLs become local targets with decoded proxy paths", () => {
  assert.deepEqual(
    localMarkdownTarget("/Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("file:///Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.equal(
    localImageUrl("/Users/me/visual review/shot.png"),
    "/_frizz/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("/Users/me/visual%20review/shot.png")!),
    "/_frizz/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
})

test("only server-supported local image extensions become proxy URLs", () => {
  for (const path of ["/tmp/shot.png", "/tmp/shot.JPG", "/tmp/shot.jpeg", "/tmp/shot.gif", "/tmp/shot.webp"]) {
    assert.ok(localImageUrlForTarget(localMarkdownTarget(path)!), path)
  }
  assert.equal(localImageUrlForTarget(localMarkdownTarget("/tmp/shot.svg")!), null)
  // A Windows screenshot is proxied like any other: the route resolves a drive path when the server
  // runs there, and dropping the image left a Windows write-up with no picture in it at all.
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("C:\\Users\\me\\shot.png")!),
    "/_frizz/local-image?path=C%3A%5CUsers%5Cme%5Cshot.png",
  )
})

test("editor deep links resolve to the local path they name", () => {
  // Both slash forms of the VS Code URL grammar, every recognized scheme, and a percent-escaped path.
  assert.deepEqual(
    localMarkdownTarget("cursor://file/Users/me/plan.md"),
    { display: "/Users/me/plan.md", filePath: "/Users/me/plan.md" },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file//Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode-insiders://file/tmp/a.ts"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  assert.deepEqual(
    localMarkdownTarget("windsurf://file/tmp/a.ts"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  // The editor cursor suffix survives (the reader and the server's opener strip it themselves), and a
  // query tail does not.
  assert.deepEqual(
    localMarkdownTarget("cursor://file/repo/AGENTS.md:42:7"),
    { display: "/repo/AGENTS.md:42:7", filePath: "/repo/AGENTS.md:42:7" },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file/tmp/a.ts?windowId=_blank"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  // A Windows drive path the route carries is a file path too, and an empty path is nothing.
  assert.deepEqual(localMarkdownTarget("vscode://file/c:/Users/me/shot.png"), { display: "c:/Users/me/shot.png", filePath: "c:/Users/me/shot.png" })
  assert.equal(localMarkdownTarget("cursor://file/"), null)
  // Unrecognized schemes stay ordinary links.
  assert.equal(localMarkdownTarget("zed://file/tmp/a.ts"), null)
})

test("a Windows drive path is a file path the server can act on; a remote host is not", () => {
  // Every one of these was a chip with NO path until 2026-09-14, which made a file link on Windows a
  // button whose click did nothing and an inline screenshot vanish from the prose.
  assert.deepEqual(localMarkdownTarget("C:\\Users\\me\\shot.png"), { display: "C:\\Users\\me\\shot.png", filePath: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("C:%5CUsers%5Cme%5Cshot.png"), { display: "C:\\Users\\me\\shot.png", filePath: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("D:/Development/frizz/AGENTS.md"), { display: "D:/Development/frizz/AGENTS.md", filePath: "D:/Development/frizz/AGENTS.md" })
  // A drive path wearing a URL's leading slash is neither POSIX nor Windows, and no server gate finds
  // it. Shed the slash so `file:` links, editor deep links and plain paths all name the same file.
  assert.deepEqual(localMarkdownTarget("file:///D:/Development/frizz/AGENTS.md"), { display: "D:/Development/frizz/AGENTS.md", filePath: "D:/Development/frizz/AGENTS.md" })
  assert.deepEqual(localMarkdownTarget("/D:/Development/frizz/AGENTS.md"), { display: "D:/Development/frizz/AGENTS.md", filePath: "D:/Development/frizz/AGENTS.md" })
  assert.deepEqual(localMarkdownTarget("cursor://file//C:/Users/me/plan.md"), { display: "C:/Users/me/plan.md", filePath: "C:/Users/me/plan.md" })
  // A one-character URL scheme shares the drive path's prefix and must NOT become a file button. The
  // separator count is the whole difference: a path has one, a URL has two.
  assert.equal(localMarkdownTarget("x://host/p"), null)
  assert.equal(localMarkdownTarget("m://mail/inbox"), null)
  // A UNC share is still not a file this machine's server resolves.
  assert.deepEqual(localMarkdownTarget("file://fileserver/share/shot.png"), { display: "file://fileserver/share/shot.png" })
})

test("normal web, relative app, anchor, and mail links remain links", () => {
  for (const href of [
    "https://example.com/shot.png",
    "//cdn.example.com/shot.png",
    "thread/a",
    "/thread/a",
    "/status/active",
    "/",
    "/?filter=active",
    "#details",
    "mailto:dev@example.com",
  ]) assert.equal(localMarkdownTarget(href), null, href)
})

test("malformed URL encoding cannot throw or become an app navigation", () => {
  assert.deepEqual(localMarkdownTarget("/Users/me/bad%ZZ.png"), {
    display: "/Users/me/bad%ZZ.png",
    filePath: "/Users/me/bad%ZZ.png",
  })
})

test("a local Markdown file is recognized by extension, editor suffix and all", () => {
  for (const path of ["/repo/README.md", "/repo/docs/a.MARKDOWN", "~/.claude/CLAUDE.md", "/repo/AGENTS.md:42", "/repo/AGENTS.md:42:7", "/repo/content/blog/post.mdx"])
    assert.equal(isLocalMarkdownFile(path), true, path)
  for (const path of ["/repo/notes.txt", "/repo/md", "/repo/a.md.bak", "/repo/docs", "/repo/a.mdxx"])
    assert.equal(isLocalMarkdownFile(path), false, path)
})

test("a document's relative links resolve against its own directory", () => {
  const base = "/repo/docs"
  assert.equal(resolveRelativeLocalPath("guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("./guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("../AGENTS.md", base), "/repo/AGENTS.md")
  assert.equal(resolveRelativeLocalPath("a/../b/c.md", base), "/repo/docs/b/c.md")
  assert.equal(resolveRelativeLocalPath("shots/one%20two.png", base), "/repo/docs/shots/one two.png")
  // A filesystem path has no query or fragment; the tail is dropped rather than baked into the name.
  assert.equal(resolveRelativeLocalPath("guide.md#section", base), "/repo/docs/guide.md")
})

test("only a genuinely relative destination is rebased", () => {
  const base = "/repo/docs"
  for (const href of ["/abs/x.md", "https://example.com/x.md", "mailto:a@b.c", "file:///x.md", "#anchor", "?q=1", "", "   "])
    assert.equal(resolveRelativeLocalPath(href, base), null, JSON.stringify(href))
  // No base at all (a page whose board keyframe has not landed yet) means no rebasing.
  assert.equal(resolveRelativeLocalPath("guide.md", ""), null)
})

test("chat prose rebases a project-relative path the way a worker writes it", () => {
  // The reported bug verbatim: a worker linking its own scratch file wrote the path relative to the
  // project root, the anchor stayed relative, and the browser resolved it against the THREAD PAGE.
  const project = "/Users/me/projects/nub"
  assert.equal(
    resolveRelativeLocalPath(".frizz/threads/6d56ea2f/HANDOFF.md", project),
    "/Users/me/projects/nub/.frizz/threads/6d56ea2f/HANDOFF.md",
  )
  assert.equal(resolveRelativeLocalPath("packages/web/src/App.tsx", project), "/Users/me/projects/nub/packages/web/src/App.tsx")
})

test("a home-anchored path expands against home, never onto the base directory", () => {
  const base = "/repo/docs"
  const home = "/Users/me"
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base, home), "/Users/me/.claude/CLAUDE.md")
  assert.equal(resolveRelativeLocalPath("~", base, home), "/Users/me")
  // Without a home from the board there is nothing to expand against, and gluing `~` onto the base
  // would invent a directory nobody has: leave it alone so it renders as plain text.
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base), null)
  // `~` only anchors at the START. A file whose own name begins with one is still relative.
  assert.equal(resolveRelativeLocalPath("notes/~draft.md", base, home), "/repo/docs/notes/~draft.md")
})

test("a document's base directory is its parent", () => {
  assert.equal(localFileDir("/repo/docs/guide.md"), "/repo/docs")
  assert.equal(localFileDir("/README.md"), "/")
})

test("a Windows base resolves relative links in its own separator and under its drive (Windows audit 2026-09-11, finding 12)", () => {
  // Before the audit every case here was null — no relative link in a rendered local Markdown file
  // ever opened on Windows. The link is written with `/` whatever the platform; the base decides.
  const base = "C:\\Users\\x\\proj\\docs"
  assert.equal(resolveRelativeLocalPath("guide.md", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  assert.equal(resolveRelativeLocalPath("./guide.md", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  assert.equal(resolveRelativeLocalPath("../AGENTS.md", base), "C:\\Users\\x\\proj\\AGENTS.md")
  assert.equal(resolveRelativeLocalPath("a/../b/c.md", base), "C:\\Users\\x\\proj\\docs\\b\\c.md")
  assert.equal(resolveRelativeLocalPath("shots/one%20two.png", base), "C:\\Users\\x\\proj\\docs\\shots\\one two.png")
  assert.equal(resolveRelativeLocalPath("guide.md#section", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  // A `..` escape climbs no higher than the drive, as it climbs no higher than `/` on POSIX.
  assert.equal(resolveRelativeLocalPath("../../../../../etc/passwd", base), "C:\\etc\\passwd")
  // A forward-slash drive path (how some tools spell it) keeps its own spelling; a mixed base takes
  // its first separator.
  assert.equal(resolveRelativeLocalPath("docs/guide.md", "C:/Users/x/proj"), "C:/Users/x/proj/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("src/a.ts", "C:\\Users\\x/proj"), "C:\\Users\\x\\proj\\src\\a.ts")
  // A Windows home expands `~` the same way.
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base, "C:\\Users\\x"), "C:\\Users\\x\\.claude\\CLAUDE.md")
  assert.equal(resolveRelativeLocalPath("~", base, "C:\\Users\\x"), "C:\\Users\\x")
  // Already absolute is not relative: a drive path reads as a scheme (`c:`), a `\`-rooted one as a root.
  assert.equal(resolveRelativeLocalPath("C:\\Users\\x\\other.md", base), null)
  assert.equal(resolveRelativeLocalPath("\\abs\\x.md", base), null)
  // The base itself must be rooted; a bare drive is drive-relative and is not.
  assert.equal(resolveRelativeLocalPath("guide.md", "proj\\docs"), null)
  assert.equal(resolveRelativeLocalPath("guide.md", "C:"), null)
})

test("a Windows document's base directory is its parent, in its own separator", () => {
  assert.equal(localFileDir("C:\\Users\\x\\proj\\docs\\guide.md"), "C:\\Users\\x\\proj\\docs")
  assert.equal(localFileDir("C:/Users/x/proj/README.md"), "C:/Users/x/proj")
  assert.equal(localFileDir("C:\\README.md"), "C:\\")
})
