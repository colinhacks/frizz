# Remote access

Frizz binds `127.0.0.1` and has no login of its own. To reach a board from a phone or another machine, something in front of it carries the traffic, and Frizz gates the first visit with a single-use sign-in link.

Press **R** in the terminal running Frizz. A walkthrough offers four ways to reach the board, checks what each needs, prints the commands, and remembers your choice — a plain `npx frizz` serves it from then on. **Off** in the same place goes back to loopback only.

```
  Reach this board from anywhere

  ❯ frizz.sh subdomain  a random address and a one-time QR code; no account
    Cloudflare Tunnel   a domain you own on Cloudflare; cloudflared on this machine
    Tailscale           your tailnet; tailscale serve does the TLS
    Something else      any proxy or tunnel you run — tell Frizz its address
    Off                 loopback only  (current)
```

Whichever you pick, the board stays bound to loopback, and a frizz.sh subdomain asks for confirmation before it puts the board on the internet. Once the setup is done, the pane shows a QR: scanning it trades a single-use code for a session cookie, so the link stops working the moment it is used. A later launch serves the saved setup without minting a link. Press **L** for one at any time. A session lasts 30 days, after which the device needs a fresh link.

```sh
npx frizz --link          # a fresh link for a board that is already running — over SSH, for a headless box
npx frizz --sessions      # the devices holding a session
npx frizz --sign-out all  # revoke them
```

A device can sign itself out: **Sign out this device** in Settings ends that browser's session and nothing else. Signing out any other device happens on the host (SSH counts): `frizz --sign-out`, or **Sign out devices** in the **R** menu, which signs out every one. A stolen phone cannot sign out the laptop.

## What a remote session can do

A signed-in device has full control, which is what a tab on the computer running Frizz can do. A few things stay on that computer for every device:

- minting a sign-in link;
- listing the devices that hold a session, or signing another one out;
- changing what a device signed in through frizz.sh can do.

A [frizz.sh subdomain](#a-frizzsh-subdomain) also offers a narrower level, read and answer, which you choose in the **R** menu. Cloudflare Tunnel, Tailscale and your own proxy don't offer it, because nothing Frizz runs is in their path. A device at this level reads the board and answers question cards by picking a listed option. Everything else happens on the computer running Frizz:

- starting or steering a thread, or changing its settings;
- answering a free-text, secret or danger card;
- approving or denying an action a worker is waiting on;
- restarts and updates;
- reading a file outside a registered project or a thread's scratch and attachment directories, or a secret-looking file inside one (`.env`, a key, anything under a dotted folder other than `.frizz`).

A refused call is written to `logs/audit.jsonl` under Frizz's data folder, with the session and device that made it. [SSH port forwarding](#ssh-port-forwarding) counts as the computer itself, so it keeps the whole board.

## Try it without touching your board

A second Frizz that shares nothing with the one you run: a throwaway home and project, its own port, deleted when you press ctrl-c.

```sh
npx frizz --sandbox
```

Press **R** in it and walk through any setup. Credentials come along (`gh`, cloudflared's certificate and tunnel files, the agent CLIs, and on macOS the login keychain), so every screen sees what the real board sees; the saved setup, the registry and the session key are throwaway copies.

## A frizz.sh subdomain

Pick it and answer one question. It needs no account, no domain, no Tailscale, and no tunnel.

```
  What can a device signed in through frizz.sh do?

  ❯ Full control      start and steer threads, answer cards
    Read and answer   read the board and pick options on cards
```

To change the answer later, press **R** and pick **Device access**. The new answer applies to devices already signed in. [What a remote session can do](#what-a-remote-session-can-do) lists both levels.

```
  Serving https://mk7w2qp9x4n3f6tbz5vh.frizz.sh (frizz.sh).

  Scan to sign in on a phone. Single use, expires in 5 minutes. Press L later for another.
```

Your board stays on loopback and opens one outbound connection to a relay Frizz runs, and visitors' requests travel down that connection.

- **No inbound port.** The board dials out, so a laptop behind any NAT works with no configuration.
- **No DNS record.** The relay already answers for every frizz.sh subdomain.
- **Reconnects.** The connection comes back after a sleep or a network change.

| | |
| --- | --- |
| **Address** | 20 random characters, so nobody finds it by guessing. A first visit still needs a single-use sign-in link. |
| **Ownership** | This machine's key proves ownership, with no account. Copy the key file to another machine to move the subdomain. |
| **Key file** | The file is `identity.key`, in `~/Library/Application Support/Frizz` on macOS and `~/.local/state/frizz` on Linux. An older install keeps it in `~/.frizz`. |
| **Renewal** | A running board renews it. A subdomain nobody runs for **30 days** is released, and someone else can claim it. |

### Terms

- **One per machine.** Each machine key holds one subdomain.
- **Lease.** Frizz can reclaim any subdomain at any time.
- **Relay.** Every request and keystroke passes through a relay Frizz runs, and the sign-in check runs on your machine. A device with full control can run anything on your machine. The relay carries that traffic, so anyone who took control of the relay could do the same. Under read and answer, they could read the board and pick options on cards. To keep the relay out of the path, use Tailscale or your own proxy.
- **No warranty.** If you cannot afford to lose access, use a domain you control.

## Cloudflare Tunnel

Needs a domain you control on Cloudflare and `cloudflared` on this machine. Create the tunnel and its DNS record once, in another terminal:

```sh
cloudflared tunnel login                                  # pick your zone
cloudflared tunnel create my-board
cloudflared tunnel route dns my-board board.example.com
```

Point the tunnel at the board. Frizz looks for this file by name:

```yaml
# ~/.cloudflared/frizz.yml
tunnel: my-board
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: board.example.com
    service: http://127.0.0.1:9393
  - service: http_status:404
```

Then pick **Cloudflare Tunnel** and name them. Frizz runs the tunnel beside the board, so the two start and stop together.

```
  Hostname   board.example.com
  Tunnel     my-board
```

## Tailscale

Tailscale gives the machine a stable HTTPS name on your tailnet and terminates TLS itself, so only your devices can reach it. Run once, in another terminal:

```sh
tailscale serve --bg 9393     # Frizz's port
```

Then pick **Tailscale**. Frizz reads this machine's MagicDNS name from the daemon and offers it as the origin; enter accepts it.

## Something else

The rule is the same for Caddy, nginx, ngrok or anything else: terminate TLS wherever you like, proxy to `http://127.0.0.1:9393`, and give Frizz the exact origin a browser will show — scheme and host, no path. Frizz answers only to that `Host` and prints its sign-in link for it.

## Headless machines

A machine nobody watches still mints links on demand — sign in over SSH and ask the running board for one:

```sh
ssh you@box npx frizz --link
```

The link prints as a QR and a URL, is single-use, and expires in five minutes. The setup itself is made once from an interactive terminal; the saved choice (`cloud.json`, next to Frizz's registry — `~/Library/Application Support/Frizz` on macOS, `~/.frizz` on an install that already has one) is what a headless launch serves.

## SSH port forwarding

Needs no setup at all. The forwarded port is loopback on both ends, so Frizz treats it as local:

```sh
ssh -L 9393:127.0.0.1:9393 you@your-machine
# then open http://127.0.0.1:9393 on the client
```

Nothing is exposed and no sign-in link is involved. The cost is that the tunnel lives as long as the SSH session, which makes it awkward from a phone.
