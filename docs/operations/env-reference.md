# Environment variable reference

All env names in agnt start with `AGNT_*`. Reads go through `readFirstDefinedEnv([...])` in the bridge so adding a future legitimate alias is a one-line edit.

## Provider selection

| Var | Default | Purpose |
|---|---|---|
| `AGNT_PROVIDER` | (auto-detect) | Force a specific provider (`codex`, `claude`, `opencode`, `cursor`, …). See [`../providers/overview.md`](../providers/overview.md) for resolution precedence. |
| `AGNT_AGENT_ENDPOINT` | (none) | If set, the bridge connects to an existing CLI WebSocket endpoint instead of spawning. Currently only honored by the Codex provider. |
| `AGNT_CODEX_ENDPOINT` | (none) | Alias for `AGNT_AGENT_ENDPOINT` for the Codex provider specifically. |

## Relay + transport

| Var | Default | Purpose |
|---|---|---|
| `AGNT_RELAY` | (none) | WebSocket relay URL (e.g. `ws://localhost:9000/relay`, `wss://relay.example.com/relay`). Required when not using `scripts/run-local-agnt.sh`. |
| `AGNT_TRUST_PROXY` | `false` | When `true`, the relay trusts the `X-Forwarded-For` header. Only enable behind a trusted reverse proxy. |

## State + paths

| Var | Default | Purpose |
|---|---|---|
| `AGNT_HOME` | `~/.agnt` | Override the agnt state root. Affects daemon-state, secure-device-state, push-state, etc. |
| `AGNT_DEVICE_STATE_DIR` | `~/.agnt` | Override only the secure-device-state directory. Used by tests. |
| `AGNT_DEVICE_STATE_FILE` | `device.json` | Override the secure-device-state filename within the dir. |
| `AGNT_DEVICE_STATE_KEYCHAIN_MOCK_FILE` | (none) | Test-only — point the bridge at a mock keychain file instead of the real macOS keychain. |
| `AGNT_DESKTOP_IPC_SOCKET` | (system default) | Override the desktop IPC socket path used by the Codex desktop refresher. |

Provider-specific env that sit alongside agnt's:

| Var | Used by | Purpose |
|---|---|---|
| `CODEX_HOME` | Codex provider | Override `~/.codex` location. |
| `CLAUDE_HOME` | Claude provider | Override `~/.claude` location. |
| `CLAUDE_CLI_PATH` | Claude provider | Explicit path to the `claude` binary. |
| `OPENCODE_HOME` | opencode provider | Override `~/.local/share/opencode` location. |
| `XDG_DATA_HOME` | opencode provider | Standard XDG location for opencode home. |
| `CURSOR_HOME` | Cursor provider | Override `~/.cursor` location. |
| `CURSOR_CLI_PATH` | Cursor provider | Explicit path to the `cursor-agent` binary. |

## Desktop refresher (Codex only)

| Var | Default | Purpose |
|---|---|---|
| `AGNT_REFRESH_ENABLED` | `true` if Codex.app is detected | Enable/disable the macOS Codex.app companion refresh. |
| `AGNT_REFRESH_DEBOUNCE_MS` | `2000` | Debounce window for refresh signals. |
| `AGNT_REFRESH_COMMAND` | (built-in) | Override the AppleScript / shell command used to refresh Codex.app. |
| `AGNT_CODEX_BUNDLE_ID` | `com.openai.codex` | Override Codex.app bundle id (advanced — for non-default Codex builds). |

## Voice transcription (Codex only)

| Var | Default | Purpose |
|---|---|---|
| `AGNT_VOICE_UPLOAD_USER_AGENT` | Safari-like macOS UA | Override the User-Agent used for bridge-proxied ChatGPT transcription uploads. Useful if ChatGPT rejects Node's default fetch identity. |

## Wake / service supervision

| Var | Default | Purpose |
|---|---|---|
| `AGNT_KEEP_MAC_AWAKE` | `false` | Hold an idle-sleep inhibitor while the bridge is connected so the host doesn't sleep mid-session. macOS uses `caffeinate -i -w <pid>`; Linux uses `systemd-inhibit --what=idle:sleep` if available. The setting is preserved as `AGNT_KEEP_MAC_AWAKE` for compatibility but applies on both platforms. |

The built-in service installer (`agnt up` / `agnt start` / `agnt stop` / `agnt status`) writes a launchd plist to `~/Library/LaunchAgents/com.dotbrains.agnt.bridge.plist` on macOS, and a systemd-user unit to `~/.config/systemd/user/com.dotbrains.agnt.bridge.service` on Linux. Headless Linux boxes that should keep the bridge running across logout need `loginctl enable-linger $USER`.

## Push notifications (optional, self-hosted)

Push delivery is **off by default**. Set these only if you're operating an APNs push service and want delivery for your iPhone:

| Var | Default | Purpose |
|---|---|---|
| `AGNT_ENABLE_PUSH_SERVICE` | `false` | Master toggle. |
| `AGNT_PUSH_SERVICE_URL` | (none) | URL of your push delivery service. |
| `AGNT_PUSH_STATE_FILE` | `<state>/push.json` | Where the bridge persists push subscription state. |
| `AGNT_PUSH_PREVIEW_MAX_CHARS` | `120` | Max characters of message preview to include in the APNs payload. |
| `AGNT_APNS_BUNDLE_ID` | (none) | iOS app bundle id for APNs. |
| `AGNT_APNS_TEAM_ID` | (none) | Apple Developer team id. |
| `AGNT_APNS_KEY_ID` | (none) | APNs key id. |
| `AGNT_APNS_PRIVATE_KEY` | (none) | APNs private key (string). |
| `AGNT_APNS_PRIVATE_KEY_FILE` | (none) | Alternative — path to a `.p8` file. |

If you set `AGNT_ENABLE_PUSH_SERVICE=true` without the rest, the bridge refuses to start and tells you what's missing.

## Bootstrap

| Var | Default | Purpose |
|---|---|---|
| `AGNT_SKIP_BOOTSTRAP` | (unset) | When set, skip every provider's postinstall bootstrap hook. Useful for offline installs. |
| `AGNT_SKIP_CODEX_BOOTSTRAP` | (unset) | Skip only the Codex CLI bootstrap. |

## Registry

| Var | Default | Purpose |
|---|---|---|
| `AGNT_REGISTRY_URL` | npm public | Override the npm registry used during bootstrap (private mirrors). |

## Defaults file

For repeatable configurations, put env into `~/.agnt/env` (or wherever you'd like) and `source` it before running `agnt up`. The bridge does not auto-load any env file — that's intentional, because a malicious env file in your home is a real risk vector.

## Dev / testing

| Var | Used by | Purpose |
|---|---|---|
| `AGNT_RELAY_BIND_HOST` | `scripts/run-local-agnt.sh`, `relay/server.js` | Interface the local relay binds to. Default `0.0.0.0`. |
| `AGNT_RELAY_PORT` | `scripts/run-local-agnt.sh`, `relay/server.js` | Local relay port. Default `9000`. |
| `AGNT_RELAY_HOSTNAME` | `scripts/run-local-agnt.sh` | Hostname clients use to reach the relay. Default `LocalHostName.local` then `hostname` then `localhost`. |
| `AGNT_RELAY_URL` | `scripts/run-local-agnt.sh` | Full relay URL to advertise for tunnel/reverse-proxy testing. Equivalent to `--relay-url`; `http(s)` is normalized to `ws(s)` and `/relay` is appended when needed. |
