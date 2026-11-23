import { LAUNCH_TOKEN_HEADER } from "@frizz/server/launch-routing";
import {
  REMOTE_SETUP_PATH,
  REMOTE_SETUP_PROTOCOL,
  type RemoteSetupAnswer,
  type RemoteSetupContext,
  type RemoteSetupEffect,
  type RemoteSetupEvent,
} from "@frizz/server/remote-setup-protocol";
import type { RelayAccess } from "@frizz/shared/relay-protocol";
import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared/routes";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, DIM, HIDE_CURSOR, RESET, SHOW_CURSOR, type AccessLink } from "./access-pane.ts";
import { type CloudConfig, parseCloudConfig } from "./cloud.ts";
import type { Pane, PaneHandle } from "./pane-host.ts";

/**
 * R, drawn by the server. The menu that sets up remote access lives in the server now
 * (packages/server/src/remote-setup/), so a change to it ships in a server release rather than a release
 * of this shell. This pane forwards each key to `POST /_frizz/control/remote-setup` and writes the screen
 * the server answers with; packages/server/src/remote-setup-protocol.ts is the wire.
 *
 * What the server cannot do, the server asks for and this pane does: switching the transport the board is
 * served through, minting a sign-in link, signing devices out. Those are the shell's — the relay, the public
 * listener and the sessions all live here — and each is run only for the menu open in this terminal, in
 * answer to the keys pressed in it.
 *
 * A server that does not answer R — one from before the route, one restarting, one too busy to answer
 * within a few seconds — gets this shell's own menu instead (remote-pane.ts), which is frozen as it was
 * when the menu moved. Nothing about the menu is changed there any more.
 */

export interface RemoteSetupShellActs {
  current(): CloudConfig | null;
  devices(): Array<{ id: string; label: string; createdAt: number }>;
  apply(next: CloudConfig | null, options?: { justClaimed?: boolean }): Promise<void>;
  setRelayAccess(access: RelayAccess): void | Promise<void>;
  issueLink(): AccessLink | null;
  signOut(id: string): boolean;
  signOutAll(): number;
  forgetSessionsFor(hostname: string): void;
}

export interface RemoteSetupClientOptions {
  /** The board's port: the server is asked through it, and the menu's instructions name it. */
  port: number;
  /** The owner token the server's control routes take. Without one, R opens this shell's own menu. */
  token: string | undefined;
  sandbox: boolean;
  acts: RemoteSetupShellActs;
  /** This shell's own menu, for a server that does not draw one. Built on first need, then kept. */
  fallback: () => Pane;
  /** Told after a change the server's menu made, as the shell's own menu does. */
  onChanged?: (config: CloudConfig | null) => void;
  /** Told as the menu closes, when a change it made is in force (remote-pane.ts says why then). */
  onClosedAfterChange?: (config: CloudConfig | null) => void;
  /** Which menu R opened, and why it was not the server's: for the log. */
  onOpened?: (by: "server" | "shell", why?: string) => void;
  output?: NodeJS.WriteStream;
  fetcher?: typeof fetch;
  /** How long R waits for the server's first screen before it opens this shell's own menu. */
  openTimeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Longer than the server holds a wait (REMOTE_SETUP_WAIT_MS, 25s). */
const WAIT_TIMEOUT_MS = 40_000;

type Mode = "closed" | "connecting" | "server" | "shell" | "lost";

const RELAY_ACCESS = new Set<string>(["full", "read-and-answer"]);

/** The server's answer, or undefined when it is not one this shell can read. */
function parseAnswer(body: unknown): RemoteSetupAnswer | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const answer = body as Partial<RemoteSetupAnswer>;
  if (answer.protocol !== REMOTE_SETUP_PROTOCOL || typeof answer.session !== "string" || typeof answer.frame !== "number" || typeof answer.screen !== "string") return undefined;
  const effect = answer.effect as { id?: unknown; kind?: unknown } | undefined;
  const effectOk = effect === undefined || (typeof effect === "object" && effect !== null && Number.isInteger(effect.id) && typeof effect.kind === "string");
  if (!effectOk) return undefined;
  return {
    protocol: REMOTE_SETUP_PROTOCOL,
    session: answer.session,
    frame: answer.frame,
    screen: answer.screen,
    ...(answer.close === true ? { close: true as const } : {}),
    ...(effect ? { effect: effect as RemoteSetupEffect } : {}),
  };
}

export function createRemoteSetupClient(options: RemoteSetupClientOptions): Pane {
  const output = options.output ?? process.stdout;
  const fetcher = options.fetcher ?? fetch;
  let mode: Mode = "closed";
  /** Moves on every open and close, so an answer to a menu that is gone is dropped. */
  let generation = 0;
  let session: string | undefined;
  /** The newest frame on screen. */
  let painted = -1;
  let handle: PaneHandle | undefined;
  /** Keys pressed before the server's first screen arrived, sent once it has. */
  let queued: string[] = [];
  let keys: Promise<void> = Promise.resolve();
  /** Effects already run for this menu: each answer repeats the pending one until it is answered. */
  const started = new Set<number>();
  /** A change made while the menu is up, for the readout once it closes. */
  let changed: { config: CloudConfig | null } | null = null;
  let serverClosed = false;
  let fallback: Pane | undefined;

  const context = (): RemoteSetupContext => ({
    port: options.port,
    columns: output.columns ?? 80,
    rows: output.rows ?? 24,
    current: options.acts.current(),
    devices: options.acts.devices().map(({ id, label, createdAt }) => ({ id, label, createdAt })),
    sandbox: options.sandbox,
  });

  const post = async (event: RemoteSetupEvent, timeoutMs: number): Promise<{ status: number; body: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetcher(`http://127.0.0.1:${options.port}${FRIZZ_ROUTE_PREFIX}${REMOTE_SETUP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [LAUNCH_TOKEN_HEADER]: options.token ?? "" },
        body: JSON.stringify({ protocol: REMOTE_SETUP_PROTOCOL, ...(session ? { session } : {}), event, context: context() }),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.json().catch(() => undefined) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** The server stopped answering this menu. Said in place of its screen; any key hands the terminal back. */
  const lose = (reason: string) => {
    mode = "lost";
    output.write(CLEAR);
    output.write(`\n  The Frizz server stopped answering this menu (${reason}).\n\n  ${DIM}press any key to return, then R to open it again${RESET}`);
  };

  /**
   * Send `event` for the menu of generation `at`, the one the key or effect behind it belonged to. A menu
   * closed or reopened since then hears nothing: its session is not this one, and an effect id or a key
   * meant for the old menu would land on the new one's.
   */
  const send = async (event: RemoteSetupEvent, at: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RemoteSetupAnswer | undefined> => {
    if (at !== generation || mode !== "server") return undefined;
    let reply: { status: number; body: unknown };
    try {
      reply = await post(event, timeoutMs);
    } catch (error) {
      if (at === generation && mode === "server") lose(error instanceof Error && error.name === "AbortError" ? "it took too long" : "it could not be reached");
      return undefined;
    }
    if (at !== generation || mode !== "server") return undefined;
    const answer = reply.status === 200 ? parseAnswer(reply.body) : undefined;
    if (!answer) {
      lose(reply.status === 404 ? "it restarted" : `it answered ${reply.status}`);
      return undefined;
    }
    receive(answer, at);
    return answer;
  };

  const receive = (answer: RemoteSetupAnswer, at: number) => {
    if (answer.frame > painted) {
      painted = answer.frame;
      output.write(CLEAR);
      output.write(answer.screen);
    }
    if (answer.close) {
      serverClosed = true;
      handle?.close();
      return;
    }
    if (answer.effect && !started.has(answer.effect.id)) {
      started.add(answer.effect.id);
      void run(answer.effect, at);
    }
  };

  /** Do what the server asked, and tell it how that went, if the menu that asked is still the one up. */
  const run = async (effect: RemoteSetupEffect, at: number) => {
    let outcome: { ok: true; value?: unknown } | { ok: false; error: string };
    try {
      outcome = { ok: true, value: await perform(effect) };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await send({ type: "effect", id: effect.id, ...outcome } as RemoteSetupEvent, at);
  };

  const perform = async (effect: RemoteSetupEffect): Promise<unknown> => {
    switch (effect.kind) {
      case "apply": {
        // Read as cloud.json is: the server's word is not taken for what this shell is about to serve.
        const config = effect.config === null ? null : parseCloudConfig(effect.config);
        if (effect.config !== null && config === null) throw new Error("the server asked for a setup this launcher cannot read");
        // A name claimed afresh signs out what was signed in under it before, before it is served:
        // someone else may have served it in between and collected those cookies (cloud.ts, onFreshClaim).
        if (config && effect.forgetSessions === true) options.acts.forgetSessionsFor(config.hostname);
        await options.acts.apply(config, effect.justClaimed === true ? { justClaimed: true } : undefined);
        options.onChanged?.(config);
        // The readout hears once the terminal is back on it: when the menu up now closes, or at once when
        // none is (a change can finish after a lost menu was closed).
        if (mode === "closed") options.onClosedAfterChange?.(config);
        else changed = { config };
        return undefined;
      }
      case "relay-access":
        if (!RELAY_ACCESS.has(effect.access)) throw new Error(`this launcher does not know the access level ${String(effect.access)}`);
        await options.acts.setRelayAccess(effect.access);
        return undefined;
      case "issue-link":
        return options.acts.issueLink();
      case "sign-out":
        if (typeof effect.device !== "string") throw new Error("the server did not say which device");
        return options.acts.signOut(effect.device);
      case "sign-out-all":
        return options.acts.signOutAll();
      default:
        // A server newer than this shell may ask for something it cannot do; the menu says so.
        throw new Error(`this launcher cannot do that yet (${String((effect as { kind: unknown }).kind)}); update Frizz to use it`);
    }
  };

  /** One wait outstanding while the menu is up: how a screen the server draws on its own reaches here. */
  const watch = async (at: number) => {
    while (at === generation && mode === "server") {
      const before = painted;
      const answer = await send({ type: "wait", after: painted }, at, WAIT_TIMEOUT_MS);
      // A wait answered at once with nothing new would spin; a breath stops that without slowing a real change.
      if (answer && answer.frame <= before) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  /**
   * Open this shell's own menu in place of the server's, with any keys already pressed. `screenTaken` says
   * this pane already switched to the alternate screen, which a menu that will not open must hand back.
   */
  const openShellMenu = (why: string, screenTaken: boolean): boolean => {
    fallback ??= options.fallback();
    options.onOpened?.("shell", why);
    if (!fallback.open(handle)) {
      mode = "closed";
      if (screenTaken) {
        output.write(ALT_SCREEN_OFF);
        output.write(SHOW_CURSOR);
      }
      return false;
    }
    mode = "shell";
    for (const key of queued.splice(0)) {
      if (fallback.key(key) === "close") {
        handle?.close();
        break;
      }
    }
    return true;
  };

  /** Keys go to the server one at a time, each after the answer to the one before, and only to their own menu. */
  const sendKey = (key: string) => {
    const at = generation;
    keys = keys.then(async () => {
      await send({ type: "key", key }, at);
    });
  };

  const connect = async (at: number) => {
    let reply: { status: number; body: unknown } | undefined;
    try {
      reply = await post({ type: "open" }, options.openTimeoutMs ?? 3_000);
    } catch (error) {
      reply = undefined;
      if (at === generation && mode === "connecting") {
        const why = error instanceof Error && error.name === "AbortError" ? "the server did not answer in time" : "the server could not be reached";
        if (!openShellMenu(why, true)) handle?.close();
      }
      return;
    }
    if (at !== generation || mode !== "connecting") return;
    const answer = reply.status === 200 ? parseAnswer(reply.body) : undefined;
    if (!answer) {
      // 403 or 404 from a server older than the route, 503 from one restarting.
      if (!openShellMenu(`the server answered ${reply.status}`, true)) handle?.close();
      return;
    }
    session = answer.session;
    mode = "server";
    options.onOpened?.("server");
    receive(answer, at);
    for (const key of queued.splice(0)) sendKey(key);
    void watch(at);
  };

  return {
    open(paneHandle) {
      handle = paneHandle;
      generation += 1;
      session = undefined;
      painted = -1;
      queued = [];
      started.clear();
      changed = null;
      serverClosed = false;
      if (!options.token) return openShellMenu("this launcher holds no token for the server", false);
      mode = "connecting";
      output.write(ALT_SCREEN_ON);
      output.write(HIDE_CURSOR);
      // The menu's first line, until the server's screen replaces it.
      output.write(CLEAR);
      output.write("\n  Reach this board from other devices");
      void connect(generation);
      return true;
    },
    key(key) {
      if (mode === "connecting") {
        queued.push(key);
        return "keep";
      }
      if (mode === "shell") return fallback!.key(key);
      if (mode === "server") {
        sendKey(key);
        return "keep";
      }
      return "close";
    },
    close() {
      const was = mode;
      if (was === "closed") return;
      mode = "closed";
      generation += 1;
      if (was === "shell") {
        fallback?.close();
        // A change the server's menu finished while this shell's own menu was up.
        if (changed) options.onClosedAfterChange?.(changed.config);
        changed = null;
        return;
      }
      if (was === "server" && session && !serverClosed) void post({ type: "close" }, 2_000).catch(() => {});
      output.write(ALT_SCREEN_OFF);
      output.write(SHOW_CURSOR);
      // Back on the main screen, so a line written now lands under the readout rather than in the menu.
      if (changed) options.onClosedAfterChange?.(changed.config);
      changed = null;
    },
  };
}
