// FILE: CodexService+Connection.swift
// Purpose: Connection lifecycle and initialization handshake.
// Layer: Service
// Exports: CodexService connection APIs
// Depends on: Network.NWConnection, UIKit

import Foundation
import Network
import UIKit

extension CodexService {
    // Only close codes that prove the saved pairing/session can no longer be reused
    // should force a QR reset. Temporary delivery loss uses the dedicated `4004`
    // close so `4002` can stay available for "session unavailable right now" cases.
    static let permanentRelayCloseCodeRawValues: Set<UInt16> = [4000, 4001, 4003]
    static let explicitRelayDropCloseCodeRawValues: Set<UInt16> = [4004]
    static let maxTrustedReconnectFailures = 3
    static let trustedReconnectRecoveryMessage =
        "Secure reconnect could not be restored from the saved session. Try reconnecting again."

    // Models how one socket failure should affect reconnect state, pairing persistence, and UI copy.
    struct ReceiveErrorDisposition {
        let shouldClearSavedRelaySession: Bool
        let shouldAutoReconnectOnForeground: Bool
        let connectionRecoveryState: CodexConnectionRecoveryState
        let lastErrorMessage: String?
    }

    // Opens the WebSocket and performs initialize/initialized handshake.
    func connect(
        serverURL: String,
        token: String,
        role: String? = nil,
        performInitialSync: Bool = true
    ) async throws {
        guard !isConnecting else {
            lastErrorMessage = "Connection already in progress"
            throw CodexServiceError.invalidInput("Connection already in progress")
        }

        isConnecting = true
        defer { isConnecting = false }

        await prepareForConnectionAttempt(preserveReconnectIntent: true)

        let normalizedServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = try validateConnectionURL(normalizedServerURL)
        try await requestLocalNetworkAuthorizationIfNeeded(for: url)
        let serverIdentity = canonicalServerIdentity(for: url)
        if let previousIdentity = connectedServerIdentity, previousIdentity != serverIdentity {
            resetThreadRuntimeStateForServerSwitch()
        }
        connectedServerIdentity = serverIdentity

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let transport: CodexWebSocketTransport
        do {
            transport = try await establishWebSocketConnection(url: url, token: trimmedToken, role: role)
        } catch {
            let friendlyMessage = userFacingConnectError(
                error: error,
                attemptedURL: normalizedServerURL,
                host: url.host
            )
            if isRecoverableTransientConnectionError(error) || isRetryableSavedSessionConnectError(error) {
                connectionRecoveryState = .retrying(attempt: 0, message: recoveryStatusMessage(for: error))
                lastErrorMessage = retryableSessionUnavailableMessage(forConnectError: error)
                throw error
            } else {
                lastErrorMessage = friendlyMessage
            }
            throw CodexServiceError.invalidInput(friendlyMessage)
        }
        switch transport {
        case .network(let connection):
            usesManualWebSocketTransport = false
            webSocketConnection = connection
            startReceiveLoop(with: connection)
        case .manualTCP(let connection):
            usesManualWebSocketTransport = true
            manualWebSocketReadBuffer = Data()
            webSocketConnection = connection
            startManualReceiveLoop(with: connection)
        case .urlSession(let session, let task):
            usesManualWebSocketTransport = false
            webSocketSession = session
            webSocketTask = task
            startReceiveLoop(with: task)
        }
        clearHydrationCaches()
        let isTrustedReconnectAttempt = hasTrustedReconnectContext

        do {
            try await performSecureHandshake()

            isConnected = true
            shouldAutoReconnectOnForeground = false
            connectionRecoveryState = .idle
            lastErrorMessage = nil
            try await initializeSession()
            trustedReconnectFailureCount = 0
            if secureSession != nil {
                secureConnectionState = .encrypted
            }

            startWebSocketKeepAliveLoop()
            startSyncLoop()
            // Push registration is best-effort and talks to the bridge, so it must not
            // hold the main connect path hostage when the managed backend is slow.
            Task { @MainActor [weak self] in
                await self?.syncManagedPushRegistrationIfNeeded(force: true)
            }
            if performInitialSync {
                schedulePostConnectSyncPass()
            }
            Task { @MainActor [weak self] in
                await self?.refreshBridgeManagedState(
                    allowAvailableBridgeUpdatePrompt: self?.isAppInForeground ?? false
                )
                self?.startGPTLoginSyncIfNeeded()
                await self?.syncBridgeKeepMacAwakePreferenceIfNeeded()
                await self?.syncBridgeEnableWebTerminalPreferenceIfNeeded()
            }
        } catch {
            let shouldResetSavedSession = recordTrustedReconnectFailureIfNeeded(
                isTrustedReconnectAttempt: isTrustedReconnectAttempt
            )
            presentConnectionErrorIfNeeded(error)
            // Keep foreground auto-recovery armed across internal reconnect failures.
            await disconnect(preserveReconnectIntent: shouldAutoReconnectOnForeground)
            if shouldResetSavedSession {
                recoverTrustedReconnectCandidate()
            }
            throw error
        }
    }

    // Closes the socket and fails any in-flight requests.
    func disconnect(preserveReconnectIntent: Bool = false) async {
        cancelCurrentSocketConnection()

        isConnected = false
        isInitialized = false
        isLoadingThreads = false
        isLoadingModels = false
        pendingRuntimeOptionRefresh = false
        runtimeOptionRefreshTask?.cancel()
        runtimeOptionRefreshTask = nil
        runtimeOptionRefreshToken = nil
        clearPendingApprovals()
        finalizeAllStreamingState()
        messagePersistenceDebounceTask?.cancel()
        messagePersistenceDebounceTask = nil
        if !suspendAutomaticMacScopedPersistence {
            persistCurrentMacMessages()
        }
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
        clearTransientConnectionPrompts()
        endBackgroundRunGraceTask(reason: "disconnect")
        if !preserveReconnectIntent {
            shouldAutoReconnectOnForeground = false
            connectionRecoveryState = .idle
        }
        supportsStructuredSkillInput = true
        supportsStructuredMentionInput = true
        supportsTurnCollaborationMode = false
        hasResolvedRateLimitsSnapshot = false
        bridgeInstalledVersion = nil
        latestBridgePackageVersion = nil
        clearConnectionSyncState()
        clearHydrationCaches()
        resumedThreadIDs.removeAll()
        resetSecureTransportState()
        cancelTrustedSessionResolve()

        failAllPendingRequests(with: CodexServiceError.disconnected)
    }

    func setKeepMacAwakeWhileBridgeRunsPreference(_ enabled: Bool) {
        keepMacAwakeWhileBridgeRuns = enabled
        defaults.set(enabled, forKey: Self.keepMacAwakeWhileBridgeRunsDefaultsKey)
    }

    func updateBridgeKeepMacAwakePreference(_ enabled: Bool) async {
        setKeepMacAwakeWhileBridgeRunsPreference(enabled)
        await syncBridgeKeepMacAwakePreferenceIfNeeded(showFailureInUI: true)
    }

    func syncBridgeKeepMacAwakePreferenceIfNeeded(showFailureInUI: Bool = false) async {
        guard isConnected, supportsKeepAwakeWhileBridgeRuns else {
            return
        }

        let handoffService = DesktopHandoffService(codex: self)

        do {
            try await handoffService.updateBridgeKeepMacAwakePreference(
                enabled: keepMacAwakeWhileBridgeRuns
            )
        } catch {
            if showFailureInUI {
                lastErrorMessage = userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }

    func setEnableWebTerminalOnBridgePreference(_ enabled: Bool) {
        enableWebTerminalOnBridge = enabled
        defaults.set(enabled, forKey: Self.enableWebTerminalOnBridgeDefaultsKey)
    }

    func updateBridgeEnableWebTerminalPreference(_ enabled: Bool) async {
        setEnableWebTerminalOnBridgePreference(enabled)
        await syncBridgeEnableWebTerminalPreferenceIfNeeded(showFailureInUI: true)
    }

    func syncBridgeEnableWebTerminalPreferenceIfNeeded(showFailureInUI: Bool = false) async {
        guard isConnected else {
            return
        }
        let handoffService = DesktopHandoffService(codex: self)
        do {
            try await handoffService.updateBridgeEnableWebTerminalPreference(
                enabled: enableWebTerminalOnBridge
            )
        } catch {
            if showFailureInUI {
                lastErrorMessage = userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }

    // Clears all remembered relay metadata when the pairing itself is no longer trustworthy.
    func clearSavedRelaySession() {
        SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayUrl)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacDeviceId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacIdentityPublicKey)
        SecureStore.deleteValue(for: CodexSecureKeys.relayProtocolVersion)
        SecureStore.deleteValue(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)
        SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
        relaySessionId = nil
        relayUrl = nil
        relayMacDeviceId = nil
        relayMacIdentityPublicKey = nil
        relayProtocolVersion = codexSecureProtocolVersion
        lastAppliedBridgeOutboundSeq = 0
        lastAppliedBridgeReplayEpoch = nil
        shouldForceQRBootstrapOnNextHandshake = false
        trustedReconnectFailureCount = 0
        if let trustedMac = currentTrustedMacRecord {
            secureConnectionState = .liveSessionUnresolved
            secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        } else {
            secureConnectionState = .notPaired
            secureMacFingerprint = nil
        }
        pendingNotificationOpenThreadID = nil
        lastPushRegistrationSignature = nil
        clearTransientConnectionPrompts()
    }

    // Drops only the per-launch relay session after repeated trusted reconnect failures.
    func clearStaleSavedRelaySessionForTrustedReconnect() {
        guard let trustedMac = preferredTrustedMacRecord else {
            clearSavedRelaySession()
            return
        }

        SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)
        SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
        relaySessionId = nil
        lastAppliedBridgeOutboundSeq = 0
        lastAppliedBridgeReplayEpoch = nil
        shouldForceQRBootstrapOnNextHandshake = false
        trustedReconnectFailureCount = 0
        secureConnectionState = .liveSessionUnresolved
        secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        pendingNotificationOpenThreadID = nil
        lastPushRegistrationSignature = nil
        clearTransientConnectionPrompts()
    }

    func forgetTrustedMac(deviceId: String? = nil) {
        let targetDeviceId = deviceId ?? normalizedCurrentTrustedMacDeviceId
        guard let targetDeviceId else {
            return
        }

        trustedMacRegistry.records.removeValue(forKey: targetDeviceId)
        SecureStore.writeCodable(trustedMacRegistry, for: CodexSecureKeys.trustedMacRegistry)

        if normalizedCurrentTrustedMacDeviceId == targetDeviceId {
            setCurrentTrustedMacDeviceId(nil)
        }
        if normalizedLastTrustedMacDeviceId == targetDeviceId {
            SecureStore.deleteValue(for: CodexSecureKeys.lastTrustedMacDeviceId)
            lastTrustedMacDeviceId = nil
        }
        if normalizedPreviousTrustedMacDeviceId == targetDeviceId {
            clearPreviousTrustedMacDeviceId()
        }

        if normalizedRelayMacDeviceId == targetDeviceId {
            clearSavedRelaySession()
        } else {
            resetSecureTransportState()
        }
    }

    // Gives the UI one stable "forget pair" action whether reconnect comes from a trusted record
    // or only from the last saved relay session.
    func forgetReconnectCandidate() {
        if let normalizedRelayMacDeviceId,
           trustedMacRegistry.records[normalizedRelayMacDeviceId] != nil {
            forgetTrustedMac(deviceId: normalizedRelayMacDeviceId)
            return
        }

        if normalizedCurrentTrustedMacDeviceId != nil {
            forgetTrustedMac()
            return
        }

        clearSavedRelaySession()
    }

    func initializeSession() async throws {
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let clientInfo: JSONValue = .object([
            "name": .string("codexmobile_ios"),
            "title": .string("AgntMobile iOS"),
            "version": .string(appVersion),
        ])

        // Ask for experimental APIs up front so plan mode can use `collaborationMode`
        // on runtimes that support it, while keeping a legacy handshake fallback.
        let modernParams: JSONValue = .object([
            "clientInfo": clientInfo,
            "capabilities": .object([
                "experimentalApi": .bool(true),
            ]),
        ])
        var shouldProbePlanCollaborationMode = false

        do {
            let initializeResponse = try await sendRequest(method: "initialize", params: modernParams)
            learnTurnPaginationSupportFromInitializeResponse(initializeResponse)
            // A successful modern initialize means the runtime accepted the experimental
            // capability negotiation. Keep plan-mode sends enabled unless the runtime
            // explicitly rejects `collaborationMode` on a turn request later.
            supportsTurnCollaborationMode = true
            debugRuntimeLog("initialize success experimentalApi=true")
            shouldProbePlanCollaborationMode = true
        } catch {
            if let incompatibleAppVersionError = incompatibleBridgeAppVersionError(from: error) {
                throw incompatibleAppVersionError
            }

            guard shouldRetryInitializeWithoutCapabilities(error) else {
                throw error
            }

            let legacyParams: JSONValue = .object([
                "clientInfo": clientInfo,
            ])
            do {
                let initializeResponse = try await sendRequest(method: "initialize", params: legacyParams)
                learnTurnPaginationSupportFromInitializeResponse(initializeResponse)
            } catch {
                if let incompatibleAppVersionError = incompatibleBridgeAppVersionError(from: error) {
                    throw incompatibleAppVersionError
                }
                throw error
            }
            supportsTurnCollaborationMode = false
            debugRuntimeLog("initialize fallback experimentalApi=false")
        }

        try await sendNotification(method: "initialized", params: nil)
        isInitialized = true
        flushPendingReplayDiscontinuityHistoryRefresh()
        if shouldProbePlanCollaborationMode {
            schedulePlanCollaborationModeProbe()
        }
    }

    // Converts a bridge-declared "your iPhone app is too old" initialize failure into
    // a direct connect error and surfaces the app-update recovery sheet.
    func incompatibleBridgeAppVersionError(from error: Error) -> CodexServiceError? {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return nil
        }

        let dataObject = rpcError.data?.objectValue
        let errorCode = dataObject?["errorCode"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard errorCode == "ios_app_update_required" else {
            return nil
        }

        let minimumSupportedAppVersion = dataObject?["minimumSupportedAppVersion"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let bridgeVersion = dataObject?["bridgeVersion"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let message = rpcError.message.trimmingCharacters(in: .whitespacesAndNewlines)

        let promptMessage: String
        if !message.isEmpty {
            promptMessage = message
        } else if let bridgeVersion, !bridgeVersion.isEmpty,
                  let minimumSupportedAppVersion, !minimumSupportedAppVersion.isEmpty {
            promptMessage =
                "This computer bridge is running agnt \(bridgeVersion), which requires agnt iPhone \(minimumSupportedAppVersion) or newer. Update the iPhone app, then reconnect."
        } else if let minimumSupportedAppVersion, !minimumSupportedAppVersion.isEmpty {
            promptMessage =
                "This computer bridge requires agnt iPhone \(minimumSupportedAppVersion) or newer. Update the iPhone app, then reconnect."
        } else {
            promptMessage = "This computer bridge requires a newer agnt iPhone app. Update the app, then reconnect."
        }

        bridgeUpdatePrompt = CodexBridgeUpdatePrompt(
            title: "Update agnt on your iPhone to reconnect",
            message: promptMessage,
            command: nil
        )

        if !message.isEmpty {
            return .invalidInput(message)
        }

        if let bridgeVersion, !bridgeVersion.isEmpty,
           let minimumSupportedAppVersion, !minimumSupportedAppVersion.isEmpty {
            return .invalidInput(
                "This computer bridge is running agnt \(bridgeVersion), which requires agnt iPhone \(minimumSupportedAppVersion) or newer. Update the iPhone app, then reconnect."
            )
        }

        if let minimumSupportedAppVersion, !minimumSupportedAppVersion.isEmpty {
            return .invalidInput(
                "This computer bridge requires agnt iPhone \(minimumSupportedAppVersion) or newer. Update the iPhone app, then reconnect."
            )
        }

        return .invalidInput("This computer bridge requires a newer agnt iPhone app. Update the app, then reconnect.")
    }

}
