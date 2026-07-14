// FILE: CodexService+AccountDecoding.swift
// Purpose: Decode bridge account payloads and build account snapshots.
// Layer: Service

import Foundation

extension CodexService {
    func openGPTLoginOnMac(authURL: URL) async throws {
        _ = try await sendRequest(
            method: "account/login/openOnMac",
            params: .object([
                "authUrl": .string(authURL.absoluteString),
            ])
        )
    }

    func isExpectedGPTLoginCallbackURL(_ url: URL) -> Bool {
        guard let callbackScheme = Bundle.main.object(
            forInfoDictionaryKey: "AGNT_CHATGPT_CALLBACK_SCHEME"
        ) as? String else {
            return false
        }

        guard url.scheme?.caseInsensitiveCompare(callbackScheme) == .orderedSame else {
            return false
        }

        return url.host == "auth" && url.path.lowercased().contains("/gpt/callback")
    }

    func decodeBridgeGPTAccountSnapshot(from payloadObject: IncomingParamsObject) -> CodexGPTAccountSnapshot {
        // Older bridges fall back to raw `getAuthStatus`, so derive a stable account state
        // even when the payload does not include the newer sanitized `status` field.
        let parsedStatus = decodeGPTAccountStatus(
            from: firstStringValue(in: payloadObject, keys: ["status", "state"])
        )
        let bridgeReportedPendingLogin = firstBoolValue(in: payloadObject, keys: ["loginInFlight", "login_in_flight"]) ?? false
        let needsReauth = firstBoolValue(in: payloadObject, keys: ["needsReauth", "needs_reauth"]) ?? false
        let legacyAuthMethod = decodeGPTAuthMethod(
            from: firstStringValue(in: payloadObject, keys: ["authMethod", "auth_mode"])
        )
        let hasLegacyAuthToken = firstStringValue(in: payloadObject, keys: ["authToken", "auth_token"]) != nil

        let resolvedStatus: CodexGPTAccountStatus
        if parsedStatus == .authenticated || parsedStatus == .expired {
            resolvedStatus = parsedStatus
        } else if parsedStatus == .unknown && hasLegacyAuthToken && legacyAuthMethod != nil && !needsReauth {
            resolvedStatus = .authenticated
        } else if parsedStatus == .notLoggedIn && bridgeReportedPendingLogin && !needsReauth {
            resolvedStatus = .loginPending
        } else if parsedStatus == .unknown && bridgeReportedPendingLogin {
            resolvedStatus = .loginPending
        } else if parsedStatus == .unknown {
            resolvedStatus = .notLoggedIn
        } else {
            resolvedStatus = parsedStatus
        }

        let hasPendingLogin = bridgeReportedPendingLogin
            || (currentPendingGPTLogin() != nil && resolvedStatus != .authenticated && resolvedStatus != .expired)

        let tokenReady = resolvedTokenReady(
            from: payloadObject,
            status: resolvedStatus,
            needsReauth: needsReauth,
            hasLegacyAuthToken: hasLegacyAuthToken
        )
        let tokenUnavailableSince = resolvedTokenUnavailableSince(
            status: resolvedStatus,
            needsReauth: needsReauth,
            tokenReady: tokenReady
        )
        let escalatedNeedsReauth = resolvedNeedsReauth(
            baseNeedsReauth: needsReauth,
            status: resolvedStatus,
            tokenReady: tokenReady,
            tokenUnavailableSince: tokenUnavailableSince
        )

        return CodexGPTAccountSnapshot(
            status: resolvedStatus,
            authMethod: legacyAuthMethod,
            email: firstStringValue(in: payloadObject, keys: ["email"]),
            displayName: nil,
            planType: firstStringValue(in: payloadObject, keys: ["planType", "plan_type"]),
            hostPlatform: decodeBridgeHostPlatform(
                from: firstStringValue(
                    in: payloadObject,
                    keys: ["hostPlatform", "host_platform", "bridgeHostPlatform", "bridge_host_platform"]
                )
            ),
            hostCapabilities: decodeBridgeHostCapabilities(from: payloadObject),
            loginInFlight: hasPendingLogin,
            needsReauth: escalatedNeedsReauth,
            expiresAt: firstDateValue(in: payloadObject, keys: ["expiresAt", "expires_at"]),
            tokenReady: tokenReady,
            tokenUnavailableSince: tokenUnavailableSince,
            updatedAt: .now
        )
    }

    func decodeGPTLoginStartResult(from response: RPCMessage) throws -> CodexGPTLoginStartResult {
        guard let payloadObject = response.result?.objectValue else {
            throw CodexServiceError.invalidResponse("account/login/start response missing payload")
        }

        guard firstStringValue(in: payloadObject, keys: ["type"]) == "chatgpt" else {
            throw CodexServiceError.invalidResponse("account/login/start did not return a ChatGPT login flow")
        }

        guard let loginId = firstStringValue(in: payloadObject, keys: ["loginId", "login_id"]),
              let authURLString = firstStringValue(in: payloadObject, keys: ["authUrl", "auth_url"]),
              let authURL = URL(string: authURLString) else {
            throw CodexServiceError.invalidResponse("account/login/start response missing auth URL")
        }

        return CodexGPTLoginStartResult(
            loginId: loginId,
            authURL: authURL,
            expiresAt: firstDateValue(in: payloadObject, keys: ["expiresAt", "expires_at"])
        )
    }

    func disconnectedGPTAccountSnapshot() -> CodexGPTAccountSnapshot {
        CodexGPTAccountSnapshot(
            status: .unavailable,
            authMethod: gptAccountSnapshot.authMethod,
            email: gptAccountSnapshot.email,
            displayName: gptAccountSnapshot.displayName,
            planType: gptAccountSnapshot.planType,
            hostPlatform: gptAccountSnapshot.hostPlatform,
            hostCapabilities: gptAccountSnapshot.hostCapabilities,
            loginInFlight: currentPendingGPTLogin() != nil,
            needsReauth: false,
            expiresAt: currentPendingGPTLogin()?.expiresAt,
            tokenReady: gptAccountSnapshot.tokenReady,
            tokenUnavailableSince: gptAccountSnapshot.tokenUnavailableSince,
            updatedAt: .now
        )
    }

    func pendingLoginSnapshot(
        expiresAt: Date?,
        retaining snapshot: CodexGPTAccountSnapshot
    ) -> CodexGPTAccountSnapshot {
        CodexGPTAccountSnapshot(
            status: .loginPending,
            authMethod: .chatgpt,
            email: snapshot.email,
            displayName: snapshot.displayName,
            planType: snapshot.planType,
            hostPlatform: snapshot.hostPlatform,
            hostCapabilities: snapshot.hostCapabilities,
            loginInFlight: true,
            needsReauth: false,
            expiresAt: expiresAt,
            tokenReady: false,
            tokenUnavailableSince: nil,
            updatedAt: .now
        )
    }

    func loggedOutGPTAccountSnapshot(
        status: CodexGPTAccountStatus,
        needsReauth: Bool = false,
        retaining snapshot: CodexGPTAccountSnapshot = codexGPTAccountInitialSnapshot()
    ) -> CodexGPTAccountSnapshot {
        CodexGPTAccountSnapshot(
            status: status,
            authMethod: nil,
            email: needsReauth ? snapshot.email : nil,
            displayName: needsReauth ? snapshot.displayName : nil,
            planType: needsReauth ? snapshot.planType : nil,
            hostPlatform: snapshot.hostPlatform,
            hostCapabilities: snapshot.hostCapabilities,
            loginInFlight: false,
            needsReauth: needsReauth,
            expiresAt: nil,
            tokenReady: false,
            tokenUnavailableSince: nil,
            updatedAt: .now
        )
    }

    func resolvedTokenReady(
        from payloadObject: IncomingParamsObject,
        status: CodexGPTAccountStatus,
        needsReauth: Bool,
        hasLegacyAuthToken: Bool = false
    ) -> Bool {
        if let tokenReady = firstBoolValue(in: payloadObject, keys: ["tokenReady", "token_ready"]) {
            return tokenReady
        }

        return hasLegacyAuthToken && status == .authenticated && !needsReauth
    }

    func resolvedTokenUnavailableSince(
        status: CodexGPTAccountStatus,
        needsReauth: Bool,
        tokenReady: Bool
    ) -> Date? {
        guard status == .authenticated, !needsReauth, !tokenReady else {
            return nil
        }

        if gptAccountSnapshot.status == .authenticated,
           gptAccountSnapshot.tokenReady == false,
           let existingDate = gptAccountSnapshot.tokenUnavailableSince {
            return existingDate
        }

        return .now
    }

    func resolvedNeedsReauth(
        baseNeedsReauth: Bool,
        status: CodexGPTAccountStatus,
        tokenReady: Bool,
        tokenUnavailableSince: Date?
    ) -> Bool {
        guard !baseNeedsReauth else {
            return true
        }

        if gptAccountSnapshot.needsReauth, !tokenReady {
            return true
        }

        guard status == .authenticated, !tokenReady, let tokenUnavailableSince else {
            return false
        }

        return Date().timeIntervalSince(tokenUnavailableSince) >= CodexGPTAccountSnapshot.voiceTokenGraceInterval
    }

    func decodeGPTAccountStatus(from value: String?) -> CodexGPTAccountStatus {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            return .unknown
        }

        switch value {
        case "authenticated", "logged_in", "loggedin", "connected":
            return .authenticated
        case "loginpending", "login_pending", "pending", "pending_login":
            return .loginPending
        case "expired", "needs_reauth", "needsreauth", "reauth_required":
            return .expired
        case "not_logged_in", "notloggedin", "signed_out", "logged_out", "unauthenticated":
            return .notLoggedIn
        case "unavailable", "offline":
            return .unavailable
        default:
            return .unknown
        }
    }

    func decodeGPTAuthMethod(from value: String?) -> CodexGPTAuthMethod? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else {
            return nil
        }

        switch value {
        case "chatgpt", "chat_gpt", "chatgptauthtokens":
            return .chatgpt
        default:
            return nil
        }
    }

    func decodeBridgeHostPlatform(from value: String?) -> CodexBridgeHostPlatform? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else {
            return nil
        }

        return CodexBridgeHostPlatform(rawValue: value) ?? .unknown
    }

    func decodeBridgeHostCapabilities(from payloadObject: IncomingParamsObject) -> CodexBridgeHostCapabilities? {
        let capabilitiesObject = payloadObject["hostCapabilities"]?.objectValue
            ?? payloadObject["host_capabilities"]?.objectValue
            ?? payloadObject["bridgeHostCapabilities"]?.objectValue
            ?? payloadObject["bridge_host_capabilities"]?.objectValue

        guard let capabilitiesObject else {
            return nil
        }

        return CodexBridgeHostCapabilities(
            desktopHandoff: firstBoolValue(in: capabilitiesObject, keys: ["desktopHandoff", "desktop_handoff"]) ?? false,
            displayWake: firstBoolValue(in: capabilitiesObject, keys: ["displayWake", "display_wake"]) ?? false,
            keepAwake: firstBoolValue(in: capabilitiesObject, keys: ["keepAwake", "keep_awake"]) ?? false,
            hostBrowserLogin: firstBoolValue(in: capabilitiesObject, keys: ["hostBrowserLogin", "host_browser_login"]) ?? false,
            bridgeSelfUpdate: firstBoolValue(in: capabilitiesObject, keys: ["bridgeSelfUpdate", "bridge_self_update"]) ?? false,
            terminal: firstBoolValue(in: capabilitiesObject, keys: ["terminal", "sshTerminal", "ssh_terminal"]) ?? false
        )
    }

    func firstStringValue(in object: IncomingParamsObject?, keys: [String]) -> String? {
        guard let object else {
            return nil
        }

        for key in keys {
            if let value = object[key]?.stringValue {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
        }
        return nil
    }

    func firstBoolValue(in object: IncomingParamsObject?, keys: [String]) -> Bool? {
        guard let object else {
            return nil
        }

        for key in keys {
            if let value = object[key]?.boolValue {
                return value
            }

            if let value = object[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                switch value {
                case "true", "1", "yes", "y":
                    return true
                case "false", "0", "no", "n":
                    return false
                default:
                    continue
                }
            }

            if let value = object[key]?.intValue {
                return value != 0
            }
        }

        return nil
    }

    func firstDateValue(in object: IncomingParamsObject?, keys: [String]) -> Date? {
        guard let object else {
            return nil
        }

        for key in keys {
            if let value = object[key], let decodedDate = decodeDateValue(value) {
                return decodedDate
            }
        }
        return nil
    }

    func decodeDateValue(_ value: JSONValue) -> Date? {
        switch value {
        case .integer(let integer):
            let interval = integer > 10_000_000_000 ? TimeInterval(integer) / 1_000 : TimeInterval(integer)
            return Date(timeIntervalSince1970: interval)
        case .double(let double):
            let interval = double > 10_000_000_000 ? double / 1_000 : double
            return Date(timeIntervalSince1970: interval)
        case .string(let string):
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if let interval = TimeInterval(trimmed) {
                let adjusted = interval > 10_000_000_000 ? interval / 1_000 : interval
                return Date(timeIntervalSince1970: adjusted)
            }

            let formatter = ISO8601DateFormatter()
            return formatter.date(from: trimmed)
        default:
            return nil
        }
    }
}
