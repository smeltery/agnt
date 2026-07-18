// FILE: CodexService+BridgeAccountStatus.swift
// Purpose: Bridge-managed account status, host metadata, and package update prompt handling.
// Layer: Service

import Foundation

extension CodexService {
    func fetchBridgeManagedStatusSnapshot() async throws -> (
        payload: IncomingParamsObject,
        allowMissingVersionPrompt: Bool
    ) {
        do {
            let response = try await sendRequest(method: "account/status/read", params: nil)
            guard let payload = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("bridge account status response missing payload")
            }
            return (
                payload: payload,
                allowMissingVersionPrompt: true
            )
        } catch {
            let response = try await sendRequest(method: "getAuthStatus", params: nil)
            guard let payload = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("bridge account status response missing payload")
            }
            return (
                payload: payload,
                allowMissingVersionPrompt: shouldTreatAsUnsupportedBridgeManagedAccountStatus(error)
            )
        }
    }

    // Applies the bridge-owned ChatGPT snapshot after a shared managed-status fetch.
    func applyBridgeManagedAccountSnapshot(from payloadObject: IncomingParamsObject) {
        applyGPTAccountSnapshot(decodeBridgeGPTAccountSnapshot(from: payloadObject))
        if currentPendingGPTLogin() != nil,
           (gptAccountSnapshot.hasActiveLogin || (gptAccountSnapshot.isAuthenticated && !gptAccountSnapshot.isVoiceTokenReady)) {
            startGPTLoginSyncIfNeeded()
        }
        if gptAccountSnapshot.isAuthenticated || gptAccountSnapshot.status == .notLoggedIn {
            gptAccountErrorMessage = nil
        }
    }

    // Applies bridge package versions and prompts independently from GPT account state.
    func applyBridgePackageStatus(
        from payloadObject: IncomingParamsObject,
        allowMissingVersionPrompt: Bool,
        allowAvailableBridgeUpdatePrompt: Bool
    ) {
        let previousTransportMode = codexTransportMode
        codexTransportMode = decodeCodexTransportMode(
            from: firstStringValue(
                in: payloadObject,
                keys: ["codexTransportMode", "codex_transport_mode", "transportMode", "transport_mode"]
            )
        )
        reconcileNativePlanSessionSources(
            previousTransportMode: previousTransportMode,
            nextTransportMode: codexTransportMode
        )
        bridgeInstalledVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeVersion", "bridge_version", "bridgePackageVersion", "bridge_package_version"]
        )
        latestBridgePackageVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeLatestVersion", "bridge_latest_version", "bridgePublishedVersion", "bridge_published_version"]
        )
        applyBridgeHostMetadata(from: payloadObject)
        evaluateRequiredBridgePackageVersion(
            from: payloadObject,
            allowMissingVersionPrompt: allowMissingVersionPrompt
        )
        if allowAvailableBridgeUpdatePrompt {
            evaluateAvailableBridgePackageVersionPromptIfNeeded()
        }
    }

    func decodeCodexTransportMode(from rawValue: String?) -> CodexRuntimeTransportMode {
        guard let rawValue = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !rawValue.isEmpty else {
            return .unknown
        }

        return CodexRuntimeTransportMode(rawValue: rawValue) ?? .unknown
    }

    func applyBridgeHostMetadata(from payloadObject: IncomingParamsObject) {
        gptAccountSnapshot.hostPlatform = decodeBridgeHostPlatform(
            from: firstStringValue(
                in: payloadObject,
                keys: ["hostPlatform", "host_platform", "bridgeHostPlatform", "bridge_host_platform"]
            )
        )
        gptAccountSnapshot.hostCapabilities = decodeBridgeHostCapabilities(from: payloadObject)
    }

    func handleBridgeManagedAccountRefreshFailure() {
        if gptAccountSnapshot.status == .unknown {
            gptAccountSnapshot = disconnectedGPTAccountSnapshot()
        }
    }

    // Prompts for a bridge package upgrade once per session when bridge-managed status
    // reports an older npm package or omits the version entirely.
    func evaluateRequiredBridgePackageVersion(
        from payloadObject: IncomingParamsObject,
        allowMissingVersionPrompt: Bool
    ) {
        guard !hasPresentedMinimumBridgePackageUpdatePrompt else {
            return
        }

        let bridgeVersion = firstStringValue(
            in: payloadObject,
            keys: ["bridgeVersion", "bridge_version", "bridgePackageVersion", "bridge_package_version"]
        )
        let requiresUpgrade =
            bridgePackageVersionIsOlderThanMinimum(bridgeVersion)
            || (bridgeVersion == nil && allowMissingVersionPrompt)

        guard requiresUpgrade else {
            return
        }

        hasPresentedMinimumBridgePackageUpdatePrompt = true
        bridgeUpdatePrompt = minimumBridgePackageUpdatePrompt(currentVersion: bridgeVersion)
    }

    // Only explicit versions can be compared here; missing versions are handled by the caller.
    func bridgePackageVersionIsOlderThanMinimum(_ bridgeVersion: String?) -> Bool {
        guard let bridgeVersion = bridgeVersion?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bridgeVersion.isEmpty else {
            return false
        }

        return bridgeVersion.compare(CodexService.minimumSupportedBridgePackageVersion, options: .numeric) == .orderedAscending
    }

    // Distinguishes "older bridge only exposes getAuthStatus" from transient read failures on a current bridge.
    func shouldTreatAsUnsupportedBridgeManagedAccountStatus(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code == -32601 {
            return true
        }

        let message = rpcError.message.lowercased()
        let mentionsUnsupportedMethod = message.contains("method not found")
            || message.contains("unknown method")
            || message.contains("not implemented")
            || message.contains("does not support")
        let mentionsAccountStatusRoute = message.contains("account/status/read")
            || message.contains("account status read")
            || message.contains("auth status")

        guard rpcError.code == -32600 || rpcError.code == -32602 || rpcError.code == -32000 else {
            return mentionsUnsupportedMethod && mentionsAccountStatusRoute
        }

        return mentionsUnsupportedMethod && mentionsAccountStatusRoute
    }

    func minimumBridgePackageUpdatePrompt(currentVersion: String?) -> CodexBridgeUpdatePrompt {
        let message: String
        if let currentVersion = currentVersion?.trimmingCharacters(in: .whitespacesAndNewlines),
           !currentVersion.isEmpty {
            message =
                "This computer bridge is running agnt \(currentVersion), but this iPhone app requires agnt \(CodexService.minimumSupportedBridgePackageVersion) or newer. Update the npm package on your computer, then reconnect."
        } else {
            message =
                "This computer bridge is too old for this version of agnt iPhone. Update the agnt npm package on your computer to \(CodexService.minimumSupportedBridgePackageVersion) or newer, then reconnect."
        }

        return CodexBridgeUpdatePrompt(
            title: "Update agnt on your computer to reconnect",
            message: message,
            command: minimumBridgePackageUpdateCommand
        )
    }

    // Surfaces a softer "npm update available" prompt without overriding stricter compatibility prompts.
    func evaluateAvailableBridgePackageVersionPromptIfNeeded() {
        guard isAppInForeground else {
            return
        }

        guard bridgeUpdatePrompt == nil else {
            return
        }

        guard let installedVersion = normalizedBridgePackageVersion(bridgeInstalledVersion) else {
            return
        }

        if installedVersion == forcedBridgeUpgradeFromVersion {
            guard lastPresentedAvailableBridgePackageVersion != forcedBridgeUpgradeTargetVersion else {
                return
            }

            lastPresentedAvailableBridgePackageVersion = forcedBridgeUpgradeTargetVersion
            bridgeUpdatePrompt = forcedBridgePackageUpdatePrompt(currentVersion: installedVersion)
            return
        }

        guard let latestVersion = normalizedBridgePackageVersion(latestBridgePackageVersion),
              installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending else {
            return
        }

        guard lastPresentedAvailableBridgePackageVersion != latestVersion else {
            return
        }

        lastPresentedAvailableBridgePackageVersion = latestVersion
        bridgeUpdatePrompt = availableBridgePackageUpdatePrompt(
            currentVersion: installedVersion,
            latestVersion: latestVersion
        )
    }

    // Keeps version comparisons and prompt copy on one normalized representation.
    func normalizedBridgePackageVersion(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }

    func availableBridgePackageUpdatePrompt(
        currentVersion: String,
        latestVersion: String
    ) -> CodexBridgeUpdatePrompt {
        CodexBridgeUpdatePrompt(
            title: "A newer agnt update is available on your computer",
            message: "This computer bridge is running agnt \(currentVersion), and npm now has agnt \(latestVersion). Update the package on your computer when you're ready, then reconnect to start using the newer build.",
            command: minimumBridgePackageUpdateCommand
        )
    }

    func forcedBridgePackageUpdatePrompt(currentVersion: String) -> CodexBridgeUpdatePrompt {
        CodexBridgeUpdatePrompt(
            title: "Update agnt on your computer to reconnect",
            message: "This computer bridge is running agnt \(currentVersion). Update the agnt CLI on your computer to \(forcedBridgeUpgradeTargetVersion), then reconnect.",
            command: forcedBridgeUpgradeCommand
        )
    }

    // Opens the pending ChatGPT login URL on the bridge Mac instead of opening Safari on iPhone.
}
