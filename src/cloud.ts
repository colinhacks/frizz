import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { frizzPaths } from "@frizz/server/frizz-paths";
import { claimNameIsValid, generateAnonymousClaimName, isAnonymousClaimName, normalizeClaimName } from "@frizz/shared";
import { loadOrCreateClaimIdentity } from "./identity.ts";
import { deviceCodeMessage, githubDeviceFlow, type GithubAuthorizer } from "./github-device-flow.ts";
import { ClaimError, claimName } from "./registrar-client.ts";
import { connectRelay } from "./relay-connection.ts";

/**
 * `frizz up` — one command for "start the server and reach it from anywhere".
 *
 * Before this, reaching a board from a phone meant two terminals and three flags: a launch with
 * `--public-origin https://…`, a separate `cloudflared tunnel … run …` in another window, and
 * remembering that closing either one silently breaks the phone. Nothing about that is discoverable,
 * and getting it wrong produces either "Forbidden" or a Cloudflare error with no hint which half died.
 *
 * So the tunnel becomes a supervised CHILD of the board. One process to start, one to stop, and the two
 * halves cannot drift out of sync because they share a lifetime.
 *
 * Deliberately does NOT ask about the port. There is a default, and `FRIZZ_PORT` overrides it for the
 * few people who care — a prompt for it would be a question almost nobody has an answer to.
 *
 * Three ways to have a hostname, told apart by the shape of the answer:
 *
 *   (empty)            -> CLAIM a private unguessable name on frizz.sh — no account, no sign-in
 *   colin              -> CLAIM `colin.frizz.sh` from the registrar, bound to your GitHub account
 *                         through a no-permission GitHub sign-in (github-device-flow.ts). PAUSED
 *                         while CUSTOM_NAMES_OFFERED is false: the answer is refused up front.
 *   board.example.com  -> a tunnel you made yourself, which Frizz only runs
 *
 * The claimed path exists because creating a tunnel and its DNS record needs a zone-scoped Cloudflare
 * token, and that token can never live on a user's machine. The registrar holds it and hands back a
 * per-tunnel run token, which runs exactly one tunnel and can reach nothing else in the zone.
 */

export interface CloudConfig {
  /** The public hostname, e.g. `colin.frizz.sh`. Stored without a scheme; it is always https. */
  hostname: string;
  /**
   * The cloudflared tunnel name to run, for a tunnel the operator made themselves.
   *
   * Absent on a CLAIMED name, where the tunnel is remotely managed and runs from a token instead —
   * there is no local tunnel name to say, and no config file to point at.
   */
  tunnel?: string;
  /** Optional explicit cloudflared config path; defaults beside the others in ~/.cloudflared. */
  config?: string;
  /** The claimed label, e.g. `colin`. Its presence is what marks this as a registrar-issued name. */
  claim?: string;
  /**
   * How the name is served.
   *
   * `relay` — the board opens a socket to the relay and serves through it. No tunnel, no cloudflared,
   * nothing per-name in DNS. This is what a claim gets now.
   * `tunnel` — the older path, where the registrar provisioned a Cloudflare tunnel per name.
   *
   * `external` — the operator runs the transport (Tailscale Serve, a proxy, a tunnel started by hand)
   * and Frizz runs nothing: it only knows the origin, gates it, and prints links for it.
   *
   * Absent on an existing config means tunnel, so an upgrade does not silently change how a board that
   * already works is served.
   */
  serve?: "relay" | "tunnel" | "external";
  /** For an `external` config, which setup the R pane walked through — only a label for the readout. */
  provider?: "tailscale" | "other";
}

/** A config Frizz serves by knowing the origin alone — nothing to start, nothing to renew. */
export function isExternalConfig(config: CloudConfig): boolean {
  return config.serve === "external";
}

/** The readout's name for how a board is reached, next to its public address. */
export function describeCloudConfig(config: CloudConfig): string {
  if (isClaimedConfig(config)) return "frizz.sh";
  if (isExternalConfig(config)) return config.provider === "tailscale" ? "Tailscale" : "your proxy";
  return "Cloudflare Tunnel";
}

/**
 * Is there a registrar to claim names from yet?
 *
 * Yes since 2026-08-24: the Worker is deployed at registrar.frizz.sh and the whole loop is verified
 * against real Cloudflare and real GitHub. Set this back to `false` to withdraw the offer — it is the
 * whole gate, and a bare name then refuses up front instead of failing at a connection error.
 *
 * Setting `FRIZZ_REGISTRAR` points the CLI at a different registrar, which is how a deployment gets
 * tested before it takes the default hostname.
 */
export const REGISTRAR_IS_LIVE = true;

/**
 * Are CUSTOM names (`colin.frizz.sh`, bound to a GitHub account) offered?
 *
 * No, as of 2026-10-08, until Frizz's GitHub OAuth app is registered: the client id in
 * github-device-flow.ts is still the placeholder, so a custom claim could only refuse with
 * "not-configured" after the person had already picked it. While this is false the R pane does not
 * list "Custom subdomain", the prompt does not mention it, and a word answer refuses before any GitHub
 * sign-in or registrar call. Private names, and every bring-your-own setup, are unaffected.
 *
 * Flipping it to `true` (with a real client id) brings the whole path back — nothing behind it was
 * removed. A name already claimed keeps renewing either way: a renewal is signed by the keypair and
 * never touches GitHub (resolveRunToken).
 *
 * `FRIZZ_CUSTOM_NAMES=1` turns the offer on for one process, which is how the tests and
 * scripts/verify-claim-e2e.mjs keep driving the path while it is withdrawn. Read through
 * customNamesOffered, never directly.
 */
export const CUSTOM_NAMES_OFFERED = false;

/** CUSTOM_NAMES_OFFERED, or the `FRIZZ_CUSTOM_NAMES=1` override. */
export function customNamesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return CUSTOM_NAMES_OFFERED || env.FRIZZ_CUSTOM_NAMES === "1";
}

/** Why a word answer is refused while custom names are withdrawn. */
export const CUSTOM_NAMES_PAUSED =
  "custom frizz.sh subdomains are paused for now — press enter for a private subdomain (no account needed), or answer with the hostname of a tunnel you run";

/** A claimed name runs a remotely-managed tunnel; a hand-made one runs by name from a config file. */
export function isClaimedConfig(config: CloudConfig): boolean {
  return typeof config.claim === "string" && config.claim.length > 0;
}

/**
 * Is this board served through the relay rather than a tunnel of its own?
 *
 * A config written before the relay existed has no `serve`. Until 2026-08-25 that meant "keep serving
 * it the way it already works" — but the relay's wildcard route now answers for EVERY name in the
 * zone at Cloudflare's edge, so a tunnel behind such a name is unreachable however faithfully it is
 * run. reconcileCloudConfig is what moves those configs over; this predicate only reads the file.
 */
export function isRelayConfig(config: CloudConfig): boolean {
  return isClaimedConfig(config) && config.serve === "relay";
}

/** The zone the registrar hands names out in. Every hostname inside it is served by the relay. */
export const CLAIM_ZONE = "frizz.sh";

/**
 * The claim label a hostname inside the zone stands for: `colin.frizz.sh` → `colin`. Null for a
 * hostname outside the zone, the zone apex, or a deeper name the registrar never hands out.
 */
export function zoneClaimLabel(hostname: string): string | null {
  const suffix = `.${CLAIM_ZONE}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".") ? label : null;
}

/**
 * Bring a saved config in line with how its name is actually served today.
 *
 * Nobody claims a name by hand: `frizz up` is the whole procedure. So when the saved config names a
 * host inside the zone but is not a relay claim — a tunnel written by hand before names could be
 * claimed at all, or a claim issued while the registrar still provisioned tunnels — this claims the
 * label now, through the same call a first launch makes, and hands back the relay config to save.
 * The board then serves through the relay on this very launch. Before this, the launcher ran the old
 * tunnel faithfully and the phone that scanned the QR read "No Frizz board has claimed this name."
 * (2026-08-25), with no step anywhere that would ever have claimed it.
 *
 * A hostname outside the zone is the operator's own tunnel and is never touched; a relay config is
 * returned as-is, and the caller renews its lease the usual way. Throws when the claim fails — a name
 * somebody else holds, or a registrar that cannot be reached on a first claim — because starting a
 * tunnel that nothing can reach is the failure this exists to end.
 *
 * While custom names are withdrawn (CUSTOM_NAMES_OFFERED), a saved custom label that still needs this
 * move refuses with a message saying so, rather than starting a GitHub sign-in at launch. A relay
 * claim on a custom name is untouched: it returns above, and the caller renews it by keypair alone.
 */
export async function reconcileCloudConfig(
  config: CloudConfig,
  port: number,
  home = homedir(),
  onNotice?: (message: string) => void,
  origin?: string,
  // A reconcile runs at launch, before any pane is open, so the sign-in code is shown the way every
  // other launch notice is.
  github: GithubAuthorizer = githubDeviceFlow(onNotice ? { onPrompt: (prompt) => onNotice(deviceCodeMessage(prompt)) } : {}),
): Promise<CloudConfig> {
  if (isRelayConfig(config)) return config;
  const label = config.claim ?? zoneClaimLabel(config.hostname);
  if (!label) return config;
  if (!isAnonymousClaimName(label) && !customNamesOffered()) {
    throw new Error(
      `${config.hostname} needs moving onto the Frizz relay, which means claiming it again, and custom frizz.sh subdomains are paused for now — press R to pick a private subdomain or another setup`,
    );
  }
  onNotice?.(
    isClaimedConfig(config)
      ? `${config.hostname} is served by the Frizz relay now; moving this board off its tunnel`
      : `${config.hostname} is inside ${CLAIM_ZONE}, where names are claimed, not tunnelled; claiming ${label}`,
  );
  return establishCloudConfig(label, port, home, origin, github);
}

/**
 * Where the saved setup lives: `cloud.json` under the data root frizz-paths.ts resolves, beside the
 * registry and `server.lock` — NOT a literal `~/.frizz`.
 *
 * It was the literal until 2026-09-23, and on a machine that had never had a `~/.frizz` (every fresh
 * macOS, Windows or XDG install since the roots split) the first remote-access setup CREATED one.
 * frizz-paths.ts reads that directory's existence as "legacy install" and routes every root there
 * from the next launch on, so the board came back with none of its projects — the same trap the claim
 * identity fell into and was pulled out of on 2026-08-28 (identity.ts). A machine that already has
 * `~/.frizz` resolves to the same file as before.
 */
export function cloudConfigPath(home = homedir()): string {
  return join(frizzPaths({ home }).data, "cloud.json");
}

export function readCloudConfig(home = homedir()): CloudConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(cloudConfigPath(home), "utf8")) as Partial<CloudConfig>;
    if (typeof parsed.hostname !== "string" || !parsed.hostname) return null;
    // Exactly one of the two shapes must be present. A config naming NEITHER a tunnel nor a claim
    // describes a hostname nothing can serve, which is worse than having no config at all — the
    // launcher would arm the origin gate for an address with no tunnel behind it.
    const claimed = typeof parsed.claim === "string" && parsed.claim.length > 0;
    const named = typeof parsed.tunnel === "string" && parsed.tunnel.length > 0;
    const external = parsed.serve === "external";
    if (!claimed && !named && !external) return null;
    return {
      hostname: parsed.hostname,
      ...(named ? { tunnel: parsed.tunnel } : {}),
      ...(claimed ? { claim: parsed.claim } : {}),
      ...(parsed.serve === "relay" || parsed.serve === "tunnel" || external ? { serve: parsed.serve } : {}),
      ...(external && (parsed.provider === "tailscale" || parsed.provider === "other") ? { provider: parsed.provider } : {}),
      ...(parsed.config ? { config: parsed.config } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Where the per-tunnel run token is cached.
 *
 * SEPARATE FROM cloud.json, which is ordinary config and world-readable on machines that already have
 * one. This file is a credential, so it gets 0600 — and keeping the two apart means an existing
 * config file cannot silently become a secret when a user claims a name. It sits in the state root
 * beside the claim identity key, for the reason given on `cloudConfigPath`.
 */
export function tunnelTokenPath(home = homedir()): string {
  return join(frizzPaths({ home }).state, "tunnel-token");
}

export function readTunnelToken(home = homedir()): string | null {
  try {
    const token = readFileSync(tunnelTokenPath(home), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function writeTunnelToken(token: string, home = homedir()): void {
  const path = tunnelTokenPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
}

/** Forget the saved setup: the next launch is loopback-only. Nothing else to undo — a claim lapses on its own. */
export function deleteCloudConfig(home = homedir()): void {
  rmSync(cloudConfigPath(home), { force: true });
}

export function writeCloudConfig(config: CloudConfig, home = homedir()): void {
  const path = cloudConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Strip a scheme, path or trailing dot someone pastes in, so `https://x.dev/` and `x.dev` both work. */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed || !trimmed.includes(".")) {
    throw new Error(`invalid hostname: ${raw} (expected something like colin.frizz.sh)`);
  }
  return trimmed.toLowerCase();
}

/**
 * Ask once, remember forever. Asked only when there is no saved config — the whole point is that the
 * second launch is a single flag.
 *
 * One question, not two. A bare label claims a name on frizz.sh; anything with a dot in it is a
 * hostname the operator already has a tunnel for. Asking "do you want to claim or bring your own"
 * first would be a fork most people cannot answer before they know what the options mean.
 */
export async function promptForCloudName(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "needs a saved name when there is no terminal to ask — press R in a running board once, interactively",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      await rl.question(
        customNamesOffered()
          ? "Name for this board — press enter for a private unguessable name (no account), a word claims <name>.frizz.sh (needs GitHub), or paste a hostname you already run a tunnel for: "
          : "Name for this board — press enter for a private unguessable name (no account), or paste a hostname you already run a tunnel for: ",
      )
    ).trim();
  } finally {
    rl.close();
  }
}

/** The cloudflared tunnel that serves an operator-owned hostname; the first label is only a guess. */
export async function promptForTunnelName(hostname: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Name of the cloudflared tunnel serving ${hostname} [${fallback}]: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/**
 * Turn what they typed into a usable config, claiming a name if that is what they asked for.
 *
 * The run token is written HERE rather than returned, because the caller's job is to start a board and
 * every path out of this function has to leave the same thing on disk for the next launch to find.
 */
export async function establishCloudConfig(
  answer: string,
  port: number,
  home = homedir(),
  origin?: string,
  github: GithubAuthorizer = githubDeviceFlow(),
): Promise<CloudConfig> {
  if (answer.includes(".")) {
    // A hostname: the operator owns the tunnel, so ASK which one. Deriving it from the hostname's
    // first label looked clever and was wrong for any tunnel not named after its host — the doc's own
    // example (`my-board` serving `board.example.com`) ran `cloudflared tunnel run board` and died.
    const hostname = normalizeHostname(answer);
    const tunnel = await promptForTunnelName(hostname, hostname.split(".")[0]!);
    return { hostname, tunnel };
  }

  if (!REGISTRAR_IS_LIVE && !origin && !process.env.FRIZZ_REGISTRAR) {
    throw new Error(
      "claiming a frizz.sh subdomain is not available yet.\n" +
        "       Reach this board through a tunnel of your own instead — see docs/remote-access.md — and\n" +
        "       answer with its hostname rather than a bare name.",
    );
  }

  // An EMPTY answer is the auth-free default: mint an unguessable name and claim it with the keypair
  // alone. The registrar recognises the shape and asks for no GitHub identity, so this path needs no
  // GitHub account at all — which is the whole point of it. A name that already HAS the
  // anonymous shape rides the same path, so reconciling or re-entering one never demands GitHub.
  const anonymous = answer === "" || isAnonymousClaimName(answer);
  // Withdrawn custom names refuse HERE: before the name is judged, before a keypair is minted, and
  // before GitHub or the registrar hears anything (see CUSTOM_NAMES_OFFERED).
  if (!anonymous && !customNamesOffered()) throw new Error(CUSTOM_NAMES_PAUSED);
  if (!anonymous && !claimNameIsValid(answer)) {
    // Surface the specific reason — reserved, too short, bad character — rather than a generic refusal.
    normalizeClaimName(answer);
  }
  const name = answer === "" ? generateAnonymousClaimName() : normalizeClaimName(answer);
  const identity = await loadOrCreateClaimIdentity(home);
  let token: string | undefined;
  if (!anonymous) {
    // A name is bound to a GitHub account, so say WHICH one before binding it. Someone signed in as a
    // work account would otherwise find out only when they wanted the name somewhere else. The token is
    // the zero-scope one the device flow mints — never the `gh` CLI's, which can push to every repo.
    const authorization = await github.authorize();
    token = authorization.token;
    if (authorization.login) console.log(`  claiming ${name}.frizz.sh for GitHub user ${authorization.login}`);
  } else {
    console.log("  claiming a private frizz.sh subdomain — no account needed");
  }
  let result;
  try {
    result = await claimName({ name, port, identity, ...(token ? { github: token } : {}), ...(origin ? { origin } : {}) });
  } catch (error) {
    // A FIRST claim that cannot reach the registrar leaves the operator with nothing — unlike a
    // renewal, which falls back to its cached token. Point at the path that works without us rather
    // than leaving them staring at a network error for a service they have never heard of.
    if (error instanceof ClaimError && error.code === "unreachable") {
      throw new ClaimError(
        `${error.message}\n       You can still reach this board through a tunnel of your own — see docs/remote-access.md, then answer with its hostname instead of a name.`,
        error.code,
      );
    }
    throw error;
  }
  if (result.token) {
    writeTunnelToken(result.token, home);
    return { hostname: result.hostname, claim: name, serve: "tunnel" };
  }
  // No run token means the registrar is in relay mode and the board serves itself over a socket.
  return { hostname: result.hostname, claim: name, serve: "relay" };
}

/**
 * The run token for this launch: renewed if the registrar answers, cached if it does not.
 *
 * Renewing on every launch is what keeps a lease alive, so it costs nothing extra to do it here. The
 * fallback is the important half — the registrar is NOT on the data plane, and a board that could not
 * start because a signup service was down would quietly make it one.
 */
export async function resolveRunToken(
  config: CloudConfig,
  port: number,
  home = homedir(),
  onWarning?: (message: string) => void,
  origin?: string,
): Promise<string | null> {
  if (!isClaimedConfig(config)) return null;
  const cached = readTunnelToken(home);
  try {
    const identity = await loadOrCreateClaimIdentity(home);
    const result = await claimName({ name: config.claim!, port, identity, ...(origin ? { origin } : {}) });
    // A relay-served name renews its lease here and returns no token — there is no tunnel to run.
    if (!result.token) return null;
    writeTunnelToken(result.token, home);
    return result.token;
  } catch (error) {
    if (cached && error instanceof ClaimError && error.code === "unreachable") {
      onWarning?.(`could not reach the Frizz registrar to renew ${config.hostname}; using the token from last time`);
      return cached;
    }
    throw error;
  }
}

/** Where cloudflared's config for this tunnel lives, unless the operator named one. */
export function resolveTunnelConfigPath(config: CloudConfig, home = homedir()): string | null {
  if (config.config) return config.config;
  const candidate = join(home, ".cloudflared", "frizz.yml");
  return existsSync(candidate) ? candidate : null;
}

export interface TunnelHandle {
  child: ChildProcess;
  stop: () => void;
}

/** Whatever is currently making the board reachable — a tunnel child, or a socket to the relay. */
export interface CloudTransport {
  stop: () => void;
}

/**
 * Open the board's connection to the relay.
 *
 * There is no child process here and nothing to install: the board dials out and holds one socket. A
 * board behind any NAT works with no configuration, because nothing ever dials IN.
 */
export async function startRelay(
  config: CloudConfig,
  port: number,
  home = homedir(),
  onStatus?: (message: string) => void,
): Promise<CloudTransport> {
  const identity = await loadOrCreateClaimIdentity(home);
  const origin = `https://${config.hostname}`;
  return connectRelay({
    name: config.claim!,
    identity,
    // The board's own hostname IS the relay: one wildcard record puts it in front of every name.
    relayOrigin: origin,
    boardOrigin: `http://127.0.0.1:${port}`,
    publicOrigin: origin,
    ...(onStatus
      ? {
          onStatus: (status, detail) => {
            if (status === "connected") onStatus(`connected to the Frizz relay for ${config.hostname}`);
            else if (status === "retrying") onStatus(`relay: ${detail ?? "reconnecting"}`);
          },
        }
      : {}),
  });
}

/**
 * Run the tunnel as a child of this launcher.
 *
 * Its stdout is deliberately swallowed except for failures: cloudflared is chatty (four "Registered
 * tunnel connection" lines plus QUIC noise) and interleaving that with the board readout makes both
 * unreadable. What matters is whether it came up, and that is reported by the caller.
 */
export function startTunnel(
  config: CloudConfig,
  onExit: (code: number | null) => void,
  onError: (message: string) => void,
  home = homedir(),
  runToken?: string,
): TunnelHandle {
  // A claimed name runs a REMOTELY-MANAGED tunnel: its ingress lives in Cloudflare, so there is
  // nothing local to configure and the token is the whole identity. A hand-made tunnel keeps the
  // original form — a name, and a config file holding its ingress rules.
  const configPath = runToken ? null : resolveTunnelConfigPath(config, home);
  const args = runToken
    ? ["tunnel", "--no-autoupdate", "run", "--token", runToken]
    : [
        "tunnel",
        ...(configPath ? ["--config", configPath] : []),
        "--no-autoupdate",
        "run",
        config.tunnel!,
      ];
  const child = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  // ENOENT arrives as an 'error' event, and an unhandled one on a ChildProcess THROWS — so without
  // this, `frizz up` on a machine without cloudflared crashed with a stack trace instead of saying
  // which program to install. That is the first thing a new user hits, so it is the last thing that
  // should be a crash.
  child.once("error", (error: NodeJS.ErrnoException) => {
    onError(
      error.code === "ENOENT"
        ? "cloudflared is not installed or not on PATH — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        : `could not start cloudflared: ${error.message}`,
    );
  });
  child.once("exit", (code) => onExit(code));
  return {
    child,
    // SIGTERM rather than kill(): cloudflared drains its edge connections, which stops Cloudflare
    // serving a 530 to anyone mid-request while it goes away.
    stop: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
  };
}
