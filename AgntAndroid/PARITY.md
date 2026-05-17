# AgntAndroid parity

Tracks Android-client feature parity against the canonical clients (iOS
`AgntMobile/` and browser `agnt-web/`). Update this file whenever a surface
lands or its scope changes.

## Secure transport / protocol

| Constant / Behavior                      | iOS                                    | Web                                     | Android (this module)            | Status |
| ---                                      | ---                                    | ---                                     | ---                              | ---    |
| Handshake tag                            | `agnt-e2ee-v1`                         | `agnt-e2ee-v1`                          | `agnt-e2ee-v1`                   | parity |
| Pairing QR version                       | 2                                      | 2                                       | 2                                | parity |
| Secure protocol version                  | 1                                      | 1                                       | 1                                | parity |
| Trusted-session resolve tag              | `agnt-trusted-session-resolve-v1`      | `agnt-trusted-session-resolve-v1`       | `agnt-trusted-session-resolve-v1`| parity |
| Sender id (client)                       | `iphone`                               | `iphone` (query `?role=iphone`)         | `iphone` (query `?role=iphone`)  | parity |
| Workspace checkpoint ref prefix          | `refs/agnt/checkpoints`                | `refs/agnt/checkpoints`                 | `refs/agnt/checkpoints`          | parity |

The Android module imports the secure-transport constants from
`app/src/main/kotlin/com/dotbrains/agnt/mobile/core/model/SecureTransportModels.kt`
and the envelope cipher from `core/crypto/`. Both mirror `agnt-bridge/src/secure-transport.js`.

## Provider-agnostic protocol

The upstream Stivy-01/remodex Android client assumes a Codex-only bridge.
agnt's bridge gates Codex-only RPCs (`account/status/read`, `account/login/*`,
`voice/transcribe`, `voice/resolveAuth`, structured-JSON
`thread/generateTitle`) on `activeProvider.id === "codex"`. Non-Codex providers
get a synthetic "managed externally" response.

| Behavior                                                   | iOS               | Web               | Android           | Notes |
| ---                                                        | ---               | ---               | ---               | ---   |
| Tolerate Codex-only RPC `managed externally` replies       | yes               | yes               | partial           | see ROADMAP — UI hides the affected affordances when active provider != codex; needs audit |
| Render `thread/initialized` skills/tools from any provider | yes               | yes               | yes (Codex shape) | parity for Codex/Claude `system.init`; opencode/Cursor default tool lists land via same RPC, should "just work" — needs runtime verification |
| Handle opencode `item/commandExecution/requestApproval`    | yes               | yes               | **no**            | Approval UI not yet wired. Tracked in ROADMAP. |
| Handle opencode `item/fileChange/requestApproval`          | yes               | yes               | **no**            | Same as above. |
| Reject overlapping `turn/start` with code `-32003`         | n/a (bridge does) | n/a (bridge does) | n/a (bridge does) | The bridge-side translator enforces this. Client just surfaces the error. |
| Surface `system/notice` toasts                             | yes               | yes               | needs verify      | UI plumbing exists; routing check pending. |
| Render reasoning deltas (Claude / Codex)                   | yes               | yes               | yes               | Codex-style reasoning rendering ported from upstream. Claude `system.init` reasoning shape needs runtime verification. |
| Per-turn provider flags (`params.model`, plan mode, …)     | yes               | yes               | partial           | Composer accepts model override; plan mode not yet exposed. |

## UI / feature parity (vs iOS, inherited from upstream parity audit)

The upstream audit (see `ios-android-parity-plan.md`) reports 24 of 32
applicable iOS commits ported, 1 partial, and 7 iOS-only. Notable areas:

| Area                                | Status (vs iOS) |
| ---                                 | ---             |
| Reconnect + usage polish            | done            |
| Timeline rendering (commands, diffs, thinking, images, collapse) | done |
| Image preview caching               | done            |
| Workspace checkpoint lifecycle      | done            |
| Composer features (skill mentions, runtime overrides, autocomplete) | done |
| Project/git flow (picker, dir mgmt, git init) | done |
| iOS-style navigation, composer, settings, picker, onboarding, and grouped form chrome | done |
| On-device SSH terminal (xterm.js + sshj) | done — sidebar entry → full-screen `TerminalScreen` powered by `sshj` and an xterm.js WebView; bridge advertises `hostCapabilities.terminal: true`. iOS-only per-turn "Open Terminal Here" toolbar entry not ported. |
| End-to-end local flow validation    | done            |
| Markdown / message pixel polish (upstream commit c7843aa) | pending |
| Manual device pairing + visual screenshot verification | pending — remaining iOS/Android visual differences should be verified on device or screenshot baselines rather than inferred from code inspection |

## Build / CI

| Item                          | Status |
| ---                           | ---    |
| `./gradlew :app:testDebugUnitTest` runs Kotlin tests | yes |
| Lint / ktlint                 | not configured; tracked in ROADMAP |
| CI workflow `android-check.yml` | yes (unit tests + assemble debug) |
| Release signing               | requires `key.properties` at repo root, not committed |
