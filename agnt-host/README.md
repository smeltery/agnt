# Agnt Host

A local-first desktop app (Tauri 2 + React) that manages the agnt bridge and relay
on your machine. Handles QR-pairing UI, system tray, and the local-relay/remote-relay
mode switch so you don't need to keep a terminal open running `agnt up`.

This is the desktop counterpart to the `AgntMobile` (iOS) and `AgntAndroid` clients.
Ported from the upstream `Stivy-01/remodex` `remodex-host`, with branding and bundled
sources adapted for agnt.

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

## Branding deltas vs upstream

| Item | Upstream | agnt |
| --- | --- | --- |
| Crate / package name | `remodex-host` | `agnt-host` |
| App identifier | `com.remodex.host` | `com.dotbrains.agnt.host` |
| Bundled bridge directory | `phodex-bridge` | `agnt-bridge` |
| Bridge entry script | `bin/remodex.js` | `bin/agnt.js` |
| Bundle manifest | `remodex-bundle.json` | `agnt-bundle.json` |
| Bridge env vars | `REMODEX_RELAY`, `REMODEX_PRINT_PAIRING_JSON` | `AGNT_RELAY`, `AGNT_PRINT_PAIRING_JSON` |
| Updater env vars | `REMODEX_HOST_UPDATE_*` | `AGNT_HOST_UPDATE_*` |
| Default remote relay URL | `wss://relay.remodex.app` | `ws://127.0.0.1:9000` (local; user must configure self-hosted relay) |
| Updater endpoint | Stivy-01/remodex releases | `dotbrains/agnt` releases |
| Updater pubkey | Stivy-01 minisign key | placeholder — regenerate before release |
| Provider-bridge secret file | `remodex-host/provider-bridge-secrets.json` | `agnt-host/provider-bridge-secrets.json` |
| Provider-bridge key env | `DEEPSEEK_API_KEY` | `AGNT_PROVIDER_BRIDGE_API_KEY` (falls back to `DEEPSEEK_API_KEY`) |
| Provider-bridge secret schema | `{ deepseek_api_key }` | `{ api_key }` (provider-agnostic) |
| License | ISC | Apache-2.0 |

## TODO before first release

- Regenerate the Tauri updater minisign keypair and replace the placeholder
  `pubkey` in `tauri.conf.json`. Keep the private key out of git.
- Replace upstream icons (`src-tauri/icons/`) with agnt-branded artwork. Current
  icons are inherited from `remodex-host` and must be rebranded before any
  public release.
- Verify macOS / Linux Tauri targets and add to `tauri:build:*` scripts.
- Wire up CI to build and sign installers.
