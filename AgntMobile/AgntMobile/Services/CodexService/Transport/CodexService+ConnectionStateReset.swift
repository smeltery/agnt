// FILE: CodexService+ConnectionStateReset.swift
// Purpose: Transport reset, reconnect candidate, and volatile connection state helpers.
// Layer: Service

import Foundation
import Network

extension CodexService {
    func resetThreadRuntimeStateForServerSwitch() {
        resetRuntimeSettingsSyncState()
        activeThreadId = nil
        activeTurnId = nil
        activeTurnIdByThread.removeAll()
        refreshAllThreadTimelineStates()
        threadIdByTurnID.removeAll()
        clearPendingApprovals()
        currentOutput = ""
        lastErrorMessage = nil
        isLoadingModels = false
        pendingRuntimeOptionRefresh = false
        runtimeOptionRefreshTask?.cancel()
        runtimeOptionRefreshTask = nil
        runtimeOptionRefreshToken = nil
        modelsErrorMessage = nil
        assistantCompletionFingerprintByThread.removeAll()
        recentActivityLineByThread.removeAll()
        removeAllThreadTimelineState()
        assistantRevertStateCacheByThread.removeAll()
        assistantRevertStateRevision = 0
        workspaceCheckpointCopyTaskByTurnID.values.forEach { $0.cancel() }
        workspaceCheckpointCopyTaskByTurnID.removeAll()
        supportsServiceTier = true
        hasPresentedServiceTierBridgeUpdatePrompt = false
        supportsBridgeVoiceAuth = true
        supportsThreadFork = true
        supportsTurnPagination = true
        hasPresentedThreadForkBridgeUpdatePrompt = false
        hasPresentedMinimumBridgePackageUpdatePrompt = false
        lastPresentedAvailableBridgePackageVersion = nil
        clearAllRunningState()
        readyThreadIDs.removeAll()
        failedThreadIDs.removeAll()
        runningThreadWatchByID.removeAll()
        pendingNotificationOpenThreadID = nil
        clearTransientConnectionPrompts()
        endBackgroundRunGraceTask(reason: "server-switch")
        shouldAutoReconnectOnForeground = false
        connectionRecoveryState = .idle
        supportsStructuredSkillInput = true
        supportsStructuredMentionInput = true
        supportsTurnCollaborationMode = false
        bridgeInstalledVersion = nil
        latestBridgePackageVersion = nil
        resumedThreadIDs.removeAll()
        clearHydrationCaches()
        resetSecureTransportState()
    }

    // Clears UI-only recovery prompts that should not survive a relay/context teardown.
    func clearTransientConnectionPrompts() {
        bridgeUpdatePrompt = nil
        threadCompletionBanner = nil
        missingNotificationThreadPrompt = nil
        clearSystemNotices()
    }

    // Removes the current socket reference before reconnect/teardown logic mutates shared state.
    func cancelCurrentSocketConnection() {
        stopWebSocketKeepAliveLoop()

        if let connection = webSocketConnection {
            connection.stateUpdateHandler = nil
            webSocketConnection = nil
            connection.cancel()
        }

        if let task = webSocketTask {
            webSocketTask = nil
            task.cancel(with: .goingAway, reason: nil)
        }

        if let session = webSocketSession {
            webSocketSession = nil
            session.invalidateAndCancel()
        }

        webSocketSessionDelegate = nil
        manualWebSocketReadBuffer = Data()
        usesManualWebSocketTransport = false
    }

    // Drops sync work tied to the old transport so reconnect starts from a clean baseline.
    func clearConnectionSyncState() {
        isBootstrappingConnectionSync = false
        stopSyncLoop()
        postConnectSyncTask?.cancel()
        postConnectSyncTask = nil
        postConnectSyncToken = nil
        threadListFetchTaskByLimit.values.forEach { $0.task.cancel() }
        threadListFetchTaskByLimit.removeAll()
        cancelAllPerThreadRefreshWork()
    }

    // Avoids wiping thread/runtime state when reconnecting after a socket that already died.
    func prepareForConnectionAttempt(preserveReconnectIntent: Bool = true) async {
        let needsTransportReset = webSocketConnection != nil
            || webSocketTask != nil
            || isConnected
            || isInitialized
            || !pendingRequests.isEmpty

        guard needsTransportReset else {
            // A dead socket can still leave secure-handshake buffers behind; clear only transport-volatiles here.
            resetSecureTransportState(preservePendingQRBootstrapState: shouldForceQRBootstrapOnNextHandshake)
            return
        }

        await disconnect(preserveReconnectIntent: preserveReconnectIntent)
    }

    // Identifies reconnects that should reuse a previously trusted Mac instead of going through QR bootstrap.
    var hasTrustedReconnectContext: Bool {
        guard hasSavedRelaySession,
              !shouldForceQRBootstrapOnNextHandshake,
              let relayMacDeviceId = normalizedRelayMacDeviceId,
              normalizedCurrentTrustedMacDeviceId == nil || normalizedCurrentTrustedMacDeviceId == relayMacDeviceId else {
            return false
        }

        return trustedMacRegistry.records[relayMacDeviceId] != nil
    }

    // Counts reconnect handshake failures so repeated stale-session wakeups can fall back to
    // trusted-session resolution instead of forcing an unnecessary fresh QR scan.
    @discardableResult
    func recordTrustedReconnectFailureIfNeeded(isTrustedReconnectAttempt: Bool) -> Bool {
        guard isTrustedReconnectAttempt else {
            trustedReconnectFailureCount = 0
            return false
        }

        trustedReconnectFailureCount += 1
        guard trustedReconnectFailureCount >= Self.maxTrustedReconnectFailures else {
            return false
        }

        shouldAutoReconnectOnForeground = false
        connectionRecoveryState = .idle
        return true
    }

    // Preserves trusted Mac identity while removing only the stale per-launch relay session.
    func recoverTrustedReconnectCandidate() {
        if hasSavedRelaySession {
            clearStaleSavedRelaySessionForTrustedReconnect()
        } else if preferredTrustedMacRecord != nil {
            secureConnectionState = .liveSessionUnresolved
        } else {
            clearSavedRelaySession()
        }
        lastErrorMessage = Self.trustedReconnectRecoveryMessage
    }

}
