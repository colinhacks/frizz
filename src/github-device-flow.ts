/**
 * The GitHub identity behind a custom-name claim, taken through GitHub's OAuth DEVICE FLOW against
 * Frizz's own OAuth App, which asks for NO scopes.
 *
 * WHY A TOKEN AND NOT JUST A USERNAME. Reading a username locally proves nothing — the CLI could send
 * any string, so a loop could claim a name per invented account and the limit would mean exactly
 * nothing. The registrar has to check with GitHub itself, and a token is what lets it.
 *
 * WHY THIS TOKEN AND NOT THE `gh` ONE. Until 2026-10-08 the claim sent whatever `gh auth token`
 * printed: a token with `repo`, `workflow` and `read:org`, able to push to every repository its owner
 * can. A compromised registrar collected those tokens (2026-09-21 to 2026-10-08), and at least one
 * leaked. A token from an app that requests no scopes can read only what anyone can read about the
 * account — its public profile — so a leaked one is worth nothing. The registrar now refuses any token
 * that carries a scope, so even an old Frizz cannot hand it a powerful one again.
 *
 * The token is sent ONCE, at the first claim. The registrar exchanges it for a numeric user id, keeps
 * the id, and discards the token; renewals afterwards carry no token at all, because the keypair
 * already proves ownership. Nothing here stores the token either.
 *
 * Device flow needs no client secret and no local web server: the launcher shows a short code, the
 * person enters it at github.com/login/device in any browser — on another device if they like — and
 * the launcher polls GitHub until they have.
 */

/**
 * The client id of Frizz's GitHub OAuth App — public by design: device flow has no secret.
 *
 * Still the placeholder until the maintainer registers the app (see the registrar README). While it is,
 * custom names are withdrawn altogether (CUSTOM_NAMES_OFFERED in cloud.ts, false since 2026-10-08), so
 * nobody is offered a claim that would end here; registering the app means setting this AND flipping
 * that. A claim that reaches this anyway (`FRIZZ_CUSTOM_NAMES=1`) refuses up front with a clear message
 * rather than sending GitHub an id it does not know. `FRIZZ_GITHUB_CLIENT_ID` overrides it, for tests
 * and for a self-hosted registrar.
 */
export const GITHUB_CLIENT_ID_PLACEHOLDER = "frizz-oauth-app-client-id-not-set";
export const FRIZZ_GITHUB_CLIENT_ID: string = GITHUB_CLIENT_ID_PLACEHOLDER;

/** The configured client id, or null while it is still the placeholder. */
export function githubClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.FRIZZ_GITHUB_CLIENT_ID?.trim() || FRIZZ_GITHUB_CLIENT_ID;
  return id === GITHUB_CLIENT_ID_PLACEHOLDER ? null : id;
}

/** Where to send the person, and what to type there. */
export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  /** Epoch ms after which the code is dead and the flow gives up. */
  expiresAt: number;
}

export interface GithubAuthorization {
  /** A token carrying NO scopes. Never logged, never stored; it rides one claim and is dropped. */
  token: string;
  /** Who signed in, for the "claiming X for GitHub user Y" line. Null when GitHub did not say. */
  login: string | null;
}

/** The one question a claim asks of GitHub, behind a seam a test can stand in for. */
export interface GithubAuthorizer {
  authorize(): Promise<GithubAuthorization>;
}

export class GithubSignInError extends Error {
  constructor(
    message: string,
    readonly code: "not-configured" | "unreachable" | "expired" | "denied" | "scoped" | "cancelled" | "failed",
  ) {
    super(message);
    this.name = "GithubSignInError";
  }
}

export interface DeviceFlowOptions {
  /** Shown the code to enter. Called once, before the first poll. */
  onPrompt: (prompt: DeviceCodePrompt) => void;
  /** Aborting stops the poll and rejects with code `cancelled`. */
  signal?: AbortSignal;
  clientId?: string | null;
  /** `https://github.com` — where the device and token endpoints live. */
  githubOrigin?: string;
  /** `https://api.github.com` — where the login is read. */
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const GITHUB_DEVICE_URL = "https://github.com/login/device";

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const cancelled = () => new GithubSignInError("the GitHub sign-in was cancelled", "cancelled");

/** A GitHub OAuth endpoint answers 200 with `{ error }` for most failures, so both shapes are read. */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "frizz",
      },
      body: new URLSearchParams(fields).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new GithubSignInError(
      `could not reach GitHub to sign in: ${error instanceof Error ? error.message : error}`,
      "unreachable",
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body: body ?? {} };
}

const oauthErrorText = (body: Record<string, unknown>, fallback: string): string =>
  typeof body.error_description === "string" && body.error_description
    ? body.error_description
    : typeof body.error === "string" && body.error
      ? body.error
      : fallback;

/**
 * Run the device flow to the end: a zero-scope token, or a GithubSignInError saying why not.
 *
 * Polls at GitHub's interval, and slows down when told to — GitHub answers `slow_down` with a new
 * interval, and ignoring it gets the client rate-limited for the rest of the flow.
 */
export async function runDeviceFlow(options: DeviceFlowOptions): Promise<GithubAuthorization> {
  const clientId = options.clientId === undefined ? githubClientId() : options.clientId;
  if (!clientId) {
    throw new GithubSignInError(
      "custom frizz.sh subdomains are not available in this version of Frizz yet: its GitHub sign-in is not set up. A random frizz.sh subdomain needs no account and works today.",
      "not-configured",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const githubOrigin = (options.githubOrigin ?? "https://github.com").replace(/\/$/, "");
  const apiOrigin = (options.apiOrigin ?? "https://api.github.com").replace(/\/$/, "");
  const { signal } = options;

  // NO `scope` parameter: the app asks for nothing, so the token can do nothing but say who it is.
  const start = await postForm(fetchImpl, `${githubOrigin}/login/device/code`, { client_id: clientId }, signal);
  const deviceCode = start.body.device_code;
  const userCode = start.body.user_code;
  if (start.status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string") {
    throw new GithubSignInError(
      `GitHub would not start a sign-in: ${oauthErrorText(start.body, `HTTP ${start.status}`)}`,
      "failed",
    );
  }
  const verificationUri = typeof start.body.verification_uri === "string" ? start.body.verification_uri : GITHUB_DEVICE_URL;
  const expiresIn = typeof start.body.expires_in === "number" ? start.body.expires_in : 900;
  let interval = typeof start.body.interval === "number" ? start.body.interval : 5;
  const expiresAt = now() + expiresIn * 1000;
  options.onPrompt({ userCode, verificationUri, expiresAt });

  for (;;) {
    await sleep(interval * 1000, signal);
    if (now() >= expiresAt) {
      throw new GithubSignInError("the GitHub code expired before it was entered — try again", "expired");
    }
    const poll = await postForm(
      fetchImpl,
      `${githubOrigin}/login/oauth/access_token`,
      { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      signal,
    );
    const error = poll.body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = typeof poll.body.interval === "number" ? poll.body.interval : interval + 5;
      continue;
    }
    if (error === "expired_token") {
      throw new GithubSignInError("the GitHub code expired before it was entered — try again", "expired");
    }
    if (error === "access_denied") {
      throw new GithubSignInError("the GitHub sign-in was declined, so no name was claimed", "denied");
    }
    const token = poll.body.access_token;
    if (typeof error === "string" || typeof token !== "string" || !token) {
      throw new GithubSignInError(`GitHub sign-in failed: ${oauthErrorText(poll.body, `HTTP ${poll.status}`)}`, "failed");
    }
    // The registrar refuses a scoped token anyway; refusing it HERE means one is never sent at all.
    const scope = typeof poll.body.scope === "string" ? poll.body.scope.trim() : "";
    if (scope) {
      throw new GithubSignInError(
        `GitHub granted this sign-in more access than a name needs (${scope}), so Frizz did not use it`,
        "scoped",
      );
    }
    return { token, login: await readLogin(fetchImpl, apiOrigin, token) };
  }
}

/** Best-effort: the login is only for display, and a claim must not fail because this did. */
async function readLogin(fetchImpl: typeof fetch, apiOrigin: string, token: string): Promise<string | null> {
  try {
    const response = await fetchImpl(`${apiOrigin}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "frizz" },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as { login?: unknown };
    return typeof user.login === "string" ? user.login : null;
  } catch {
    return null;
  }
}

/** The line a terminal shows for the code. One sentence, so it reads the same in a log as on screen. */
export function deviceCodeMessage(prompt: DeviceCodePrompt): string {
  return `to confirm your GitHub account, open ${prompt.verificationUri} and enter ${prompt.userCode} (Frizz asks GitHub for no permissions)`;
}

/** The real thing, showing its code through `onPrompt` — the terminal by default. */
export function githubDeviceFlow(
  options: { onPrompt?: (prompt: DeviceCodePrompt) => void; signal?: AbortSignal } = {},
): GithubAuthorizer {
  const onPrompt = options.onPrompt ?? ((prompt: DeviceCodePrompt) => console.log(`  ${deviceCodeMessage(prompt)}`));
  return { authorize: () => runDeviceFlow({ onPrompt, ...(options.signal ? { signal: options.signal } : {}) }) };
}
