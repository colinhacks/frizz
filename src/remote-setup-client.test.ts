import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRemoteSetupRoute } from "../packages/server/src/remote-setup/route.ts";
import type { CloudConfig } from "./cloud.ts";
import type { Pane } from "./pane-host.ts";
import { createRemoteSetupClient, type RemoteSetupClientOptions } from "./remote-setup-client.ts";

// The shell's end of the R menu (remote-setup-client.ts), against the server's real route
// (packages/server/src/remote-setup/route.ts) with no HTTP between them, and against servers that do not
// draw the menu, where R opens the shell's own.

delete process.env.FRIZZ_CUSTOM_NAMES;
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name];

/** The routes here claim nothing, but read the state root's fresh claims on every serve: a home of their own. */
const home = mkdtempSync(join(tmpdir(), "frizz-remote-setup-client-"));
test.after(() => rmSync(home, { recursive: true, force: true }));
const realRoute = (waitMs?: number) =>
  createRemoteSetupRoute({ probes: { cloudflared: async () => ({ version: null }), tailscale: async () => ({ installed: false, dnsName: null }) }, githubLogin: () => null, home, ...(waitMs ? { waitMs } : {}) });

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CLEAR = "\x1b[2J\x1b[H";

/** The last screen written, without escape codes. */
const lastScreen = (text: string) => text.split(CLEAR).pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

async function until(what: string, check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A fetch that hands each request to `answer`, as the launcher's own port would hand it to the server. */
function fetcherFor(answer: (body: unknown) => Promise<{ status: number; body: unknown }>): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const { status, body } = await answer(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function terminal() {
  const chunks: string[] = [];
  const stream = { columns: 80, rows: 40, write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

/** A fallback menu that records what it was given. */
function shellMenu() {
  const keys: string[] = [];
  let opened = 0;
  let closed = 0;
  const pane: Pane = {
    open: () => { opened += 1; return true; },
    key: (key) => { keys.push(key); return key === "q" ? "close" : "keep"; },
    close: () => { closed += 1; },
  };
  return { pane, keys, opened: () => opened, closed: () => closed };
}

function build(overrides: Partial<RemoteSetupClientOptions> & { applyWaits?: (config: CloudConfig | null) => Promise<void> } = {}) {
  const out = terminal();
  let current: CloudConfig | null = null;
  const applied: Array<{ config: CloudConfig | null; justClaimed: boolean }> = [];
  const changed: Array<CloudConfig | null> = [];
  const told: Array<CloudConfig | null> = [];
  const opened: string[] = [];
  const route = realRoute();
  const fallback = shellMenu();
  const pane = createRemoteSetupClient({
    port: 9393,
    token: "owner-capability",
    sandbox: false,
    acts: {
      current: () => current,
      devices: () => [],
      apply: async (config, options) => {
        await overrides.applyWaits?.(config);
        applied.push({ config, justClaimed: options?.justClaimed === true });
        current = config;
      },
      setRelayAccess: () => {},
      issueLink: () => (current ? { code: "c0de", url: `https://${current.hostname}/?frizz_code=c0de`, expiresAt: Date.now() + 300_000 } : null),
      signOut: () => false,
      signOutAll: () => 0,
      forgetSessionsFor: () => {},
    },
    fallback: () => fallback.pane,
    onChanged: (config) => changed.push(config),
    onClosedAfterChange: (config) => told.push(config),
    onOpened: (by, why) => opened.push(why ? `${by}: ${why}` : by),
    output: out.stream,
    fetcher: fetcherFor((body) => route.handle(body)),
    ...overrides,
  });
  // The pane host's half: a close the pane asks for takes it down, as a key answered "close" would.
  let handleClosed = 0;
  const handle = { close: () => { handleClosed += 1; pane.close(); } };
  const open = () => pane.open(handle);
  const type = (text: string) => { for (const ch of text) pane.key(ch); };
  return { pane, out, open, type, applied, changed, told, opened, route, fallback, handleClosed: () => handleClosed, current: () => current };
}

test("R draws the server's menu, and escape there hands the terminal back", async () => {
  const { out, open, pane, opened, route, handleClosed } = build();
  assert.equal(open(), true);
  assert.ok(out.text().startsWith(ALT_ON), "the menu takes the alternate screen at once");
  await until("the server's menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  assert.deepEqual(opened, ["server"]);
  assert.equal(pane.key("\x1b"), "keep", "the server decides what escape does");
  await until("the close", () => handleClosed() === 1);
  assert.ok(out.text().endsWith(`${ALT_OFF}\x1b[?25h`), "back on the readout's screen, cursor shown");
  assert.equal(route.size(), 0);
});

test("an origin typed fast arrives whole, the shell serves it, and the readout hears once the menu closes", async () => {
  const { out, open, pane, type, applied, changed, told } = build();
  open();
  await until("the menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  type("6\r");
  type("https://board.example.com/\r");
  await until("the done screen", () => /Serving https:\/\/board\.example\.com \(your proxy\)/.test(lastScreen(out.text())));
  assert.deepEqual(applied, [{ config: { hostname: "board.example.com", serve: "external", provider: "other" }, justClaimed: false }]);
  assert.deepEqual(changed, [{ hostname: "board.example.com", serve: "external", provider: "other" }]);
  assert.match(lastScreen(out.text()), /frizz_code=c0de/, "the link the shell minted, drawn as the server's QR screen");
  assert.equal(told.length, 0, "not while the menu holds the terminal");
  pane.key("x");
  await until("the close", () => told.length === 1);
  assert.equal(told[0]?.hostname, "board.example.com");
});

test("keys pressed before the server's first screen are not lost", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const route = realRoute();
  const { out, open, pane } = build({
    fetcher: fetcherFor(async (body) => {
      if ((body as { event: { type: string } }).event.type === "open") await held;
      return route.handle(body);
    }),
  });
  open();
  pane.key("\x1b[B");
  pane.key("\x1b[B");
  release();
  await until("both moves", () => /❯ {3}Custom subdomain/.test(lastScreen(out.text())));
});

for (const [why, fetcher, expected] of [
  ["a server from before the route", fetcherFor(async () => ({ status: 404, body: "Not Found" })), "shell: the server answered 404"],
  ["one that refuses the token", fetcherFor(async () => ({ status: 403, body: "Forbidden" })), "shell: the server answered 403"],
  ["one that is not there", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, "shell: the server could not be reached"],
  [
    "one too busy to answer",
    ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch,
    "shell: the server did not answer in time",
  ],
] as const) {
  test(`R opens the shell's own menu for ${why}, with the keys already pressed`, async () => {
    const { open, pane, fallback, opened, handleClosed } = build({ fetcher, openTimeoutMs: 50 });
    assert.equal(open(), true);
    pane.key("j");
    await until("the shell's menu", () => fallback.opened() === 1);
    assert.deepEqual(opened, [expected]);
    assert.deepEqual(fallback.keys, ["j"]);
    assert.equal(pane.key("k"), "keep");
    assert.equal(pane.key("q"), "close", "its keys are its own, answered at once");
    pane.close();
    assert.equal(fallback.closed(), 1);
    assert.equal(handleClosed(), 0);
  });
}

test("with no token R opens the shell's own menu without asking the server", () => {
  let asked = 0;
  const { open, fallback, opened } = build({ token: undefined, fetcher: (async () => { asked += 1; throw new Error("asked"); }) as unknown as typeof fetch });
  assert.equal(open(), true);
  assert.equal(fallback.opened(), 1);
  assert.equal(asked, 0);
  assert.deepEqual(opened, ["shell: this launcher holds no token for the server"]);
});

test("a server that stops answering mid-menu says so, and any key then hands the terminal back", async () => {
  const route = realRoute();
  let restarted = false;
  const { out, open, pane } = build({
    fetcher: fetcherFor(async (body) => (restarted ? { status: 404, body: { error: "unknown-session" } } : route.handle(body))),
  });
  open();
  await until("the menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  restarted = true;
  pane.key("\x1b[B");
  await until("the notice", () => /stopped answering this menu \(it restarted\)/.test(lastScreen(out.text())));
  assert.equal(pane.key("x"), "close");
});

test("an act this shell does not know is refused back to the server, which says so on the menu", async () => {
  const answers: unknown[] = [];
  const screen = (text: string) => ({ protocol: 1, session: "s", frame: answers.length + 1, screen: text });
  const { out, open } = build({
    fetcher: fetcherFor(async (body) => {
      const event = (body as { event: { type: string; ok?: boolean; error?: string } }).event;
      answers.push(event);
      if (event.type === "open") return { status: 200, body: { ...screen("menu"), effect: { id: 1, kind: "teleport" } } };
      if (event.type === "effect") return { status: 200, body: screen(`said: ${event.error}`) };
      return new Promise(() => {});
    }),
  });
  open();
  await until("the refusal", () => /said: this launcher cannot do that yet \(teleport\)/.test(lastScreen(out.text())));
  assert.equal((answers.find((event) => (event as { type: string }).type === "effect") as { ok: boolean }).ok, false);
});

test("a setup the server asks for that this shell cannot read is refused, not served", async () => {
  const { out, open, applied } = build({
    fetcher: fetcherFor(async (body) => {
      const event = (body as { event: { type: string; error?: string } }).event;
      if (event.type === "open") return { status: 200, body: { protocol: 1, session: "s", frame: 1, screen: "menu", effect: { id: 1, kind: "apply", config: { hostname: "x.example.com" } } } };
      if (event.type === "effect") return { status: 200, body: { protocol: 1, session: "s", frame: 2, screen: `said: ${event.error}` } };
      return new Promise(() => {});
    }),
  });
  open();
  await until("the refusal", () => /said: the server asked for a setup this launcher cannot read/.test(lastScreen(out.text())));
  assert.deepEqual(applied, []);
});

/** A gate a test opens when it chooses. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

test("keys still on their way to a menu that was closed never reach the menu opened after it", async () => {
  const route = realRoute();
  const held = gate();
  const sessionsKeyed: string[] = [];
  let first: string | undefined;
  const { out, open, pane } = build({
    fetcher: fetcherFor(async (body) => {
      const request = body as { session?: string; event: { type: string } };
      if (request.event.type === "key") {
        sessionsKeyed.push(request.session ?? "");
        if (request.session === first) await held.opened;
      }
      const answered = await route.handle(body);
      first ??= (answered.body as { session?: string }).session;
      return answered;
    }),
  });
  open();
  await until("the first menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  pane.key("j"); // held by the server
  await until("the first key in flight", () => sessionsKeyed.length === 1);
  pane.key("j"); // queued behind it
  pane.close();
  open();
  await until("the second menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  held.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(lastScreen(out.text()), /❯ ✓ Off/, "the cursor in the new menu did not move");
  assert.deepEqual(sessionsKeyed, [first], "only the key already sent went, and to its own menu");
});

test("a change that finishes after its menu was reopened answers nothing in the new one", async () => {
  const route = realRoute();
  const gates = new Map<string, ReturnType<typeof gate>>();
  const answered: Array<{ session?: string; id: number; ok: boolean }> = [];
  const { out, open, pane, applied } = build({
    applyWaits: (config) => {
      const waiting = gate();
      gates.set(config!.hostname, waiting);
      return waiting.opened;
    },
    fetcher: fetcherFor(async (body) => {
      const request = body as { session?: string; event: { type: string; id?: number; ok?: boolean } };
      if (request.event.type === "effect") answered.push({ session: request.session, id: request.event.id!, ok: request.event.ok! });
      return route.handle(body);
    }),
  });
  const serve = async (origin: string) => {
    open();
    await until("a menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
    for (const key of ["6", "\r", ...origin, "\r"]) pane.key(key);
    await until(`the apply of ${origin}`, () => gates.has(origin));
  };
  await serve("a.example.com");
  pane.close();
  await serve("b.example.com");
  // Both effects are id 1 in their own sessions. The first menu's finishing now must not settle the second's.
  gates.get("a.example.com")!.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(answered.length, 0, "the closed menu's answer went nowhere");
  assert.ok(lastScreen(out.text()).includes("serving b.example.com…"), "the open menu still waits on its own change");
  gates.get("b.example.com")!.open();
  await until("b served", () => /Serving https:\/\/b\.example\.com/.test(lastScreen(out.text())));
  assert.equal(answered.length >= 1 && answered.every((effect) => effect.ok), true);
  assert.deepEqual(applied.map((change) => change.config?.hostname), ["a.example.com", "b.example.com"]);
});

test("a change that finishes after a lost menu was closed is still told to the readout", async () => {
  const route = realRoute(100);
  const finish = gate();
  let gone = false;
  const { out, open, pane, told } = build({
    applyWaits: () => finish.opened,
    fetcher: fetcherFor(async (body) => (gone ? { status: 503, body: "restarting" } : route.handle(body))),
  });
  open();
  await until("the menu", () => /❯ ✓ Off/.test(lastScreen(out.text())));
  for (const key of ["6", "\r", ..."board.example.com", "\r"]) pane.key(key);
  await until("the change under way", () => lastScreen(out.text()).includes("serving board.example.com…"));
  gone = true;
  await until("the menu lost", () => /stopped answering this menu \(it answered 503\)/.test(lastScreen(out.text())));
  assert.equal(pane.key("x"), "close");
  pane.close();
  assert.equal(told.length, 0, "nothing has changed yet");
  finish.open();
  await until("the readout told", () => told.length === 1);
  assert.equal(told[0]?.hostname, "board.example.com");
});
