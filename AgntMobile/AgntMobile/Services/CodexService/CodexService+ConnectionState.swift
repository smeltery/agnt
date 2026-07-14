// FILE: CodexService+ConnectionState.swift
// Purpose: Derives bridge host, trusted Mac, reconnect, and display connection state.
// Layer: Service
// Exports: CodexService connection state helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    var bridgeHostPlatform: CodexBridgeHostPlatform {
        if let hostPlatform = gptAccountSnapshot.hostPlatform {
            return hostPlatform
        }
        return preferredTrustedMacRecord == nil ? .unknown : .macOS
    }
    var bridgeHostCapabilities: CodexBridgeHostCapabilities {
        if let hostCapabilities = gptAccountSnapshot.hostCapabilities {
            return hostCapabilities
        }
        // Older bridges did not report capabilities; only apply that compatibility
        // fallback when the remembered host is known to be macOS.
        guard preferredTrustedMacRecord != nil,
              bridgeHostPlatform == .macOS else {
            return CodexBridgeHostCapabilities()
        }
        return .legacyMacOS
    }
    var supportsDesktopAppHandoff: Bool {
        bridgeHostCapabilities.desktopHandoff
    }
    var supportsDisplayWake: Bool {
        bridgeHostCapabilities.displayWake
    }
    var supportsKeepAwakeWhileBridgeRuns: Bool {
        bridgeHostCapabilities.keepAwake
    }
    var supportsBridgeSelfUpdate: Bool {
        bridgeHostCapabilities.bridgeSelfUpdate
    }
    var hostComputerLabel: String {
        bridgeHostPlatform.displayName
    }

    // Persists per-thread plan-mode provenance so reconnect/relaunch keeps native vs fallback behavior stable.
    func persistPlanSessionSources() {
        guard !planSessionSourceByThread.isEmpty else {
            defaults.removeObject(forKey: Self.planSessionSourcesDefaultsKey)
            return
        }

        guard let data = try? encoder.encode(planSessionSourceByThread) else {
            defaults.removeObject(forKey: Self.planSessionSourcesDefaultsKey)
            return
        }

        defaults.set(data, forKey: Self.planSessionSourcesDefaultsKey)
    }

    // Remembers whether we can offer reconnect without forcing a fresh QR scan.
    var hasSavedRelaySession: Bool {
        normalizedRelaySessionId != nil && normalizedRelayURL != nil
    }

    // Normalizes the persisted relay session id before reuse in reconnect flows.
    var normalizedRelaySessionId: String? {
        relaySessionId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    // Normalizes the persisted relay base URL before reuse in reconnect flows.
    var normalizedRelayURL: String? {
        relayUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var normalizedRelayMacDeviceId: String? {
        relayMacDeviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var normalizedRelayMacIdentityPublicKey: String? {
        relayMacIdentityPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var normalizedLastTrustedMacDeviceId: String? {
        lastTrustedMacDeviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var preferredTrustedMacDeviceId: String? {
        if let normalizedLastTrustedMacDeviceId,
           trustedMacRegistry.records[normalizedLastTrustedMacDeviceId] != nil {
            return normalizedLastTrustedMacDeviceId
        }

        return trustedMacRegistry.records.values
            .sorted { lhs, rhs in
                (lhs.lastUsedAt ?? lhs.lastPairedAt) > (rhs.lastUsedAt ?? rhs.lastPairedAt)
            }
            .first?
            .macDeviceId
    }

    var preferredTrustedMacRecord: CodexTrustedMacRecord? {
        guard let preferredTrustedMacDeviceId else {
            return nil
        }
        return trustedMacRegistry.records[preferredTrustedMacDeviceId]
    }

    var normalizedCurrentTrustedMacDeviceId: String? {
        currentTrustedMacDeviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    var currentTrustedMacRecord: CodexTrustedMacRecord? {
        guard let normalizedCurrentTrustedMacDeviceId else {
            return nil
        }
        return trustedMacRegistry.records[normalizedCurrentTrustedMacDeviceId]
    }

    var normalizedPreviousTrustedMacDeviceId: String? {
        previousTrustedMacDeviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    func trustedMacRecord(for deviceId: String?) -> CodexTrustedMacRecord? {
        guard let normalizedDeviceId = deviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty else {
            return nil
        }

        return trustedMacRegistry.records[normalizedDeviceId]
    }

    func setCurrentTrustedMacDeviceId(_ deviceId: String?) {
        let normalizedDeviceId = deviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        currentTrustedMacDeviceId = normalizedDeviceId
        if let normalizedDeviceId {
            SecureStore.writeString(normalizedDeviceId, for: CodexSecureKeys.currentTrustedMacDeviceId)
        } else {
            SecureStore.deleteValue(for: CodexSecureKeys.currentTrustedMacDeviceId)
        }
    }

    func setPreviousTrustedMacDeviceId(_ deviceId: String?) {
        previousTrustedMacDeviceId = deviceId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    func clearPreviousTrustedMacDeviceId() {
        previousTrustedMacDeviceId = nil
    }

    // Bootstraps the explicit current Mac selection from saved relay/last-paired ids when missing.
    func migrateCurrentTrustedMacDeviceIdIfNeeded() {
        if let normalizedCurrentTrustedMacDeviceId,
           trustedMacRegistry.records[normalizedCurrentTrustedMacDeviceId] != nil {
            return
        }

        let bootstrapDeviceId = [
            normalizedRelayMacDeviceId,
            normalizedLastTrustedMacDeviceId,
        ]
        .compactMap { $0 }
        .first { trustedMacRegistry.records[$0] != nil }

        setCurrentTrustedMacDeviceId(bootstrapDeviceId)
    }

    var hasTrustedMacReconnectCandidate: Bool {
        preferredTrustedMacRecord?.relayURL?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    var hasReconnectCandidate: Bool {
        hasSavedRelaySession || hasTrustedMacReconnectCandidate
    }

    // Chooses the best relay base URL for a one-shot display wake before reconnecting.
    var preferredWakeRelayURL: String? {
        guard !isConnected,
              secureConnectionState != .rePairRequired else {
            return nil
        }

        if hasTrustedReconnectContext {
            return normalizedRelayURL
        }

        let trimmedRelayURL = preferredTrustedMacRecord?.relayURL?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedRelayURL, !trimmedRelayURL.isEmpty {
            return trimmedRelayURL
        }
        return nil
    }

    // Wake can use either a saved live session or a freshly resolved trusted session.
    var canWakePreferredMacDisplay: Bool {
        guard !isConnected,
              secureConnectionState != .rePairRequired else {
            return false
        }

        return preferredWakeRelayURL != nil
    }

    // Separates transport readiness from post-connect hydration so the UI can explain delays honestly.
    var connectionPhase: CodexConnectionPhase {
        if isConnecting {
            return .connecting
        }

        guard isConnected else {
            return .offline
        }

        if threads.isEmpty && (isBootstrappingConnectionSync || isLoadingThreads) {
            return .loadingChats
        }

        if isBootstrappingConnectionSync || isLoadingThreads {
            return .syncing
        }

        return .connected
    }

    var connectionPhaseDisplayLabel: String {
        switch connectionPhase {
        case .offline:
            return "Offline"
        case .connecting:
            return "Connecting"
        case .loadingChats:
            return "Loading chats"
        case .syncing:
            return "Syncing"
        case .connected:
            return "Connected"
        }
    }

    var secureConnectionDisplayLabel: String? {
        let label = secureConnectionState.statusLabel
        return label.isEmpty || secureConnectionState == .notPaired ? nil : label
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
