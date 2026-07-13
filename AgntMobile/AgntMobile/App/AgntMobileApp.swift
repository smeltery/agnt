// FILE: AgntMobileApp.swift
// Purpose: App entry point and root dependency wiring.
// Layer: App
// Exports: AgntMobileApp

import SwiftUI

@MainActor
@main
struct AgntMobileApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(AgntMobileAppDelegate.self) private var appDelegate
    @State private var codexService: CodexService
    @State private var petCompanionStore: PetCompanionStore
    @State private var petCompanionStatusStore: PetCompanionStatusStore

    init() {
        let service = CodexService()
        service.configureNotifications()
        _codexService = State(initialValue: service)
        _petCompanionStore = State(initialValue: PetCompanionStore())
        _petCompanionStatusStore = State(initialValue: PetCompanionStatusStore())
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(codexService)
                .environment(petCompanionStore)
                .environment(petCompanionStatusStore)
                .onOpenURL { url in
                    Task { @MainActor in
                        if handleAppURL(url, codexService: codexService) {
                            return
                        }
                        guard CodexService.legacyGPTLoginCallbackEnabled else {
                            return
                        }
                        await codexService.handleGPTLoginCallbackURL(url)
                    }
                }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIApplication.didReceiveMemoryWarningNotification
                    )
                ) { _ in
                    TurnCacheManager.resetAll()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .background:
                        TurnCacheManager.resetAll()
                    case .active:
                        // Returning to a chat retires its Lock Screen mirror.
                        LiveActivityCoordinator.shared.dismissIfViewing(
                            threadId: codexService.activeThreadId
                        )
                    default:
                        break
                    }
                }
        }
    }

    private func handleAppURL(_ url: URL, codexService: CodexService) -> Bool {
        guard url.scheme == "agnt" else {
            return false
        }

        switch url.host {
        case "home":
            return true
        case "thread":
            let threadId = url.path
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                .removingPercentEncoding?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !threadId.isEmpty else {
                return true
            }
            codexService.handleNotificationOpen(threadId: threadId, turnId: nil)
            return true
        default:
            return false
        }
    }
}
