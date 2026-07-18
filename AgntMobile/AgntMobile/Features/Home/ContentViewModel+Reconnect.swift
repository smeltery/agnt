// FILE: ContentViewModel+Reconnect.swift
// Purpose: Owns reconnect URL resolution, retry loops, and cancellation helpers for ContentViewModel.
// Layer: ViewModel support
// Exports: ContentViewModel reconnect helpers
// Depends on: Foundation, CodexService

import Foundation

extension ContentViewModel {
    private enum ReconnectURLResolution {
        case use(String)
        case fallbackToSaved
        case retryLater
        case stop
    }

    struct AutoRecoveryReconnectURLResolution {
        let url: String?
        let shouldKeepRetrying: Bool
    }

    func connect(codex: CodexService, serverURL: String) async throws {
        if let connectOverride {
            try await connectOverride(codex, serverURL)
            return
        }

        try await codex.connect(
            serverURL: serverURL,
            token: "",
            role: "iphone"
        )
    }

    // Re-resolves the reconnect target on every retry so bridge restarts cannot pin
    // launch/manual recovery loops to one stale saved session id.
    func connectWithAutoRecovery(
        codex: CodexService,
        performAutoRetry: Bool,
        continueWhile shouldContinue: (() -> Bool)? = nil,
        serverURLProvider: () async -> String?
    ) async throws {
        guard !isRunningAutoReconnect else {
            return
        }

        isRunningAutoReconnect = true
        defer { isRunningAutoReconnect = false }

        let maxAttemptIndex = performAutoRetry ? autoReconnectBackoffNanoseconds.count : 0
        var lastError: Error?

        for attemptIndex in 0...maxAttemptIndex {
            if Task.isCancelled {
                codex.connectionRecoveryState = .idle
                throw CancellationError()
            }

            guard shouldContinue?() ?? true else {
                codex.connectionRecoveryState = .idle
                throw CancellationError()
            }

            guard let serverURL = await serverURLProvider() else {
                codex.connectionRecoveryState = .idle
                return
            }

            guard shouldContinue?() ?? true else {
                codex.connectionRecoveryState = .idle
                throw CancellationError()
            }

            if attemptIndex > 0 {
                codex.connectionRecoveryState = .retrying(
                    attempt: attemptIndex,
                    message: "Connection timed out. Retrying..."
                )
            }

            do {
                try await connect(codex: codex, serverURL: serverURL)
                codex.connectionRecoveryState = .idle
                codex.lastErrorMessage = nil
                codex.shouldAutoReconnectOnForeground = false
                codex.clearPreviousTrustedMacDeviceId()
                macSwitchNotice = nil
                return
            } catch {
                if isCancellationLikeError(error) {
                    codex.connectionRecoveryState = .idle
                    throw error
                }

                lastError = error
                if codex.secureConnectionState == .rePairRequired {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    if codex.lastErrorMessage?.isEmpty ?? true {
                        codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    }
                    throw error
                }

                let isRetryable = codex.isRecoverableTransientConnectionError(error)
                    || codex.isBenignBackgroundDisconnect(error)
                    || codex.isRetryableSavedSessionConnectError(error)

                guard performAutoRetry,
                      isRetryable,
                      attemptIndex < autoReconnectBackoffNanoseconds.count else {
                    codex.connectionRecoveryState = .idle
                    codex.shouldAutoReconnectOnForeground = false
                    codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
                    throw error
                }

                codex.lastErrorMessage = nil
                codex.connectionRecoveryState = .retrying(
                    attempt: attemptIndex + 1,
                    message: codex.recoveryStatusMessage(for: error)
                )
                await sleepForReconnectBackoff(
                    autoReconnectBackoffNanoseconds[attemptIndex],
                    continueWhile: shouldContinue
                )
                if Task.isCancelled {
                    codex.connectionRecoveryState = .idle
                    throw CancellationError()
                }
            }
        }

        if let lastError {
            codex.connectionRecoveryState = .idle
            codex.shouldAutoReconnectOnForeground = false
            codex.lastErrorMessage = codex.userFacingConnectFailureMessage(lastError)
            throw lastError
        }
    }

    // Chooses the best reconnect path: resolve the live trusted-Mac session first, then fall back to the saved QR session.
    func preferredReconnectURL(codex: CodexService) async -> String? {
        await preferredReconnectURL(
            codex: codex,
            targetMacDeviceId: codex.normalizedCurrentTrustedMacDeviceId
        )
    }

    // Resolves a reconnect URL for an explicit Mac target, instead of implicitly following the current one.
    func preferredReconnectURL(
        codex: CodexService,
        targetMacDeviceId: String?
    ) async -> String? {
        switch await trustedReconnectResolution(
            codex: codex,
            targetMacDeviceId: targetMacDeviceId
        ) {
        case .use(let resolvedURL):
            return resolvedURL
        case .fallbackToSaved:
            return savedReconnectURL(codex: codex, targetMacDeviceId: targetMacDeviceId)
        case .retryLater:
            return nil
        case .stop:
            return nil
        }
    }

    // Keeps launch/foreground recovery alive while the bridge is still re-registering after sleep.
    func autoRecoveryReconnectURLResolution(codex: CodexService) async -> AutoRecoveryReconnectURLResolution {
        let targetMacDeviceId = codex.normalizedCurrentTrustedMacDeviceId
        switch await trustedReconnectResolution(
            codex: codex,
            targetMacDeviceId: targetMacDeviceId
        ) {
        case .use(let resolvedURL):
            return AutoRecoveryReconnectURLResolution(url: resolvedURL, shouldKeepRetrying: true)
        case .fallbackToSaved:
            if let savedURL = savedReconnectURL(codex: codex, targetMacDeviceId: targetMacDeviceId) {
                return AutoRecoveryReconnectURLResolution(url: savedURL, shouldKeepRetrying: true)
            }
            return AutoRecoveryReconnectURLResolution(
                url: nil,
                shouldKeepRetrying: codex.hasTrustedMacReconnectCandidate
            )
        case .retryLater:
            return AutoRecoveryReconnectURLResolution(url: nil, shouldKeepRetrying: true)
        case .stop:
            return AutoRecoveryReconnectURLResolution(url: nil, shouldKeepRetrying: false)
        }
    }

    // Resolves a trusted-Mac session when possible and tells the caller whether to use, fall back, or stop.
    private func trustedReconnectResolution(codex: CodexService) async -> ReconnectURLResolution {
        await trustedReconnectResolution(
            codex: codex,
            targetMacDeviceId: codex.normalizedCurrentTrustedMacDeviceId
        )
    }

    private func trustedReconnectResolution(
        codex: CodexService,
        targetMacDeviceId: String?
    ) async -> ReconnectURLResolution {
        guard let targetMacDeviceId = normalizedMacDeviceId(targetMacDeviceId),
              let trustedMac = codex.trustedMacRecord(for: targetMacDeviceId),
              trustedMac.relayURL?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            return .fallbackToSaved
        }

        do {
            guard let trustedReconnectURL = try await resolvedTrustedReconnectURL(
                codex: codex,
                targetMacDeviceId: targetMacDeviceId
            ) else {
                return .fallbackToSaved
            }
            return .use(trustedReconnectURL)
        } catch let error as CodexTrustedSessionResolveError {
            return trustedReconnectResolution(
                for: error,
                codex: codex,
                targetMacDeviceId: targetMacDeviceId
            )
        } catch is CancellationError {
            return .stop
        } catch {
            if savedReconnectURL(codex: codex, targetMacDeviceId: targetMacDeviceId) == nil {
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }
            return .fallbackToSaved
        }
    }

    // Builds the live reconnect URL after the trusted-session lookup succeeds.
    private func resolvedTrustedReconnectURL(
        codex: CodexService,
        targetMacDeviceId: String
    ) async throws -> String? {
        let resolved = try await codex.resolveTrustedMacSession(deviceId: targetMacDeviceId)
        guard let trustedMac = codex.trustedMacRecord(for: targetMacDeviceId),
              let relayURL = trustedMac.relayURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !relayURL.isEmpty else {
            return nil
        }
        return "\(relayURL)/\(resolved.sessionId)"
    }

    // Applies trusted-resolve error policy without mixing it into the happy path URL assembly.
    private func trustedReconnectResolution(
        for error: CodexTrustedSessionResolveError,
        codex: CodexService,
        targetMacDeviceId: String?
    ) -> ReconnectURLResolution {
        let hasSavedReconnectURL = savedReconnectURL(codex: codex, targetMacDeviceId: targetMacDeviceId) != nil
        switch error {
        case .unsupportedRelay:
            if !hasSavedReconnectURL {
                codex.secureConnectionState = .liveSessionUnresolved
                codex.connectionRecoveryState = .idle
                codex.shouldAutoReconnectOnForeground = false
                codex.lastErrorMessage = "Trusted reconnect is unavailable from this relay endpoint. Update or check the relay/proxy, then reconnect. Scan a new QR code only if this Mac was reset."
                return .stop
            }
            return .fallbackToSaved
        case .macOffline(let message):
            if hasSavedReconnectURL {
                codex.lastErrorMessage = nil
                return .fallbackToSaved
            }
            codex.lastErrorMessage = message
            return .retryLater
        case .rePairRequired(let message):
            codex.connectionRecoveryState = .idle
            codex.shouldAutoReconnectOnForeground = false
            codex.lastErrorMessage = message
            return .stop
        case .noTrustedMac:
            return .fallbackToSaved
        case .invalidResponse(let message), .network(let message):
            if !hasSavedReconnectURL {
                codex.secureConnectionState = .liveSessionUnresolved
                codex.lastErrorMessage = message
            }
            return .fallbackToSaved
        }
    }

    // Reuses the last QR-resolved session when trusted lookup is unavailable or not yet supported end-to-end.
    private func savedReconnectURL(codex: CodexService, targetMacDeviceId: String?) -> String? {
        guard let sessionId = codex.normalizedRelaySessionId,
              let relayURL = codex.normalizedRelayURL else {
            return nil
        }

        if let normalizedTargetMacDeviceId = normalizedMacDeviceId(targetMacDeviceId),
           codex.normalizedRelayMacDeviceId != normalizedTargetMacDeviceId {
            return nil
        }
        return "\(relayURL)/\(sessionId)"
    }

    // Centralizes reconnect sleeps so manual retry can interrupt stale foreground backoff quickly.
    func sleepForReconnectBackoff(
        _ nanoseconds: UInt64,
        continueWhile shouldContinue: (() -> Bool)? = nil
    ) async {
        if let reconnectSleepOverride {
            await reconnectSleepOverride(nanoseconds)
            return
        }

        guard let shouldContinue else {
            try? await Task.sleep(nanoseconds: nanoseconds)
            return
        }

        var remaining = nanoseconds
        let chunkSize = max(1 as UInt64, reconnectSleepChunkNanosecondsOverride ?? reconnectSleepChunkNanoseconds)
        while remaining > 0 {
            guard shouldContinue() else {
                return
            }

            let nextChunk = min(remaining, chunkSize)
            try? await Task.sleep(nanoseconds: nextChunk)
            remaining -= nextChunk
        }
    }

    // Treats cancelled resolve/connect work as intentional handoff, not as a user-visible failure.
    func isCancellationLikeError(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    var shouldContinueManualReconnect: Bool {
        !shouldCancelManualReconnect
    }
}
