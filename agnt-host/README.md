# Agnt Host

A local-first desktop app (Tauri 2 + React) that manages the agnt bridge and relay
on your machine. Handles QR-pairing UI, system tray, and the local-relay/remote-relay
mode switch so you don't need to keep a terminal open running `agnt up`.

This is the desktop counterpart to the `AgntMobile` (iOS) and `AgntAndroid` clients.
Forked from an Apache-2.0 desktop host, with branding and bundled sources adapted for
agnt (see `NOTICE` for attribution).

## Status

Initial port. Builds on Windows; macOS / Linux Tauri targets are present in the
crate but unverified. The updater pubkey and endpoint are placeholders — see
`src-tauri/tauri.conf.json` and regenerate before publishing a release.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | React 19 + Vite frontend (popup window, settings UI, pet renderer) |
| `src-tauri/` | Rust 2021 Tauri backend (process supervision, tray, IPC commands) |
| `src-tauri/bundled/` | Generated at build time by `copy-bundled.mjs` — do not edit by hand |
| `copy-bundled.mjs` | Snapshots `../agnt-bridge` and `../relay` into `src-tauri/bundled/` so they ship in the installer |
| `scripts/create-updater-manifest.mjs` | Builds `latest.json` for the Tauri updater |
| `public/pets/relay/` | Sprite + state map for the animated relay companion |
| `run-pet/` | Asset-generation toolchain (prompts, frames, QA). Not loaded at runtime. |

## Local development

```bash
cd agnt-host
npm install
npm run dev            # Vite dev server (popup at http://localhost:5173)
npm run tauri dev      # Tauri dev with hot reload
```

Production build:

```bash
npm run copy-bundled
npm run tauri build
```

On Windows, `npm run tauri:build:windows` produces NSIS + MSI installers.

## Key identifiers

| Item | agnt |
| --- | --- |
| Crate / package name | `agnt-host` |
| App identifier | `com.dotbrains.agnt.host` |
| Bundled bridge directory | `agnt-bridge` |
| Bridge entry script | `bin/agnt.js` |
| Bundle manifest | `agnt-bundle.json` |
| Bridge env vars | `AGNT_RELAY`, `AGNT_PRINT_PAIRING_JSON` |
| Updater env vars | `AGNT_HOST_UPDATE_*` |
| Default remote relay URL | `ws://127.0.0.1:9000` (local; user must configure self-hosted relay) |
| Updater endpoint | `dotbrains/agnt` releases |
| Updater pubkey | placeholder — regenerate before release |
| Provider-bridge secret file | `agnt-host/provider-bridge-secrets.json` |
| Provider-bridge key env | `AGNT_PROVIDER_BRIDGE_API_KEY` (falls back to `DEEPSEEK_API_KEY`) |
| Provider-bridge secret schema | `{ api_key }` (provider-agnostic) |
| License | Apache-2.0 |

## TODO before first release

- Regenerate the Tauri updater minisign keypair and replace the placeholder
  `pubkey` in `tauri.conf.json`. Keep the private key out of git.
- Replace the inherited placeholder icons (`src-tauri/icons/`) with agnt-branded
  artwork before any public release.
- Verify macOS / Linux Tauri targets and add to `tauri:build:*` scripts.
- Wire up CI to build and sign installers.
