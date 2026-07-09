# Testing

agnt bridge and relay tests use Node's built-in test runner (`node:test`). No Jest, no Mocha — just `node --test`.

## Running

```sh
# All tests
npm test --prefix agnt-bridge

# A single file
node --test agnt-bridge/test/cursor-translate.test.js

# A subset (e.g. translator tests for any provider)
node --test agnt-bridge/test/*-translate.test.js
```

The main CI workflow (`.github/workflows/ci.yml`) runs package checks for bridge, relay, web, host, Android, iOS, and Markdown links when their owned surfaces change.

The scheduled Link Check workflow (`.github/workflows/link-check.yml`) keeps the weekly/manual link-rot scan separate from PR/push CI.

## Conventions

| Convention | Example |
|---|---|
| One test file per source file or feature area | `bridge-relay-helpers.test.js` covers the relay-bound helpers in `bridge.js` |
| Files named `<feature>.test.js` | `claude-translate.test.js`, `codex-transport.test.js` |
| Top-of-file header comment with FILE / Purpose / Layer / Exports / Depends on | every test file follows this |
| Pure unit tests, no real network or real spawning | tests inject `execFileSyncImpl`, `spawnImpl`, `fsModule`, etc. |
| Real filesystem only when essential | rollout tests use `fs.mkdtempSync(os.tmpdir())` and clean up |
| Helpers private to the test file at the bottom | `withTempDaemonEnv()` in `macos-launch-agent.test.js`, `setupTranslator()` in translator tests |

The pattern is "constructor-injection of every external dependency." Each module that touches the world (filesystem, child_process, env, time) accepts overrides:

```js
function createCursorTransport({
  env = process.env,
  spawnImpl = spawn,             // ← test injects a fake
  binPath = "",
  cwd = process.cwd(),
} = {}) { ... }
```

## Coverage map

| Test file | Source under test | What it asserts |
|---|---|---|
| `bridge.test.js` | `bridge.js` | relay watchdog, sleep/wake handling, status heartbeat, bridge preferences, image-sanitization |
| `bridge-relay-helpers.test.js` | `bridge.js` | normalize Codex `payload`/`result`, byte-cap retries, emergency single-turn fallback, JSONL fallback gating |
| `bridge-desktop-ipc-integration.test.js` | `bridge.js` + `desktop-ipc-*` | macOS Codex.app companion mirror integration |
| `secure-transport.test.js` | `secure-transport.js` | encrypted session lifecycle, replay, ack semantics, QR bootstrap |
| `secure-device-state.test.js` | `secure-device-state.js` | trusted-pair persistence, device identity rotation |
| `qr.test.js` | `qr.js` | QR payload generation |
| `daemon-state.test.js` | `daemon-state.js` | `bridge-status.json`, `daemon.json`, `pairing.json` lifecycle |
| `macos-launch-agent.test.js` | `macos-launch-agent.js` | plist generation, `launchctl` interactions, orphan run-service cleanup |
| `agnt-cli.test.js` | `bin/agnt.js` | CLI subcommand dispatch + flag parsing |
| `account-status.test.js` | `account-status.js` (Codex) | account status + auth state |
| `voice-handler.test.js` | `voice-handler.js` (Codex) | voice transcription, ChatGPT auth gating |
| `git-handler.test.js` | `git-handler.js` | git ops triggered from phone, title generation |
| `project-handler.test.js` | `project-handler.js` | workspace project discovery |
| `desktop-handler.test.js` | `desktop-handler.js` | Codex.app message bridging |
| `desktop-ipc-action-follower.test.js` | `desktop-ipc-action-follower.js` | IPC action sequencing |
| `workspace-image.test.js` | `workspace-handler.js` | image read sandbox + sanitization |
| `provider-translator.test.js` | `providers/types.js` | `withTranslator` contract, error isolation |
| `codex-transport.test.js` | `providers/codex/transport.js` | Codex spawn + WebSocket modes |
| `codex-cli-bootstrap.test.js` | `providers/codex/cli-bootstrap.js` | Codex CLI install nudge |
| `codex-desktop-refresher.test.js` | `providers/codex/desktop-refresher.js` | debounced Codex.app refresh |
| `codex-session-jsonl-history.test.js` | `providers/codex/session-jsonl-history.js` | rollout schema parsing, paginated reads |
| `claude-translate.test.js` | `providers/claude/translate.js` | stream-json ↔ JSON-RPC mapping, tool dispatch |
| `claude-transport.test.js` | `providers/claude/transport.js` | spawn lifecycle, soft-interrupt + auto-respawn, `--resume` |
| `opencode-translate.test.js` | `providers/opencode/translate.js` | REST/SSE mapping, approval flow, toast notices |
| `cursor-translate.test.js` | `providers/cursor/translate.js` | spawn-per-turn flow, tool-call dispatch |
| `rollout-watch.test.js` | `rollout-watch.js` | Codex rollout file tailing |
| `rollout-live-mirror.test.js` | `rollout-live-mirror.js` | Codex desktop-companion mirror watcher |
| `ios-app-compatibility.test.js` | (cross-cutting) | iOS protocol-version compatibility |
| `package-version-status.test.js` | `bridge.js` | published-version status reporting |
| `push-notification-tracker.test.js` | `push-notification-tracker.js` | dedup + delivery tracking |
| `push-notification-service-client.test.js` | `push-notification-service-client.js` | self-hosted push delivery client |
| `push-notification-completion-dedupe.test.js` | (cross-cutting) | end-of-turn push dedupe |

This list is a starting map, not a generated inventory; use `find agnt-bridge/test -name '*.test.js'` for the current bridge test set.

## Adding tests

The two most relevant templates:

- **Translator tests:** `cursor-translate.test.js` — clean, modern style with a `setupTranslator()` helper. Mock `injectInbound` as a `[]` and assert against parsed JSON.
- **Transport tests:** `claude-transport.test.js` — uses `spawnImpl` injection to simulate child process events.

Bridge-core tests (`bridge.test.js`, `bridge-relay-helpers.test.js`) export module-level helpers and call them directly. If you're testing a helper currently inside `startBridge()`'s closure, lift it to module scope first (with explicit dependency injection) — the JSONL-fallback refactor in commit `620bb4a` is a worked example.

## What we don't test

Honest list:

- **End-to-end iOS-to-bridge flows.** The iOS app has its own unit tests (`AgntMobileTests/`) but there's no full-stack integration test that drives the WebSocket from a fake iOS client through the bridge to a fake provider. This would catch protocol drift but is currently absent.
- **Full relay deployment behavior.** Relay unit tests cover the server core, but CI does not exercise a real deployed relay.
- **Manual smoke tests.** Verifying QR pairing actually works requires a real iPhone. The CI badge can't tell you the secure transport is healthy on real iOS hardware.

## Running tests in CI

The main CI workflow uses one change detector and only runs jobs for changed surfaces:

| Surface | CI command |
|---|---|
| Bridge | `cd agnt-bridge && bun run ci` |
| Relay | `cd relay && bun run ci` |
| Web | `cd agnt-web && bun run ci` |
| Host | `cd agnt-host && bun run ci` |
| Android | `cd AgntAndroid && ./gradlew :app:ktlintCheck :app:testDebugUnitTest :app:assembleDebug --no-daemon` |
| iOS | `xcodebuild ... archive CODE_SIGNING_ALLOWED=NO` |
| Markdown links | `lycheeverse/lychee` over `./**/*.md` |

The standalone Link Check workflow is scheduled/manual only; PR and push link checks run inside main CI so each change gets one CI suite.
