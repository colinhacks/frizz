// The pages the DURABLE launcher draws itself, with no disposable child behind it: the recovery page a
// restart puts up, and the two refusals an exposed board answers with.
//
// EVERYTHING THEY NEED IS INLINE — tokens, layout, the one script — and that is a constraint rather
// than a style choice. While one of these is on screen the launcher is answering *every* request with
// it, so a `<link>` to a stylesheet, a webfont, or even the favicon fetches this same HTML back with a
// 503 and renders nothing.
//
// The colours, radii and type sizes are the board's own, copied by hand from `packages/web/src/
// styles.css` (@theme) and `components/ErrorBoundary.tsx` — the in-app precedent for a full-viewport
// system panel, and the reason the buttons here read at 11.5px on a 6px radius. Copied because nothing
// can cross that package boundary at this altitude: a launcher has to render before, and without, the
// web bundle. Keep them in step. The failure this prevents is visible on every restart — the board's
// #0d0e10 strobing to some other near-black and back.
//
// ONE PAGE HERE MUST NAME NOTHING. unauthorizedPage is served to a visitor who has proved nothing, and
// it may not disclose that a shell-capable board lives at this address — a property two tests in
// restart-supervisor.test.ts assert against the whole response body with /frizz|board|agent/i. That is
// why the stylesheet is SPLIT and why BASE_STYLE below carries no comments: a CSS comment, a keyframe
// name or a localStorage key that says "frizz" leaks just as loudly as a heading would, and the first
// draft of this file leaked through all three at once.

/** Every page here interpolates operator-supplied text, so there is one escape and it covers `>` too. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/**
 * The URL the retry affordance points at, reduced to something that can only ever be THIS board.
 *
 * `req.url` is a request TARGET, not a browser URL. Origin-form (`/thread/x`) is what a browser sends,
 * but nothing stops a non-browser client sending absolute-form (`http://elsewhere/`) or a bare token,
 * and this page used to drop whatever arrived straight into an `href` with only `&<"` escaped —
 * enough to stop markup injection, not enough to stop the link pointing somewhere else. Anything that
 * is not a plain same-origin path, including the protocol-relative `//host` spelling, becomes `/`.
 */
export function retryTarget(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? url : "/"
}

// THE ANONYMOUS HALF. Tokens, page frame and prose only — every rule the 401 needs and nothing else.
// It carries no comments and no identifying name ON PURPOSE (see the header): anything written here is
// served verbatim to an unauthenticated visitor. The reasoning that would ordinarily be a CSS comment
// lives in TypeScript comments around this string instead.
//
// Values, for the reader who would otherwise have to diff them against the app: --bg/--panel-2/--border
// -strong/--fg/--muted/--accent are styles.css @theme verbatim; --danger is Tailwind red-300, the tone
// RestartFailureNotice already uses; the 12px radius is --block-radius; the 120ms ease-out transition
// is the app's --default-transition-* pair. The `main` box is ErrorPanel's own shell one size up.
const BASE_STYLE = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:dark;
  --bg:#0d0e10;--panel:#131519;--panel-2:#181b20;
  --border:#26282d;--border-strong:#33363c;--control-border:#26282d;--control-strong:#33363c;
  --fg:#e6e7e9;--muted:#8b8f96;--accent:#e8b923;--danger:#fca5a5;
  --focus-border:color-mix(in srgb,var(--accent) 55%,transparent);--focus-ring:color-mix(in srgb,var(--accent) 22%,transparent);
  --sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"JetBrains Mono","SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  --ease:cubic-bezier(0,0,.2,1);
}
:root[data-theme=light]{
  color-scheme:light;
  --bg:#f6f8fa;--panel:#fff;--panel-2:#f1f4f7;
  --border:#d0d7de;--border-strong:#afb8c1;--control-border:#858e98;--control-strong:#7d8791;
  --fg:#1f2328;--muted:#57606a;--accent:#9a6700;--danger:#cf222e;
  --focus-border:#9a6700;--focus-ring:#9a6700;
}
@media(prefers-color-scheme:light){
  :root:not([data-theme]){
    color-scheme:light;
    --bg:#f6f8fa;--panel:#fff;--panel-2:#f1f4f7;
    --border:#d0d7de;--border-strong:#afb8c1;--control-border:#858e98;--control-strong:#7d8791;
    --fg:#1f2328;--muted:#57606a;--accent:#9a6700;--danger:#cf222e;
    --focus-border:#9a6700;--focus-ring:#9a6700;
  }
}
html,body{background:var(--bg)}
body{
  margin:0;min-height:100vh;min-height:100dvh;
  display:flex;align-items:center;justify-content:center;padding:24px;
  color:var(--fg);font-family:var(--sans);font-size:12.5px;line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
html[data-font=mono] body{font-family:var(--mono)}
main{width:100%;max-width:28rem;padding:18px;border:1px solid var(--border-strong);border-radius:12px;background:var(--panel-2)}
h1{margin:0;display:flex;align-items:baseline;gap:7px;font-size:14px;font-weight:600;letter-spacing:-.01em;line-height:1.4}
p{margin:0;text-wrap:pretty}
.detail{margin-top:7px;color:color-mix(in srgb,var(--fg) 88%,transparent)}
.note{margin-top:12px;padding-top:11px;border-top:1px solid var(--border);color:var(--muted);font-size:11.5px;line-height:1.6}
code{font-family:var(--mono);font-size:.92em;padding:.1em .35em;border-radius:4px;background:var(--panel);border:1px solid var(--border);white-space:nowrap}
[hidden]{display:none!important}
`.trim()

// THE RECOVERY HALF: the live dot, the probe line, the action buttons and the failure log. Appended
// only for pages that already say what they are, so it is free to name things.
const RECOVERY_STYLE = `
.actions{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
/* ErrorBoundary's ACTION_CLASS, one size up for a page that is alone in a viewport. */
.btn{
  appearance:none;display:inline-flex;align-items:center;
  border:1px solid var(--control-border);border-radius:6px;background:transparent;
  padding:5px 10px;font:inherit;font-size:11.5px;color:color-mix(in srgb,var(--fg) 90%,transparent);
  cursor:pointer;text-decoration:none;
  transition:background-color 120ms var(--ease),border-color 120ms var(--ease),color 120ms var(--ease);
}
.btn:hover{background:var(--panel);border-color:var(--control-strong);color:var(--fg)}
.btn:focus-visible{outline:none;border-color:var(--focus-border);box-shadow:0 0 0 2px var(--focus-ring)}
.btn:disabled{opacity:.5;pointer-events:none}
/* min-height holds the slot open while it is LIVE, so a changing status line never nudges the card;
   :empty collapses it when there is nothing live to say, so a halted card has no trailing gutter. */
.probe{margin-top:12px;font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--muted);min-height:1.5em}
.probe:empty{margin-top:0;min-height:0}
/* RestartFailureNotice's block, at this altitude: a supervisor \`message\` is raw build output, and it
   reads as what it is — a terminal excerpt — only inside a scrolling mono box. */
.log{
  margin-top:10px;max-height:16rem;overflow:auto;white-space:pre-wrap;overflow-wrap:break-word;
  border:1px solid var(--border);border-radius:6px;background:var(--panel);padding:8px 10px;
  font-family:var(--mono);font-size:11px;line-height:1.6;color:color-mix(in srgb,var(--fg) 70%,transparent);
}

/* THE LIVE DOT, and it is the app's own \`.frizz-live-dot\` — same 6px, same 28%/14% halo, same 1.25s
   cadence — because it means the same thing here that it means there: work is in flight.

   Alignment is an INK problem. A baseline-aligned flex item with no text of its own contributes its
   BORDER-BOX BOTTOM as the baseline, so the dot's ink centre lands 3px above it while the cap band's
   centre sits 0.5cap above it. \`cap\` is the resolved font's own cap height, so the correction holds
   in BOTH board fonts and at any size, with nothing to re-measure when the type scale moves or the
   font setting flips. The em spelling is the fallback for a browser without the unit (.35em ~= 0.5 x a
   0.7em cap) and is overwritten wherever \`cap\` parses. */
.dot{
  width:6px;height:6px;flex:0 0 auto;border-radius:9999px;background:var(--accent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 28%,transparent);
  animation:frizz-live-pulse 1.25s ease-in-out infinite;
  transform:translateY(calc(3px - .35em));
  transform:translateY(calc(3px - .5cap));
}
.dot[data-state=idle]{animation:none;background:var(--muted);box-shadow:none}
.dot[data-state=bad]{animation:none;background:var(--danger);box-shadow:0 0 0 1px color-mix(in srgb,var(--danger) 28%,transparent)}
@keyframes frizz-live-pulse{50%{opacity:.62;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent)}}
@media (prefers-reduced-motion:reduce){
  .dot{animation:none;background:transparent;border:2px solid var(--accent);box-shadow:none}
  .dot[data-state=idle]{border-color:var(--muted)}
  .dot[data-state=bad]{border-color:var(--danger);background:transparent}
}

/* The app's \`.shimmer-text\`: a highlight sweeping muted text is how this product says "working", and
   the probe line is the only thing on the page that is. */
.probe[data-live=yes]{
  color:transparent;
  background:linear-gradient(90deg,var(--muted) 0%,var(--muted) 35%,var(--fg) 50%,var(--muted) 65%,var(--muted) 100%) 0 0/200% 100%;
  -webkit-background-clip:text;background-clip:text;
  animation:frizz-shimmer 2.2s linear infinite;
}
@keyframes frizz-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){
  .probe[data-live=yes]{animation:none;background:none;color:var(--muted)}
}
`.trim()

// The board applies the operator's font choice from localStorage before first paint (see
// packages/web/index.html). This page renders while the bundle that owns that setting is unreachable,
// so it reads the same key for itself — otherwise a restart flips a sans board to mono for two seconds.
// Branded pages only: the key names the product.
const FONT_SCRIPT = `try{document.documentElement.dataset.font=localStorage.getItem("frizz-font")==="mono"?"mono":"sans"}catch{}`
const THEME_SCRIPT = `var p;try{p=localStorage.getItem("frizz-theme")}catch{}var d=false;try{d=matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches}catch{}var t=p==="dark"||p==="light"?p:d?"dark":"light";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;document.querySelector('meta[name="theme-color"]').content=t==="dark"?"#0d0e10":"#f6f8fa"`

/**
 * THE RECOVERY PAGE POLLS, and the comment this replaces said it deliberately did not: "a broken child
 * must not make a browser spin forever". That reason is honoured by STOPPING, not by never starting.
 *
 * What it does instead: a backed-off HEAD against the very URL the reader is trying to reach — the
 * only honest test of "would reloading work now", since a 503 here is this proxy's own answer and
 * anything else means the child is answering — plus the launcher's `/status` for the narrative, which
 * is served without a child and carries the build error a failed restart would otherwise never show
 * anyone. After the budget of silence below it goes quiet and leaves the two buttons. Polling pauses
 * outright on a hidden tab and restarts the budget on return, so time spent in another tab is not
 * counted against a server that may be perfectly healthy by the time anyone looks again.
 *
 * The ordinary case this exists for is a two-second restart, where the reader should never have to
 * click anything at all.
 */
const RECOVERY_SCRIPT = `
(function(){
  var target=document.body.dataset.target||"/"
  var heading=document.getElementById("heading")
  var detail=document.getElementById("detail")
  var probe=document.getElementById("probe")
  var log=document.getElementById("log")
  var dot=document.getElementById("dot")
  var restart=document.getElementById("restart")
  var BUDGET=120000,MIN=600,MAX=4000,GROWTH=1.4
  var delay=MIN,deadline=Date.now()+BUDGET,timer=0,stopped=false,busy=false,told=""

  function say(text,live){probe.textContent=text;probe.setAttribute("data-live",live?"yes":"no")}
  function halt(text,bad){stopped=true;clearTimeout(timer);dot.setAttribute("data-state",bad?"bad":"idle");say(text,false)}
  function showLog(message){if(message){log.textContent=message;log.hidden=false}else{log.hidden=true}}
  function resume(){stopped=false;busy=false;delay=MIN;deadline=Date.now()+BUDGET;dot.removeAttribute("data-state");clearTimeout(timer);timer=setTimeout(tick,0)}

  // 503 is this proxy's own "no child". Every other answer — 200, 404, even a 500 from the app — means
  // something is listening again, and the reader's own URL is the right thing to ask.
  function alive(){
    return fetch(target,{method:"HEAD",cache:"no-store",credentials:"same-origin"})
      .then(function(r){return r.status!==503}).catch(function(){return false})
  }
  function readStatus(){
    return fetch("/_frizz/control/status",{cache:"no-store",headers:{"cache-control":"no-store"}})
      .then(function(r){return r.ok?r.json():null})
      .then(function(b){return b&&b.protocol===1?b:null}).catch(function(){return null})
  }

  // An unreachable launcher leaves the server-rendered copy alone: it is already right for the case
  // that rendered it, and guessing over it would be worse than saying nothing.
  function narrate(status){
    if(!status||status.state===told)return
    told=status.state
    if(status.state==="failed"){
      heading.textContent="Frizz did not restart"
      // Not a second copy of the note below it — a lead-in to the log, which is the next thing down.
      detail.textContent="The launcher could not bring the application server back, and reported this:"
      showLog(status.message||"The launcher gave no reason.")
      halt("",true)
      return
    }
    showLog("")
    if(status.state==="restarting"){
      heading.textContent="Frizz is restarting"
      detail.textContent="The application server is coming back up."
    }
  }

  function tick(){
    if(stopped||busy)return
    // A hidden tab neither polls nor spends its budget; visibilitychange starts the loop again.
    if(document.hidden)return
    alive().then(function(up){
      if(up){say("Frizz is back. Reloading.",true);location.replace(target);return}
      return readStatus().then(function(status){
        narrate(status)
        if(stopped)return
        if(Date.now()>deadline){halt("No answer after 2m. This page stopped checking.",false);return}
        delay=Math.min(MAX,delay*GROWTH)
        say("Waiting for Frizz",true)
        timer=setTimeout(tick,delay)
      })
    })
  }

  document.addEventListener("visibilitychange",function(){
    if(document.hidden||stopped||busy)return
    resume()
  })

  restart.addEventListener("click",function(){
    if(busy)return
    busy=true;stopped=false;told="";clearTimeout(timer)
    restart.disabled=true;restart.textContent="Restarting"
    dot.removeAttribute("data-state");showLog("");say("Restarting Frizz",true)
    fetch("/_frizz/control/restart",{method:"POST",headers:{"cache-control":"no-store"}})
      .then(function(r){return r.json().catch(function(){return null}).then(function(b){return{ok:r.ok,status:r.status,body:b}})})
      .catch(function(){return{ok:false,status:0,body:null}})
      .then(function(r){
        restart.disabled=false;restart.textContent="Restart Frizz";busy=false
        if(!r.ok){
          heading.textContent="Frizz did not restart"
          detail.textContent="The launcher could not bring the application server back, and reported this:"
          showLog((r.body&&r.body.message)||("The launcher refused the restart ("+(r.status||"no response")+")."))
          halt("",true)
          return
        }
        // Accepted. The probe, not this response, decides whether the child is actually back.
        resume()
      })
  })

  say("Waiting for Frizz",true)
  tick()
})()
`.trim()

function documentShell(options: {
  title: string
  body: string
  /** Appended after BASE_STYLE. Omitted for the page that must disclose nothing. */
  style?: string
  script?: string
  bodyAttributes?: string
  /** Carry the operator's font choice over from the board. Names the product, so branded pages only. */
  font?: boolean
}): string {
  return `<!doctype html><html lang="en" data-font="sans"><head><meta charset="utf-8">`
    + `<title>${options.title}</title>`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + (options.font
      ? `<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0d0e10">`
      : `<meta name="color-scheme" content="dark light"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d0e10"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f8fa">`)
    + `<style>${options.style ? `${BASE_STYLE}\n${options.style}` : BASE_STYLE}</style>`
    + (options.font ? `<script>${THEME_SCRIPT}</script><script>${FONT_SCRIPT}</script>` : "")
    + `</head>`
    + `<body${options.bodyAttributes ? ` ${options.bodyAttributes}` : ""}><main>${options.body}</main>`
    + (options.script ? `<script>${options.script}</script>` : "")
    + `</body></html>`
}

/**
 * WHY THIS PAGE IS UP, in the launcher's own terms. `starting` is the ordinary two-second gap where
 * the disposable child is not listening yet; `unreachable` is a child that took the connection and
 * then failed it, which is the one an operator has to act on.
 */
export type RecoveryVariant = "starting" | "unreachable"

const RECOVERY_COPY: Record<RecoveryVariant, { title: string; heading: string; detail: string }> = {
  starting: {
    title: "Restarting | Frizz",
    heading: "Frizz is restarting",
    detail: "The application server is not listening yet. This page reloads as soon as it answers.",
  },
  unreachable: {
    title: "Not responding | Frizz",
    heading: "Frizz is not responding",
    detail: "The application server accepted this request and then dropped it. Restarting it usually clears this.",
  },
}

// The one fact an operator staring at this page actually wants, and the reason is worth stating: a
// worker is a daemon in its OWN process group, so nothing here — a restart, a crash, a ctrl-C on the
// launcher — reaches it. Its events queue while nothing is attached and replay when the board is back.
const THREADS_NOTE = "Threads already running are not affected. Each runs as its own detached process, and Frizz reattaches to it on restart."

export function recoveryPage(url: string, variant: RecoveryVariant = "starting"): string {
  const copy = RECOVERY_COPY[variant]
  const target = escapeHtml(retryTarget(url))
  return documentShell({
    title: copy.title,
    style: RECOVERY_STYLE,
    font: true,
    bodyAttributes: `data-target="${target}"`,
    body: `<h1><span class="dot" id="dot" aria-hidden="true"></span>`
      + `<span id="heading">${copy.heading}</span></h1>`
      + `<p class="detail" id="detail">${copy.detail}</p>`
      // The failure log sits ABOVE the actions on purpose: it is the thing that decides whether
      // clicking Restart again is worth anything, so it has to be read first.
      + `<pre class="log" id="log" hidden></pre>`
      + `<p class="note">${THREADS_NOTE}</p>`
      + `<div class="actions">`
      + `<a class="btn" href="${target}">Try again</a>`
      + `<button class="btn" type="button" id="restart">Restart Frizz</button>`
      + `</div>`
      + `<p class="probe" id="probe" aria-live="polite"></p>`,
    script: RECOVERY_SCRIPT,
  })
}

/**
 * Deliberately says nothing about what this product is or whose machine this is — which is why it takes
 * the bare shell, with no recovery stylesheet and no font script. An unauthenticated visitor should not
 * learn that a shell-capable board lives here. The reason is the one exception: "already used" and
 * "expired" send the operator to very different next actions, and neither discloses anything to
 * somebody who did not already hold a link.
 */
export function unauthorizedPage(reason?: "unknown" | "expired" | "already-used"): string {
  const detail = reason === "already-used"
    ? "That link has already been used. Generate a fresh one."
    : reason === "expired"
      ? "That link expired. Generate a fresh one."
      : "This address needs a current access link."
  return documentShell({
    title: "Unauthorized",
    body: `<h1>Unauthorized</h1><p class="detail">${detail}</p>`,
  })
}

/**
 * The refusal an operator sees after opening an exposed board by a name `--allowed-host` does not
 * list. Unlike unauthorizedPage this SAYS what Frizz is: the board is already open to this network by
 * IP with no gate at all, so naming the flag costs nothing and saves the guess. The name is escaped
 * even though the Host parser already refuses every character that could break markup.
 */
export function unlistedHostPage(name: string): string {
  const shown = escapeHtml(name)
  return documentShell({
    title: "Not served by this name",
    font: true,
    body: `<h1>Not served by this name</h1>`
      + `<p class="detail">Frizz does not answer to <code>${shown}</code>. A name a browser has to resolve is how DNS rebinding makes another site's page count as this board, so an exposed board accepts only its own hostname and the names its operator lists.</p>`
      + `<p class="note">Open the board by its IP address, or relaunch with <code>--allowed-host ${shown}</code> (or <code>FRIZZ_ALLOWED_HOSTS=${shown}</code>) to accept this one.</p>`,
  })
}
