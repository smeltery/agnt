# Android upstream divergences

The following constants were tightened during import; nothing else should
diverge from upstream silently:

| File                                                                                  | Upstream                                 | This module                              |
| ---                                                                                   | ---                                      | ---                                      |
| `core/model/SecureTransportModels.kt::CODEX_SECURE_HANDSHAKE_TAG`                     | `remodex-e2ee-v1`                        | `agnt-e2ee-v1`                           |
| `core/model/SecureTransportModels.kt::CODEX_TRUSTED_SESSION_RESOLVE_TAG`              | `remodex-trusted-session-resolve-v1`     | `agnt-trusted-session-resolve-v1`        |
| `core/model/SecureTransportModels.kt::CODEX_TRUSTED_SESSION_RESOLVE_RESPONSE_TAG`     | `remodex-trusted-session-resolve-response-v1` | `agnt-trusted-session-resolve-response-v1` |
| `app/build.gradle.kts` `defaultConfig`                                                | `sionCode = 7` orphan line + `versionCode = 8` | clean `versionCode = 1`, `versionName = "0.1.0"` |
| Bridge checkpoint ref prefix (test fixtures)                                          | `refs/remodex/checkpoints`               | `refs/agnt/checkpoints`                  |
| Bridge update command (test fixture)                                                  | `npm install -g remodex@latest`          | `bun install -g @dotbrains/agnt`         |
| `AndroidManifest.xml` optional default-relay meta-data key                            | `PHODEX_DEFAULT_RELAY_URL`               | `AGNT_DEFAULT_RELAY_URL`                 |
