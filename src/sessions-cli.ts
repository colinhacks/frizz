import { SUPERVISOR_SESSIONS_PATH } from "@frizz/server/restart-supervisor";
import { signedInAgo, type SessionRecord } from "@frizz/server/access-codes";

/**
 * `--sessions` and `--sign-out`, for whichever launcher is asking.
 *
 * Shared by BOTH launchers on purpose. `src/index.ts` (frizz-dev) and `src/production.ts` (npx frizz)
 * are separate programs, and every user-facing thing added to one and not the other has shipped broken
 * at least once here — `--cloud` did exactly that. One implementation, two call sites.
 *
 * Talks to the ALREADY-RUNNING board over loopback, the way `--link` does, because that is where the
 * session directory lives. The endpoint refuses anything that did not arrive on loopback, so a stolen
 * session cannot sign the real owner out.
 */

async function call(port: number, init?: RequestInit): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}${SUPERVISOR_SESSIONS_PATH}`, {
    ...init,
    headers: { origin: `http://127.0.0.1:${port}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  }).catch(() => undefined);
  if (!response) {
    console.error("frizz: the running board did not answer");
    process.exit(1);
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!response.ok) {
    console.error(`frizz: ${(body?.error as string) ?? `the board answered ${response.status}`}`);
    process.exit(1);
  }
  return body;
}

export async function listSessions(port: number): Promise<never> {
  const body = await call(port);
  const sessions = (body?.sessions ?? []) as SessionRecord[];
  // A record past its own expiry cannot sign in any more, so listing it would invite a pointless
  // --sign-out. Records written before 2026-10-08 carry no expiry and stay listed until signed out.
  const now = Date.now();
  const live = sessions.filter((s) => s.revokedAt === undefined && (s.expiresAt === undefined || s.expiresAt > now));
  if (live.length === 0) {
    console.log("No device is signed in.");
    process.exit(0);
  }
  // The id is what the operator types back into --sign-out, so it leads.
  const width = Math.max(...live.map((s) => s.id.length));
  for (const session of live) {
    console.log(`  ${session.id.padEnd(width)}  ${session.label}  ${signedInAgo(session.createdAt)}`);
  }
  console.log(`\n  frizz --sign-out <id>   sign one out\n  frizz --sign-out all    sign every device out`);
  process.exit(0);
}

export async function signOutSession(port: number, target: string): Promise<never> {
  const all = target === "all";
  const body = await call(port, {
    method: "POST",
    body: JSON.stringify(all ? { all: true } : { id: target }),
  });
  const count = Number(body?.signedOut ?? 0);
  if (all) {
    console.log(count === 0 ? "No device was signed in." : `Signed out ${count} device${count === 1 ? "" : "s"}.`);
  } else {
    console.log(`Signed out ${target}.`);
  }
  process.exit(0);
}
