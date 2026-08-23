// FILE: CodexService+Account.swift
// Purpose: Owns ChatGPT account state, browser-login lifecycle, and sanitized bridge refreshes.
// Layer: Service
// Exports: CodexGPTAccountSnapshot, CodexGPTLoginState, CodexService GPT account helpers
// Depends on: Foundation, RPCMessage, JSONValue

import Foundation

let minimumBridgePackageUpdateCommand = "npm install -g @smeltery/agnt@latest"
let forcedBridgeUpgradeFromVersion = "1.3.8"
let forcedBridgeUpgradeTargetVersion = "1.3.9"
let forcedBridgeUpgradeCommand = "npm install -g @smeltery/agnt@1.3.9"

enum CodexGPTAccountStatus: String, Codable, Sendable {
    case unknown
    case unavailable
    case notLoggedIn
    case loginPending
    case authenticated
    case expired
}

enum CodexGPTAuthMethod: String, Codable, Sendable {
    case chatgpt
}

struct CodexGPTAccountSnapshot: Codable, Equatable, Sendable {
    var status: CodexGPTAccountStatus
    var authMethod: CodexGPTAuthMethod?
    var email: String?
    var displayName: String?
    var planType: String?
    var hostPlatform: CodexBridgeHostPlatform?
    var hostCapabilities: CodexBridgeHostCapabilities?
    var loginInFlight: Bool
    var needsReauth: Bool
    var expiresAt: Date?
    var tokenReady: Bool? = nil
    var tokenUnavailableSince: Date? = nil
    var updatedAt: Date

    var hasActiveLogin: Bool {
        loginInFlight || status == .loginPending
    }

    var isAuthenticated: Bool {
        status == .authenticated && !needsReauth
    }

    var canLogout: Bool {
        isAuthenticated || needsReauth
    }

    var isVoiceTokenReady: Bool {
        tokenReady ?? isAuthenticated
    }

    var statusLabel: String {
        switch status {
        case .unknown:
            return "Unknown"
        case .unavailable:
            return "Unavailable"
        case .notLoggedIn:
            return "Not logged in"
        case .loginPending:
            return "Login pending"
        case .authenticated:
            return needsReauth ? "Needs reauth" : "Authenticated"
        case .expired:
            return "Expired"
        }
    }

    var detailText: String? {
        var parts: [String] = []
        if let email, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(email)
        }
        if let planType, !planType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(planType.capitalized)
        }
        if let expiresAt {
            parts.append(Self.expiryFormatter.string(from: expiresAt))
        }
        if isAuthenticated && !isVoiceTokenReady {
            parts.append("Voice syncing")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " • ")
    }

    static let voiceTokenGraceInterval: TimeInterval = 45

    private static let expiryFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}

enum CodexBridgeHostPlatform: String, Codable, Sendable {
    case macOS = "macos"
    case linux
    case windows
    case unknown

    var displayName: String {
        switch self {
        case .macOS:
            return "Mac"
        case .linux:
            return "Linux computer"
        case .windows:
            return "Windows computer"
        case .unknown:
            return "computer"
        }
    }
}

struct CodexBridgeHostCapabilities: Codable, Equatable, Sendable {
    private enum CodingKeys: String, CodingKey {
        case desktopHandoff
        case displayWake
        case keepAwake
        case hostBrowserLogin
        case bridgeSelfUpdate
        case terminal
    }

    var desktopHandoff: Bool = false
    var displayWake: Bool = false
    var keepAwake: Bool = false
    var hostBrowserLogin: Bool = false
    var bridgeSelfUpdate: Bool = false
    var terminal: Bool = false

    init(
        desktopHandoff: Bool = false,
        displayWake: Bool = false,
        keepAwake: Bool = false,
        hostBrowserLogin: Bool = false,
        bridgeSelfUpdate: Bool = false,
        terminal: Bool = false
    ) {
        self.desktopHandoff = desktopHandoff
        self.displayWake = displayWake
        self.keepAwake = keepAwake
        self.hostBrowserLogin = hostBrowserLogin
        self.bridgeSelfUpdate = bridgeSelfUpdate
        self.terminal = terminal
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        desktopHandoff = try container.decodeIfPresent(Bool.self, forKey: .desktopHandoff) ?? false
        displayWake = try container.decodeIfPresent(Bool.self, forKey: .displayWake) ?? false
        keepAwake = try container.decodeIfPresent(Bool.self, forKey: .keepAwake) ?? false
        hostBrowserLogin = try container.decodeIfPresent(Bool.self, forKey: .hostBrowserLogin) ?? false
        bridgeSelfUpdate = try container.decodeIfPresent(Bool.self, forKey: .bridgeSelfUpdate) ?? false
        terminal = try container.decodeIfPresent(Bool.self, forKey: .terminal) ?? false
    }

    static let legacyMacOS = CodexBridgeHostCapabilities(
        desktopHandoff: true,
        displayWake: true,
        keepAwake: true,
        hostBrowserLogin: true,
        bridgeSelfUpdate: false,
        terminal: false
    )
}

nonisolated func codexGPTAccountInitialSnapshot() -> CodexGPTAccountSnapshot {
    CodexGPTAccountSnapshot(
        status: .unknown,
        authMethod: nil,
        email: nil,
        displayName: nil,
        planType: nil,
        hostPlatform: nil,
        hostCapabilities: nil,
        loginInFlight: false,
        needsReauth: false,
        expiresAt: nil,
        tokenReady: nil,
        tokenUnavailableSince: nil,
        updatedAt: .distantPast
    )
}

struct CodexGPTLoginState: Codable, Equatable, Sendable {
    let loginId: String
    let authURL: String
    let createdAt: Date
    let expiresAt: Date?
}

struct CodexGPTLoginCallbackState: Codable, Equatable, Sendable {
    let loginId: String
    let callbackURL: String
    let createdAt: Date
}

struct CodexGPTLoginStartResult: Equatable, Sendable {
    let loginId: String
    let authURL: URL
    let expiresAt: Date?
}
