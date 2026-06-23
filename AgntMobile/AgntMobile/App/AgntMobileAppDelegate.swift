// FILE: AgntMobileAppDelegate.swift
// Purpose: Bridges APNs registration callbacks into the service layer without coupling SwiftUI views to UIApplicationDelegate.
// Layer: App
// Exports: AgntMobileAppDelegate, Notification.Name push-registration helpers
// Depends on: Foundation, UIKit

import Foundation
import UIKit

extension Notification.Name {
    static let codexDidRegisterForRemoteNotifications = Notification.Name("codex.didRegisterForRemoteNotifications")
    static let codexDidFailToRegisterForRemoteNotifications = Notification.Name("codex.didFailToRegisterForRemoteNotifications")
}

final class AgntMobileAppDelegate: NSObject, UIApplicationDelegate {
    // Captures a cold-launch Home Screen shortcut so the root view can route it
    // once SwiftUI is ready.
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if let shortcutItem = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            Task { @MainActor in
                AgntQuickActionCenter.handleShortcutItem(shortcutItem)
            }
        }
        return true
    }

    // Routes the SwiftUI WindowGroup scene through a delegate that receives
    // quick-action callbacks. The delegate creates no window, so SwiftUI keeps
    // managing the UI.
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: nil,
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = AgntMobileSceneDelegate.self
        return configuration
    }

    // Warm-launch fallback for hosts that deliver shortcuts to the app delegate.
    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in
            completionHandler(AgntQuickActionCenter.handleShortcutItem(shortcutItem))
        }
    }

    // Forwards the APNs token so CodexService can persist and sync it to the paired Mac bridge.
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationCenter.default.post(
            name: .codexDidRegisterForRemoteNotifications,
            object: nil,
            userInfo: [
                "deviceToken": deviceToken,
            ]
        )
    }

    // Keeps registration failures observable in debug builds without surfacing noisy UI errors.
    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationCenter.default.post(
            name: .codexDidFailToRegisterForRemoteNotifications,
            object: nil,
            userInfo: [
                "error": error,
            ]
        )
    }
}

// Minimal scene delegate: receives Home Screen quick-action callbacks. It
// deliberately does not create or assign a window — SwiftUI's WindowGroup
// continues to own the scene's UI.
final class AgntMobileSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let shortcutItem = connectionOptions.shortcutItem else {
            return
        }
        Task { @MainActor in
            AgntQuickActionCenter.handleShortcutItem(shortcutItem)
        }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in
            completionHandler(AgntQuickActionCenter.handleShortcutItem(shortcutItem))
        }
    }
}
