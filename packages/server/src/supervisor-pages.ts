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
//
// ON A TOUCH SCREEN (the last rule; RECOVERY_STYLE has its own half) the page takes the phone shell's
// sizes: 15px prose under a 17px heading, where the desktop's 12.5px and 14px were a caption read at
// arm's length. A phone lands here on every update it starts from its own Settings, and on a stale link.
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
  --bg:#f7f7f7;--panel:#fff;--panel-2:#fafafa;
  --border:#dedede;--border-strong:#cecece;--control-border:#858585;--control-strong:#7d7d7d;
  --fg:#292929;--muted:#606060;--accent:#416896;--danger:#cf222e;
  --focus-border:#416896;--focus-ring:#416896;
}
@media(prefers-color-scheme:light){
  :root:not([data-theme]){
    color-scheme:light;
    --bg:#f7f7f7;--panel:#fff;--panel-2:#fafafa;
    --border:#dedede;--border-strong:#cecece;--control-border:#858585;--control-strong:#7d7d7d;
    --fg:#292929;--muted:#606060;--accent:#416896;--danger:#cf222e;
    --focus-border:#416896;--focus-ring:#416896;
  }
}
html,body{background:var(--bg)}
body{
  margin:0;min-height:100vh;min-height:100dvh;
  display:flex;align-items:center;justify-content:center;padding:24px;
  color:var(--fg);font-family:var(--sans);font-size:12.5px;line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
main{width:100%;max-width:28rem;padding:18px;border:1px solid var(--border-strong);border-radius:12px;background:var(--panel-2)}
h1{margin:0;display:flex;align-items:baseline;gap:7px;font-size:14px;font-weight:600;letter-spacing:-.01em;line-height:1.4}
p{margin:0;text-wrap:pretty}
.detail{margin-top:7px;color:color-mix(in srgb,var(--fg) 88%,transparent)}
.note{margin-top:12px;padding-top:11px;border-top:1px solid var(--border);color:var(--muted);font-size:11.5px;line-height:1.6}
code{font-family:var(--mono);font-size:.92em;padding:.1em .35em;border-radius:4px;background:var(--panel);border:1px solid var(--border);white-space:nowrap}
[hidden]{display:none!important}
@media(pointer:coarse){
  body{padding:16px;font-size:15px}
  h1{gap:9px;font-size:17px}
  .note{font-size:13.5px}
}
`.trim()

// THE RECOVERY HALF: the live dot, the checklist, the buttons and the failure log. Appended only for
// pages that already say what they are, so it is free to name things.
//
// THE CHECKLIST (2026-11-15). The page said "The application server is coming back up" and "Waiting
// for Frizz" for the whole of a restart, which on 2026-11-15 was nearly ten minutes of a runtime
// download nobody could see, with a "Restart Frizz" button that would have started that download over.
// It now draws what the launcher's status says the boot is doing (boot-view.ts): what was stopped, each
// runtime on disk or downloading with its bytes, speed and time left, the threads loading. The two
// buttons appear only once the boot stops making progress or fails, where they help; a slow download
// offers "Open Frizz now" instead, which opens the board and leaves the download running.
const RECOVERY_STYLE = `
:root{--on-accent:#0d0e10;--success:#6ad58b}
:root[data-theme=light]{--on-accent:#fff;--success:#1a7f37}
@media(prefers-color-scheme:light){:root:not([data-theme]){--on-accent:#fff;--success:#1a7f37}}
.elapsed{margin-left:auto;padding-left:10px;font-family:var(--mono);font-size:11px;font-weight:400;letter-spacing:0;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.actions{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
/* ErrorBoundary's ACTION_CLASS, one size up for a page that is alone in a viewport. */
.btn{
  appearance:none;display:inline-flex;align-items:center;
  border:1px solid var(--control-border);border-radius:6px;background:transparent;
  padding:5px 10px;font:inherit;font-size:11.5px;line-height:1.4;color:color-mix(in srgb,var(--fg) 90%,transparent);
  cursor:pointer;text-decoration:none;
  transition:background-color 120ms var(--ease),border-color 120ms var(--ease),color 120ms var(--ease),filter 120ms var(--ease);
}
.btn:hover{background:var(--panel);border-color:var(--control-strong);color:var(--fg)}
.btn:focus-visible{outline:none;border-color:var(--focus-border);box-shadow:0 0 0 2px var(--focus-ring)}
.btn:disabled{opacity:.5;pointer-events:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.btn.primary:hover{background:var(--accent);border-color:var(--accent);color:var(--on-accent);filter:brightness(1.08)}
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
   at any size, with nothing to re-measure when the type scale moves. The em spelling is the fallback for a browser without the unit (.35em ~= 0.5 x a
   0.7em cap) and is overwritten wherever \`cap\` parses. */
.dot{
  width:6px;height:6px;flex:0 0 auto;border-radius:9999px;background:var(--accent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 28%,transparent);
  animation:frizz-live-pulse 1.25s ease-in-out infinite;
  transform:translateY(calc(3px - .35em));
  transform:translateY(calc(3px - .5cap));
}
.dot[data-state=idle]{animation:none;background:var(--muted);box-shadow:none}
.dot[data-state=stalled]{animation:none}
.dot[data-state=bad]{animation:none;background:var(--danger);box-shadow:0 0 0 1px color-mix(in srgb,var(--danger) 28%,transparent)}
@keyframes frizz-live-pulse{50%{opacity:.62;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent)}}

/* The checklist. Each row is a 14px mark column and the step: its label, a mono version, a short reading
   at the right, and for a download a bar and a line of bytes, speed and time left. The mark column is
   one line box tall and centres its mark in it, so a check, the spinner and the hollow ring all sit on
   the label's line whatever their own size. */
.steps{list-style:none;margin:12px 0 0;padding:11px 0 0;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.steps li{display:grid;grid-template-columns:14px minmax(0,1fr);column-gap:10px;align-items:start}
.ic{height:1.55em;display:flex;align-items:center;justify-content:center}
.row{display:flex;align-items:baseline;gap:10px}
.row>span{min-width:0}
.row em{margin-left:auto;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.steps li.done .row>span{color:var(--muted)}
.steps li.todo .row>span{color:color-mix(in srgb,var(--muted) 70%,transparent)}
.v{font-family:var(--mono);font-size:11.5px}
.check{display:block;color:var(--success)}
.warn{display:block;color:var(--accent)}
.hollow{width:7px;height:7px;border-radius:99px;border:1.5px solid color-mix(in srgb,var(--muted) 55%,transparent)}
.spin{width:11px;height:11px;border-radius:99px;border:1.5px solid color-mix(in srgb,var(--accent) 25%,transparent);border-top-color:var(--accent);animation:frizz-spin .9s linear infinite}
@keyframes frizz-spin{to{transform:rotate(360deg)}}
.bar{margin-top:6px;height:4px;border-radius:99px;background:color-mix(in srgb,var(--fg) 9%,transparent);overflow:hidden}
.bar>b{display:block;height:100%;border-radius:99px;background:var(--accent);transition:width 400ms var(--ease)}
.steps li.stalled .bar>b{background:color-mix(in srgb,var(--accent) 45%,var(--muted))}
.meta{margin-top:5px;font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.steps li.stalled .meta{color:color-mix(in srgb,var(--accent) 80%,var(--muted))}
.callout{margin-top:14px;padding:11px 12px 12px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--border));border-radius:9px;background:var(--panel)}
.callout p{font-size:12px;line-height:1.55;color:var(--muted)}
.callout b{color:var(--fg);font-weight:600}
.callout .actions{margin-top:10px}
@media (prefers-reduced-motion:reduce){
  .dot{animation:none;background:transparent;border:2px solid var(--accent);box-shadow:none}
  .dot[data-state=idle]{border-color:var(--muted)}
  .dot[data-state=bad]{border-color:var(--danger);background:transparent}
  .spin{animation:none;border-color:var(--accent)}
  .bar>b{transition:none}
}

/* A TOUCH SCREEN (BASE_STYLE sets the prose): the readings a step up, and every button a thumb's
   height. They were 28px tall at 11.5px, and "Restart Frizz" beside "Try again" is the one pair on this
   page a miss costs something. The board's own card takes the same sizes (web BootProgress.tsx,
   RestartOverlay.tsx): keep them in step. The download's line stays at 12px, the largest that holds
   "118 MB of 190 MB · 1.4 MB/s · 51s left" on one line of a 375px phone. */
@media(pointer:coarse){
  .elapsed,.row em{font-size:12.5px}
  .v{font-size:13.5px}
  .meta,.probe,.log{font-size:12px}
  .callout p{font-size:14px}
  .actions{gap:10px}
  .btn{min-height:42px;padding:0 16px;border-radius:9px;font-size:15px}
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

const THEME_SCRIPT = `var p;try{p=localStorage.getItem("frizz-theme")}catch{}var d=false;try{d=matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches}catch{}var t=p==="dark"||p==="light"?p:d?"dark":"light";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;document.querySelector('meta[name="theme-color"]').content=t==="dark"?"#0d0e10":"#f7f7f7"`

/** The sentence under the heading whenever the boot is making progress. */
export const RECOVERY_PROGRESS_DETAIL = "Running threads keep working. The board opens when it is ready."

/**
 * THE RECOVERY PAGE POLLS, and the comment this replaces said it deliberately did not: "a broken child
 * must not make a browser spin forever". That reason is honoured by STOPPING, not by never starting.
 *
 * What it does instead: a HEAD against the very URL the reader is trying to reach — the only honest
 * test of "would reloading work now", since a 503 here is this proxy's own answer and anything else
 * means the child is answering — plus the launcher's `/status`, which is served without a child and
 * carries the boot's checklist (boot-view.ts) or the build error a failed restart would otherwise never
 * show anyone. While the checklist moves it polls every second; once nothing has moved for the budget
 * below it goes quiet and leaves the two buttons. Polling pauses outright on a hidden tab and restarts
 * the budget on return, so time spent in another tab is not counted against a server that may be
 * perfectly healthy by the time anyone looks again.
 *
 * The ordinary case this exists for is a two-second restart, where the reader should never have to
 * click anything at all.
 */
/**
 * This page's half of the board's navigation gate (`frizzNavigate` in packages/web/index.html): the same
 * per-tab ledger of moves nobody clicked for, under the same key and the same limits, five in a minute or
 * twelve in half an hour. A board whose page answered this one's HEAD and then served it again would
 * otherwise pass the reader back and forth for as long as the tab stayed open, the two pages each
 * starting their own count. navigationGate.test.ts holds the two halves to the same answers.
 */
export const NAVIGATION_LEDGER_CHECK = `
  function mayMove(){
    var key="frizz-auto-navigations",now=Date.now(),list=[]
    try{list=JSON.parse(sessionStorage.getItem(key)||"[]")}catch(e){}
    if(!Array.isArray(list))list=[]
    list=list.filter(function(at){return typeof at==="number"&&at<=now&&now-at<1800000})
    if(list.length>=12||list.filter(function(at){return now-at<60000}).length>=5)return false
    list.push(now)
    try{sessionStorage.setItem(key,JSON.stringify(list))}catch(e){}
    return true
  }
`

const RECOVERY_SCRIPT = `
(function(){${NAVIGATION_LEDGER_CHECK}
  var target=document.body.dataset.target||"/"
  function $(id){return document.getElementById(id)}
  var heading=$("heading"),detail=$("detail"),elapsed=$("elapsed"),steps=$("steps"),callout=$("callout"),calloutText=$("callout-text")
  var openNow=$("open-now"),probe=$("probe"),log=$("log"),dot=$("dot"),note=$("note"),actions=$("actions"),restart=$("restart")
  var BUDGET=120000,MIN=600,MAX=4000,GROWTH=1.4,LIVE=1000
  var delay=MIN,deadline=Date.now()+BUDGET,timer=0,stopped=false,busy=false,told="",moved="",clock=null
  var CHECK='<svg class="check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
  var WARN='<svg class="warn" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'

  function say(text,live){probe.textContent=text;probe.setAttribute("data-live",live?"yes":"no")}
  function halt(text,bad){stopped=true;clearTimeout(timer);clock=null;dot.setAttribute("data-state",bad?"bad":"idle");say(text,false);actions.hidden=false}
  function showLog(message){if(message){log.textContent=message;log.hidden=false}else{log.hidden=true}}
  function resume(){stopped=false;busy=false;delay=MIN;deadline=Date.now()+BUDGET;dot.removeAttribute("data-state");clearTimeout(timer);timer=setTimeout(tick,0)}

  // House grammar, two units at most: 24s, 3m 12s, 1h 05m (boot-view.ts formatElapsed).
  function fmt(ms){var s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+"s";var m=Math.floor(s/60);if(m<60)return m+"m "+String(s%60).padStart(2,"0")+"s";return Math.floor(m/60)+"h "+String(m%60).padStart(2,"0")+"m"}
  setInterval(function(){if(clock)elapsed.textContent=fmt(clock.base+Date.now()-clock.at)},1000)

  // One row per step, kept across polls by key: rebuilt rows would restart the spinner every second.
  var rows={}
  function row(step){
    var r=rows[step.key]
    if(!r){
      r={li:document.createElement("li"),ic:document.createElement("span"),label:document.createElement("span"),note:document.createElement("em"),bar:null,meta:null,state:""}
      r.ic.className="ic";r.li.appendChild(r.ic)
      var body=document.createElement("div"),line=document.createElement("div");line.className="row"
      line.appendChild(r.label);line.appendChild(r.note);body.appendChild(line);r.li.appendChild(body);r.body=body
      rows[step.key]=r
    }
    if(r.state!==step.state){
      r.state=step.state;r.li.className=step.state
      if(step.state==="done")r.ic.innerHTML=CHECK
      else if(step.state==="stalled")r.ic.innerHTML=WARN
      else{r.ic.textContent="";var mark=document.createElement("span");mark.className=step.state==="live"?"spin":"hollow";r.ic.appendChild(mark)}
    }
    r.label.textContent=step.label+(step.version?" ":"")
    if(step.version){var v=document.createElement("span");v.className="v";v.textContent=step.version;r.label.appendChild(v)}
    r.note.textContent=step.note||"";r.note.hidden=!step.note
    if(typeof step.fraction==="number"){
      if(!r.bar){r.bar=document.createElement("div");r.bar.className="bar";r.bar.appendChild(document.createElement("b"));r.body.insertBefore(r.bar,r.meta)}
      r.bar.firstChild.style.width=(Math.max(0,Math.min(1,step.fraction))*100).toFixed(1)+"%"
    }else if(r.bar){r.bar.remove();r.bar=null}
    if(step.meta){
      if(!r.meta){r.meta=document.createElement("div");r.meta.className="meta";r.body.appendChild(r.meta)}
      r.meta.textContent=step.meta
    }else if(r.meta){r.meta.remove();r.meta=null}
    return r.li
  }

  function render(view){
    heading.textContent=view.title
    detail.textContent=${JSON.stringify(RECOVERY_PROGRESS_DETAIL)}
    note.hidden=true
    clock={base:view.elapsedMs,at:Date.now()}
    elapsed.textContent=fmt(view.elapsedMs);elapsed.hidden=false
    var keep={}
    view.steps.forEach(function(step,i){keep[step.key]=1;var li=row(step);if(steps.children[i]!==li)steps.insertBefore(li,steps.children[i]||null)})
    Object.keys(rows).forEach(function(key){if(!keep[key]){rows[key].li.remove();delete rows[key]}})
    steps.hidden=view.steps.length===0
    // The words are the launcher's (boot-view.ts openNowCallout), so this page and the board's overlay agree.
    if(view.callout){
      callout.hidden=false;calloutText.textContent=""
      if(view.callout.lead){var lead=document.createElement("b");lead.textContent=view.callout.lead;calloutText.appendChild(lead);calloutText.appendChild(document.createTextNode(" "))}
      calloutText.appendChild(document.createTextNode(view.callout.text))
      openNow.hidden=!view.openNow&&!view.opening
      if(view.opening){openNow.disabled=true;openNow.textContent="Opening"}
      else if(!busy){openNow.disabled=false;openNow.textContent="Open Frizz now"}
    }else{callout.hidden=true}
    if(view.steps.some(function(step){return step.state==="stalled"}))dot.setAttribute("data-state","stalled")
    else if(dot.getAttribute("data-state")==="stalled")dot.removeAttribute("data-state")
    say("",false)
  }

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
  // that rendered it, and guessing over it would be worse than saying nothing. Returns whether the
  // boot moved since the last answer, which is what buys this page more patience.
  function narrate(status){
    if(!status)return false
    if(status.state==="failed"){
      if(told==="failed")return false
      told="failed";clock=null;elapsed.hidden=true;steps.hidden=true;callout.hidden=true;note.hidden=false
      heading.textContent="Frizz did not restart"
      // Not a second copy of the note below it — a lead-in to the log, which is the next thing down.
      detail.textContent="The launcher could not bring the application server back, and reported this:"
      showLog(status.message||"The launcher gave no reason.")
      halt("",true)
      return false
    }
    showLog("")
    if(status.state==="restarting"&&status.progress){
      told="progress"
      render(status.progress)
      actions.hidden=true
      var now=JSON.stringify(status.progress.steps)+(status.progress.opening?"o":"")
      if(now===moved)return false
      moved=now
      return true
    }
    if(status.state==="restarting"&&told!=="restarting"){
      told="restarting"
      heading.textContent="Frizz is restarting"
      detail.textContent=${JSON.stringify(RECOVERY_PROGRESS_DETAIL)}
    }
    return false
  }

  function tick(){
    if(stopped||busy)return
    // A hidden tab neither polls nor spends its budget; visibilitychange starts the loop again.
    if(document.hidden)return
    alive().then(function(up){
      if(up){
        clock=null
        // Over the gate's limits: Frizz answers, but this tab has been sent around enough. The link is a click,
        // which clears the count, as the board's own Reload button does.
        if(!mayMove()){
          halt("Frizz is back. ",false);actions.hidden=true
          var open=document.createElement("a");open.href=target;open.textContent="Open it"
          open.addEventListener("click",function(){try{sessionStorage.removeItem("frizz-auto-navigations")}catch(e){}})
          probe.appendChild(open)
          return
        }
        say("Frizz is back. Reloading.",true);location.replace(target);return
      }
      return readStatus().then(function(status){
        var advanced=narrate(status)
        if(stopped)return
        if(advanced)deadline=Date.now()+BUDGET
        if(Date.now()>deadline){halt(told==="progress"?"Nothing has moved for 2m. This page stopped checking.":"No answer after 2m. This page stopped checking.",false);return}
        if(told==="progress"){delay=LIVE}
        else{delay=Math.min(MAX,delay*GROWTH);say("Waiting for Frizz",true)}
        timer=setTimeout(tick,delay)
      })
    })
  }

  document.addEventListener("visibilitychange",function(){
    if(document.hidden||stopped||busy)return
    resume()
  })

  openNow.addEventListener("click",function(){
    if(openNow.disabled)return
    openNow.disabled=true;openNow.textContent="Opening"
    fetch("/_frizz/control/open-now",{method:"POST",headers:{"cache-control":"no-store"}})
      .then(function(r){return r.json().catch(function(){return null}).then(function(b){return{ok:r.ok,body:b}})})
      .catch(function(){return{ok:false,body:null}})
      .then(function(r){
        if(r.ok)return
        openNow.disabled=false;openNow.textContent="Open Frizz now"
        calloutText.textContent=(r.body&&r.body.message)||"The launcher did not take the request."
      })
  })

  restart.addEventListener("click",function(){
    if(busy)return
    busy=true;stopped=false;told="";moved="";clearTimeout(timer)
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
  /** Carry the browser appearance preference on branded pages only. */
  appearance?: boolean
}): string {
  return `<!doctype html><html lang="en" data-font="sans"><head><meta charset="utf-8">`
    + `<title>${options.title}</title>`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + (options.appearance
      ? `<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0d0e10">`
      : `<meta name="color-scheme" content="dark light"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d0e10"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f7">`)
    + `<style>${options.style ? `${BASE_STYLE}\n${options.style}` : BASE_STYLE}</style>`
    + (options.appearance ? `<script>${THEME_SCRIPT}</script>` : "")
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
    detail: RECOVERY_PROGRESS_DETAIL,
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
// The checklist's own sentence says it shorter (RECOVERY_PROGRESS_DETAIL), so this shows only where
// that sentence does not: an unreachable server, and a failure.
const THREADS_NOTE = "Threads already running are not affected. Each runs as its own detached process, and Frizz reattaches to it on restart."

export function recoveryPage(url: string, variant: RecoveryVariant = "starting"): string {
  const copy = RECOVERY_COPY[variant]
  const target = escapeHtml(retryTarget(url))
  return documentShell({
    title: copy.title,
    style: RECOVERY_STYLE,
    appearance: true,
    bodyAttributes: `data-target="${target}"`,
    body: `<h1><span class="dot" id="dot" aria-hidden="true"></span>`
      + `<span id="heading">${copy.heading}</span><span class="elapsed" id="elapsed" hidden></span></h1>`
      + `<p class="detail" id="detail">${copy.detail}</p>`
      + `<ol class="steps" id="steps" aria-live="polite" hidden></ol>`
      + `<div class="callout" id="callout" hidden><p id="callout-text"></p>`
      + `<div class="actions"><button class="btn primary" type="button" id="open-now">Open Frizz now</button></div></div>`
      // The failure log sits ABOVE the actions on purpose: it is the thing that decides whether
      // clicking Restart again is worth anything, so it has to be read first.
      + `<pre class="log" id="log" hidden></pre>`
      + `<p class="note" id="note"${variant === "starting" ? " hidden" : ""}>${THREADS_NOTE}</p>`
      // Visible without the script, and for a server that is not responding. The script hides them
      // while a boot is making progress and shows them again when it stops or fails.
      + `<div class="actions" id="actions">`
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
    appearance: true,
    body: `<h1>Not served by this name</h1>`
      + `<p class="detail">Frizz does not answer to <code>${shown}</code>. A name a browser has to resolve is how DNS rebinding makes another site's page count as this board, so an exposed board accepts only its own hostname and the names its operator lists.</p>`
      + `<p class="note">Open the board by its IP address, or relaunch with <code>--allowed-host ${shown}</code> (or <code>FRIZZ_ALLOWED_HOSTS=${shown}</code>) to accept this one.</p>`,
  })
}
