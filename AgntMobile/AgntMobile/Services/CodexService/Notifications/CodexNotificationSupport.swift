// FILE: CodexNotificationSupport.swift
// Purpose: Provides notification registration, delegate, payload, and authorization support types.
// Layer: Service
// Exports: Codex notification support types
// Depends on: UIKit, UserNotifications, CodexService notification routing

import UIKit
import UserNotifications

enum CodexNotificationSource {
    static let runCompletion = "codex.runCompletion"
    static let structuredUserInput = "codex.structuredUserInput"
}

protocol CodexRemoteNotificationRegistering: AnyObject {
    func registerForRemoteNotifications()
}

final class CodexApplicationRemoteNotificationRegistrar: CodexRemoteNotificationRegistering {
    nonisolated init() {}

    // Requests the APNs device token once alert permission is no longer denied.
    func registerForRemoteNotifications() {
#if targetEnvironment(simulator)
        return
#else
        UIApplication.shared.registerForRemoteNotifications()
#endif
    }
}

enum CodexPushAPNsEnvironment: String {
    case development
    case production
}

protocol CodexUserNotificationCentering: AnyObject {
    var delegate: UNUserNotificationCenterDelegate? { get set }
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
    func authorizationStatus() async -> UNAuthorizationStatus
}

extension UNUserNotificationCenter: CodexUserNotificationCentering {
    func authorizationStatus() async -> UNAuthorizationStatus {
        let settings = await notificationSettings()
        return settings.authorizationStatus
    }
}

final class CodexNotificationCenterDelegateProxy: NSObject, UNUserNotificationCenterDelegate {
    weak var service: CodexService?

    init(service: CodexService) {
        self.service = service
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // The in-app timeline and run badges already explain the new state.
        []
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let service,
              let payload = CodexThreadNotificationPayload(from: response.notification.request.content.userInfo) else {
            return
        }

        await MainActor.run {
            service.handleNotificationOpen(threadId: payload.threadId, turnId: payload.turnId)
        }
    }
}

struct CodexThreadNotificationPayload {
    let threadId: String
    let turnId: String?

    init?(from userInfo: [AnyHashable: Any]) {
        guard let source = userInfo[CodexNotificationPayloadKeys.source] as? String,
              (source == CodexNotificationSource.runCompletion
                || source == CodexNotificationSource.structuredUserInput),
              let threadId = userInfo[CodexNotificationPayloadKeys.threadId] as? String,
              !threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        self.threadId = threadId
        self.turnId = userInfo[CodexNotificationPayloadKeys.turnId] as? String
    }
}

extension UNAuthorizationStatus {
    var pushRegistrationValue: String {
        switch self {
        case .notDetermined:
            return "notDetermined"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .provisional:
            return "provisional"
        case .ephemeral:
            return "ephemeral"
        @unknown default:
            return "unknown"
        }
    }
}
