import type { AccessLink } from "./access-pane.ts";
import { type CloudConfig, establishCloudConfig } from "./cloud.ts";
import { frizzGithubLogin, frizzGithubSignIn } from "./github-claim-identity.ts";
import type { Pane } from "./pane-host.ts";
import type { RemoteController } from "./remote-controller.ts";
import { probeCloudflared, probeTailscale } from "./remote-detect.ts";
import { createRemotePane } from "./remote-pane.ts";
import { createRemoteSetupClient } from "./remote-setup-client.ts";

/** What the R menu needs of the supervisor: sign-in links and the devices signed in. */
export interface RemoteMenuSupervisor {
  issueAccessLink(): AccessLink | null;
  signedInDeviceList(): Array<{ id: string; label: string; createdAt: number }>;
  signOutDevice(id: string): boolean;
  signOutAllDevices(): number;
  forgetSessionsFor(hostname: string): unknown;
}

export interface RemoteMenuOptions {
  port: number;
  /** The owner token the server's control routes take. */
  token: string | undefined;
  sandbox: boolean;
  supervisor: RemoteMenuSupervisor;
  remote: () => RemoteController | null | undefined;
  onChanged?: (config: CloudConfig | null) => void;
  onClosedAfterChange?: (config: CloudConfig | null) => void;
  onOpened?: (by: "server" | "shell", why?: string) => void;
}

/**
 * The pane R opens, for both launchers: the server's menu (remote-setup-client.ts), or this shell's own
 * (remote-pane.ts) when the server does not draw one. Both act through the same remote controller and
 * supervisor, so a change made in either is the same change.
 */
export function createRemoteMenu(options: RemoteMenuOptions): Pane {
  const { port, supervisor } = options;
  const remote = () => {
    const controller = options.remote();
    if (!controller) throw new Error("remote access is not running yet");
    return controller;
  };
  const current = () => options.remote()?.current() ?? null;
  return createRemoteSetupClient({
    port,
    token: options.token,
    sandbox: options.sandbox,
    acts: {
      current,
      devices: () => supervisor.signedInDeviceList(),
      apply: (next, applyOptions) => remote().apply(next, applyOptions),
      setRelayAccess: (access) => remote().setRelayAccess(access),
      issueLink: () => supervisor.issueAccessLink(),
      signOut: (id) => supervisor.signOutDevice(id),
      signOutAll: () => supervisor.signOutAllDevices(),
      forgetSessionsFor: (hostname) => void supervisor.forgetSessionsFor(hostname),
    },
    // Frozen: what R showed before the server drew it, kept for a server that does not.
    fallback: () =>
      createRemotePane({
        port,
        current,
        apply: (next, applyOptions) => remote().apply(next, applyOptions),
        setRelayAccess: (access) => remote().setRelayAccess(access),
        claim: (name, progress) =>
          establishCloudConfig(name, port, undefined, undefined, frizzGithubSignIn(), {
            say: progress,
            promptHint: false,
            // A name claimed afresh signs out what was signed in under it before (cloud.ts, onFreshClaim).
            onFreshClaim: (hostname) => void supervisor.forgetSessionsFor(hostname),
          }),
        githubLogin: frizzGithubLogin,
        issueLink: () => supervisor.issueAccessLink(),
        devices: { list: () => supervisor.signedInDeviceList(), signOut: (id) => supervisor.signOutDevice(id), signOutAll: () => supervisor.signOutAllDevices() },
        probes: { cloudflared: probeCloudflared, tailscale: probeTailscale },
        ...(options.onChanged ? { onChanged: options.onChanged } : {}),
        ...(options.onClosedAfterChange ? { onClosedAfterChange: options.onClosedAfterChange } : {}),
        sandbox: options.sandbox,
      }),
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    ...(options.onClosedAfterChange ? { onClosedAfterChange: options.onClosedAfterChange } : {}),
    ...(options.onOpened ? { onOpened: options.onOpened } : {}),
  });
}
