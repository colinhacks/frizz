import { execFileSync } from "node:child_process"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { frizzRoots } from "./frizz-paths.ts"

// THE ENCRYPTION AROUND FRIZZ'S GITHUB CREDENTIAL (github-credential.ts). Maintainer, 2026-11-05: a
// file on disk, but encrypted, with a random key per machine in the keychain.
//
// WHAT IT STOPS: a scanner looking for token patterns, a worker opening the file by accident, and a
// copy of the file or a backup leaving the machine, since the file alone cannot be decrypted.
// WHAT IT DOES NOT STOP: a program running as this user that goes after Frizz on purpose. A keychain
// item saved by `/usr/bin/security` can be read back by any process that runs `security` (checked on a
// dummy item), and macOS cannot tell Frizz's Node process from another. Never describe this as "only
// Frizz can read it".
//
// A key baked into Frizz was rejected: Frizz is open source, so everyone would hold it.
//
// THE KEYCHAIN IS NAMED BY ITS PATH, NEVER LEFT TO `security`'S DEFAULT. Under a temp HOME the default
// lookup fails with the SAME exit 44 as a missing item, and saving there raises the "Keychain Not
// Found" dialog (AGENTS.md). So a machine whose HOME has no keychain file uses the file key below and
// never runs `security` at all. A sandbox that shares the real credential names the real keychain in
// FRIZZ_GITHUB_KEYCHAIN.
//
// WHERE THERE IS NO KEYCHAIN (Linux, Windows, a temp HOME) the key is a 0600 file in Frizz's state root,
// away from the credential's own folder. A copy of that folder alone stays useless; a copy of the whole
// home does not, which makes this much the weaker of the two.

const SERVICE = "Frizz GitHub credential key"
const ACCOUNT = "frizz"
const ALGORITHM = "aes-256-gcm"
const AAD = Buffer.from("frizz-github-credential:v1")
const SECURITY_TIMEOUT_MS = 5_000
/** A failed keychain read is retried this often, not on every status check. */
const RETRY_MS = 60_000
/** `security`'s exit status for an item that is not there. */
const NOT_FOUND = 44

export class GithubCredentialSealError extends Error {}

/** One `security` run. A test swaps it, so no test can reach the real keychain. */
export type SecurityRunner = (args: string[], stdin?: string) => { status: number; stdout: string }

const realSecurity: SecurityRunner = (args, stdin) => {
  try {
    const stdout = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      timeout: SECURITY_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      ...(stdin === undefined ? {} : { input: stdin }),
    })
    return { status: 0, stdout }
  } catch (error) {
    const status = (error as { status?: unknown }).status
    return { status: typeof status === "number" ? status : -1, stdout: "" }
  }
}

let security: SecurityRunner = realSecurity
let heldKey: Buffer | undefined
let failure: { at: number; message: string } | undefined
let lastReloadAt = 0

/** Test-only: replace `security`, or restore the real one with no argument. */
export function setGithubCredentialSecurityForTest(runner?: SecurityRunner): void {
  security = runner ?? realSecurity
}

/** Test-only, and the sign-out path of a test: forget the key this process holds. */
export function resetGithubCredentialSeal(): void {
  heldKey = undefined
  failure = undefined
  lastReloadAt = 0
}

/** The keychain to use, or null where there is none. Only ever a file that exists. */
export function githubCredentialKeychainPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") return null
  const named = env.FRIZZ_GITHUB_KEYCHAIN?.trim()
  const path = named || join(homedir(), "Library", "Keychains", "login.keychain-db")
  return existsSync(path) ? path : null
}

export function githubCredentialKeyFilePath(): string {
  return join(frizzRoots().state, "github-credential.key")
}

function parseKey(text: string): Buffer | null {
  const hex = text.trim()
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null
}

function readKeychainKey(keychain: string): Buffer | null {
  const { status, stdout } = security(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", keychain])
  if (status === NOT_FOUND) return null
  const key = status === 0 ? parseKey(stdout) : null
  if (!key) throw new GithubCredentialSealError("Frizz could not read its key from the keychain.")
  return key
}

function keychainKey(keychain: string, create: boolean): Buffer {
  const found = readKeychainKey(keychain)
  if (found) return found
  if (!create) throw new GithubCredentialSealError("Its key is missing from the keychain.")
  // Over stdin, because a command line is readable by every process on the machine.
  const added = security(["-i"], `add-generic-password -a "${ACCOUNT}" -s "${SERVICE}" -w ${randomBytes(32).toString("hex")} "${keychain}"\n`)
  // Read back rather than trust what was generated: another process may have saved one first.
  const stored = added.status === 0 ? readKeychainKey(keychain) : null
  if (!stored) throw new GithubCredentialSealError("Frizz could not save its key to the keychain.")
  return stored
}

function fileKey(create: boolean): Buffer {
  const path = githubCredentialKeyFilePath()
  if (create && !existsSync(path)) {
    mkdirSync(frizzRoots().state, { recursive: true })
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new GithubCredentialSealError("Its key is missing.")
  }
  const key = parseKey(text)
  if (!key) throw new GithubCredentialSealError("Its key is damaged.")
  return key
}

function sealKey(create: boolean): Buffer {
  if (heldKey) return heldKey
  if (!create && failure && Date.now() - failure.at < RETRY_MS) throw new GithubCredentialSealError(failure.message)
  try {
    const keychain = githubCredentialKeychainPath()
    heldKey = keychain ? keychainKey(keychain, create) : fileKey(create)
    failure = undefined
    return heldKey
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failure = { at: Date.now(), message }
    throw error instanceof GithubCredentialSealError ? error : new GithubCredentialSealError(message)
  }
}

/** The file's contents for a credential. Creates this machine's key the first time. */
export function sealGithubCredential(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, sealKey(true), iv)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })
}

function decrypt(key: Buffer, sealed: { iv: string; tag: string; data: string }): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"))
  decipher.setAAD(AAD)
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8")
}

/** The credential's JSON. NEVER creates a key: a missing key must read as a problem to report, or the
 *  next write would replace the only key this file can be opened with. */
export function openGithubCredential(fileText: string): string {
  let sealed: { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown }
  try {
    sealed = JSON.parse(fileText)
  } catch {
    throw new GithubCredentialSealError("The stored file is damaged.")
  }
  if (sealed?.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.tag !== "string" || typeof sealed.data !== "string") {
    throw new GithubCredentialSealError("The stored file is damaged.")
  }
  const parts = { iv: sealed.iv, tag: sealed.tag, data: sealed.data }
  const held = heldKey
  try {
    return decrypt(sealKey(false), parts)
  } catch (error) {
    if (error instanceof GithubCredentialSealError) throw error
    // A held key may be stale if another process sharing this folder saved a new one. Look once a minute.
    if (held && Date.now() - lastReloadAt >= RETRY_MS) {
      lastReloadAt = Date.now()
      heldKey = undefined
      try {
        return decrypt(sealKey(false), parts)
      } catch (retry) {
        if (retry instanceof GithubCredentialSealError) throw retry
      }
    }
    throw new GithubCredentialSealError("It can't be decrypted on this machine.")
  }
}
