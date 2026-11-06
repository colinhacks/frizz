/**
 * How a board is reached from outside, as one object both launchers drive.
 *
 * The saved setup (`cloud.json` in the data root, see `cloudConfigPath`) is the whole configuration: a plain `npx frizz` serves
 * whatever it says, and the R pane changes it on the running board. This controller owns the three
 * things that have to move together when it changes — the transport (a relay socket or a cloudflared
 * child, or nothing for a setup the operator runs), the public origin the supervisor gates, and the
 * file the next launch reads. Doing them here, in one order, is what makes "Off" actually off and a
 * switch from one setup to another leave no tunnel behind.
 */
import { homedir } from "node:os";
import {
  type CloudConfig,
  type CloudTransport,
  deleteCloudConfig,
  isClaimedConfig,
  isExternalConfig,
  isRelayConfig,
  readCloudConfig,
  readTunnelToken,
  reconcileCloudConfig,
  resolveRunToken,
  startRelay,
  startTunnel,
  writeCloudConfig,
} from "./cloud.ts";

export interface RemoteHost {
  /** Declare or clear the origin the gate keys on. */
  setPublicOrigin(origin: string | undefined): void;
  /** The port the relay agent dials instead of the board's own: everything on it is public. */
  relayListener(): Promise<number>;
}

export interface RemoteLog {
  info(scope: string, message: string): void;
  warn(scope: string, message: string): void;
  error(scope: string, message: string): void;
}

export interface RemoteControllerOptions {
  host: RemoteHost;
  port: number;
  log: RemoteLog;
  /** A line for the operator's terminal, for the warnings that must not only go to the log file. */
  say: (message: string) => void;
  home?: string;
  /** How often a served name renews its lease. Only a test sets this. */
  leaseRenewalMs?: number;
}

export interface RemoteController {
  /** The setup in force, or null while loopback-only. */
  current(): CloudConfig | null;
  /** `https://<hostname>` for the current setup, or undefined. */
  origin(): string | undefined;
  /** Serve the saved setup, if any. Called once at boot, after the supervisor listens. */
  serveSaved(): Promise<void>;
  /**
   * Switch to `next` (or to loopback-only with null): stop what is running, persist, start the new
   * transport, then declare the origin — in that order, so the origin is never declared for a name
   * nothing serves. `justClaimed` skips the renewal a fresh claim just performed.
   */
  apply(next: CloudConfig | null, options?: { justClaimed?: boolean }): Promise<void>;
  /** Stop the transport without touching the saved setup — shutdown. */
  stop(): void;
}

/**
 * A lease lasts 30 days. Until 2026-11-06 only a launch renewed one, so a launcher left running that
 * long lost its name to the registrar's daily sweep while still serving it, and anyone could claim it.
 */
const LEASE_RENEWAL_MS = 24 * 60 * 60_000;

export function createRemoteController(options: RemoteControllerOptions): RemoteController {
  const home = options.home ?? homedir();
  let config: CloudConfig | null = null;
  let transport: CloudTransport | null = null;
  let leaseRenewal: ReturnType<typeof setInterval> | null = null;

  const stopTransport = () => {
    if (leaseRenewal) clearInterval(leaseRenewal);
    leaseRenewal = null;
    transport?.stop();
    transport = null;
  };

  const keepLease = (next: CloudConfig) => {
    leaseRenewal = setInterval(() => {
      resolveRunToken(next, options.port, home).catch((error: unknown) => {
        const message = `could not renew ${next.hostname}, which lapses 30 days after its last renewal: ${error instanceof Error ? error.message : error}`;
        options.log.warn("cloud", message);
        options.say(message);
      });
    }, options.leaseRenewalMs ?? LEASE_RENEWAL_MS);
    leaseRenewal.unref();
  };

  const startTransport = async (next: CloudConfig, justClaimed: boolean): Promise<void> => {
    if (isExternalConfig(next)) return;
    if (isRelayConfig(next)) {
      // Renew the lease first. A relay name gets no run token back, but the call is what keeps the
      // claim alive — skip it and the name lapses after 30 days while the board is still serving it.
      if (!justClaimed) {
        await resolveRunToken(next, options.port, home, (message) => {
          options.log.warn("relay", message);
          options.say(message);
        });
      }
      transport = await startRelay(next, await options.host.relayListener(), home, (message) => options.log.info("relay", message));
      keepLease(next);
      options.log.info("relay", `serving ${next.hostname} through the Frizz relay`);
      return;
    }
    // The tunnel is a CHILD of this launcher, so the two halves share a lifetime. A tunnel outliving
    // its board serves Cloudflare 1033; a board outliving its tunnel is unreachable with nothing to
    // say why.
    const runToken = isClaimedConfig(next)
      ? justClaimed
        ? readTunnelToken(home)
        : await resolveRunToken(next, options.port, home, (message) => {
            options.log.warn("tunnel", message);
            options.say(message);
          })
      : null;
    transport = startTunnel(
      next,
      (code) => {
        if (code === 0 || code === null) return;
        options.log.error("tunnel", `cloudflared exited with code ${code}; the public hostname is now unreachable`);
      },
      (message) => {
        options.log.error("tunnel", message);
        options.say(message);
      },
      home,
      runToken ?? undefined,
    );
    if (isClaimedConfig(next)) keepLease(next);
    options.log.info("tunnel", `running cloudflared for ${next.hostname}`);
  };

  const originOf = (next: CloudConfig | null) => (next ? `https://${next.hostname}` : undefined);

  return {
    current: () => config,
    origin: () => originOf(config),
    async serveSaved() {
      const saved = readCloudConfig(home);
      if (!saved) return;
      // A saved name inside the zone that is not yet a relay claim is claimed now (see
      // reconcileCloudConfig); that counts as a fresh claim, so the lease is not renewed twice.
      const reconciled = await reconcileCloudConfig(saved, options.port, home, (message) => {
        options.log.warn("cloud", message);
        options.say(message);
      });
      const justClaimed = reconciled !== saved;
      if (justClaimed) writeCloudConfig(reconciled, home);
      await startTransport(reconciled, justClaimed);
      config = reconciled;
      options.host.setPublicOrigin(originOf(reconciled));
    },
    async apply(next, applyOptions = {}) {
      stopTransport();
      // Declare nothing while the switch is in progress: a request judged between the old transport
      // dying and the new one answering would be gated for a name with nothing behind it.
      options.host.setPublicOrigin(undefined);
      if (!next) {
        deleteCloudConfig(home);
        config = null;
        return;
      }
      writeCloudConfig(next, home);
      try {
        await startTransport(next, applyOptions.justClaimed ?? false);
      } catch (error) {
        // The file already says `next`, and the next launch will retry it; but THIS board must not
        // claim an origin it failed to bring up.
        config = null;
        throw error;
      }
      config = next;
      options.host.setPublicOrigin(originOf(next));
    },
    stop: stopTransport,
  };
}
