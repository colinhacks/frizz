// What a remote caller is told when it asks for something only the machine itself may do. Apart from the
// gate (remote-gate.ts) because the launcher's proxy refuses too, and the proxy ships in the launcher's
// bundle, which has no business carrying the application server's router types.

/** The stable code on every refusal, so a client can tell "not from here" from "this failed". */
export const REMOTE_REFUSED_CODE = "remote_refused"

/** The machine Frizz runs on, as a remote visitor would name it. */
export function remoteHostLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "the Mac" : "the computer running Frizz"
}

export function remoteRefusedMessage(): string {
  return `This can only be done on ${remoteHostLabel()}.`
}
