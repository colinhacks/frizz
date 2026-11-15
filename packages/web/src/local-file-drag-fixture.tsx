import { createRoot } from "react-dom/client"
import { FileText } from "lucide-react"
import "./styles.css"
import { WaitRow } from "./components/AwaitingBackgroundCard.tsx"
import { BlockFile, BlockImage } from "./components/ChatView.tsx"
import { DiffBlock } from "./components/DiffBlock.tsx"
import { LinkedHtml } from "./components/LinkedHtml.tsx"
import { ThreadLinks } from "./components/ThreadLinks.tsx"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { mdToHtml } from "./lib/markdown.ts"

// Every kind of file handle the board draws, on one page, for localFileDrag.e2e.test.ts to drag out
// with a real mouse: sanitized Markdown's file link, picture link, picture and inline-code path; a
// standalone attachment chip and picture; a tool header's path; the registered-link rows in both of
// their forms; and the /full rail's row. Each one must put its file on the drag.
//
// The inline-code path resolves through the server's `resolveLocalPaths`, stubbed here to confirm
// the one path the prose names.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/_frizz/rpc/resolveLocalPaths") {
    // A query: its input rides the URL.
    const body = JSON.parse(url.searchParams.get("input") ?? String(init?.body ?? "{}")) as { paths?: string[] }
    const resolved = (body.paths ?? []).map((input) => ({ input, path: input === "/fixture/src/app.ts" ? input : null }))
    return new Response(JSON.stringify({ result: { resolved } }), { headers: { "content-type": "application/json", "x-frizz-boot": "drag-fixture" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json", "x-frizz-boot": "drag-fixture" } })
  }
  return nativeFetch(input, init)
}

const prose = mdToHtml([
  "Read the [review report](/fixture/report.md).",
  "",
  "The capture is [the shot](/fixture/shot.png).",
  "",
  "![prose picture](/fixture/shot.png)",
  "",
  "The entry point is `/fixture/src/app.ts`.",
].join("\n"), { baseDir: "/fixture", homeDir: "/fixture/home" })

const links = [{ id: "lnk_1", kind: "file" as const, label: "Audit report", target: "/fixture/audit.pdf" }]

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <LinkedHtml className="md-body" html={prose} />
    <div data-case="block-file"><BlockFile path="/fixture/notes.txt" /></div>
    <div data-case="block-image" className="w-40"><BlockImage path="/fixture/shot.png" /></div>
    {/* A tool header's path, where it sits: inside the header that also toggles the diff. */}
    <div data-case="path-link"><DiffBlock edits={[{ file: "/fixture/src/server.ts", old: "a\n", new: "b\n" }]} /></div>
    <div data-case="thread-links"><ThreadLinks links={links} /></div>
    <div data-case="thread-links-panel"><ThreadLinks links={links} panel /></div>
    <div data-case="wait-row" className="grid grid-cols-[auto_1fr_auto]">
      <WaitRow testKind="file" testId="/fixture/src/rail.ts" mark={<FileText size={12} />} name="rail.ts" onOpen={() => {}} dragPath="/fixture/src/rail.ts" status={null} />
    </div>
  </main>,
)
