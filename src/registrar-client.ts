import { CLAIM_PROTOCOL_VERSION, normalizeClaimName, signClaim } from "@frizz/shared";

/**
 * The CLI half of claiming `<name>.frizz.sh`.
 *
 * Deliberately separate from the launch path in cloud.ts. This talks to the registrar and nothing
 * else, so it can be driven against a real HTTP server in a test without booting a board — and so
 * that wiring it into `--cloud` later is a small change to a proven piece rather than a rewrite of a
 * path that already works.
 */

/** Overridable so a test, or a self-hoster running their own registrar, can point somewhere else. */
export const DEFAULT_REGISTRAR = "https://registrar.frizz.sh";

/** The zone Frizz's own registrar hands names out in. Every hostname inside it is served by the relay. */
export const CLAIM_ZONE = "frizz.sh";

export function registrarOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRIZZ_REGISTRAR?.trim() || DEFAULT_REGISTRAR;
}

/** https, or plain http to this machine's own loopback. */
export function carriesSecretsSafely(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

export interface ClaimResult {
  hostname: string;
  /**
   * The per-tunnel run token, in TUNNEL mode only.
   *
   * Absent means the registrar is in relay mode: the board serves through the relay over a socket it
   * opens itself, proving ownership with its keypair, so there is no tunnel and nothing to run.
   */
  token?: string;
  leaseExpiresAt: number;
  /** False the first time a name is claimed, true for every renewal afterwards. */
  renewed: boolean;
}

/**
 * Messages for the failures a person can actually do something about.
 *
 * The registrar's own wording is used for anything not listed here, so a newer server can explain a
 * failure this client has never heard of instead of being flattened into "something went wrong".
 */
const ADVICE: Record<string, string> = {
  "name-taken": "that name is already taken — try another",
  "github-required": "claiming a custom name needs a GitHub sign-in — sign in to GitHub in the board's Settings, then try again",
  "github-rejected": "GitHub did not recognise that sign-in — try again",
  "github-token-foreign": "a name is claimed with Frizz's own GitHub sign-in, and this was another kind of GitHub token — sign in to GitHub in the board's Settings, then try again",
  // What a registrar older than 2026-11-07 answers for Frizz's sign-in, which it does not take yet.
  "github-token-scoped": "this registrar does not take Frizz's GitHub sign-in yet — try again once frizz.sh is updated",
  "github-too-new": "that GitHub account is too new to claim a name",
  "not-your-github-username": "a custom frizz.sh name is your own GitHub username, and this is not it",
  // Nothing releases a name: an old one stays its holder's until 30 days after it was last served.
  "one-name-per-account": "that GitHub account already holds another frizz.sh name; it frees up 30 days after it was last served",
  "one-name-per-key": "this machine already holds another custom name; it frees up 30 days after it was last served",
  expired: "this machine's clock is behind the registrar; fix the clock and try again",
  "from-the-future": "this machine's clock is ahead of the registrar; fix the clock and try again",
  "bad-version": "this version of Frizz is too old to claim a name — upgrade and try again",
};

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

export interface ClaimOptions {
  name: string;
  port: number;
  identity: CryptoKeyPair;
  /**
   * A GitHub access token, on a FIRST claim of a custom name only — the user token of Frizz's own
   * GitHub sign-in (github-claim-identity.ts), never the `gh` CLI's, which the registrar refuses.
   *
   * Renewals deliberately omit it: the keypair already proves ownership, so a live name never depends
   * on GitHub being reachable.
   */
  github?: string;
  origin?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Claim a name, or renew one already held by this identity.
 *
 * The same call does both — the registrar decides which, from the key that signed the request. A
 * caller never has to know whether this machine has claimed before, which is what lets the CLI run it
 * unconditionally on every launch.
 */
export async function claimName(options: ClaimOptions): Promise<ClaimResult> {
  const origin = (options.origin ?? registrarOrigin()).replace(/\/$/, "");
  // A GitHub token goes only to a registrar reached over TLS. FRIZZ_REGISTRAR can point anywhere, and
  // a plain-http one would put the token on the wire in the clear. Loopback is for tests.
  if (options.github && !carriesSecretsSafely(origin)) {
    throw new ClaimError(`refusing to send a GitHub sign-in to ${origin}, which is not https`, "insecure-registrar");
  }
  const request = await signClaim(
    {
      name: options.name,
      port: options.port,
      issuedAt: (options.now ?? Date.now)(),
      ...(options.github ? { github: options.github } : {}),
    },
    options.identity,
  );

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${origin}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // Never followed: a 307 or 308 would send the same body, GitHub token and all, wherever it pointed.
      redirect: "manual",
    });
  } catch (error) {
    // A registrar that is down must not read as "your name was rejected" — one is temporary and the
    // other is not, and a person who confuses them goes and picks a different name for no reason.
    throw new ClaimError(
      `could not reach the Frizz registrar at ${origin}: ${error instanceof Error ? error.message : error}`,
      "unreachable",
    );
  }

  const body = (await response.json().catch(() => null)) as
    | (Partial<ClaimResult> & { error?: string; message?: string })
    | null;

  if (!response.ok) {
    const code = typeof body?.error === "string" ? terminalSafe(body.error, 64) : `http-${response.status}`;
    const said = typeof body?.message === "string" ? terminalSafe(body.message, 300) : "";
    throw new ClaimError(ADVICE[code] ?? (said || `the registrar refused the claim (${code})`), code);
  }

  const malformed = () =>
    new ClaimError(
      `the registrar at ${origin} answered something this version does not understand (protocol v${CLAIM_PROTOCOL_VERSION})`,
      "malformed-response",
    );
  if (typeof body?.hostname !== "string") throw malformed();

  // THE ANSWER IS CHECKED, NOT TRUSTED (2026-11-12). The launcher saves the hostname, dials it as the
  // relay with a handshake good for five minutes, gates it as the board's public origin and prints sign-in
  // links for it, and a run token in the answer used to start a cloudflared tunnel whose routes the token's
  // issuer writes. So whoever answered as Frizz's registrar could send a board to a host of their choosing,
  // or expose this machine through a tunnel of their own. From Frizz's own registrar the hostname must be
  // the name asked for in its zone, and a token is ignored: every name there is served by the relay. A
  // registrar the operator pointed at (FRIZZ_REGISTRAR, or a test) is theirs to trust, and only has to
  // answer for the name asked.
  const name = normalizeClaimName(options.name);
  const official = origin === DEFAULT_REGISTRAR;
  const hostname = body.hostname;
  if (official ? hostname !== `${name}.${CLAIM_ZONE}` : !hostname.startsWith(`${name}.`) || !/^[a-z0-9.-]+$/.test(hostname)) throw malformed();

  return {
    hostname,
    ...(!official && typeof body.token === "string" && body.token ? { token: body.token } : {}),
    leaseExpiresAt: typeof body.leaseExpiresAt === "number" ? body.leaseExpiresAt : 0,
    renewed: body.renewed === true,
  };
}

/**
 * Text from the registrar, fit to print in the operator's terminal: control characters out, so an answer
 * cannot retitle the window, clear the screen or colour what follows, and cut to a sentence's length.
 */
function terminalSafe(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, limit);
}
