/** The one line a remote session gets in place of a prompt box: see useRemoteHost. */
export function RemoteNote({ remoteHost }: { remoteHost: string }) {
  return <p data-remote-note className="min-w-0 text-[13px] text-muted">Starting or steering a thread happens on {remoteHost}.</p>
}
