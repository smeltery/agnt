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

The upstream Android client assumes a Codex-only bridge.
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
| Surface `system/notice` toasts                             | yes               | yes               | yes               | iOS: `CodexService.handleSystemNotice` → `systemNotices` → `SystemNoticeBannerView` top overlay, with severity defaults, auto-dismiss, and manual close. Android: `IncomingEventRouter` → `SystemNoticesStore` → `MainShell.SystemNoticeHost` (severity-colored bottom pills, per-severity auto-dismiss, manual close, reconnect clear). Web: `useNoticesStore` from `agnt-web/src/state/notices-store.ts`. |
| Render reasoning deltas (Claude / Codex)                   | yes               | yes               | yes               | Codex-style reasoning rendering ported from upstream. Claude `system.init` reasoning shape needs runtime verification. |
| Finalize turn on turnless desktop-mirror `agent_message`   | n/a (Codex-only)  | n/a (Codex-only)  | yes               | Codex desktop-mirror path emits no `turn/completed`, so `IncomingEventRouter` routes `codex/event/agent_message` with `completesTurn = true`; `handleItemCompleted` / `handleLegacyAgentCompleted` call `onTurnFinished` when the turn id is absent, clearing the running fallback. Regression: `IncomingEventRouterDesktopMirrorTest`. |
| Per-turn provider flags (`params.model`, plan mode, …)     | yes               | yes               | yes               | Composer's selected-model override is sent as `params.model` on every `turn/start` (`runtimeModelIdentifierForTurn`); Claude / Cursor read it directly, opencode falls back from `modelID` (regression-pinned). Plan-mode toggle in the composer attachment menu wires `params.collaborationMode.mode = "plan"`, which the Claude bridge translator maps to `--permission-mode plan`. Granular per-turn `permissionMode` values (`acceptEdits` / `bypassPermissions` / `dontAsk`) aren't surfaced in the composer — deferred follow-up. |
| Runtime-persisted thread goals (`thread/goal/*`)           | yes               | yes               | yes               | Android mirrors `thread/goal/updated|cleared`, supports `thread/goal/get|set|clear`, and exposes a composer-adjacent goal chip/dialog for create, edit, pause, resume, budget, and clear. Coverage: `CodexThreadGoalTest`, `IncomingEventRouterNotificationTest`. |

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
| Thread goal controls | done — `CodexThreadGoal` model + repository/service RPC helpers, live notification mirror, and `ThreadGoalControl` in the chat composer area. |
| Project/git flow (picker, dir mgmt, git init) | done |
| iOS-style navigation, composer, settings, picker, onboarding, and grouped form chrome | done |
| Sidebar redesign (color palette, active-chat metadata, new-worktree sheet, recent-workspaces carousel) | done — `SidebarColorPalette`/`AgntPopupChrome` ported, `SidebarActiveChatMetadata` threaded through screen → row + picker, `SidebarNewWorktreeSheet` added, project picker now surfaces current workspace + recent-workspaces carousel + `NewThreadSessionType` selector. `Theme.kt` `SystemBars` helper deferred (separate behavior). |
| On-device SSH terminal (xterm.js + sshj) | done — sidebar entry → full-screen `TerminalScreen` powered by `sshj` and an xterm.js WebView; bridge advertises `hostCapabilities.terminal: true`. WebView fallback is a real Termux-based native emulator (see below). iOS-only per-turn "Open Terminal Here" toolbar entry not ported. |
| Native terminal renderer (Termux fallback) | done — `TermuxTerminalSurface.kt` ported from the original import; Apache-2.0 `com.termux.termux-app:terminal-view + terminal-emulator` deps resolved via JitPack. Replaces the previous static-text `TerminalFallbackSurface` (now deleted) as the WebView-unavailable fallback. Visual verification on a device still pending. |
| Windows-over-SSH setup guide | done — `TerminalWindowsSetupGuide.kt` ported from the original import with branding scrubbed; surfaced as a collapsible Help section in `TerminalConnectionEditorSheet`. Self-contained (Material 3 `Surface`); does not depend on the upstream `remodexFlatControlChrome` modifier or `TerminalFormChrome` helpers. |
| QR pairing hardening — short codes + pasteable code prefix (`QrScannerScreen.kt` +136, `QrPairingValidator.kt` +87, +3 tests) | done — short-code regex `[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,12}` + `RMX1:`-prefixed base64 pasteable codes (matching iOS `QRScannerPairingValidator.swift`); `QrPairingValidationResult.ShortCode` sealed case; `normalizeShortPairingCode` / `decodePasteablePairingCode` helpers. Manual-entry dialog now uses a smart parser (`parseManualPairingInput`) that extracts pairing code + relay URL from arbitrary pasted text and a multi-candidate resolver (`manualRelayCandidates` → pasted / saved snapshot / trusted-Mac registry / `AppEnvironment.relayBaseURL`) — the upstream "Relay URL for short codes" input field has been dropped. Renamed `looksLikeRemodexPairingPayload` → `looksLikeAgntPairingPayload` and rebranded "Update Remodex" copy → "Update agnt" to match iOS. 562 unit tests green, ktlint clean. |
| Companion pet overlay (iOS `Features/Pet/`) | done — `core/model/PetCompanion.kt` (phases/atlas/layout), `services/agent/pet/AgentServicePets.kt` (`pet/list` + `pet/read` via `CodexRepository.sendRequest`), `data/PetCompanionStore.kt` + `PetCompanionStatus.kt` (persistence + pure status derivation including failed/review/completion-banner phases), `ui/pet/PetCompanionOverlay.kt` (atlas decode/crop/animate + drag + status pill) wired into `MainShell` via `PetCompanionHost`; Settings `Companion pet` card toggles + picks the pet. Bridge handler (`agnt-bridge/src/handlers/pet-handler.js`) is provider-agnostic, so this works under any active CLI. `AgentService` now feeds live failed/ready/completion-banner state from turn lifecycle notifications and clears it when the thread is viewed or starts again. Visual verification on a device still pending. |
| End-to-end local flow validation    | done            |
| Markdown / message pixel polish (upstream commit c7843aa) | partial — collapsible search citation accessory ported; remaining pixel-level differences still need screenshot/device verification |
| Manual device pairing + visual screenshot verification | pending — remaining iOS/Android visual differences should be verified on device or screenshot baselines rather than inferred from code inspection |
| Live Activity / Dynamic Island (iOS `AgntWidget/`) | iOS-only — done on iOS (Live Activity + Dynamic Island surface an in-flight turn on the Lock Screen via local ActivityKit updates). No direct Android analog; the equivalent would be an ongoing/foreground status notification, not yet built. Tracked as an Android gap, not an upstream port. |
| Workspace text-file preview | done — `core/model/WorkspaceTextFileModels.kt`, `services/workspace/WorkspaceTextFileService.kt` (uses the existing `workspace/readFile` RPC), and `ui/turn/WorkspaceTextFilePreviewDialog.kt` (`AgntModalBottomSheet`) ported with tests. Wired into `MainShell`: tapping a repo-file link in assistant markdown opens the read-only preview when the repo-diff sheet isn't applicable (clean tree / no git / no active thread), reusing the existing `RepoMarkdownFileLink` detection rather than a new file-mention parser. |
| Workspace SVG preview — hardened WebKit render | done — iOS uses `WorkspaceSVGPreview.swift`; Android now detects `.svg` in `WorkspaceTextFilePreviewDialog.kt`, loads the source through the existing `workspace/readFile` path, and renders it in `WorkspaceSvgPreview.kt` as offline WebView artwork with JavaScript disabled, network/file access blocked, strict CSP, and external `href`/`src` stripping. Sanitizer/path/navigation rules are covered by `WorkspaceSvgPreviewSecurityTest`. |
| Syntax-highlighted code preview | done — iOS uses Runestone + TreeSitter in `AgntMobile/Features/Chat/Timeline/WorkspaceRunestoneCodeView.swift`; Android uses `WorkspaceCodePreview` for line-numbered, selectable workspace text previews with common token highlighting and a 512 KB highlight cap. |
| User bubble color | done — `core/model/UserBubbleColor.kt`, `data/UserBubblePreferences.kt` (storage key rebranded `codex.userBubbleColor` → `agnt.userBubbleColor`, reuses `ThemePreferences` store), `ui/theme/UserBubbleColorPalette.kt` ported with tests. Applied in `ui/turn/timeline/TurnMessageRow.kt` (user bubble background + foreground) via a `LocalUserBubbleColor` CompositionLocal provided by `AgntTheme` (listens to the pref so the timeline recomposes on change); a swatch picker lives in `ui/settings/SettingsScreen.kt`. |
| Relay health client | done — `core/model/RelayHealthModels.kt` + `services/RelayHealthClient.kt` (polls the relay `GET /health` exposed by `relay/server.js`; log tag rebranded `RemodexRelayHealth` → `AgntRelayHealth`) with parser test. Reuses agnt's `SessionPersistence.loadRelaySnapshot()` + `validateRelayUrl()`. |
| New-chat draft flow | done — `ui/draft/NewChatDraftLogic.kt` + `NewChatDraftModels.kt` ported with tests; `ui/draft/NewChatDraftScreen.kt` adapted to agnt with the freemium `SubscriptionService` gate dropped entirely. Wired into nav via `AppRoutes.NewChatDraft` + a destination in `AppNavHost`, reachable from the sidebar "Quick Chat" action (`SidebarScreen` → `SidebarDrawerContent`); the existing project-picker sheet new-chat path is left intact. |
| Home Screen quick actions | done — Android publishes dynamic launcher shortcuts for New Chat plus the two most recent live threads via `AgntShortcutPublisher`; `MainActivity` routes cold/warm shortcut launches through `AppContainer.shortcutLaunches`, and `MainShell` opens the new-chat draft or selects the target thread. |
| Multi-device switcher / "My Devices" (iOS PR #100) | done — `core/persistence/MacScopedSessionStore.kt`, `services/agent/connection/AgntTrustedSessionResolveClient.kt`, and `services/agent/devices/{AgentServiceTrustedDevices,AgentServiceDeviceSwitch}.kt` wire per-device trusted-session resolve + scoped session state into `AgentService` (`trustedDevices`/`switchingDeviceId`/`deviceSwitchNotice`/`currentTrustedMacDeviceId`/`previousTrustedMacDeviceId`/`relayMacDeviceId` flows + `switchToTrustedDevice`/`switchToScannedDevice`/`cancelDeviceSwitch`/`forgetTrustedDevice`/`setDeviceMenuVisible`). UI `ui/mydevices/MyDevicesScreen.kt` + `MyDevicesPresentation.kt`, nav route `AppRoutes.MyDevices`, sidebar entry (`lucide_ic_monitor_smartphone`), and inline sidebar quick-switch dropdown now share the same switcher-row presentation helpers. Provider-agnostic (no freemium gate). Tests: `MyDevicesPresentationTest`, `MacScopedSessionStoreTest`. Deferred: mac-scoped message-timeline store (timeline stays un-scoped, same as iOS PR #100) and composer-draft scoping (agnt has no composer-draft store). |

## Build / CI

| Item                          | Status |
| ---                           | ---    |
| `./gradlew :app:testDebugUnitTest` runs Kotlin tests | yes |
| Lint / ktlint                 | ktlint wired into CI; Android Lint runs clean against a baseline (`lint-baseline.xml`) — pre-existing 20 errors / 163 warnings / 6 hints snapshotted, gates only NEW findings. Categories listed in ROADMAP. |
| CI workflow `ci.yml` / `android` job | yes (unit tests + assemble debug) |
| Release signing               | requires `key.properties` at repo root, not committed |
