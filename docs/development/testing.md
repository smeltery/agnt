# Testing

agnt has 386 unit tests using Node's built-in test runner (`node:test`). No Jest, no Mocha — just `node --test`. Tests live in `agnt-bridge/test/*.test.js`.

## Running

```sh
# All tests
npm test --prefix agnt-bridge

# A single file
node --test agnt-bridge/test/cursor-translate.test.js

# A subset (e.g. translator tests for any provider)
node --test agnt-bridge/test/*-translate.test.js
```

The bridge-check CI workflow (`.github/workflows/bridge-check.yml`) runs `npm test` on every push and PR that touches `agnt-bridge/**`.

The Build Unsigned IPA workflow (`.github/workflows/build-unsigned-ipa.yml`) archives the iOS app on every push to main and on PRs that touch `AgntMobile/**`.

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

Total: 386 tests across 32 files.

## Adding tests

The two most relevant templates:

- **Translator tests:** `cursor-translate.test.js` — clean, modern style with a `setupTranslator()` helper. Mock `injectInbound` as a `[]` and assert against parsed JSON.
- **Transport tests:** `claude-transport.test.js` — uses `spawnImpl` injection to simulate child process events.

Bridge-core tests (`bridge.test.js`, `bridge-relay-helpers.test.js`) export module-level helpers and call them directly. If you're testing a helper currently inside `startBridge()`'s closure, lift it to module scope first (with explicit dependency injection) — the JSONL-fallback refactor in commit `620bb4a` is a worked example.

## What we don't test

Honest list:

- **End-to-end iOS-to-bridge flows.** The iOS app has its own unit tests (`AgntMobileTests/`) but there's no full-stack integration test that drives the WebSocket from a fake iOS client through the bridge to a fake provider. This would catch protocol drift but is currently absent.
- **The relay server.** `relay/server.js` has no tests. It's small and inspection is the primary defense.
- **Manual smoke tests.** Verifying QR pairing actually works requires a real iPhone. The CI badge can't tell you the secure transport is healthy on real iOS hardware.

## Running tests in CI

The bridge-check workflow:

```yaml
- run: bun install --frozen-lockfile
- run: |
    node -e "
    const mod = require('./src');
    for (const name of ['startBridge', 'openLastActiveThread', 'watchThreadRollout']) {
      if (typeof mod[name] !== 'function') throw new Error('Missing export: ' + name);
    }"
```

Note that the CI currently only verifies the bridge entrypoints **load** — it doesn't run the test suite. If you want full test coverage in CI, add `bun run test` to the workflow. (Open question: that would catch behavioral regressions, but the entrypoint check is faster and catches the most common breakage — broken imports.)
