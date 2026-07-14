// FILE: CodexService+AccountLifecycle.swift
// Purpose: ChatGPT login, logout, callback, and voice-auth lifecycle helpers.
// Layer: Service

import Foundation

extension CodexService {
    static let legacyGPTLoginCallbackEnabled = true

    // Refreshes bridge-managed account + package metadata together for foreground/reconnect flows.
    func refreshBridgeManagedState(allowAvailableBridgeUpdatePrompt: Bool = false) async {
        guard isConnected else {
            applyGPTAccountConnectionFallback()
            return
        }

        do {
            let bridgeState = try await fetchBridgeManagedStatusSnapshot()
            applyBridgePackageStatus(
                from: bridgeState.payload,
                allowMissingVersionPrompt: bridgeState.allowMissingVersionPrompt,
                allowAvailableBridgeUpdatePrompt: allowAvailableBridgeUpdatePrompt
            )
            applyBridgeManagedAccountSnapshot(from: bridgeState.payload)
        } catch {
            handleBridgeManagedAccountRefreshFailure()
        }
    }

    // Refreshes the bridge-owned account snapshot without ever fetching GPT tokens on iPhone.
    func refreshGPTAccountState() async {
        guard isConnected else {
            applyGPTAccountConnectionFallback()
            return
        }

        do {
            let bridgeState = try await fetchBridgeManagedStatusSnapshot()
            applyBridgeManagedAccountSnapshot(from: bridgeState.payload)
        } catch {
            handleBridgeManagedAccountRefreshFailure()
        }
    }

    // Refreshes only the bridge package version state so agnt updates stay independent from GPT UX.
    func refreshBridgeVersionState(allowAvailableBridgeUpdatePrompt: Bool = false) async {
        guard isConnected else {
            return
        }

        do {
            let bridgeState = try await fetchBridgeManagedStatusSnapshot()
            applyBridgePackageStatus(
                from: bridgeState.payload,
                allowMissingVersionPrompt: bridgeState.allowMissingVersionPrompt,
                allowAvailableBridgeUpdatePrompt: allowAvailableBridgeUpdatePrompt
            )
        } catch {
            // Keep the last-known bridge version info when the status read fails transiently.
        }
    }

    // Starts a ChatGPT login or reuses the last valid auth URL while login is still pending.
    func startOrResumeGPTLogin() async throws -> CodexGPTLoginStartResult {
        if let pendingLogin = currentPendingGPTLogin(),
           let authURL = URL(string: pendingLogin.authURL) {
            applyGPTAccountSnapshot(
                pendingLoginSnapshot(
                    expiresAt: pendingLogin.expiresAt,
                    retaining: gptAccountSnapshot
                )
            )
            gptAccountErrorMessage = nil
            return CodexGPTLoginStartResult(
                loginId: pendingLogin.loginId,
                authURL: authURL,
                expiresAt: pendingLogin.expiresAt
            )
        }

        guard isConnected else {
            throw CodexServiceError.disconnected
        }

        let response = try await sendRequest(
            method: "account/login/start",
            params: .object([
                "type": .string("chatgpt"),
            ])
        )
        let loginStartResult = try decodeGPTLoginStartResult(from: response)
        gptPendingLoginState = CodexGPTLoginState(
            loginId: loginStartResult.loginId,
            authURL: loginStartResult.authURL.absoluteString,
            createdAt: .now,
            expiresAt: loginStartResult.expiresAt
        )
        applyGPTAccountSnapshot(
            pendingLoginSnapshot(
                expiresAt: loginStartResult.expiresAt,
                retaining: gptAccountSnapshot
            )
        )
        gptAccountErrorMessage = nil
        return loginStartResult
    }

    // Starts or resumes ChatGPT login, then asks the bridge Mac to open the browser locally.
    func startOrResumeGPTLoginOnMac() async throws {
        guard isConnected else {
            throw CodexServiceError.disconnected
        }

        let login = try await startOrResumeGPTLogin()
        try await openGPTLoginOnMac(authURL: login.authURL)
        startGPTLoginSyncIfNeeded()
    }

    // Starts or resumes ChatGPT login and returns the auth URL so iPhone can open it directly.
    func startOrResumeGPTLoginOnPhone() async throws -> URL {
        guard isConnected else {
            throw CodexServiceError.disconnected
        }

        let login = try await startOrResumeGPTLogin()
        startGPTLoginSyncIfNeeded()
        return login.authURL
    }

    // Cancels a pending browser login locally and on the Mac runtime when reachable.
    func cancelGPTLogin() async {
        if isConnected, let pendingLogin = currentPendingGPTLogin() {
            _ = try? await sendRequest(
                method: "account/login/cancel",
                params: .object([
                    "loginId": .string(pendingLogin.loginId),
                ])
            )
        }

        clearGPTLoginState()
        clearGPTLoginCallbackState()
        stopGPTLoginSync()
        if !gptAccountSnapshot.isAuthenticated {
            applyGPTAccountSnapshot(loggedOutGPTAccountSnapshot(status: .notLoggedIn, retaining: gptAccountSnapshot))
        }
        gptAccountErrorMessage = nil
    }

    // Logs the Mac-owned ChatGPT session out without touching pairing or reconnect state.
    func logoutGPTAccount() async {
        if isConnected {
            _ = try? await sendRequest(method: "account/logout", params: nil)
        }

        clearGPTLoginState()
        clearGPTLoginCallbackState()
        stopGPTLoginSync()
        applyGPTAccountSnapshot(loggedOutGPTAccountSnapshot(status: .notLoggedIn))
        gptAccountErrorMessage = nil
    }

    // Keeps the account card honest when voice auth proves the bridge token is no longer usable.
    func markGPTVoiceReauthenticationRequired() {
        stopGPTLoginSync()
        clearGPTLoginState()
        clearGPTLoginCallbackState()
        applyGPTAccountSnapshot(
            loggedOutGPTAccountSnapshot(
                status: .expired,
                needsReauth: true,
                retaining: gptAccountSnapshot
            )
        )
        gptAccountErrorMessage = "ChatGPT voice needs a fresh sign-in on your paired computer."
    }

    // Stores an incoming deep-link callback and completes the pending login when the bridge is reachable.
    func handleGPTLoginCallbackURL(_ url: URL) async {
        guard isExpectedGPTLoginCallbackURL(url) else {
            return
        }

        guard let pendingLogin = currentPendingGPTLogin() else {
            return
        }

        let callbackState = CodexGPTLoginCallbackState(
            loginId: pendingLogin.loginId,
            callbackURL: url.absoluteString,
            createdAt: .now
        )
        gptPendingLoginCallbackState = callbackState
        await resumePendingGPTLoginIfPossible()
    }

    // Retries a stored callback after reconnects so a completed browser login is not lost.
    func resumePendingGPTLoginIfPossible() async {
        guard isConnected,
              let pendingLogin = currentPendingGPTLogin(),
              let callbackState = currentPendingGPTLoginCallback(),
              callbackState.loginId == pendingLogin.loginId else {
            return
        }

        do {
            _ = try await sendRequest(
                method: "account/login/complete",
                params: .object([
                    "loginId": .string(callbackState.loginId),
                    "callbackUrl": .string(callbackState.callbackURL),
                ])
            )
            clearGPTLoginCallbackState()
            gptAccountErrorMessage = nil
            startGPTLoginSyncIfNeeded()
        } catch {
            gptAccountErrorMessage = error.localizedDescription
        }
    }

    // Reacts to the provider login finishing on the Mac and refreshes the safe snapshot on iPhone.
    func handleGPTLoginCompletedNotification(_ paramsObject: IncomingParamsObject?) {
        let notificationLoginID = firstStringValue(in: paramsObject, keys: ["loginId", "login_id"])
        if let pendingLogin = currentPendingGPTLogin(),
           let notificationLoginID,
           notificationLoginID != pendingLogin.loginId {
            return
        }

        let wasSuccessful = firstBoolValue(in: paramsObject, keys: ["success"]) ?? false
        if wasSuccessful {
            clearGPTLoginCallbackState()
            gptAccountErrorMessage = nil
            startGPTLoginSyncIfNeeded()
            Task { await refreshGPTAccountState() }
            return
        }

        clearGPTLoginState()
        clearGPTLoginCallbackState()
        stopGPTLoginSync()
        gptAccountErrorMessage = firstStringValue(in: paramsObject, keys: ["error", "message"])
            ?? "ChatGPT sign-in did not complete."
        if !gptAccountSnapshot.isAuthenticated {
            applyGPTAccountSnapshot(
                loggedOutGPTAccountSnapshot(
                    status: .expired,
                    needsReauth: true,
                    retaining: gptAccountSnapshot
                )
            )
        }
    }

    // Keeps the cached snapshot in sync with logout and plan-change notifications from the bridge runtime.
    func handleGPTAccountUpdated(_ paramsObject: IncomingParamsObject?) {
        if let planType = firstStringValue(in: paramsObject, keys: ["planType", "plan_type"]) {
            gptAccountSnapshot.planType = planType
            gptAccountSnapshot.updatedAt = .now
        }

        Task { await refreshGPTAccountState() }
    }

    // Falls back to the last known safe snapshot so reconnects do not look like unexpected logouts.
    func applyGPTAccountConnectionFallback() {
        if let pendingLogin = currentPendingGPTLogin() {
            applyGPTAccountSnapshot(
                pendingLoginSnapshot(
                    expiresAt: pendingLogin.expiresAt,
                    retaining: gptAccountSnapshot
                )
            )
            return
        }

        if gptAccountSnapshot.status == .unknown {
            gptAccountSnapshot = disconnectedGPTAccountSnapshot()
        }
    }

    // Determines whether the mic button should nudge the user into login instead of recording.
    var gptVoiceRequiresLogin: Bool {
        !gptAccountSnapshot.isAuthenticated || gptAccountSnapshot.hasActiveLogin
    }

    // Separates signed-in state from bridge token readiness so the mic does not appear ready too early.
    var gptVoiceTemporarilyUnavailable: Bool {
        isConnected
            && gptAccountSnapshot.isAuthenticated
            && !gptAccountSnapshot.hasActiveLogin
            && !gptAccountSnapshot.isVoiceTokenReady
    }

    // Determines whether the bridge-backed voice flow can capture and transcribe audio right now.
    var canUseGPTVoiceTranscription: Bool {
        isConnected && gptAccountSnapshot.isAuthenticated && gptAccountSnapshot.isVoiceTokenReady && !gptAccountSnapshot.hasActiveLogin
    }

    // Re-polls account status while the user is finishing login in the browser.
    func startGPTLoginSyncIfNeeded() {
        guard gptAccountLoginSyncTask == nil, currentPendingGPTLogin() != nil else {
            return
        }

        gptAccountLoginSyncTask = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled {
                guard self.currentPendingGPTLogin() != nil else {
                    self.stopGPTLoginSync()
                    return
                }

                if self.isConnected {
                    await self.refreshGPTAccountState()
                }

                if self.gptAccountSnapshot.status == .expired
                    || (self.gptAccountSnapshot.isAuthenticated && self.gptAccountSnapshot.isVoiceTokenReady)
                    || self.currentPendingGPTLogin() == nil {
                    self.stopGPTLoginSync()
                    return
                }

                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    // Stops the lightweight login polling once the bridge reports a stable account state.
    func stopGPTLoginSync() {
        gptAccountLoginSyncTask?.cancel()
        gptAccountLoginSyncTask = nil
    }
}

