/**
 * What the R pane can find out about this machine before it asks anything.
 *
 * Each probe is best-effort and bounded: a missing binary, a signed-out CLI or a hung daemon must
 * turn into a line on the screen ("cloudflared: not found"), never a pane that does not open. Nothing
 * here is trusted for anything but display — a tunnel that is not really there fails where it fails
 * today, at launch. There is no GitHub probe: a custom-name claim uses Frizz's own GitHub sign-in
 * (github-claim-identity.ts) and never reads the `gh` CLI.
 */
import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 4_000;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

export interface CloudflaredProbe {
  /** The version string cloudflared printed, or null when it is not on PATH. */
  version: string | null;
}

export async function probeCloudflared(): Promise<CloudflaredProbe> {
  const out = await run("cloudflared", ["--version"]);
  // "cloudflared version 2025.8.1 (built …)" — keep the number, drop the rest.
  const version = out?.match(/\d+\.\d+\.\d+/)?.[0] ?? (out ? out.trim() : null);
  return { version };
}

export interface TailscaleProbe {
  installed: boolean;
  /** This machine's MagicDNS name, e.g. `mac-mini.corgi-alpha.ts.net`, when the daemon answers. */
  dnsName: string | null;
}

export async function probeTailscale(): Promise<TailscaleProbe> {
  const out = await run("tailscale", ["status", "--json"]);
  if (out === null) return { installed: (await run("tailscale", ["--version"])) !== null, dnsName: null };
  try {
    const status = JSON.parse(out) as { Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "") || null;
    return { installed: true, dnsName };
  } catch {
    return { installed: true, dnsName: null };
  }
}
