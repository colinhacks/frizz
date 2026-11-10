import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml } from "./lib/markdown.ts"

// The sanitizer in lib/markdown.ts only exists in a DOM, so this is where it gets tested. Two halves:
// SHAPE cases pin what agent-written markdown must still communicate after sanitizing (task-list
// state, a list's own numbering, table alignment, prose that merely LOOKS like a tag), and XSS cases
// are an escape battery against the widened rule that unwraps a disallowed tag instead of deleting it.
export const SHAPE: [string, string][] = [
  ["tasklist", "- [x] Reproduce the failing fixture\n- [ ] Bisect to the offending commit"],
  ["tasklist-custom", "- [/] Implement the fix\n- [-] Drop the rejected approach\n- [?] Confirm the human-owned decision"],
  ["tasklist-loose", "- [x] First item\n\n- [ ] Second item"],
  ["tasklist-nested", "- [-] Drop the rejected approach\n  - [ ] still live"],
  // GFM wants a space after the bracket, so a bare marker is the shape server/dispatch.ts writes into
  // every new scratchpad's Task list and the one most likely to regress back to literal text.
  ["tasklist-empty", "- [ ]\n- [x]"],
  ["olstart", "17. `install.sandbox` — the baseline policy\n18. `run.sandbox` — the default"],
  ["align", "| left | mid | right |\n| :--- | :---: | ---: |\n| a | b | c |\n| d | e | f |"],
  ["table-head-only", "| left | right |\n| --- | --- |"],
  ["table-headerless", "| a | b |\n| c | d |"],
  ["generic", "The handler returns Promise<void> and then logs the slug."],
  ["placeholder", "Write to <cwdSlug>/<sessionId>.jsonl and restart the tailer."],
  ["details", "<details><summary>Full trace</summary>\n\nThe stack was 40 frames deep.\n\n</details>"],
  // What the walk MINTS has to survive the rules that refuse the same things from an author: the
  // button a local link becomes, the frame and proxy URL of a local picture, and an ordinary link.
  ["local-link", "[the notes](/tmp/frizz-fixture.txt)"],
  ["local-image", "![shot](/tmp/frizz-fixture.png)"],
  ["safe-links", "[site](https://example.invalid/a) [mail](mailto:a@example.invalid) [anchor](#top) [thread](/thread/some-slug)"],
]

export const XSS: [string, string][] = [
  ["x-script", "<script>window.__pwned='script'</script>after"],
  ["x-img", '<img src=x onerror="window.__pwned=\'img\'">after'],
  ["x-jsurl", '<a href="javascript:window.__pwned=\'href\'">click</a>'],
  ["x-unknown-handler", '<unknown onclick="window.__pwned=\'unknown\'">visible text</unknown>'],
  ["x-style", "<style>body{display:none}</style>after"],
  ["x-div-script", "<div><script>window.__pwned='nested'</script>kept</div>"],
  ["x-svg", "<svg><script>window.__pwned='svg'</script></svg>after"],
  ["x-noscript", "<noscript><img src=x onerror=\"window.__pwned='ns'\"></noscript>after"],
  ["x-template", "<template><img src=x onerror=\"window.__pwned='tpl'\"></template>after"],
  ["x-iframe", '<iframe src="javascript:window.__pwned=\'iframe\'"></iframe>after'],
  ["x-deep", '<foo><bar onclick="window.__pwned=\'deep\'">deep text</bar></foo>'],
  ["x-olstart", '<ol start="javascript:1"><li>a</li></ol>'],
  ["x-tdalign", '<table><tr><td align="x" onclick="window.__pwned=\'td\'">cell</td></tr></table>'],
  ["x-form", '<form action="/x"><input name="pw" type="password"></form>after'],
  // A span may carry an inline style — an ```ansi fence's hex colour — but ONLY that exact shape.
  ["x-span-style", '<span style="background:url(javascript:window.__pwned=\'css\')">styled</span> <span style="color:#ff0000;position:fixed;inset:0">fixed</span> <p style="color:#ff0000">para</p>'],
  // A link to a local file becomes a minted button, and what the link held moves into it. Until
  // 2026-11-09 the walk never looked at those children: the first payload ran with no click, and the
  // second, pure Markdown, loaded a remote picture on render.
  ["x-local-link-img", '<a href="/tmp/frizz-fixture.txt"><img src="x" onerror="window.__pwned=\'localchild\'"></a>after'],
  ["x-local-link-remote-img", "[![a](https://example.invalid/t.png)](/tmp/frizz-fixture.txt)"],
  ["x-local-link-nested", '<a href="/tmp/frizz-fixture.txt"><b onmouseover="window.__pwned=\'nested\'">label</b><script>window.__pwned=\'localscript\'</script></a>'],
  // Raw HTML may not position, hide or stack anything, and may not name a file for the app-wide click
  // handler (lib/local-file-links.ts): a transparent full-page button carrying a path made the next
  // click anywhere on the board open that file.
  ["x-class-overlay", '<button class="fixed inset-0 z-50 opacity-0" data-local-path="/tmp/frizz-fixture.command">x</button><p class="fixed inset-0" data-local-path="/tmp/frizz-fixture.command" data-local-image="true">para</p><a class="fixed inset-0 z-50 opacity-0" href="https://example.invalid/overlay">link</a><img class="fixed inset-0" src="/tmp/frizz-fixture.png" data-local-path="/tmp/frizz-fixture.command">'],
  // A scheme is judged as the browser parses it. The URL parser skips a tab or a newline inside
  // "javascript:" and a control character in front of it, and a pattern over the raw text missed each.
  ["x-scheme", '<a href="java&#9;script:window.__pwned=\'tab\'">a</a><a href="java&#10;script:window.__pwned=\'nl\'">b</a><a href="&#1;javascript:window.__pwned=\'ctl\'">c</a><a href="data:text/html,x">d</a><a href="vbscript:x">e</a> [f](java&#9;script:window.__pwned=1) [g](<java&Tab;script:window.__pwned=2>)'],
]

createRoot(document.getElementById("root")!).render(
  <main className="p-6">
    <div className="md-body max-w-2xl">
      {[...SHAPE, ...XSS].map(([id, md]) => (
        <section key={id} data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
      ))}
    </div>
  </main>,
)
