# Self-Hosting agnt

This guide is for developers who clone the public GitHub repository and want to run agnt on infrastructure they control.

It covers two supported setups:

1. Local LAN pairing on your own machine
2. A self-hosted VPS relay that your bridge connects to over the internet

This document intentionally avoids any private hosted-service details. If you are using the public repo, assume you are bringing your own relay endpoint.

The public source tree is local-first and self-host friendly:

- there is no public production relay baked into the GitHub source
- local pairing should work out of the box with `./scripts/run-local-agnt.sh`
- internet-facing setups should pass their own relay URL explicitly with `AGNT_RELAY`
- the first QR scan bootstraps trust, then later reconnects can reuse the same trusted Mac/Linux host through that relay
- the built-in background daemon supports macOS (launchd) and Linux (systemd-user); Codex provider features that depend on the macOS desktop app (`/Applications/Codex.app` mirroring, `desktop/continueOnMac`, ChatGPT sign-in helper) remain macOS-only

## What agnt Self-Hosting Means

agnt is local-first.

That means:

- the bridge runs on your own machine (macOS or Linux)
- the agent CLI runs on your own machine
- git commands run on your own machine
- your iPhone is a remote control
- the relay is only a transport layer for pairing, trusted-session resolve, and encrypted message forwarding

The relay does not run Codex and does not get your plaintext application payloads after the secure handshake completes.

## Option 1: Local LAN Setup

This is the easiest way to try the public repo, but on iPhone it should be treated as a best-effort local test path. The recommended self-host setup for regular use is Tailscale or another stable private network path to your relay.

### What you need

- a macOS or Linux host with at least one supported agent CLI installed (Codex on macOS only; Claude Code, opencode, and Cursor work on both)
- an iPhone with an agnt build installed
- both devices on the same local network

### Start everything locally

From the repo root:

```sh
git clone https://github.com/dotbrains/agnt.git
cd agnt
./scripts/run-local-agnt.sh
```

What this does:

- starts a local relay on your machine
- starts the agnt bridge
- prints a pairing QR code for first-time trust bootstrap or recovery

Then:

1. Open the iPhone app
2. Scan the QR code from inside the app
3. Start a thread and send a message
4. On later launches, let the app try trusted reconnect before scanning again

### If your iPhone cannot reach the default hostname

Pass a hostname or IP address that the phone can actually reach:

```sh
./scripts/run-local-agnt.sh --hostname 192.168.1.10
```

For temporary tunnel or reverse-proxy testing, advertise the tunnel URL directly.
The helper accepts `http(s)` URLs and normalizes them to `ws(s)` with `/relay`
when no path is provided:

```sh
./scripts/run-local-agnt.sh --relay-url https://example-tunnel.trycloudflare.com
```

### Health check

By default the local relay listens on port `9000`.

From the same Mac:

```sh
curl http://127.0.0.1:9000/health
```

You should get:

```json
{"ok":true}
```

## Option 2: Self-Hosted VPS Relay

Use this when you want the bridge on your Mac to connect through a relay you run on a VPS.

This is also the best base for a Tailscale setup: the relay can live on a Mac, a mini server, or a VPS you control, as long as the iPhone can reach it reliably.

### What runs where

On your VPS:

- the agnt relay

On your Mac:

- the agnt bridge
- the agent CLI you want to drive (Codex `app-server`, Claude Code, opencode, Cursor `cursor-agent`, etc.)

On your iPhone:

- the agnt app

### Start the relay on the VPS

From the public repo:

```sh
git clone https://github.com/dotbrains/agnt.git
cd agnt/relay
bun install
bun run start
```

By default the relay listens on port `9000`.

### Verify the relay

On the VPS:

```sh
curl http://127.0.0.1:9000/health
```

You should get:

```json
{"ok":true}
```

### Put a reverse proxy in front of it

Expose the relay through a public `ws://` or `wss://` endpoint that forwards to the Node relay.

Two common patterns are:

- a dedicated subdomain, for example `wss://relay.example.com/relay`
- a shared-domain subpath, for example `wss://api.example.com/agnt/relay`

If you use a shared-domain subpath, make sure your reverse proxy strips the prefix before forwarding so the Node process still receives `/relay/...`.

### Point the bridge at your VPS relay

On the Mac that runs the bridge:

```sh
AGNT_RELAY="wss://relay.example.com/relay" agnt up
```

Or, if you are running from source:

```sh
cd agnt-bridge
bun install
AGNT_RELAY="wss://relay.example.com/relay" bun run start
```

The bridge will print a QR code the first time you trust that Mac, or later if you intentionally reset trust.

That QR carries the relay URL and session information, so the iPhone does not need a hardcoded relay endpoint in the public source build.

After the first successful scan:

- the iPhone stores the Mac as a trusted device
- the bridge keeps its local device identity
- the relay can resolve the current live session for that trusted Mac
- the app can reconnect without requiring a new QR every time

Today, the built-in background-service path supports macOS (launchd, via `~/Library/LaunchAgents/com.dotbrains.agnt.bridge.plist`) and Linux (systemd-user, via `~/.config/systemd/user/com.dotbrains.agnt.bridge.service`). Both are managed transparently by `agnt up` / `agnt start` / `agnt stop` / `agnt status`.

On Linux, the systemd-user installer requires:

- `XDG_RUNTIME_DIR` set (a real PAM/SSH session — present whenever a user is logged in)
- `systemctl --user` available
- for headless boxes that should keep the bridge running after logout: `loginctl enable-linger $USER`

If `systemctl --user` is unavailable (for example, on a container without systemd, or Alpine), `agnt up` falls back to a foreground bridge with the same pairing QR. You can supervise that yourself (tmux, supervisord, your own systemd unit, etc.).

On other operating systems pairing and relay routing still work, but you must manage persistence/background service behavior yourself.

If you install the bridge from npm and do not use the local launcher, make sure you export `AGNT_RELAY` before running `agnt up`.

## Push Notifications

Managed push is optional.

For public self-hosting:

- you do not need push to use agnt
- local in-app and local-device flows can still work without it
- the relay keeps push endpoints disabled by default

Do not turn push on unless you are also ready to configure:

- a bridge-side `AGNT_PUSH_SERVICE_URL`
- APNs credentials on the relay side
- your own operational setup for notification delivery

If you do nothing here, push stays off.

## Reverse Proxy Notes

If your relay sits behind Traefik, Nginx, or Caddy:

- forward WebSocket upgrades correctly
- forward the `/relay/...` path to the relay process
- only enable `AGNT_TRUST_PROXY=true` when the proxy is trusted and sanitizes forwarded IP headers

## What Not to Commit

If you are self-hosting from the public repo, keep these things out of Git:

- your real relay hostname
- your private VPS IP addresses
- any APNs credentials
- any private package or App Store build defaults

The public repo should stay generic. Your actual deployment values belong in your own environment, build pipeline, or private config.

## Troubleshooting

### The bridge starts but the iPhone cannot connect

Check:

- the relay is reachable from the phone
- your reverse proxy forwards WebSockets
- the bridge is using the correct `AGNT_RELAY`
- the public endpoint uses `wss://` if you are going over the internet

### Local LAN pairing fails

Try a concrete LAN IP:

```sh
./scripts/run-local-agnt.sh --hostname 192.168.1.10
```

If local LAN pairing still fails on iPhone even though the relay health check works, prefer a Tailscale-reachable relay instead of continuing to rely on plain `ws://` over the same Wi-Fi.

### The relay health check works, but pairing still fails

That usually means one of these:

- the public path is wrong
- the reverse proxy is not forwarding upgrades
- the bridge is pointing at the wrong relay base URL

## Minimal Summary

If you cloned the public repo, the supported self-hosting story is:

- run the relay yourself
- prefer a relay path reachable from iPhone over Tailscale or another stable private network
- point the bridge at your relay with `AGNT_RELAY`
- scan the QR from the iPhone app once to trust the Mac/Linux host
- let reconnect reuse that trusted host over the same relay
- the built-in daemon path supports macOS (launchd) and Linux (systemd-user); other operating systems run the bridge in the foreground and you supervise it yourself
- keep private hostnames and credentials out of the public repo
