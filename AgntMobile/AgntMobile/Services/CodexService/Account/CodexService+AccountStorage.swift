// FILE: CodexService+AccountStorage.swift
// Purpose: Persisted ChatGPT account and pending-login state helpers.
// Layer: Service

import Foundation

extension CodexService {
    static let gptAccountSnapshotDefaultsKey = "codex.gpt.accountSnapshot"
    static let gptPendingLoginStateDefaultsKey = "codex.gpt.pendingLoginState"
    static let gptPendingLoginCallbackDefaultsKey = "codex.gpt.pendingLoginCallbackState"

    var gptPendingLoginState: CodexGPTLoginState? {
        get { gptPendingLoginState(macDeviceId: normalizedCurrentTrustedMacDeviceId) }
        set { setGPTPendingLoginState(newValue, macDeviceId: normalizedCurrentTrustedMacDeviceId) }
    }

    func gptPendingLoginState(macDeviceId: String?) -> CodexGPTLoginState? {
        guard let data = defaults.data(forKey: macScopedDefaultsKey(Self.gptPendingLoginStateDefaultsKey, macDeviceId: macDeviceId)),
              let state = try? decoder.decode(CodexGPTLoginState.self, from: data) else {
            return nil
        }

        return state.isExpired ? nil : state
    }

    func setGPTPendingLoginState(_ newValue: CodexGPTLoginState?, macDeviceId: String?) {
        if let newValue {
            guard let data = try? encoder.encode(newValue) else {
                return
            }
            defaults.set(data, forKey: macScopedDefaultsKey(Self.gptPendingLoginStateDefaultsKey, macDeviceId: macDeviceId))
        } else {
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.gptPendingLoginStateDefaultsKey, macDeviceId: macDeviceId))
        }
    }

    var gptPendingLoginCallbackState: CodexGPTLoginCallbackState? {
        get { gptPendingLoginCallbackState(macDeviceId: normalizedCurrentTrustedMacDeviceId) }
        set { setGPTPendingLoginCallbackState(newValue, macDeviceId: normalizedCurrentTrustedMacDeviceId) }
    }

    func gptPendingLoginCallbackState(macDeviceId: String?) -> CodexGPTLoginCallbackState? {
        guard let data = defaults.data(forKey: macScopedDefaultsKey(Self.gptPendingLoginCallbackDefaultsKey, macDeviceId: macDeviceId)),
              let state = try? decoder.decode(CodexGPTLoginCallbackState.self, from: data) else {
            return nil
        }

        return state.isExpired ? nil : state
    }

    func setGPTPendingLoginCallbackState(_ newValue: CodexGPTLoginCallbackState?, macDeviceId: String?) {
        if let newValue {
            guard let data = try? encoder.encode(newValue) else {
                return
            }
            defaults.set(data, forKey: macScopedDefaultsKey(Self.gptPendingLoginCallbackDefaultsKey, macDeviceId: macDeviceId))
        } else {
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.gptPendingLoginCallbackDefaultsKey, macDeviceId: macDeviceId))
        }
    }

    func currentPendingGPTLogin() -> CodexGPTLoginState? {
        guard let pendingLogin = gptPendingLoginState else {
            return nil
        }

        if pendingLogin.isExpired {
            clearGPTLoginState()
            return nil
        }

        return pendingLogin
    }

    func currentPendingGPTLoginCallback() -> CodexGPTLoginCallbackState? {
        guard let callbackState = gptPendingLoginCallbackState else {
            return nil
        }

        if callbackState.isExpired {
            clearGPTLoginCallbackState()
            return nil
        }

        return callbackState
    }

    func loadPersistedGPTAccountSnapshot(macDeviceId: String? = nil) -> CodexGPTAccountSnapshot? {
        guard let data = defaults.data(forKey: macScopedDefaultsKey(Self.gptAccountSnapshotDefaultsKey, macDeviceId: macDeviceId)),
              let snapshot = try? decoder.decode(CodexGPTAccountSnapshot.self, from: data) else {
            return nil
        }
        return snapshot
    }

    func persistGPTAccountSnapshot(_ snapshot: CodexGPTAccountSnapshot, macDeviceId: String? = nil) {
        guard !suspendAutomaticMacScopedPersistence, !isApplyingMacScopedState else {
            return
        }

        guard let data = try? encoder.encode(snapshot) else {
            return
        }
        defaults.set(data, forKey: macScopedDefaultsKey(Self.gptAccountSnapshotDefaultsKey, macDeviceId: macDeviceId))
    }

    func clearGPTLoginState() {
        gptPendingLoginState = nil
        stopGPTLoginSync()
    }

    func clearGPTLoginCallbackState() {
        gptPendingLoginCallbackState = nil
    }

    // Keeps stale browser URLs from surviving once the runtime reports a stable account state.
    func syncPendingGPTLoginStateIfNeeded() {
        guard let pendingLogin = gptPendingLoginState else {
            clearGPTLoginCallbackState()
            return
        }

        if pendingLogin.isExpired
            || (gptAccountSnapshot.isAuthenticated && gptAccountSnapshot.isVoiceTokenReady)
            || gptAccountSnapshot.status == .expired {
            clearGPTLoginState()
            clearGPTLoginCallbackState()
            return
        }

        if let callbackState = currentPendingGPTLoginCallback(),
           callbackState.loginId != pendingLogin.loginId {
            clearGPTLoginCallbackState()
        }
    }

    // Centralizes snapshot writes so persistence and pending-login cleanup stay aligned.
    func applyGPTAccountSnapshot(_ snapshot: CodexGPTAccountSnapshot) {
        var resolvedSnapshot = snapshot
        if resolvedSnapshot.status == .authenticated || resolvedSnapshot.status == .expired {
            resolvedSnapshot.loginInFlight = false
        }
        if (resolvedSnapshot.isAuthenticated && resolvedSnapshot.isVoiceTokenReady)
            || resolvedSnapshot.status == .expired {
            clearGPTLoginState()
            clearGPTLoginCallbackState()
        }
        resolvedSnapshot.updatedAt = .now
        gptAccountSnapshot = resolvedSnapshot
        syncPendingGPTLoginStateIfNeeded()
    }

}
