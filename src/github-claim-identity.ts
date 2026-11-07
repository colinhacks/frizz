import { claimNameIsValid, isAnonymousClaimName } from "@frizz/shared";
import { GithubCredentialError, githubClaimToken, githubCredentialStatus } from "@frizz/server/github-credential";

/**
 * The GitHub identity behind a custom-name claim: Frizz's own GitHub sign-in, the one the board holds
 * for its GitHub reads (Settings → GitHub; packages/server/src/github-credential.ts). A board signed in
 * there needs nothing more to claim `<name>.frizz.sh`: no second app, no device code, no `gh`.
 *
 * WHY A TOKEN AND NOT JUST A USERNAME. Reading a username locally proves nothing — the CLI could send
 * any string, so a loop could claim a name per invented account and the limit would mean exactly
 * nothing. The registrar has to check with GitHub itself, and a token is what lets it.
 *
 * WHICH TOKEN. Until 2026-10-08 the claim sent whatever `gh auth token` printed, which can push to every
 * repository its owner can, and a compromised registrar collected those tokens (2026-09-21 to
 * 2026-10-08). From then until 2026-11-07 a claim was to carry a zero-scope token from a separate OAuth
 * App's device flow, an app that was never registered, so custom names stayed withdrawn. The maintainer
 * dropped that rule on 2026-11-07: the registrar deploys from the same workflow, with the same token and
 * the same approval, as the relay, and a hijacked relay already has full control of every board serving
 * through it. So the claim sends the user token of Frizz's GitHub App, whose permissions are all
 * read-only. It is never the `gh` CLI's, which the registrar still refuses.
 *
 * The token is sent ONCE, at the first claim. The registrar exchanges it for a numeric user id, keeps
 * the id, and drops the token; renewals afterwards carry no token at all, because the keypair already
 * proves ownership. Nothing here stores or prints it.
 */

export interface GithubAuthorization {
  /** Never logged, never stored here; it rides one claim and is dropped. */
  token: string;
  /** Who signed in, for the "claiming X for GitHub user Y" line. Null when the sign-in did not say. */
  login: string | null;
}

/** The one question a claim asks of GitHub, behind a seam a test can stand in for. */
export interface GithubAuthorizer {
  authorize(): Promise<GithubAuthorization>;
}

/** The authorizer every real claim uses: Frizz's own GitHub sign-in, read from disk at claim time. */
export function frizzGithubSignIn(): GithubAuthorizer {
  return {
    authorize: async () => {
      try {
        return await githubClaimToken();
      } catch (error) {
        if (error instanceof GithubCredentialError) {
          throw new Error(`a custom frizz.sh subdomain is tied to your GitHub account through Frizz's GitHub sign-in. ${error.message}`);
        }
        throw error;
      }
    },
  };
}

/** The GitHub login of Frizz's sign-in, or null while it is signed out. Local, no network. */
export function frizzGithubLogin(): string | null {
  const status = githubCredentialStatus();
  return status.signedIn ? status.login : null;
}

/**
 * That login as a frizz.sh name, when it makes one: lowercased, and null where it is not a usable name
 * (too short, reserved) or has the random-name shape, which would claim with no account at all.
 */
export function claimNameForLogin(login: string | null): string | null {
  if (!login) return null;
  const name = login.toLowerCase();
  return claimNameIsValid(name) && !isAnonymousClaimName(name) ? name : null;
}
