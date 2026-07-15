// FILE: ContentViewModel.swift
// Purpose: Owns non-visual orchestration logic for the root screen (connection, relay pairing, sync throttling).
// Layer: ViewModel
// Exports: ContentViewModel
// Depends on: Foundation, Observation, CodexService, SecureStore

import Foundation
import Observation

@MainActor
@Observable
final class ContentViewModel {
    private var hasAttemptedInitialAutoConnect = false
    private var lastSidebarOpenSyncAt: Date = .distantPast
    let autoReconnectBackoffNanoseconds: [UInt64] = [1_000_000_000, 3_000_000_000]
    private let launchReconnectAttemptLimit = 10
    let reconnectSleepChunkNanoseconds: UInt64 = 100_000_000
    var isRunningAutoReconnect = false
    var isRunningManualReconnect = false
    var isSwitchingMac = false
    var isCancellingMacSwitch = false
    var switchingMacDeviceId: String?
    var macSwitchNotice: String?
    var shouldCancelManualReconnect = false
    // Test hooks keep reconnect verification fast without changing production retry behavior.
    @ObservationIgnored var reconnectAttemptLimitOverride: Int?
    @ObservationIgnored var launchReconnectAttemptLimitOverride: Int?
    @ObservationIgnored var connectOverride: ((CodexService, String) async throws -> Void)?
    @ObservationIgnored var reconnectSleepOverride: ((UInt64) async -> Void)?
    @ObservationIgnored var reconnectSleepChunkNanosecondsOverride: UInt64?

    struct RelaySessionSnapshot {
        let relaySessionId: String?
        let relayUrl: String?
        let relayMacDeviceId: String?
        let relayMacIdentityPublicKey: String?
        let relayProtocolVersion: Int
        let lastAppliedBridgeOutboundSeq: Int
        let lastAppliedBridgeReplayEpoch: String?
        let shouldForceQRBootstrapOnNextHandshake: Bool
        let trustedReconnectFailureCount: Int
        let secureConnectionState: CodexSecureConnectionState
        let secureMacFingerprint: String?
    }

    var isAttemptingAutoReconnect: Bool {
        isRunningAutoReconnect
    }

    var isAttemptingManualReconnect: Bool {
        isRunningManualReconnect
    }

    // Throttles sidebar-open sync requests to avoid redundant thread refresh churn.
    func shouldRequestSidebarFreshSync(isConnected: Bool) -> Bool {
        guard isConnected else {
            return false
        }

        let now = Date()
        guard now.timeIntervalSince(lastSidebarOpenSyncAt) >= 0.8 else {
            return false
        }

        lastSidebarOpenSyncAt = now
        return true
    }

    // Connects to the relay WebSocket using a scanned QR code payload.
    func connectToRelay(pairingPayload: CodexPairingQRPayload, codex: CodexService) async {
        await stopAutoReconnectForManualScan(codex: codex)
        // Avoid logging live pairing metadata; the relay URL path includes a bearer-like session id.
        let fullURL = "\(pairingPayload.relay)/\(pairingPayload.sessionId)"
        codex.rememberRelayPairing(pairingPayload)

        do {
            try await connectWithAutoRecovery(
                codex: codex,
                performAutoRetry: true,
                serverURLProvider: { fullURL }
            )
        } catch {
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Connects or disconnects the relay.
    func toggleConnection(codex: CodexService) async {
        if codex.isConnected {
            await codex.disconnect()
            codex.clearSavedRelaySession()
            return
        }

        guard !isRunningManualReconnect else {
            return
        }

        // Flips the UI into an immediate busy state before the reconnect handoff reaches the socket layer.
        shouldCancelManualReconnect = false
        isRunningManualReconnect = true
        defer { isRunningManualReconnect = false }

        await stopAutoReconnectForManualRetry(codex: codex)

        guard shouldContinueManualReconnect else {
            codex.connectionRecoveryState = .idle
            return
        }
        do {
            try await connectWithAutoRecovery(
                codex: codex,
                performAutoRetry: true,
                continueWhile: { self.shouldContinueManualReconnect },
                serverURLProvider: { await self.preferredReconnectURL(codex: codex) }
            )
        } catch {
            if isCancellationLikeError(error) {
                return
            }
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            }
        }
    }

    // Lets a manual reconnect tap interrupt a stuck foreground recovery loop.
    func stopAutoReconnectForManualRetry(codex: CodexService) async {
        guard isRunningAutoReconnect || codex.isConnecting || codex.shouldAutoReconnectOnForeground else {
            return
        }

        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .retrying(attempt: 0, message: "Preparing reconnect...")
        codex.lastErrorMessage = nil
        codex.cancelTrustedSessionResolve()

        if codex.isConnecting || codex.isConnected {
            await codex.disconnect()
        }

        while isRunningAutoReconnect || codex.isConnecting {
            await sleepForReconnectBackoff(100_000_000)
        }
    }

    // Lets the manual QR flow take over instead of competing with the foreground reconnect loop.
    func stopAutoReconnectForManualScan(codex: CodexService) async {
        shouldCancelManualReconnect = true
        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .idle
        codex.lastErrorMessage = nil
        codex.cancelTrustedSessionResolve()

        // Cancel any in-flight reconnect so the scanner can appear immediately instead of waiting
        // for a stalled handshake to time out on its own.
        if codex.isConnecting || codex.isConnected {
            await codex.disconnect()
        }

        while isRunningManualReconnect || isRunningAutoReconnect || codex.isConnecting {
            await sleepForReconnectBackoff(100_000_000)
        }
    }

    // Attempts one automatic connection on app launch using saved relay session.
    func attemptAutoConnectOnLaunchIfNeeded(codex: CodexService) async {
        guard !hasAttemptedInitialAutoConnect else {
            return
        }
        hasAttemptedInitialAutoConnect = true

        guard !codex.isConnected, !codex.isConnecting else {
            return
        }

        guard codex.hasReconnectCandidate else {
            return
        }

        // Cold launches after device sleep often start before the bridge has re-registered
        // its fresh relay session, so use the foreground recovery loop instead of one short attempt.
        codex.shouldAutoReconnectOnForeground = true
        await attemptAutoReconnectOnForegroundIfNeeded(
            codex: codex,
            maxAttempts: launchReconnectAttemptLimitOverride ?? launchReconnectAttemptLimit
        )
    }

    // Reconnects after benign background disconnects.
    func attemptAutoReconnectOnForegroundIfNeeded(codex: CodexService) async {
        await attemptAutoReconnectOnForegroundIfNeeded(
            codex: codex,
            maxAttempts: reconnectAttemptLimitOverride ?? 50
        )
    }

    // Reconnects after wake/cold-launch while allowing trusted session resolve to become live.
    private func attemptAutoReconnectOnForegroundIfNeeded(
        codex: CodexService,
        maxAttempts: Int
    ) async {
        guard codex.shouldAutoReconnectOnForeground, !isRunningAutoReconnect else {
            return
        }

        isRunningAutoReconnect = true
        defer { isRunningAutoReconnect = false }

        var attempt = 0

        // Keep retryable reconnects alive until the socket recovers or the pairing becomes invalid.
        while codex.shouldAutoReconnectOnForeground, attempt < maxAttempts {

            let reconnectResolution = await autoRecoveryReconnectURLResolution(codex: codex)
            guard reconnectResolution.shouldKeepRetrying else {
                codex.shouldAutoReconnectOnForeground = false
                codex.connectionRecoveryState = .idle
                return
            }

            if codex.isConnected {
                codex.shouldAutoReconnectOnForeground = false
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                return
            }

            if codex.isConnecting {
                if !codex.shouldAutoReconnectOnForeground {
                    codex.connectionRecoveryState = .idle
                    return
                }
                await sleepForReconnectBackoff(
                    300_000_000,
                    continueWhile: { codex.shouldAutoReconnectOnForeground }
                )
                continue
            }

            guard let fullURL = reconnectResolution.url else {
                codex.lastErrorMessage = nil
                codex.connectionRecoveryState = .retrying(
                    attempt: max(1, attempt + 1),
                    message: "Reconnecting..."
                )
                let backoffIndex = min(attempt, autoReconnectBackoffNanoseconds.count - 1)
                let backoff = autoReconnectBackoffNanoseconds[backoffIndex]
                attempt += 1
                await sleepForReconnectBackoff(
                    backoff,
                    continueWhile: { codex.shouldAutoReconnectOnForeground }
                )
                continue
            }
            do {
                codex.connectionRecoveryState = .retrying(
                    attempt: max(1, attempt + 1),
                    message: "Reconnecting..."
                )
                try await connect(codex: codex, serverURL: fullURL)
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                codex.shouldAutoReconnectOnForeground = false
                return
            } catch {
                if codex.secureConnectionState == .rePairRequired {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    if codex.lastErrorMessage?.isEmpty ?? true {
                        codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    }
                    return
                }

                if isCancellationLikeError(error) {
                    codex.connectionRecoveryState = .idle
                    return
                }

                if !codex.shouldAutoReconnectOnForeground {
                    codex.connectionRecoveryState = .idle
                    return
                }

                let isRetryable = codex.isRecoverableTransientConnectionError(error)
                    || codex.isBenignBackgroundDisconnect(error)
                    || codex.isRetryableSavedSessionConnectError(error)

                guard isRetryable else {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    return
                }

                codex.lastErrorMessage = nil
                codex.connectionRecoveryState = .retrying(
                    attempt: attempt + 1,
                    message: codex.recoveryStatusMessage(for: error)
                )

                let backoffIndex = min(attempt, autoReconnectBackoffNanoseconds.count - 1)
                let backoff = autoReconnectBackoffNanoseconds[backoffIndex]
                attempt += 1
                await sleepForReconnectBackoff(
                    backoff,
                    continueWhile: { codex.shouldAutoReconnectOnForeground }
                )
            }
        }

        // Exhausted all attempts — stop retrying but keep the saved pairing for next foreground cycle.
        if attempt >= maxAttempts {
            codex.shouldAutoReconnectOnForeground = false
            codex.connectionRecoveryState = .idle
            codex.lastErrorMessage = "Could not reconnect. Tap Reconnect to try again."
        }
    }
}
