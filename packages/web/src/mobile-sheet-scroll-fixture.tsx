import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { pushDrawer, pushMarkdownDrawer } from "./store.ts"
import { initFont } from "./lib/font.ts"
import "./styles.css"

// A `.md` reader opened FROM a thread on a phone: the real drawer stack, a thread sheet at the bottom
// (modal below 800px, so it holds the page's scroll lock) and the real MarkdownDrawer stacked over it.
// The thread has no board behind it and shows its loading state — only its Radix lock matters here.
// The file read is stubbed with a document several screens long, so the reader has something to scroll.
initFont()
const sections = Array.from({ length: 24 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of a long document. The reader must scroll through every one of these on a phone, exactly as it does on a desktop.\n\n- first point of section ${i + 1}\n- second point of section ${i + 1}\n`)
const markdown = `# A long document\n\nOpened from a link in a thread's transcript.\n\n${sections.join("\n")}\n\nThe end of the document.\n`
const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, location.href)
  if (!url.pathname.startsWith("/_frizz/rpc/")) return nativeFetch(input, init)
  if (url.pathname.endsWith("/localMarkdown")) return json({ path: "/fixture/long.md", markdown, truncated: false })
  return json({})
}

pushDrawer("thread", "fixture-thread", { routed: true })
pushMarkdownDrawer("/fixture/long.md")

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg p-5 text-fg">The board behind the thread.</main>
      <DrawerStack />
    </TooltipProvider>
  </QueryClientProvider>,
)
