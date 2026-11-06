# A blind relay: frizz.sh carries ciphertext it cannot read or forge

Design plan, 2026-10-08. Prompted by the frizz.sh compromise found that day: from 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare user API token for the Frizz account ran backdoored builds of [`packages/relay`](../packages/relay) and [`packages/registrar`](../packages/registrar). Status: **PROPOSED. Nothing here is built.**

**Verdict: end-to-end encryption is necessary but is not the fix on its own. The fix is to move the code that holds the keys off every origin the Cloudflare account controls.** Today the relay serves the page, so any encryption inside the page is only as strong as the relay that serves it. The recommended design puts a small, separately hosted loader in front of the board, pins the board's public key from the access link's fragment, binds each phone to a non-extractable device key in place of the bearer cookie, and turns the relay into a pipe for binary frames it cannot open. A compromised Cloudflare account then can deny service and observe traffic shape, and nothing more.

---

## 1. What the incident proved

The backdoored relay (`evidence/live-vs-main-relay.diff` in the incident thread) did five things, and every one of them used a property the relay has by design, not a bug:

| What the backdoor did | The property it used |
| --- | --- |
| Copied every visitor request, with headers and bodies, to a collector | TLS ends at Cloudflare's edge; the Worker sees plaintext HTTP |
| Kept the latest `frizz_session` cookie and opened its own board socket with it, subscribed to every thread's transcript | The session is a bearer token in a request header, and the relay forwards headers to the board ([`relay-agent.ts`](../src/relay-agent.ts) forwards them on purpose, so the access gate sees the cookie) |
| Rewrote the `prompt` / `message` field of RPC POSTs on a verdict from the collector, and blocked RPCs | The relay frames each request itself ([`board-socket.ts`](../packages/relay/src/board-socket.ts) `request()`), so it can build any request it likes |
| Logged and rewrote terminal input, and injected commands every 5s | Nested WebSocket messages pass through the Durable Object as plaintext strings |
| With a stolen cookie, dispatched a thread with `bypassPermissions` on Claude Haiku and ran shell commands on the maintainer's machine | A remote session has every capability a loopback tab has, with no step-up for the actions that turn permissions off |

Three conclusions follow, and the design rests on them.

- **The access gate protects a board from strangers, not from the relay.** The comment at the top of [`worker.ts`](../packages/relay/src/worker.ts) and the [relay README](../packages/relay/README.md) say "Nothing in the board is trusted to us — the visitor still meets Frizz's own single-use access gate on the far side". That is false in effect: the credential the gate checks rides through the relay on every request, and the single-use code in `?frizz_code=` rides through it too, in the query string, before it is redeemed. Both statements were corrected in Phase 0.
- **The trust anchors live in the same account as the relay.** The relay authenticates a board against the pubkey the registrar wrote to the `CLAIMS` KV namespace, and Cloudflare also holds the `frizz.sh` DNS zone and terminates TLS for `*.frizz.sh`. An attacker with the account can change all three. So any defence whose root is "the name `ada.frizz.sh`" fails against this attacker: web origin security is rooted in DNS and the CA system, and the attacker controls the DNS.
- **The relay serves the code.** `index.html` and every JavaScript asset reach the browser through the same Durable Object. A protocol that encrypts inside that page stops the passive half of this backdoor and nothing else: the next upload serves a page that sends the plaintext out before it encrypts it. 1Password states the same limit for its own web client: "An attacker capable of changing the web client on the server could deliver a malicious client to the user", and its advice to users is to "Use (code signed) native clients as much as possible" ([1Password security design, "Crypto over HTTPS"](https://agilebits.github.io/security-design/leopard.html)).

## 2. Threat model

| Adversary | Capabilities | In scope |
| --- | --- | --- |
| **A1. Passive relay** | Reads every frame the relay carries | Yes: the design must reveal content to it only as ciphertext |
| **A2. Active relay** | A1, plus drops, delays, reorders, replays, injects and rewrites frames; serves any HTTP response at `*.frizz.sh` | Yes |
| **A3. Cloudflare account** | A2, plus the DNS zone, the `CLAIMS` KV, other Workers, and a DV certificate for any `*.frizz.sh` name (it controls the DNS a CA validates against) | Yes. This is the attacker of 2026-09-21. |
| **A4. Loader host** | Serves any bytes at the loader origin proposed below | Partly: the design moves trust here, so it must be on a different provider with a separately guarded deploy, and Phase 4 narrows it further |
| **A5. Stolen phone or copied browser profile** | Holds whatever the browser stored | Partly: revocation from the laptop, and step-up for escalation |
| **A6. Compromised board machine** | Everything | No. The board is the endpoint; it already runs shells. |
| **A7. Network attacker between the phone and Cloudflare** | Standard web attacker | Covered by TLS today and unchanged |

The assets: thread content (prompts, transcripts, files the board serves), the power to act on the board (dispatch, send, change permissions, sign devices out), and the power to enrol a new device.

## 3. Requirements

1. **R1 — Confidentiality from A3.** The relay and everything else in the Cloudflare account see ciphertext plus metadata: names, sizes, timing, IP addresses.
2. **R2 — Integrity from A3.** The relay cannot inject, alter or replay an action the board will accept. A rewrite is detected and closes the channel.
3. **R3 — No credential crosses the relay in a usable form.** No bearer cookie, no access code. A frame the relay copies is worthless to replay.
4. **R4 — The code that holds keys is never served by an origin A3 controls.** No path in `*.frizz.sh`, and no host whose DNS or deploy the Cloudflare account can change.
5. **R5 — The board's public key reaches the phone out of band**, in the access link's URL fragment, which [RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) defines as "dereferenced solely by the user agent". Never from the registrar, the relay or KV.
6. **R6 — No silent downgrade.** A device that has paired over the encrypted channel never falls back to the plaintext path because the relay says so.
7. **R7 — Enrolment needs presence on the machine,** as minting a code does today (the `SUPERVISOR_ACCESS_CODE_PATH` endpoint in [`restart-supervisor.ts`](../packages/server/src/restart-supervisor.ts) refuses any request that arrived publicly).
8. **R8 — Escalation needs more than a session.** A remote request that turns permissions off carries a fresh proof of user presence, or is refused.
9. **R9 — Works in a plain mobile browser** (iOS Safari, Android Chrome) with nothing installed. An installed app may be stronger; it may not be required.
10. **R10 — Keeps the zero-config property.** The board still dials out, needs no inbound port, and works behind any NAT.
11. **R11 — Keeps the live surfaces:** the `/events` SSE feed, the `/ws` app socket with its 4 MiB logical frames, streamed bodies, and gated subresources (`/_frizz/local-image`, `project-icon`, `local-visualization`, `attach`).
12. **R12 — Keeps the Durable Object cheap.** Hibernation and the keep-alive auto-response stay intact.
13. **R13 — Migrates without breaking a board that works today,** and lets the maintainer see which devices are on which path.
14. **R14 — Revocation is immediate.** A device signed out from the laptop cannot open another channel.

The loopback path (the operator's own tab on `127.0.0.1`) is out of scope and does not change.

## 4. Options compared

| | Relay reads content | Relay can forge actions | Defeats A3 | Whose code the phone trusts | Plain mobile browser | What it costs |
| --- | --- | --- | --- | --- | --- | --- |
| **O1. Today + board-side hardening** | Yes | Yes, with a copied cookie | No | The relay's | Yes | Nothing new; caps damage only |
| **O2. E2E inside the relay-served page** | Not while the page is honest | Not while the page is honest | No: A2 swaps the JavaScript | The relay's | Yes | A protocol, and a false sense of safety |
| **O3. TLS passthrough** (SNI routing; the board holds the certificate and terminates TLS) | No | No | **No under `frizz.sh`**: A3 repoints DNS and gets its own DV certificate. Certificate Transparency logs the issuance after the fact. | The board's, by name | Yes | Cannot run on Workers (a Worker only sees HTTP; custom TCP in [Spectrum](https://developers.cloudflare.com/spectrum/) needs Enterprise), so a VPS-based SNI router; ACME on every board |
| **O4. Separately hosted loader + Noise channel through a pipe relay** | No | No | Yes | The loader host's (small, static, auditable) and then the board's | Yes | A loader, a channel protocol, a new relay mode, a device registry |
| **O5. Installed client** (native app, browser extension, or an Isolated Web App) speaking the O4 channel | No | No | Yes | A signing key held offline | No | App-store distribution; [Isolated Web Apps](https://developer.chrome.com/docs/iwa/introduction) are "only available to Chrome Enterprise administered ChromeOS devices and select development partners" today |
| **O6. WebRTC data channel, relay as signalling only** | No, if the DTLS fingerprint is pinned from the QR | No, same condition | Only with O4's loader | Same as O4 | Mostly | TURN for hard NATs; does not solve where the code comes from. A transport under O4, not an alternative to it. |
| **O7. The operator's own tailnet or domain** (`serve: "external"`, exists today) | Not Frizz's relay | Not Frizz's relay | Yes, for Cloudflare-the-Frizz-account | Their own provider's | Needs the Tailscale app, or a domain | Setup the claimed name exists to avoid |

Prior art, read for this plan:

- **TLS passthrough.** [ngrok's Zero-Knowledge TLS](https://ngrok.com/docs/universal-gateway/cloud-endpoints/tls) routes on SNI and leaves termination to the agent, so "the ngrok cloud service can not see payload"; the operator then becomes "responsible for provisioning, managing, and distributing certificates". [Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) does the same: "Funnel relay servers do not decrypt the traffic", and the device terminates TLS. Both hold against a hostile relay operator only because the relay operator is not also the attacker who controls DNS for the name. For Funnel, Tailscale controls `ts.net`; for `frizz.sh`, A3 controls the zone. That is why O3 fails here and O7 does not.
- **A dumb ciphertext pipe.** Tailscale's [DERP servers](https://tailscale.com/kb/1232/derp-servers) relay WireGuard packets when a direct path fails: "A DERP server blindly forwards already-encrypted traffic from one device to another." That is the target shape for the relay's Durable Object.
- **A hostile server must not be the one that announces keys.** The [Tailnet Lock whitepaper](https://tailscale.com/kb/1230/tailnet-lock-whitepaper) starts from "a compromised or malicious control plane could broadcast nodes with attacker-controlled keys", and answers it with signatures from keys the control plane never holds. Matrix shows the failure mode: [Albrecht et al., "Practically-exploitable Cryptographic Vulnerabilities in Matrix"](https://nebuchadnezzar-megolm.github.io/) found that a homeserver could add a device to a user's account and "existing devices will share their inbound Megolm sessions with the new device", and concluded that Matrix and Element "provided neither authentication nor confidentiality against homeservers that actively attack the protocol". Here, the registrar and relay must never be the source of the board's key or of the device list.
- **Key in the QR, ciphertext through the server.** Signal's [device linking](https://signal.org/blog/a-synchronized-start-for-linked-devices/) puts a provisioning address and "the public key for a locally-generated Curve25519 keypair into the QR code"; the primary device encrypts the provisioning message to that key and Signal's server only relays it. The access link below is the same move in the other direction.
- **Integrity of web code.** Signal and WhatsApp ship installed clients. WhatsApp Web added Meta's Code Verify, a browser extension that compares the served JavaScript's hash with one published through Cloudflare ([The Hacker News, 2022](https://thehackernews.com/2022/03/heres-how-to-find-if-whatsapp-web-code.html)). Cloudflare's [WAICT proposal](https://blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/) (2025-10-16) would give browsers integrity manifests, a transparency log and enforcement; it notes that full WAICT needs browser support that does not exist yet. A service worker cannot pin code against its own origin: "the old Service Worker can't prevent a compromised, new Service Worker to be installed" ([public-webappsec, 2017](https://lists.w3.org/Archives/Public/public-webappsec/2017Sep/0010.html)), and the [Service Workers spec](https://w3c.github.io/ServiceWorker/) forces an update check once a registration is more than 86,400 seconds stale.
- **Device-bound sessions.** Chrome's [Device Bound Session Credentials](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/) (2026-04-09; Windows on Chrome 146, macOS to follow) bind a session to a hardware key so a copied cookie cannot be renewed. Frizz can get the same property on every browser from a WebCrypto key without waiting for DBSC.
- **Transaction confirmation.** WebAuthn has no shipped way to show the user what they approve: `txAuthSimple` and `txAuthGeneric` were removed from Level 2 because they had "not be[en] implemented" ([w3c/webauthn#1386](https://github.com/w3c/webauthn/issues/1386)). A WebAuthn step-up proves presence; the page decides what the user sees.

**Recommendation: O4, built so that O5 can reuse its protocol unchanged, with O1's board-side limits shipped first and kept.** O3 is rejected because it is the most work and still fails A3 under `frizz.sh`. O2 is rejected as a security boundary: it would have defeated the passive half of this exact backdoor and nothing an attacker would do next. O7 stays documented as the strongest option that exists today.

## 5. Recommended design

### 5.1 Where the code comes from

**A loader, hosted off Cloudflare, on a domain the Frizz Cloudflare account does not hold.** For example `https://<name>.<loader-domain>/`, with the domain registered at a different registrar, its DNS at a different provider, and a static host whose deploy runs only from the [`release`](../.github/workflows/release.yml) workflow on a maintainer's `workflow_dispatch` — the same rule that keeps a stolen push credential from publishing to npm. The loader is the only web code whose integrity the phone must take on trust, so it is kept small: it holds the device key, runs the handshake, and serves the board's own app through a service worker. It never renders board content itself.

**The app comes from the board, through the channel.** The loader does not bundle the Frizz web app. Every board version ships its own `web-dist` inside `frizz-server`, and the frontend and server are released together; a loader that bundled one app version would have to speak to every server version in the field. Instead, the loader's service worker answers a navigation, `/assets/*`, and every gated GET by fetching it from the board over the encrypted channel. Bytes that arrive through an authenticated channel came from the board, so they run with the loader origin's authority, and the relay has no way to add a byte to them.

**One origin per board.** `<name>.<loader-domain>` gives each board its own storage, its own service-worker scope, and a root-mounted app, so `base-path.ts` and its `/project/<slug>` and `/_frizz` routes work unchanged. It also means board A's code cannot use board B's device key, which matters for anyone with two machines. The cost is a wildcard DNS record and certificate at the loader host. (The single-origin alternative is open question 2 in § 9.)

**A strict CSP on the loader:** `script-src 'self'`, `connect-src wss://*.frizz.sh`, no third-party script, no analytics.

### 5.2 Keys

- **Board transport key** `Sb`: a new X25519 keypair in the state root beside `identity.key`, 0600, with the same "never silently replaced" rule as [`identity.ts`](../src/identity.ts). One per machine, because the server is a singleton serving every project. The claim identity (Ed25519) keeps its job of proving name ownership to the relay. The two are separate because the claim key's public half is in KV, which A3 can rewrite, and the browser must never learn `Sb` from there.
- **Device key** `Sd`: an X25519 keypair the loader generates with WebCrypto, `extractable: false`, stored in the loader origin's IndexedDB. X25519 is on by default in WebCrypto in Chrome 133, Firefox 130 and WebKit (Safari Technology Preview 211, January 2025), per [Igalia's tracking post](https://blogs.igalia.com/jfernandez/?p=1913), and `deriveBits` works with a non-extractable private key, so the Noise DH runs without the key ever being readable by script. Script on the origin can still USE the key while a tab is open; § 7 says what that means.
- **Optional step-up credential**: a WebAuthn passkey created at pairing, RP ID `<name>.<loader-domain>`. Its public key is stored in the board's device record.

### 5.3 The access link

The launcher's access pane ([`access-pane.ts`](../src/access-pane.ts)) prints, and draws as a QR:

```
https://<name>.<loader-domain>/#v=2&k=<Sb public key, base64url>&c=<single-use code>
```

Everything after `#` stays on the phone. The relay never sees the code or the key; the loader host sees only the hostname. Minting stays loopback-only, single-use and five minutes long, exactly as [`access-codes.ts`](../packages/server/src/access-codes.ts) does today. The URL is longer than today's (a 43-character key on top of the 22-character code), so the QR grows by a version or two; the pane's quiet-zone handling needs a check at 80x24.

### 5.4 Session = device key, not cookie

The board keeps a **device registry** in place of the session denylist: public key, label (from the User-Agent, as `describeDevice` does now), created-at, last-seen, revoked-at, capability tier, optional passkey. `frizz --sessions` and `--sign-out` read and write it. A revoked key fails the next handshake, which meets R14 without the "verify from signature, then consult a denylist" split the cookie needs. Nothing bearer-shaped crosses the relay: what proves a device is a DH it performs inside the handshake, and a recorded handshake replays to nothing (§ 6.3).

### 5.5 Step-up for escalation

A board-side list of **escalating actions** — a `dispatch` whose permission mode is `bypassPermissions`, `setThreadPermission` to `bypassPermissions`, a dispatch-preference change that makes it the default, and anything on the device registry — is refused for a remote device unless the request carries a fresh WebAuthn assertion over `H("frizz-stepup" ‖ handshake hash ‖ canonical action ‖ board nonce)`. The board checks the signature against the device's registered passkey, the UV flag, and that `clientDataJSON.origin` is the device's loader origin.

What it buys: a copied browser profile or a script that has the device key but not the user's finger cannot escalate, and the assertion is useless for any other action or channel. What it does not buy: a malicious LOADER can show "Dispatch fix-typo" and have the user approve a bypass dispatch, because the browser does not display the transaction (see `txAuthSimple` above). Step-up defends against A5 and narrows A4; it does nothing about A4 with a cooperative user. That gap is why the design does not stop at the loader (Phase 4).

### 5.6 The relay as a pipe

The relay gains a second mode beside today's request framing:

- The loader opens `wss://<name>.frizz.sh/_relay/pipe`. The Durable Object accepts it with the hibernation API, assigns a channel id, and stores that id in the socket's attachment.
- Every message in either direction is binary: `[type: 1 byte][channel: 4 bytes][payload]`, with types `open`, `data`, `close`. The object copies `data` payloads between the visitor's socket and the board's socket and never parses them.
- No per-request state lives in the object any more. A woken object rebuilds its routing from attachments, so a visitor socket survives hibernation, where today [`worker.ts`](../packages/relay/src/worker.ts) `restore()` has to close every visitor because their pending maps were in memory.
- The keep-alive constants and the runtime auto-response stay as they are; they are metadata.
- Today `webSocketMessage` drops any non-string message (`if (typeof message !== "string") return`), so binary forwarding is a real change to the object, not a configuration.

The board-side agent ([`relay-connection.ts`](../src/relay-connection.ts)) runs one Noise responder per channel. After the handshake it feeds decrypted inner frames to the existing [`serveRelayRequest`](../src/relay-agent.ts) and `serveRelayWebSocket`, so the code that talks to the local board barely changes.

**Authentication on the far side of the channel is in-process, not a header.** The launcher owns both the relay connection (`remote-controller.ts`) and the public proxy (`RestartSupervisorProxy`, built by `dev-supervisor.ts`), so the agent hands the proxy a request already tagged with the verified device id through a function call. If the request has to cross the loopback socket instead, the tag is a header carrying an HMAC under a per-boot secret that never leaves the process, which the proxy verifies and strips before the child sees it. Either way the board's origin policy grows a third authority beside loopback and the public origin: "arrived through the blind channel as device X".

### 5.7 Live traffic, large frames and chunking

- **There are no terminals any more.** Sign-in stopped hosting one on 2026-09-24 (`/term` went with it), so the nested-WebSocket path now carries the `/ws` app socket. The backdoor's "terminal keystroke" logging targeted the path that existed when it was written.
- **Live traffic does not go through the service worker.** The web app has exactly three transport modules — [`rpc.ts`](../packages/web/src/api/rpc.ts), [`sse.ts`](../packages/web/src/api/sse.ts), [`socket.ts`](../packages/web/src/api/socket.ts). When the loader is present it exposes a channel object, and those modules use it in place of `fetch`, `EventSource` and `WebSocket`. A WebSocket is not interceptable by a service worker in any case, and a long SSE stream should not depend on a service worker's lifetime. The service worker handles the document, assets and subresource GETs only, and opens its own short-lived channel when it wakes. Until the hook exists, `socket.ts` already falls back to SSE when `/ws` never confirms, so a first build degrades to today's fallback behaviour rather than breaking.
- **Records cap at 65,535 bytes**, the Noise message limit ([Noise spec](https://noiseprotocol.org/noise.html)). Each inner frame is fragmented into records below that, carried as binary WebSocket messages, so base64 disappears (a third off every body) and Cloudflare's 1 MiB message cap is never approached. `RELAY_MAX_FRAME_BODY` and `RELAY_MAX_WS_CHUNK` stop being relay concerns. The bounded reassembly in `WsMessageAssembler` moves to both endpoints, keeps its 8 MiB ceiling and its poisoning rule, and keeps covering the 4 MiB `APP_SOCKET_MAX_LOGICAL_FRAME_BYTES` snapshot.
- **The request multiplexer moves to the browser.** `BoardSocket`'s pending map, head timeout and stream-idle bound now run in the loader's channel object instead of the Durable Object. It imports only `@frizz/shared` already, so it moves to `packages/shared` rather than being rewritten.

## 6. Protocol sketch

Names are illustrative, and the pattern choices need a cryptographic review before anything is built.

### 6.1 Pairing (first use of an access link)

```
Noise_IKpsk1_25519_AESGCM_SHA256
prologue = "frizz-blind/2" ‖ name
psk      = HKDF-SHA256(ikm = code, salt = "frizz-pair", info = name)

  <- s                                   (Sb, from the link fragment)
  -> e, es, s, ss, psk   payload: { v: 2, label, ts }
  <- e, ee, se           payload: { v: 2, deviceId, server: "<frizz-server version>" }
```

- AES-GCM and SHA-256 rather than WireGuard's ChaCha20-Poly1305 and BLAKE2s, so every primitive is WebCrypto and the loader carries no JavaScript crypto library.
- `psk1` puts the code into the first message, so the board knows the device holds a live code before it answers. The board tries each outstanding code — there are a handful at most — and consumes the one that decrypts, using the same consume-before-observe rule as `AccessStore.redeem`. A message that decrypts under none of them gets no answer.
- The board records `Sd` as a new device only after the handshake completes, and the readout announces it ("New device: Safari on iPhone"), so a pairing the operator did not expect is visible at once.
- Optionally, the first transport message registers the passkey for step-up.

### 6.2 Reconnect (every later visit)

```
Noise_IK_25519_AESGCM_SHA256
prologue = "frizz-blind/2" ‖ name
  -> e, es, s, ss        payload: { v: 2, ts }
  <- e, ee, se           payload: { v: 2, server }
```

The board accepts `s` only if it is a registered, unrevoked device key. The initiator's static key is encrypted in message 1, so the relay cannot tell which device is connecting, only that one is.

### 6.3 Replay and downgrade

- The Noise spec marks IK's first payload as replayable and without forward secrecy. So message 1 carries no application data, only a timestamp, and the board keeps the highest timestamp seen per device and refuses anything at or below it — WireGuard's answer to the same property (its handshake initiation carries an encrypted TAI64N timestamp). A replayed message 1 gets no answer; even answered, the relay could not derive the keys.
- A loader that has paired with a board stores `{ v: 2, Sb }` and never offers the plaintext path for it. "This board only speaks v1" from the relay is shown as an error naming the update to run, not followed.

### 6.4 Transport

- Inner frames are the existing `RelayDownFrame` / `RelayUpFrame` shapes, with bodies as raw bytes instead of base64 strings.
- Records are AES-GCM with the Noise nonce counter, so a dropped, reordered or replayed record fails to decrypt and closes the channel. The loader reconnects with a fresh handshake.
- Rekey (Noise `Rekey()`) after a fixed count of records or a fixed age, whichever comes first.
- The handshake hash is the channel binding for step-up assertions.

### 6.5 Rotation and recovery

- **Board key rotation:** the board sends `{ newSb, notBefore }` to each device inside a live session authenticated by the old key, each device updates its pin, and the board accepts both keys until every registered device has moved or a deadline passes. A device offline through the deadline re-pairs with a new QR.
- **Board key lost or suspected compromised:** delete the key file; the next start makes a new one; every device re-pairs. Same blast radius as deleting `session-key` today, and the same instruction.
- **Device lost:** `frizz --sign-out <id>` on the laptop. Effective on the next handshake; live channels from that device are closed at once.
- **Loader storage cleared** (Safari's storage eviction, a "clear website data"): the device key is gone, so the device re-pairs. The board's registry keeps the dead entry until it is signed out or expires; a last-seen column makes stale ones obvious.

## 7. What a compromised relay can still do

Even with every phase below done, A3 can:

- **Deny service:** refuse the pipe, drop frames, close channels, take the name off the registrar, or point `<name>.frizz.sh` somewhere else. Every one of those looks like a board that is offline; none of them gets the attacker a byte of content or an action.
- **Observe metadata:** which names exist and when they connect, visitor IP addresses, how many devices open channels, and the size and timing of every record. Sizes and timing reveal a lot — when someone is typing, when a snapshot lands, how long a transcript is. Padding records to size buckets would blunt this at a bandwidth cost (open question 6).
- **Impersonate the board's name, not the board.** A3 can rewrite the claim pubkey in KV and connect its own "board" to the name. The device's handshake then fails against the pinned `Sb`. That is a DoS, not a takeover.
- **Phish.** A3 can serve a lookalike page at `<name>.frizz.sh`. The defence is that nothing Frizz prints points there: the access link, the readout and any install prompt name the loader origin only.

And the residual trust that does not go away:

- **The loader host (A4)** can serve a malicious loader to a new visit. Phase 4 narrows this; only an installed client (O5) or browser-enforced integrity (WAICT) removes it.
- **Script on the loader origin can use the device key** while a tab is open, even though it cannot export it. A non-extractable WebCrypto key is stored by the browser in the profile, not in a hardware module, so malware with the profile on disk is outside what WebCrypto promises. Step-up with a platform passkey is what holds there.

## 8. Phased rollout

Each phase ships on its own and says what it protects against. The plaintext path is not removed until Phase 5.

### Phase 0 — board-side limits, no protocol change

**Built, and it went further than this section first said.** The first draft refused only `bypassPermissions`, and called the result a speed bump. A prompt into a thread already running in `bypassPermissions` or `auto` is a path to the shell, and so are a command watch's first check and a monitor, so a ceiling on one permission mode left the escalation open. The strict default replaces it.

- **A session through the relay has one of two levels, the owner's choice.** The maintainer put phones back on full control on 2026-11-06, because read-only phones cost more than they were worth, with read and answer as the alternative. The **R** pane asks when a frizz.sh name is picked and changes it later. The answer lives in `cloud.json`, which only that pane writes, and no route, RPC or socket message reaches it. An unset board has full control. A session through Tailscale, a tunnel or the owner's own proxy has full control, with no question.
- **Read and answer may read the board and pick listed options on question cards, and nothing else.** One table over every procedure (`REMOTE_ACCESS` in [`remote-gate.ts`](../packages/server/src/remote-gate.ts)), exhaustive at the type level and default-deny at runtime, enforced where an RPC name resolves to a procedure. Routes outside RPC, the supervisor's controls and socket message types are default-deny too. A later widening is one line in that table.
- **Full control is what a tab on the machine can do.** The same table says so, and it still refuses every remote session what a page never calls. Minting a sign-in link, the session directory and the setting itself stay on the machine, because a session is not presence on it.
- **Under read and answer, answers are judged against the stored question.** Listed options only, with no free text. A secret or danger card is the machine's, as is any free-text follow-up on the branch taken.
- **Under read and answer, reads are confined.** A remote read resolves its real path and has to land in a registered project or a thread's scratch or attachment directory, with secret-looking names refused inside them. Loopback reads are unchanged.
- **A relay frame is public by construction.** The relay agent dials a listener of its own on which every request counts as public, and frame headers can't name the host. This also closes a route that needed no visitor at all: a frame with a second `Host` header used to read as loopback.
- **A session has to exist.** The key alone no longer makes a cookie: the session has to be in the directory, unrevoked, with an expiry within what it was issued. Signing out closes the sockets and streams that session holds open, and sign-out-all works from loopback with no public origin declared. The cookie is now `__Host-frizz_session`, which a sibling subdomain can't shadow, so each device signs in once more.
- **A document can't be framed**, on loopback or a public name, apart from the board's own PDF and visualization frames.
- **The readout announces every redeemed code** with the device label and says how many remote devices hold a session. A refused remote call writes one audit line with its via, session, device and procedure. Arming a command watch or a monitor is audited, and a `dispatch` record stores the permission mode.
- **The [relay README](../packages/relay/README.md) and the header comment of [`worker.ts`](../packages/relay/src/worker.ts) are corrected:** the access gate's credential crosses the relay, so the relay is trusted with it.
- **The web app shows what the session may do:** the whole board under full control, and under read and answer a board that says where the rest happens.
- **Protects against, in both levels:** a request with no cookie doing anything, a forged frame reading as local, and a session minting a sign-in link or signing another device out.
- **Protects against, under read and answer only:** a stolen cookie, or a hostile relay driving a real session's page, running anything on the machine or reading a secret off it.
- **Does not protect against:** under full control, which is the default, a hostile relay holding a real cookie can run anything on the machine. Under read and answer, reading what the board shows, which is every transcript, or rewriting what the visitor sees, and a hostile relay can still pick a listed option on a card in a real session's name, and a worker acts on that answer. Those remain for the phases below, and until then who can deploy the relay is what stands in front of them.
- **Not built:** the access pane's count of remote devices. The launcher's readout says it instead. Signing the caller stamp and an owner token on the control endpoints were left out, since both defend against a process already on the machine.

### Phase 1 — the channel, the pipe and the loader, opt-in

- Board: transport key, device registry, Noise responder in the relay agent, in-process device authentication.
- Relay: the `/_relay/pipe` mode with binary frames, beside today's mode.
- Loader: built in the repo, deployed by the release workflow to the separate host. The web app's three transport modules gain the channel hook.
- The launcher offers the new link beside the old one (an `L`-pane toggle, or a flag) so the maintainer can run both and compare.
- **Protects against:** A1, A2 and A3, for devices paired this way. **Does not protect against:** anything on the old path, which still accepts cookies; A4.

### Phase 2 — blind by default

- The access pane prints only loader links.
- The relay agent refuses every plaintext `req` and `ws-open` frame from the relay once the operator switches (a `cloud.json` field, default on for new claims), and the switch revokes every cookie session. This is enforced on the board, so a hostile relay cannot reopen the old path by asking.
- **Protects against:** A3 for every device on that board, including one the attacker tries to sign in with a stolen cookie; name hijack becomes DoS. **Does not protect against:** A4, A5.

### Phase 3 — step-up and capability tiers

- Passkey registration at pairing, the step-up check on escalating actions, and a per-device tier (`read`, `act`, `admin`) the laptop sets with `frizz --sessions`.
- Phase 0's refusal becomes "refused without step-up", for whichever procedures the table is widened to.
- **Protects against:** A5 for escalation; an attacker with the device key and no user cannot turn permissions off. **Does not protect against:** A4 with a cooperative user.

### Phase 4 — narrow the loader host

- Reproducible loader build. The hash goes in each GitHub release, inside `frizz-server`, and in the readout.
- The board fetches the live loader from its host on a timer and compares it with the hash it shipped with; a mismatch is a loud warning in the readout. This detects a host that serves everyone a new loader; it misses one that serves a tampered loader only to a targeted phone, which is the "consistency" property WAICT exists for.
- The loader's service worker checks every update against a signature by an offline release key and warns before the new version runs (trust on first use, with the limit in § 4: it can warn, not refuse).
- An installed client (O5) built on the same protocol, if the maintainer wants one. WAICT/WEBCAT enforcement when browsers ship it.
- **Protects against:** a mass A4 compromise (detected), and A4 entirely for anyone on the installed client.

### Phase 5 — retire the plaintext relay protocol

- The relay drops `req`/`res` framing and `BoardSocket`. A board that never upgraded gets a message at connect time naming the update.
- **Protects against:** the relay ever again being able to see content, for any board.

**Compatibility across phases.** The relay ships the pipe mode before any board uses it, and keeps the old mode until Phase 5. A new board with an old relay keeps today's path. A new loader with an old board shows "this machine runs a Frizz without the encrypted link; update it" and stops — it never falls back. The handshake carries the server version, so the loader can say which version to update to.

## 9. Open questions for the maintainer

1. **Which domain and host for the loader?** It must be outside the Frizz Cloudflare account and its DNS outside Cloudflare too. A host that deploys only from `release.yml` on a dispatch keeps the npm rule. GitHub Pages cannot serve a wildcard, which matters for question 2.
2. **One origin per board, or one origin for all?** Per-board origins (`<name>.<loader-domain>`) isolate boards from each other and keep the app root-mounted, at the cost of a wildcard certificate. A single origin is simpler to host, but then any board's app can use every other paired board's device key, and the app needs an outer mount prefix.
3. **How far should Phase 0's ceiling reach?** Answered on 2026-11-06: it is the owner's choice per board, and the default is full control. A ceiling for every board stopped the maintainer steering a thread from a phone. Read and answer stays for an owner who wants it. Step-up (Phase 3) is the likely way to narrow the default again.
4. **What is the step-up?** A WebAuthn passkey on the phone (as designed), an approval on the laptop (strong, but the operator is usually away from it), or no step-up and a hard "laptop only" rule for escalation.
5. **Is an installed client in scope?** It is the only way to remove the loader host from the trust base before browsers enforce WAICT.
6. **Padding for metadata?** Bucketed record sizes hide typing and transcript length from the relay at a bandwidth cost.
7. **Should `external` setups (Tailscale, the operator's own tunnel) use the channel too?** Nothing in the protocol depends on the relay, and it would make a misconfigured proxy as blind as frizz.sh.
8. **When does Phase 2 revoke cookie sessions?** On the switch, as written, or after a notice period in which both paths work.
