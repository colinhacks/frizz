import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { setGithubRepo, setProjectGithubRepo } from "./lib/githubAutolink.ts"
import { ProjectScope } from "./lib/projectScope.tsx"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"

// Drives the REAL render path (useMarkdownHtml → mdToHtml → marked → the DOM sanitizer) for the
// GitHub-style autolinker, and does it under the timing that actually broke it.
//
// THE REPO ARRIVES LATE ON PURPOSE. In the running app it comes off the board, and a thread's own
// transcript query resolves first — so the first render of every prose block happens with no repo, and
// the HTML is memoized. The first implementation here memoized on the markdown string alone and the
// links never appeared, in an app whose module state was demonstrably correct. This fixture reproduces
// that ordering: nothing is set at import time, and the repo lands one frame later.
const REPO = "colinhacks/frizz"

const CASES: { id: string; md: string }[] = [
  { id: "issue", md: "Closed #123 and #4207 in one pass." },
  { id: "cross-repo", md: "Picked up nubjs/nub#587 from the other repo." },
  { id: "commit", md: "Landed as 749a37b, reverted by nubjs/nub@fe2a46c." },
  { id: "code", md: "Literal bytes: `#123` and `749a37b`." },
  { id: "link-text", md: "[see #12](https://example.com/x)" },
  { id: "colour", md: "The panel is #0d0e10 over #fff, ruled #000000." },
  { id: "uuid", md: "Thread da3513c7-634b-489d-8cf5-f27a7ac7aa70 is the one." },
  { id: "digits", md: "Wrote 1234567 bytes on 20260813; the wall was defaced." },
]

// THE CONSOLE: cards from two projects on one page, each in its own <ProjectScope>, each project's repo
// recorded late off its own keyframe (api/consoleFeed.ts). Each must link to ITS repo — never the page's.
const CONSOLE_CASES: { id: string; project: string; repo: string; md: string }[] = [
  { id: "console-app", project: "app", repo: "acme/app", md: "The spec is up as acme/app#6372; #6341 uses merge commits." },
  { id: "console-nub", project: "nub", repo: "nubjs/nub", md: "Fixed #12 in 749a37b." },
]

function Case({ md }: { md: string }) {
  return <div className="md-body" data-rendered dangerouslySetInnerHTML={{ __html: useMarkdownHtml(md) }} />
}

function Fixture() {
  // A frame later, exactly as the board's keyframe does — never during the first render.
  useEffect(() => {
    const id = setTimeout(() => {
      setGithubRepo(REPO)
      for (const { project, repo } of CONSOLE_CASES) setProjectGithubRepo(project, repo)
    }, 250)
    return () => clearTimeout(id)
  }, [])
  return (
    <main className="mx-auto max-w-2xl p-8">
      <p className="mb-4 text-sm text-muted">GitHub refs fixture — the repo arrives 250ms after first render</p>
      <div className="flex flex-col gap-4">
        {CASES.map(({ id, md }) => (
          <section key={id} data-case={id} className="flex flex-col gap-1">
            <code className="text-xs text-muted">{md}</code>
            <Case md={md} />
          </section>
        ))}
        {CONSOLE_CASES.map(({ id, project, md }) => (
          <section key={id} data-case={id} className="flex flex-col gap-1">
            <code className="text-xs text-muted">{project}: {md}</code>
            <ProjectScope project={project}>
              <Case md={md} />
            </ProjectScope>
          </section>
        ))}
      </div>
    </main>
  )
}

setGithubRepo(null)
createRoot(document.getElementById("root")!).render(<Fixture />)
