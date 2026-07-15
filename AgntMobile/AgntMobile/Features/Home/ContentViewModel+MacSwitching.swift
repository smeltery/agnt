// FILE: ContentViewModel+MacSwitching.swift
// Purpose: Owns trusted/scanned Mac switch orchestration for ContentViewModel.
// Layer: ViewModel support
// Exports: ContentViewModel Mac switching APIs
// Depends on: Foundation, CodexService, SecureStore

import Foundation

extension ContentViewModel {

    func switchToTrustedMac(deviceId: String, codex: CodexService) async throws {
        let normalizedTargetMacDeviceId = try normalizedRequiredMacDeviceId(deviceId)
        guard normalizedTargetMacDeviceId != codex.normalizedCurrentTrustedMacDeviceId else {
            return
        }
        guard !isSwitchingMac else {
            return
        }

        isSwitchingMac = true
        isCancellingMacSwitch = false
        switchingMacDeviceId = normalizedTargetMacDeviceId
        macSwitchNotice = nil
        defer {
            isCancellingMacSwitch = false
            switchingMacDeviceId = nil
            isSwitchingMac = false
        }

        let previousCurrentTrustedMacDeviceId = codex.normalizedCurrentTrustedMacDeviceId
        let previousErrorMessage = codex.lastErrorMessage
        let previousRelaySessionSnapshot = captureRelaySessionSnapshot(from: codex)
        codex.lastErrorMessage = nil

        try await interruptRunningTurnsBeforeMacSwitchIfNeeded(codex: codex)
        await stopAutoReconnectForManualRetry(codex: codex)

        codex.saveLocalState(for: previousCurrentTrustedMacDeviceId)
        beginMacSwitchContext(normalizedTargetMacDeviceId, codex: codex)
        await codex.disconnect(preserveReconnectIntent: false)
        codex.clearInMemoryMacScopedState()
        codex.loadLocalState(for: normalizedTargetMacDeviceId)
        codex.loadMacScopedDefaultsState(for: normalizedTargetMacDeviceId)

        do {
            guard let fullURL = await preferredReconnectURL(
                codex: codex,
                targetMacDeviceId: normalizedTargetMacDeviceId
            ) else {
                throw CodexServiceError.invalidInput("Could not reconnect to the selected Mac.")
            }

            try await connectWithAutoRecovery(
                codex: codex,
                performAutoRetry: true,
                continueWhile: { !self.isCancellingMacSwitch },
                serverURLProvider: { fullURL }
            )
            codex.setCurrentTrustedMacDeviceId(normalizedTargetMacDeviceId)
            endMacSwitchContext(codex: codex)
        } catch is CancellationError {
            await finalizeCancelledMacSwitch(
                previousCurrentTrustedMacDeviceId: previousCurrentTrustedMacDeviceId,
                codex: codex
            )
            throw CancellationError()
        } catch {
            if isCancellingMacSwitch {
                await finalizeCancelledMacSwitch(
                    previousCurrentTrustedMacDeviceId: previousCurrentTrustedMacDeviceId,
                    codex: codex
                )
                throw CancellationError()
            }
            restoreRelaySessionSnapshot(previousRelaySessionSnapshot, to: codex)
            codex.setCurrentTrustedMacDeviceId(previousCurrentTrustedMacDeviceId)
            codex.macScopedContextOverrideDeviceId = previousCurrentTrustedMacDeviceId
            codex.clearInMemoryMacScopedState()
            codex.loadLocalState(for: previousCurrentTrustedMacDeviceId)
            codex.loadMacScopedDefaultsState(for: previousCurrentTrustedMacDeviceId)
            endMacSwitchContext(codex: codex)
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            } else if codex.lastErrorMessage == nil {
                codex.lastErrorMessage = previousErrorMessage
            }
            throw error
        }
    }

    func switchToScannedMac(pairingPayload: CodexPairingQRPayload, codex: CodexService) async throws {
        guard !isSwitchingMac else {
            return
        }

        isSwitchingMac = true
        isCancellingMacSwitch = false
        switchingMacDeviceId = pairingPayload.macDeviceId
        macSwitchNotice = nil
        defer {
            isCancellingMacSwitch = false
            switchingMacDeviceId = nil
            isSwitchingMac = false
        }

        let previousCurrentTrustedMacDeviceId = codex.normalizedCurrentTrustedMacDeviceId
        let previousErrorMessage = codex.lastErrorMessage
        let previousRelaySessionSnapshot = captureRelaySessionSnapshot(from: codex)
        codex.lastErrorMessage = nil

        try await interruptRunningTurnsBeforeMacSwitchIfNeeded(codex: codex)
        await stopAutoReconnectForManualScan(codex: codex)
        codex.saveLocalState(for: previousCurrentTrustedMacDeviceId)
        beginMacSwitchContext(pairingPayload.macDeviceId, codex: codex)
        codex.rememberRelayPairing(pairingPayload)
        codex.clearInMemoryMacScopedState()
        codex.loadLocalState(for: pairingPayload.macDeviceId)
        codex.loadMacScopedDefaultsState(for: pairingPayload.macDeviceId)

        do {
            try await connectWithAutoRecovery(
                codex: codex,
                performAutoRetry: true,
                continueWhile: { !self.isCancellingMacSwitch },
                serverURLProvider: { "\(pairingPayload.relay)/\(pairingPayload.sessionId)" }
            )
            endMacSwitchContext(codex: codex)
        } catch is CancellationError {
            await finalizeCancelledMacSwitch(
                previousCurrentTrustedMacDeviceId: previousCurrentTrustedMacDeviceId,
                codex: codex
            )
            throw CancellationError()
        } catch {
            if isCancellingMacSwitch {
                await finalizeCancelledMacSwitch(
                    previousCurrentTrustedMacDeviceId: previousCurrentTrustedMacDeviceId,
                    codex: codex
                )
                throw CancellationError()
            }
            codex.setCurrentTrustedMacDeviceId(previousCurrentTrustedMacDeviceId)
            restoreRelaySessionSnapshot(previousRelaySessionSnapshot, to: codex)
            codex.macScopedContextOverrideDeviceId = previousCurrentTrustedMacDeviceId
            codex.clearInMemoryMacScopedState()
            codex.loadLocalState(for: previousCurrentTrustedMacDeviceId)
            codex.loadMacScopedDefaultsState(for: previousCurrentTrustedMacDeviceId)
            endMacSwitchContext(codex: codex)
            if codex.lastErrorMessage?.isEmpty ?? true {
                codex.lastErrorMessage = codex.userFacingConnectFailureMessage(error)
            } else if codex.lastErrorMessage == nil {
                codex.lastErrorMessage = previousErrorMessage
            }
            throw error
        }
    }

    func requestMacSwitchCancellation(codex: CodexService) async {
        guard isSwitchingMac else {
            return
        }

        isCancellingMacSwitch = true
        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .idle
        codex.cancelTrustedSessionResolve()
        if codex.isConnecting || codex.isConnected || codex.isInitialized {
            await codex.disconnect(preserveReconnectIntent: false)
        }
    }

    func normalizedMacDeviceId(_ deviceId: String?) -> String? {
        guard let trimmed = deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func normalizedRequiredMacDeviceId(_ deviceId: String?) throws -> String {
        guard let normalizedMacDeviceId = normalizedMacDeviceId(deviceId) else {
            throw CodexServiceError.invalidInput("A valid Mac device id is required.")
        }
        return normalizedMacDeviceId
    }

    private func beginMacSwitchContext(_ macDeviceId: String?, codex: CodexService) {
        codex.suspendAutomaticMacScopedPersistence = true
        codex.macScopedContextOverrideDeviceId = normalizedMacDeviceId(macDeviceId)
    }

    private func endMacSwitchContext(codex: CodexService) {
        codex.macScopedContextOverrideDeviceId = nil
        codex.suspendAutomaticMacScopedPersistence = false
    }

    private func interruptRunningTurnsBeforeMacSwitchIfNeeded(codex: CodexService) async throws {
        guard codex.isConnected || codex.isInitialized else {
            return
        }

        guard !codex.runningThreadIDs.isEmpty
            || !codex.protectedRunningFallbackThreadIDs.isEmpty
            || !codex.activeTurnIdByThread.isEmpty else {
            return
        }

        try await codex.interruptAllRunningTurnsBeforeMacSwitch()
    }

    private func finalizeCancelledMacSwitch(
        previousCurrentTrustedMacDeviceId: String?,
        codex: CodexService
    ) async {
        codex.lastErrorMessage = nil
        codex.connectionRecoveryState = .idle
        codex.shouldAutoReconnectOnForeground = false
        codex.cancelTrustedSessionResolve()
        await codex.disconnect(preserveReconnectIntent: false)
        codex.setCurrentTrustedMacDeviceId(nil)
        if let previousCurrentTrustedMacDeviceId {
            codex.setPreviousTrustedMacDeviceId(previousCurrentTrustedMacDeviceId)
        }
        codex.clearSavedRelaySession()
        codex.clearInMemoryMacScopedState()
        endMacSwitchContext(codex: codex)
        macSwitchNotice = "Switch cancelled. Choose a Mac to reconnect."
    }

    private func captureRelaySessionSnapshot(from codex: CodexService) -> RelaySessionSnapshot {
        RelaySessionSnapshot(
            relaySessionId: codex.relaySessionId,
            relayUrl: codex.relayUrl,
            relayMacDeviceId: codex.relayMacDeviceId,
            relayMacIdentityPublicKey: codex.relayMacIdentityPublicKey,
            relayProtocolVersion: codex.relayProtocolVersion,
            lastAppliedBridgeOutboundSeq: codex.lastAppliedBridgeOutboundSeq,
            lastAppliedBridgeReplayEpoch: codex.lastAppliedBridgeReplayEpoch,
            shouldForceQRBootstrapOnNextHandshake: codex.shouldForceQRBootstrapOnNextHandshake,
            trustedReconnectFailureCount: codex.trustedReconnectFailureCount,
            secureConnectionState: codex.secureConnectionState,
            secureMacFingerprint: codex.secureMacFingerprint
        )
    }

    private func restoreRelaySessionSnapshot(_ snapshot: RelaySessionSnapshot, to codex: CodexService) {
        codex.relaySessionId = snapshot.relaySessionId
        codex.relayUrl = snapshot.relayUrl
        codex.relayMacDeviceId = snapshot.relayMacDeviceId
        codex.relayMacIdentityPublicKey = snapshot.relayMacIdentityPublicKey
        codex.relayProtocolVersion = snapshot.relayProtocolVersion
        codex.lastAppliedBridgeOutboundSeq = snapshot.lastAppliedBridgeOutboundSeq
        codex.lastAppliedBridgeReplayEpoch = snapshot.lastAppliedBridgeReplayEpoch
        codex.shouldForceQRBootstrapOnNextHandshake = snapshot.shouldForceQRBootstrapOnNextHandshake
        codex.trustedReconnectFailureCount = snapshot.trustedReconnectFailureCount
        codex.secureConnectionState = snapshot.secureConnectionState
        codex.secureMacFingerprint = snapshot.secureMacFingerprint

        if let relaySessionId = snapshot.relaySessionId {
            SecureStore.writeString(relaySessionId, for: CodexSecureKeys.relaySessionId)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
        }
        if let relayUrl = snapshot.relayUrl {
            SecureStore.writeString(relayUrl, for: CodexSecureKeys.relayUrl)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.relayUrl)
        }
        if let relayMacDeviceId = snapshot.relayMacDeviceId {
            SecureStore.writeString(relayMacDeviceId, for: CodexSecureKeys.relayMacDeviceId)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.relayMacDeviceId)
        }
        if let relayMacIdentityPublicKey = snapshot.relayMacIdentityPublicKey {
            SecureStore.writeString(relayMacIdentityPublicKey, for: CodexSecureKeys.relayMacIdentityPublicKey)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.relayMacIdentityPublicKey)
        }
        SecureStore.writeString(String(snapshot.relayProtocolVersion), for: CodexSecureKeys.relayProtocolVersion)
        SecureStore.writeString(
            String(snapshot.lastAppliedBridgeOutboundSeq),
            for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq
        )
        if let replayEpoch = snapshot.lastAppliedBridgeReplayEpoch {
            SecureStore.writeString(replayEpoch, for: CodexSecureKeys.relayBridgeReplayEpoch)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
        }
    }
}
