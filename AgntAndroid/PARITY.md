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
| Tolerate Codex-only RPC `managed externally` replies       | yes               | yes               | yes               | Audit complete (see ROADMAP). `account/login/*`, `account/status/read`, `account/logout`, `account/login/openOnMac`, `getAuthStatus` — never called from Android. `thread/generateTitle` — wrapped in `runCatching { ... }.getOrNull()`. `voice/resolveAuth` / `voice/transcribe` — pre-emptively gated: bridge publishes `providerId` on `initialize`, parsed into `CodexRepository.activeProvider: StateFlow<ActiveProvider>`, mic hidden for Claude / opencode / Cursor. Older bridges (no providerId) fall back to the legacy fail-once-then-hide path via `bridgeSupportsVoiceTranscription`. |
| Render `thread/initialized` skills/tools from any provider | yes               | yes               | yes (Codex shape) | parity for Codex/Claude `system.init`; opencode/Cursor default tool lists land via same RPC, should "just work" — needs runtime verification |
| Handle opencode `item/commandExecution/requestApproval`    | yes               | yes               | yes               | `IncomingEventRouter` matches → `pendingApprovalRequest` StateFlow → `MainShell` `AlertDialog` → `{decision: "accept"\|"decline"\|"acceptForSession"}`. |
| Handle opencode `item/fileChange/requestApproval`          | yes               | yes               | yes               | Same matcher / dialog; `acceptForSession` 3-button mode is gated to command approvals only (matches iOS). |
| Reject overlapping `turn/start` with code `-32003`         | n/a (bridge does) | n/a (bridge does) | n/a (bridge does) | The bridge-side translator enforces this. Client just surfaces the error. |
| Surface `system/notice` toasts                             | **no** (unported) | yes               | yes               | Android: `IncomingEventRouter` → `SystemNoticesStore` → `MainShell.SystemNoticeHost` (severity-colored bottom pills, per-severity auto-dismiss, manual close, reconnect clear). Web: `useNoticesStore` from `agnt-web/src/state/notices-store.ts`. iOS: PARITY previously claimed yes; a code search shows zero `system/notice` references in `AgntMobile/` — would need to be added when iOS catches up. |
| Render reasoning deltas (Claude / Codex)                   | yes               | yes               | yes               | Codex-style reasoning rendering ported from upstream. Claude `system.init` reasoning shape needs runtime verification. |
| Finalize turn on turnless desktop-mirror `agent_message`   | n/a (Codex-only)  | n/a (Codex-only)  | yes               | Codex desktop-mirror path emits no `turn/completed`, so `IncomingEventRouter` routes `codex/event/agent_message` with `completesTurn = true`; `handleItemCompleted` / `handleLegacyAgentCompleted` call `onTurnFinished` when the turn id is absent, clearing the running fallback. Regression: `IncomingEventRouterDesktopMirrorTest`. |
| Per-turn provider flags (`params.model`, plan mode, …)     | yes               | yes               | yes               | Composer's selected-model override is sent as `params.model` on every `turn/start` (`runtimeModelIdentifierForTurn`); Claude / Cursor read it directly, opencode falls back from `modelID` (regression-pinned). Plan-mode toggle in the composer attachment menu wires `params.collaborationMode.mode = "plan"`, which the Claude bridge translator maps to `--permission-mode plan`. Granular per-turn `permissionMode` values (`acceptEdits` / `bypassPermissions` / `dontAsk`) aren't surfaced in the composer — deferred follow-up. |

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
| Sidebar redesign (color palette, active-chat metadata, new-worktree sheet, recent-workspaces carousel) — upstream 8de65e2 + f35c4c6 | done — `SidebarColorPalette`/`AgntPopupChrome` ported, `SidebarActiveChatMetadata` threaded through screen → row + picker, `SidebarNewWorktreeSheet` added, project picker now surfaces current workspace + recent-workspaces carousel + `NewThreadSessionType` selector. `Theme.kt` `SystemBars` helper deferred (separate behavior). |
| On-device SSH terminal (xterm.js + sshj) | done — sidebar entry → full-screen `TerminalScreen` powered by `sshj` and an xterm.js WebView; bridge advertises `hostCapabilities.terminal: true`. WebView fallback is a real Termux-based native emulator (see below). iOS-only per-turn "Open Terminal Here" toolbar entry not ported. |
| Native terminal renderer (Termux fallback) | done — `TermuxTerminalSurface.kt` ported from upstream Stivy-01/remodex 245ea8a; Apache-2.0 `com.termux.termux-app:terminal-view + terminal-emulator` deps resolved via JitPack. Replaces the previous static-text `TerminalFallbackSurface` (now deleted) as the WebView-unavailable fallback. Visual verification on a device still pending. |
| Windows-over-SSH setup guide | done — `TerminalWindowsSetupGuide.kt` ported from upstream Stivy-01/remodex 245ea8a with branding scrubbed; surfaced as a collapsible Help section in `TerminalConnectionEditorSheet`. Self-contained (Material 3 `Surface`); does not depend on upstream's `remodexFlatControlChrome` modifier or `TerminalFormChrome` helpers. |
| QR pairing hardening — short codes + pasteable code prefix (upstream 245ea8a `QrScannerScreen.kt` +136, `QrPairingValidator.kt` +87, +3 tests) | done — short-code regex `[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,12}` + `RMX1:`-prefixed base64 pasteable codes (matching iOS `QRScannerPairingValidator.swift`); `QrPairingValidationResult.ShortCode` sealed case; `normalizeShortPairingCode` / `decodePasteablePairingCode` helpers. Manual-entry dialog now uses a smart parser (`parseManualPairingInput`) that extracts pairing code + relay URL from arbitrary pasted text and a multi-candidate resolver (`manualRelayCandidates` → pasted / saved snapshot / trusted-Mac registry / `AppEnvironment.relayBaseURL`) — the upstream "Relay URL for short codes" input field has been dropped. Renamed `looksLikeRemodexPairingPayload` → `looksLikeAgntPairingPayload` and rebranded "Update Remodex" copy → "Update agnt" to match iOS. 562 unit tests green, ktlint clean. |
| Companion pet overlay (iOS `Features/Pet/`) | done — `core/model/PetCompanion.kt` (phases/atlas/layout), `services/agent/pet/AgentServicePets.kt` (`pet/list` + `pet/read` via `CodexRepository.sendRequest`), `data/PetCompanionStore.kt` + `PetCompanionStatus.kt` (persistence + pure status derivation), `ui/pet/PetCompanionOverlay.kt` (atlas decode/crop/animate + drag + status pill) wired into `MainShell` via `PetCompanionHost`; Settings `Companion pet` card toggles + picks the pet. Bridge handler (`agnt-bridge/src/handlers/pet-handler.js`) is provider-agnostic, so this works under any active CLI. iOS `failed`/`review`/completion-banner phases degrade to idle until Android exposes that per-thread state. Visual verification on a device still pending. |
| End-to-end local flow validation    | done            |
| Markdown / message pixel polish (upstream commit c7843aa) | partial — collapsible search citation accessory ported; remaining pixel-level differences still need screenshot/device verification |
| Manual device pairing + visual screenshot verification | pending — remaining iOS/Android visual differences should be verified on device or screenshot baselines rather than inferred from code inspection |
| Live Activity / Dynamic Island (iOS `AgntWidget/`) | iOS-only — done on iOS (Live Activity + Dynamic Island surface an in-flight turn on the Lock Screen via local ActivityKit updates). No direct Android analog; the equivalent would be an ongoing/foreground status notification, not yet built. Tracked as an Android gap, not an upstream port. |
| Workspace text-file preview (upstream Stivy-01/remodex `55fe4c1c`) | done — `core/model/WorkspaceTextFileModels.kt`, `services/workspace/WorkspaceTextFileService.kt` (uses the existing `workspace/readFile` RPC), and `ui/turn/WorkspaceTextFilePreviewDialog.kt` (`AgntModalBottomSheet`) ported with tests. Wired into `MainShell`: tapping a repo-file link in assistant markdown opens the read-only preview when the repo-diff sheet isn't applicable (clean tree / no git / no active thread), reusing the existing `RepoMarkdownFileLink` detection rather than a new file-mention parser. |
| Workspace SVG preview — hardened WebKit render (iOS) | iOS-only so far — done on iOS (`AgntMobile/Features/Chat/Timeline/WorkspaceSVGPreview.swift`: `.svg` workspace artifacts render as artwork in an offline `WKWebView` behind a strict CSP + an external-`href`/`src` sanitizer, instead of plain XML text). Android has the workspace text-file preview (above) but still shows `.svg` as text; an artwork preview is an unbuilt Android gap, not an upstream port. |
| Syntax-highlighted code preview (iOS) | iOS-only so far — done on iOS (`AgntMobile/Features/Chat/Timeline/WorkspaceRunestoneCodeView.swift`: workspace text files render via Runestone + TreeSitter grammars with syntax highlighting, line numbers, and selection). Android's workspace text-file preview shows plain monospace text; syntax highlighting is an unbuilt Android gap, not an upstream port. |
| User bubble color (upstream `55fe4c1c`) | done — `core/model/UserBubbleColor.kt`, `data/UserBubblePreferences.kt` (storage key rebranded `codex.userBubbleColor` → `agnt.userBubbleColor`, reuses `ThemePreferences` store), `ui/theme/UserBubbleColorPalette.kt` ported with tests. Applied in `ui/turn/timeline/TurnMessageRow.kt` (user bubble background + foreground) via a `LocalUserBubbleColor` CompositionLocal provided by `AgntTheme` (listens to the pref so the timeline recomposes on change); a swatch picker lives in `ui/settings/SettingsScreen.kt`. |
| Relay health client (upstream `55fe4c1c`) | done — `core/model/RelayHealthModels.kt` + `services/RelayHealthClient.kt` (polls the relay `GET /health` exposed by `relay/server.js`; log tag rebranded `RemodexRelayHealth` → `AgntRelayHealth`) with parser test. Reuses agnt's `SessionPersistence.loadRelaySnapshot()` + `validateRelayUrl()`. |
| New-chat draft flow (upstream `55fe4c1c`) | done — `ui/draft/NewChatDraftLogic.kt` + `NewChatDraftModels.kt` ported with tests; `ui/draft/NewChatDraftScreen.kt` adapted to agnt with the freemium `SubscriptionService` gate dropped entirely. Wired into nav via `AppRoutes.NewChatDraft` + a destination in `AppNavHost`, reachable from the sidebar "Quick Chat" action (`SidebarScreen` → `SidebarDrawerContent`); the existing project-picker sheet new-chat path is left intact. |
| Multi-device switcher / "My Devices" (iOS PR #100) | partial — `core/persistence/MacScopedSessionStore.kt`, `services/agent/connection/AgntTrustedSessionResolveClient.kt`, and `services/agent/devices/{AgentServiceTrustedDevices,AgentServiceDeviceSwitch}.kt` wire per-device trusted-session resolve + scoped session state into `AgentService` (`trustedDevices`/`switchingDeviceId`/`deviceSwitchNotice`/`currentTrustedMacDeviceId`/`previousTrustedMacDeviceId`/`relayMacDeviceId` flows + `switchToTrustedDevice`/`switchToScannedDevice`/`cancelDeviceSwitch`/`forgetTrustedDevice`/`setDeviceMenuVisible`). UI `ui/mydevices/MyDevicesScreen.kt` + `MyDevicesPresentation.kt`, nav route `AppRoutes.MyDevices`, sidebar entry (`lucide_ic_monitor_smartphone`). Provider-agnostic (no freemium gate). Tests: `MyDevicesPresentationTest`, `MacScopedSessionStoreTest`. Deferred: mac-scoped message-timeline store (timeline stays un-scoped, same as iOS PR #100), composer-draft scoping (agnt has no composer-draft store), and the inline sidebar quick-switch dropdown (`shouldShowDeviceSwitcher` helper present for follow-up). |

## Build / CI

| Item                          | Status |
| ---                           | ---    |
| `./gradlew :app:testDebugUnitTest` runs Kotlin tests | yes |
| Lint / ktlint                 | ktlint wired into CI; Android Lint runs clean against a baseline (`lint-baseline.xml`) — pre-existing 20 errors / 163 warnings / 6 hints snapshotted, gates only NEW findings. Categories listed in ROADMAP. |
| CI workflow `android-check.yml` | yes (unit tests + assemble debug) |
| Release signing               | requires `key.properties` at repo root, not committed |
