import { isAnonymousClaimName } from "@frizz/shared";
import { qrAreaOf, renderQrLines } from "@frizz/server/qr";
import type { AccessLink } from "./access-pane.ts";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, DIM, fitScreen, HIDE_CURSOR, type OptionalLine, RESET, SHOW_CURSOR } from "./access-pane.ts";
import { type CloudConfig, customNamesOffered, describeCloudConfig, isClaimedConfig, isExternalConfig, normalizeHostname } from "./cloud.ts";
import type { Pane } from "./pane-host.ts";
import type { DeviceCodePrompt } from "./github-device-flow.ts";
import type { CloudflaredProbe, TailscaleProbe } from "./remote-detect.ts";

/**
 * "Press R to reach this board from a phone or another machine" — the whole remote-access setup, in
 * the terminal that is already running the board, remembered on disk.
 *
 * Why here and not in flags: the choice is made once, and it is a walkthrough, not a switch. Each
 * setup has a prerequisite (a tunnel created in another terminal, a Tailscale daemon) that a flag
 * can only fail on, while a screen can check it, print the commands, and ask for
 * exactly the one or two values Frizz cannot find out for itself. What it saves is served by every
 * later plain launch; "Off" clears it.
 *
 * The pane is a small state machine over a handful of screens, rendered whole on every change. Keys
 * arrive raw from the pane host: printable characters go into the focused field, arrows move, enter
 * advances or submits, escape goes back, and while a change is being applied nothing but ^C (the
 * host's) is heard.
 */

export type RemoteKind = "private" | "frizz" | "cloudflare" | "tailscale" | "other" | "off";

export interface RemotePaneOptions {
  port: number;
  current: () => CloudConfig | null;
  /** Switch the running board to `next`, or to loopback-only with null. Rejects with a message. */
  apply: (next: CloudConfig | null, options?: { justClaimed?: boolean }) => Promise<void>;
  /**
   * Claim `<name>.frizz.sh`. An empty name mints a private unguessable one with no account; a word
   * claims that word for a GitHub account, confirmed through a device code the pane shows via
   * `signIn.onDeviceCode`. Escape on that screen aborts `signIn.signal`. Rejects with a message. The
   * pane asks for a word only while custom names are offered (CUSTOM_NAMES_OFFERED in cloud.ts).
   */
  claim: (name: string, signIn: ClaimSignIn) => Promise<CloudConfig>;
  /** A fresh single-use link for the origin now in force, for the done screen. */
  issueLink: () => AccessLink | null;
  probes: {
    cloudflared: () => Promise<CloudflaredProbe>;
    tailscale: () => Promise<TailscaleProbe>;
  };
  /** Told after a successful change, so the readout can say what the board is now reached at. */
  onChanged?: (config: CloudConfig | null) => void;
  /** Running under --sandbox: everything is throwaway EXCEPT a claim, which the frizz.sh screen must say. */
  sandbox?: boolean;
  output?: NodeJS.WriteStream;
}

/** How a word claim shows its GitHub device code, and how the person backs out of it. */
export interface ClaimSignIn {
  onDeviceCode: (prompt: DeviceCodePrompt) => void;
  signal: AbortSignal;
}

interface Choice {
  kind: RemoteKind;
  title: string;
  blurb: string;
}

/** Every setup, in menu order. The menu shows the subset `choicesFor` picks, never this list directly. */
const CHOICES: Choice[] = [
  { kind: "private", title: "frizz.sh subdomain", blurb: "a private, unguessable address; no account, nothing to install" },
  { kind: "frizz", title: "Custom subdomain", blurb: "<name>.frizz.sh of your choosing; needs a GitHub account" },
  { kind: "cloudflare", title: "Cloudflare Tunnel", blurb: "a domain you own on Cloudflare; cloudflared on this machine" },
  { kind: "tailscale", title: "Tailscale", blurb: "your tailnet; tailscale serve does the TLS" },
  { kind: "other", title: "Something else", blurb: "any proxy or tunnel you run — tell Frizz its address" },
  { kind: "off", title: "Off", blurb: "loopback only" },
];

/**
 * The rows the menu lists for a board whose setup is `current`.
 *
 * "Custom subdomain" is withdrawn while custom names are paused (CUSTOM_NAMES_OFFERED in cloud.ts) — except
 * on a board ALREADY served by a custom claim, which keeps the row so the menu still marks what is
 * current. Choosing that row then serves the saved name again, renewed by the keypair alone; it never
 * opens the claim form, because a new custom claim is exactly what is paused.
 */
function choicesFor(current: CloudConfig | null): Choice[] {
  if (customNamesOffered()) return CHOICES;
  if (kindOf(current) === "frizz") {
    return CHOICES.map((choice) =>
      choice.kind === "frizz" ? { ...choice, blurb: `${current!.hostname} — kept and renewed; new custom subdomains are paused` } : choice,
    );
  }
  return CHOICES.filter((choice) => choice.kind !== "frizz");
}

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\x7f", "\b"]);
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

type Screen =
  | { name: "menu"; index: number }
  | { name: "form"; kind: FormKind; fields: Field[]; focus: number; note?: string }
  /** `cancel` makes escape back out — only while waiting on something the person can abandon. */
  | { name: "busy"; message: string; detail?: string[]; cancel?: () => void }
  | { name: "done"; message: string; link: AccessLink | null; config: CloudConfig | null }
  | { name: "error"; message: string; back: Screen };

interface Field {
  label: string;
  value: string;
  /** Shown dim inside an empty field; enter accepts it. */
  placeholder?: string;
}

/** The setups that ask for anything. "off" clears and "private" claims — neither has a form. */
type FormKind = Exclude<RemoteKind, "off" | "private">;

function kindOf(config: CloudConfig | null): RemoteKind {
  if (!config) return "off";
  if (isClaimedConfig(config)) return isAnonymousClaimName(config.claim!) ? "private" : "frizz";
  if (isExternalConfig(config)) return config.provider === "tailscale" ? "tailscale" : "other";
  return "cloudflare";
}

function wrap(text: string, width = 74): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export function createRemotePane(options: RemotePaneOptions): Pane {
  const output = options.output ?? process.stdout;
  let open = false;
  let screen: Screen = { name: "menu", index: 0 };
  // Probe results arrive after the screen opens; a repaint shows them the moment they do.
  let cloudflared: CloudflaredProbe | "pending" | null = null;
  let tailscale: TailscaleProbe | "pending" | null = null;

  // Every screen is indented two columns under a blank top line, and never scrolls (see fitScreen):
  // the top line is the first thing a short window drops.
  const write = (lines: Array<string | OptionalLine>) => {
    if (!open) return;
    output.write(CLEAR);
    const indented = lines.map((line) => (typeof line === "string" ? `  ${line}` : { ...line, text: `  ${line.text}` }));
    output.write(fitScreen([{ text: "", drop: 0 }, ...indented], output.rows, output.columns));
  };

  const check = (ok: boolean, text: string) => (ok ? `${text} ✓` : text);
  // Read on every use: the current setup moves under the pane, and the custom row follows it.
  const choices = () => choicesFor(options.current());
  /** The row for `kind`, or the first row when the menu does not list it. */
  const rowOf = (kind: RemoteKind) => Math.max(0, choices().findIndex((choice) => choice.kind === kind));

  const paint = () => {
    if (!open) return;
    const s = screen;
    if (s.name === "menu") {
      const current = kindOf(options.current());
      write([
        "Reach this board from anywhere",
        "",
        ...wrap(
          "Frizz binds 127.0.0.1 and has no login. Reaching it from another device means something in front of it does the authenticating. Whatever you pick here is remembered; from then on a plain `npx frizz` serves it.",
        ),
        "",
        ...choices().map((choice, index) => {
          const marker = index === s.index ? "❯" : " ";
          const title = choice.title.padEnd(20);
          const now = choice.kind === current ? `  ${DIM}(current)${RESET}` : "";
          return `${marker} ${title}${DIM}${choice.blurb}${RESET}${now}`;
        }),
        "",
        `${DIM}↑↓ move · enter choose · esc back${RESET}`,
      ]);
      return;
    }
    if (s.name === "form") {
      const head = formHead(s.kind);
      const fields = s.fields.map((field, index) => {
        const focused = index === s.focus;
        const shown = field.value || (field.placeholder ? `${DIM}${field.placeholder}${RESET}` : "");
        const cursor = focused ? "█" : "";
        return `${field.label.padEnd(10)} ${shown}${cursor}`;
      });
      write([...head, "", ...fields, ...(s.note ? ["", s.note] : []), "", `${DIM}enter ${s.kind === "frizz" ? "claim" : "save"} · tab next field · esc back${RESET}`]);
      return;
    }
    if (s.name === "busy") {
      if (s.detail) {
        write([s.message, "", ...s.detail, "", `${DIM}waiting for GitHub… · esc cancel${RESET}`]);
        return;
      }
      write([s.message, "", `${DIM}working…${RESET}`]);
      return;
    }
    if (s.name === "done") {
      if (!s.link) {
        write([s.message, "", `${DIM}press any key to return${RESET}`]);
        return;
      }
      const note = `${DIM}Scan to sign in on a phone. Single use, expires in 5 minutes. Press L later for another.${RESET}`;
      // The code gets the window minus the message, the URL and the way back, the one blank below it,
      // and the indent. A terminal that does not draw block elements itself gets the glyph-free code
      // when that fits (see qr.ts). A shorter window then sheds the blank lines and the note before
      // the code can scroll (see fitScreen).
      const width = output.columns ?? 80;
      const wrapped = (text: string) => Math.max(1, Math.ceil((text.length + 2) / width));
      const qr = renderQrLines(s.link.url, { area: qrAreaOf(output, { indent: 2, rows: wrapped(s.message) + 1 + wrapped(s.link.url) + 1 }) });
      write([
        s.message,
        { text: "", drop: 4 },
        ...qr,
        { text: "", drop: 6 },
        s.link.url,
        { text: "", drop: 2 },
        { text: note, drop: 5 },
        { text: "", drop: 3 },
        `${DIM}press any key to return${RESET}`,
      ]);
      return;
    }
    write([`Could not apply that: ${s.message}`, "", `${DIM}press any key to go back${RESET}`]);
  };

  const formHead = (kind: FormKind): string[] => {
    if (kind === "frizz") {
      return [
        "Custom frizz.sh subdomain",
        "",
        ...wrap(
          "Claims <name>.frizz.sh of your choosing, tied to your GitHub account so names cannot be squatted. The board dials out to frizz.sh — no port, no DNS record, no tunnel binary. One name per account; a name nobody runs for 30 days is released. (A private subdomain needs none of this.)",
        ),
        ...(options.sandbox
          ? ["", ...wrap("This is a sandbox, but a claim is real: it binds this machine's one name to your account, and your real board keeps it. Only the setup saved here is thrown away.")]
          : []),
        "",
        ...wrap(
          "When you claim, Frizz shows a code to enter at github.com/login/device. The sign-in grants Frizz no permissions: it only tells the registrar which account you are.",
        ),
      ];
    }
    if (kind === "cloudflare") {
      const cf = cloudflared === "pending" || cloudflared === null
        ? `${DIM}cloudflared   checking…${RESET}`
        : cloudflared.version
          ? check(true, `cloudflared   found, ${cloudflared.version}`)
          : "cloudflared   not found — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
      return [
        "Cloudflare Tunnel",
        "",
        "Needs a domain on Cloudflare and cloudflared on this machine.",
        cf,
        "",
        "Create the tunnel and its DNS record once, in another terminal:",
        "",
        "  cloudflared tunnel login",
        "  cloudflared tunnel create my-board",
        "  cloudflared tunnel route dns my-board board.example.com",
        "",
        ...wrap(
          `Point it at this board in ~/.cloudflared/frizz.yml (ingress to http://127.0.0.1:${options.port}; https://frizz.sh/docs/cloudflare-tunnel has the file), then name them here. Frizz runs the tunnel beside the board, so the two share a lifetime.`,
        ),
      ];
    }
    if (kind === "tailscale") {
      const ts = tailscale === "pending" || tailscale === null
        ? `${DIM}tailscale   checking…${RESET}`
        : !tailscale.installed
          ? "tailscale   not found — install it from https://tailscale.com/download"
          : tailscale.dnsName
            ? check(true, `tailscale   found, this machine is ${tailscale.dnsName}`)
            : "tailscale   found, but the daemon did not answer — is it signed in?";
      return [
        "Tailscale",
        "",
        ...wrap("Serves the board on your tailnet. Tailscale terminates TLS and only devices signed into the tailnet can reach the name."),
        ts,
        "",
        "Run once, in another terminal:",
        "",
        `  tailscale serve --bg ${options.port}`,
        "",
        "Tailscale answers at the address below — that is the origin Frizz accepts.",
      ];
    }
    return [
      "Something else",
      "",
      ...wrap(
        `Terminate TLS wherever you like, proxy to http://127.0.0.1:${options.port}, and give Frizz the exact origin a browser will show — scheme and host, no path. Frizz answers only to that Host and prints a single-use sign-in link.`,
      ),
    ];
  };

  const openForm = (kind: FormKind) => {
    const current = options.current();
    const same = kindOf(current) === kind ? current : null;
    let fields: Field[];
    if (kind === "frizz") {
      fields = [{ label: "Name", value: same?.claim ?? "" }];
    } else if (kind === "cloudflare") {
      cloudflared = "pending";
      void options.probes.cloudflared().then((result) => {
        cloudflared = result;
        paint();
      });
      fields = [
        { label: "Hostname", value: same?.hostname ?? "", placeholder: "board.example.com" },
        { label: "Tunnel", value: same?.tunnel ?? "", placeholder: "my-board" },
      ];
    } else if (kind === "tailscale") {
      tailscale = "pending";
      void options.probes.tailscale().then((result) => {
        tailscale = result;
        if (screen.name === "form" && screen.kind === "tailscale" && !screen.fields[0]!.value && result.dnsName) {
          screen.fields[0]!.placeholder = `https://${result.dnsName}`;
        }
        paint();
      });
      fields = [{ label: "Origin", value: same ? `https://${same.hostname}` : "", placeholder: "https://mac-mini.your-tailnet.ts.net" }];
    } else {
      fields = [{ label: "Origin", value: same ? `https://${same.hostname}` : "", placeholder: "https://board.example.com" }];
    }
    screen = { name: "form", kind, fields, focus: 0 };
    paint();
  };

  const valueOf = (field: Field): string => field.value || field.placeholder || "";

  const submit = async (form: Extract<Screen, { name: "form" }>) => {
    const back: Screen = form;
    try {
      let next: CloudConfig | null;
      let justClaimed = false;
      if (form.kind === "frizz") {
        const name = valueOf(form.fields[0]!).trim();
        if (!name) throw new Error("a name is needed");
        screen = { name: "busy", message: `claiming ${name}.frizz.sh…` };
        paint();
        const abort = new AbortController();
        next = await options.claim(name, {
          signal: abort.signal,
          onDeviceCode: (prompt) => {
            screen = {
              name: "busy",
              message: `Confirm your GitHub account to claim ${name}.frizz.sh`,
              detail: [
                `Open      ${prompt.verificationUri}`,
                `Enter     ${prompt.userCode}`,
                "",
                ...wrap("on this or any other device. Frizz asks GitHub for no permissions; the sign-in only names your account to the registrar."),
              ],
              cancel: () => abort.abort(),
            };
            paint();
          },
        });
        justClaimed = true;
      } else if (form.kind === "cloudflare") {
        const hostname = normalizeHostname(valueOf(form.fields[0]!));
        const tunnel = valueOf(form.fields[1]!).trim();
        if (!tunnel) throw new Error("the tunnel's name is needed");
        next = { hostname, tunnel };
      } else {
        const hostname = normalizeHostname(valueOf(form.fields[0]!));
        next = { hostname, serve: "external", provider: form.kind === "tailscale" ? "tailscale" : "other" };
      }
      screen = { name: "busy", message: `serving ${next.hostname}…` };
      paint();
      await options.apply(next, { justClaimed });
      options.onChanged?.(next);
      screen = { name: "done", message: `Serving https://${next.hostname} (${describeCloudConfig(next)}).`, link: options.issueLink(), config: next };
    } catch (error) {
      screen = { name: "error", message: error instanceof Error ? error.message : String(error), back };
    }
    paint();
  };

  // No form and nothing to ask: the name is minted, so choosing this IS the claim.
  const claimPrivate = async () => {
    const back: Screen = { name: "menu", index: 0 };
    screen = { name: "busy", message: "claiming a private frizz.sh subdomain…" };
    paint();
    try {
      // A private subdomain has no GitHub step, so nothing is ever shown and nothing can be cancelled.
      const next = await options.claim("", { signal: new AbortController().signal, onDeviceCode: () => {} });
      screen = { name: "busy", message: `serving ${next.hostname}…` };
      paint();
      await options.apply(next, { justClaimed: true });
      options.onChanged?.(next);
      screen = { name: "done", message: `Serving https://${next.hostname} (${describeCloudConfig(next)}).`, link: options.issueLink(), config: next };
    } catch (error) {
      screen = { name: "error", message: error instanceof Error ? error.message : String(error), back };
    }
    paint();
  };

  // The custom row while custom names are paused: serve the saved claim again, with no claim call of
  // its own — apply renews the lease by keypair, exactly as every launch does.
  const serveCurrent = async () => {
    const current = options.current();
    const back: Screen = { name: "menu", index: rowOf("frizz") };
    if (!current) return;
    screen = { name: "busy", message: `serving ${current.hostname}…` };
    paint();
    try {
      await options.apply(current);
      options.onChanged?.(current);
      screen = { name: "done", message: `Serving https://${current.hostname} (${describeCloudConfig(current)}).`, link: options.issueLink(), config: current };
    } catch (error) {
      screen = { name: "error", message: error instanceof Error ? error.message : String(error), back };
    }
    paint();
  };

  const turnOff = async () => {
    screen = { name: "busy", message: "back to loopback only…" };
    paint();
    try {
      await options.apply(null);
      options.onChanged?.(null);
      screen = { name: "done", message: "Loopback only. This board is reachable from this machine alone.", link: null, config: null };
    } catch (error) {
      screen = { name: "error", message: error instanceof Error ? error.message : String(error), back: { name: "menu", index: rowOf("off") } };
    }
    paint();
  };

  return {
    open() {
      open = true;
      screen = { name: "menu", index: rowOf(kindOf(options.current())) };
      output.write(ALT_SCREEN_ON);
      output.write(HIDE_CURSOR);
      paint();
      return true;
    },
    key(key) {
      const s = screen;
      if (s.name === "busy") {
        if (key === ESC && s.cancel) {
          s.cancel();
          s.cancel = undefined;
        }
        return "keep";
      }
      if (s.name === "done") return "close";
      if (s.name === "error") {
        screen = s.back;
        paint();
        return "keep";
      }
      if (s.name === "menu") {
        if (key === ESC || key === "q") return "close";
        const rows = choices();
        if (key === UP || key === "k") s.index = (s.index + rows.length - 1) % rows.length;
        else if (key === DOWN || key === "j") s.index = (s.index + 1) % rows.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= rows.length) s.index = Number(key) - 1;
        else if (ENTER.has(key)) {
          const choice = rows[Math.min(s.index, rows.length - 1)]!;
          if (choice.kind === "off") void turnOff();
          else if (choice.kind === "private") void claimPrivate();
          else if (choice.kind === "frizz" && !customNamesOffered()) void serveCurrent();
          else openForm(choice.kind);
          return "keep";
        }
        paint();
        return "keep";
      }
      // A form.
      if (key === ESC) {
        screen = { name: "menu", index: rowOf(s.kind) };
        paint();
        return "keep";
      }
      const field = s.fields[s.focus]!;
      if (ENTER.has(key)) {
        if (s.focus < s.fields.length - 1 && valueOf(field)) s.focus += 1;
        else void submit(s);
      } else if (key === TAB || key === DOWN) s.focus = (s.focus + 1) % s.fields.length;
      else if (key === SHIFT_TAB || key === UP) s.focus = (s.focus + s.fields.length - 1) % s.fields.length;
      else if (BACKSPACE.has(key)) field.value = field.value.slice(0, -1);
      else if (key.length === 1 && key >= " ") field.value += key;
      else if (!key.startsWith(ESC)) field.value += key.replace(/[\r\n\t]/g, "");
      paint();
      return "keep";
    },
    close() {
      if (!open) return;
      open = false;
      output.write(ALT_SCREEN_OFF);
      output.write(SHOW_CURSOR);
    },
  };
}
