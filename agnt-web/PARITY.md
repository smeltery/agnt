# agnt-web parity ledger

This file is the canonical inventory of every iOS surface and its TypeScript port
status. Update it as part of every session that touches `agnt-web/`.

| Status | Meaning |
| --- | --- |
| ✅ ported | functionally equivalent to iOS |
| 🟡 partial | basic version exists, edge cases / polish missing |
| 🔲 stub | typed but no real behavior; UI shows placeholder |
| ⛔ unported | not yet in agnt-web at all |

## Wire protocol

| Surface | Status | Notes |
| --- | --- | --- |
| Pairing payload validator (`QRScannerPairingValidator.swift`) | ✅ | `src/protocol/pairing.ts`, parser parity test in `test/pairing.test.ts` |
| Secure-transport handshake (`CodexService+SecureTransport.swift`) | ✅ | `src/protocol/secure-channel.ts` + `src/crypto/*`. Cross-checked against bridge's `nonceForDirection`. |
| Encrypted envelope crypto (`secure-transport.js` Node side) | ✅ | `src/crypto/envelope.ts` with vitest cross-check |
| Replay protection (`bridgeOutboundSeq`, `lastInboundCounter`) | ✅ | both directions enforced |
| Trusted-session HTTP resolver (`/v1/trusted/session/resolve`) | ✅ | `src/protocol/trusted-session.ts` |
| Manual pairing-code resolver (`/v1/pairing/code/resolve`) | 🔲 | parser recognizes short codes; resolver call pending Session 2 |
| Push notification registration | ⛔ | browsers can't receive APNs; web push is a future option |
| JSON-RPC framing | ✅ | `src/protocol/jsonrpc-client.ts` |

## CodexService method surface

| iOS file (`CodexService+…`) | Status | Session |
| --- | --- | --- |
| `Connection` | ✅ | 1 |
| `SecureTransport` | ✅ | 1 |
| `Transport` | ✅ | 1 |
| `Messages` | ✅ | 2 (item-scoped reconciliation, late-replay deltas, block-replay dedup) |
| `Incoming` | ✅ | 2 (item/agentMessage/delta, item/reasoning/textDelta, item/*/outputDelta, item/started, item/completed, turn lifecycle, thread/tokenUsage/updated) |
| `IncomingAssistant` | ✅ | 2 |
| `IncomingPlanMode` | ⛔ | 3 |
| `IncomingSupport` | 🟡 | 2 (context-window extractor only; approvals + notice routing in 3) |
| `ThreadsTurns` | ✅ | 2 (`thread/list` archived split, `thread/turns/list` cursor, `turn/start`, `turn/interrupt`) |
| `ThreadHistoryPagination` | ✅ | 2 |
| `ThreadFork` + `ThreadForkCompatibility` | ⛔ | 4 |
| `ThreadProjectRouting` | ⛔ | 4 |
| `Sync` | ✅ | 2 (initialize, model/list, thread/list active+archived) |
| `Status` | 🟡 | 1 (status pill only) |
| `RuntimeCompatibility` + `RuntimeConfig` | 🟡 | 2 (initialize round-trip + capability gate; full version negotiation in later sessions) |
| `History` | ✅ | 2 (history events replayed through the same reducer) |
| `Account` | ⛔ | 5 (Codex login flow, OAuth-style redirect dance) |
| `Voice` + `VoiceCompatibility` | ⛔ | 6 (browser MediaRecorder + voice/transcribe RPC) |
| `Notifications` | ⛔ | future (web-push when we tackle it) |
| `Pets` | ⛔ | 7 (low priority, fun feature) |
| `Review` | ⛔ | 4 |
| `AIChangeSets` | ⛔ | 4 |
| `WorkspaceCheckpoints` + `WorkspaceImages` | ⛔ | 4 |
| `ProjectFolders` | ⛔ | 4 |
| `TrustedPairPresentation` | 🔲 | sidebar shows nothing about trusted Mac yet |
| `Helpers` | n/a | utility — port functions on demand |
| `AssistantReplayDeduper` | ✅ | 2 |
| `CodexMessagePersistence` | ✅ | 2 (IndexedDB-backed, debounced per thread) |
| `AIChangeSetPersistence` | ⛔ | 4 (deferred with AI change sets) |
| `Coordination/*` | ⛔ | 4 |
| `Payments` (StoreKit) | ⛔ | not applicable in browser; needs a different provider story |
| `DesktopHandoffService` | ⛔ | not applicable |
| `GPTVoiceTranscriptionManager` | ⛔ | 6 |

## Models

The iOS `Models/` folder maps to TypeScript in two places: protocol-level types
(`src/protocol/types.ts`) and feature-state types (per `state/*-store.ts`).

| iOS model | Status | Where |
| --- | --- | --- |
| `RPCMessage` | ✅ | `src/protocol/types.ts` |
| `JSONValue` | n/a | TS uses `unknown` |
| `CodexThread` | ✅ | `models/thread.ts` (with snake_case aliases) |
| `CodexMessage` | ✅ | `models/message.ts` (full kind/role/deliveryState surface) |
| `CodexMessageOrderCounter` | ✅ | `models/order-counter.ts` |
| `ContextWindowUsage` | ✅ | `models/context-window.ts` |
| `CommandExecutionDetails` | ✅ | `models/message.ts` (with `appendCommandOutput` trimmer) |
| `CodexImageAttachment` | ⛔ | 4 |
| `CodexSkillMetadata` | ⛔ | 2 |
| `CodexModelOption` | ⛔ | 2 |
| `CodexCollaboration` | ⛔ | 4 |
| `CodexAccessMode` | ⛔ | 4 |
| `CodexFuzzyFileMatch` | ⛔ | 4 |
| `CodexRateLimitStatus` | ⛔ | 5 |
| `CodexServiceTier` | ⛔ | 5 |
| `GitActionModels` | ⛔ | 4 |
| `AIChangeSetModels` | ⛔ | 4 |
| `ContextWindowUsage` | ⛔ | 4 |
| `PetCompanionModels` | ⛔ | 7 |
| `AppFont` | n/a | use system fonts |
| `CodexReasoningEffortOption` | ⛔ | 2 |

## Views

iOS `Views/` mirrors `agnt-web/src/components/`.

| iOS area | Web component | Status |
| --- | --- | --- |
| Onboarding / pairing | `components/pairing/PairingScreen.tsx` | 🟡 (paste only — no camera scan) |
| Sidebar | `components/sidebar/Sidebar.tsx` | ✅ (live/archived tabs, cwd hint, selection) |
| Home (chat) | `components/chat/{ChatView,Composer,MarkdownContent}.tsx` + `rows/*.tsx` | ✅ (kind-aware rendering: assistant/user/reasoning/command/file-change/tool) |
| Markdown | `components/chat/MarkdownContent.tsx` | 🟡 (fenced code, inline code, bold/italic; tables/lists/syntax highlighting in 5) |
| Settings | ⛔ | 5 |
| About | ⛔ | 5 |
| Pet | ⛔ | 7 |
| Payments | ⛔ | n/a |
| Turn detail (`Views/Turn/*`) | ⛔ | 3 |
| Shared (modals, badges) | `components/shared/` | 🟡 (loading, status pill) |

## Storage

| iOS Keychain key | Web equivalent | Status |
| --- | --- | --- |
| `phoneIdentityState` | `idb["phoneIdentity"]` | ✅ |
| `relaySessionId` + relay metadata | `idb["relayPairing"]` | ✅ |
| `trustedMacRegistry` | `idb["trustedMacRegistry"]` | ✅ |
| `lastTrustedMacDeviceId` | inside trusted registry | ✅ |
| `relayLastAppliedBridgeOutboundSeq` | inside relay pairing | ✅ |
