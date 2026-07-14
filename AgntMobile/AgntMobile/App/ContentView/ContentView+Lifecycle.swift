// FILE: ContentView+Lifecycle.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    var rootContentWithLifecycleObservers: some View {
        rootContent
            // Only resume saved-pairing recovery after onboarding is done and the manual scanner is not in control.
            .task {
                guard hasSeenOnboarding, !isShowingManualScanner else {
                    debugSidebarLog("launch task skipped onboardingSeen=\(hasSeenOnboarding) manualScanner=\(isShowingManualScanner)")
                    return
                }
                debugSidebarLog("launch task autoConnect begin connected=\(codex.isConnected) threadCount=\(codex.threads.count)")
                await viewModel.attemptAutoConnectOnLaunchIfNeeded(codex: codex)
                scheduleSidebarPrewarmIfNeeded()
            }
            .task(id: whatsNewPresentationScheduleFingerprint) {
                await scheduleWhatsNewPresentationIfNeeded()
            }
            .task(id: rootSheetPresentationFingerprint) {
                syncRootSheetPresentationIfNeeded()
            }
            .onChange(of: showSettings) { _, show in
                if show {
                    navigationPath.append("settings")
                    topNavigationRouteIsTerminal = false
                    showSettings = false
                }
            }
            .onChange(of: isSidebarOpen) { wasOpen, isOpen in
                debugSidebarLog(
                    "open-state changed wasOpen=\(wasOpen) isOpen=\(isOpen) prewarmed=\(isSidebarPrewarmed) "
                        + "dragOffset=\(Int(sidebarDragOffset)) threadCount=\(codex.threads.count)"
                )
                guard !wasOpen, isOpen else {
                    return
                }
                if !isSidebarPrewarmed,
                   viewModel.shouldRequestSidebarFreshSync(isConnected: codex.isConnected) {
                    debugSidebarLog("sidebar open triggers immediate sync activeThread=\(codex.activeThreadId ?? "nil")")
                    codex.requestImmediateSync(threadId: codex.activeThreadId)
                } else {
                    debugSidebarLog("sidebar open skips immediate sync prewarmed=\(isSidebarPrewarmed) connected=\(codex.isConnected)")
                }
            }
            .onChange(of: navigationPath) { previousPath, newPath in
                debugSidebarLog("navigation path changed count=\(newPath.count) sidebarOpen=\(isSidebarOpen)")
                if isSidebarOpen {
                    closeSidebar()
                }
                // Reset the terminal-route tracker whenever the stack shrinks (system
                // back) or empties, so subsequent `openTerminal` calls don't pop a
                // non-terminal route by mistake.
                if newPath.count < previousPath.count {
                    topNavigationRouteIsTerminal = false
                }
            }
            .onChange(of: selectedThread) { previousThread, thread in
                debugSidebarLog("selectedThread changed from=\(previousThread?.id ?? "nil") to=\(thread?.id ?? "nil")")
                codex.handleDisplayedThreadChange(
                    from: previousThread?.id,
                    to: thread?.id
                )
                codex.activeThreadId = thread?.id
                if thread != nil {
                    suppressAutomaticThreadSelection = false
                }
            }
            .onChange(of: codex.activeThreadId) { _, activeThreadId in
                debugSidebarLog("activeThreadId changed to=\(activeThreadId ?? "nil")")
                guard let activeThreadId,
                      let matchingThread = codex.threads.first(where: { $0.id == activeThreadId }),
                      selectedThread?.id != matchingThread.id else {
                    return
                }
                selectedThread = matchingThread
            }
            .onChange(of: codex.threads) { _, threads in
                debugSidebarLog("threads changed count=\(threads.count) sidebarOpen=\(isSidebarOpen) prewarmed=\(isSidebarPrewarmed)")
                syncSelectedThread(with: threads)
                scheduleSidebarPrewarmIfNeeded()
                AgntQuickActionCenter.updateShortcutItems(for: threads)
                routePendingQuickActionIfNeeded()
            }
            .onReceive(NotificationCenter.default.publisher(for: AgntQuickActionCenter.didReceiveQuickAction)) { notification in
                _ = AgntQuickActionCenter.consumePendingAction()
                guard let action = notification.userInfo?["action"] as? AgntQuickAction else {
                    return
                }
                pendingQuickAction = action
                routePendingQuickActionIfNeeded()
            }
            .onChange(of: scenePhase) { _, phase in
                debugSidebarLog("scenePhase changed phase=\(String(describing: phase))")
                codex.setForegroundState(phase != .background)
                if phase == .active {
                    Task {
                        guard hasSeenOnboarding, !isShowingManualScanner else {
                            return
                        }

                        await codex.probeForegroundConnectionIfNeeded()
                        await attemptSavedMacReconnectRecoveryIfNeeded()
                        scheduleSidebarPrewarmIfNeeded()
                    }
                    AgntQuickActionCenter.updateShortcutItems(for: codex.threads)
                    routePendingQuickActionIfNeeded()
                } else if phase == .background {
                    resetSavedMacWakeRecoveryState()
                    teardownSidebarPrewarm()
                }
            }
            .onChange(of: codex.shouldAutoReconnectOnForeground) { _, shouldReconnect in
                guard shouldReconnect else {
                    return
                }
                Task {
                    await attemptSavedMacReconnectRecoveryIfNeeded()
                }
            }
            .onChange(of: codex.isConnected) { wasConnected, isNowConnected in
                debugSidebarLog("connection changed wasConnected=\(wasConnected) isConnected=\(isNowConnected)")
                if !wasConnected, isNowConnected {
                    resetSavedMacWakeRecoveryState()
                    Task {
                        await codex.requestNotificationPermissionOnFirstLaunchIfNeeded()
                    }
                    scheduleSidebarPrewarmIfNeeded()
                }
            }
            .onChange(of: codex.normalizedRelaySessionId) { _, _ in
                resetSavedMacWakeRecoveryState()
            }
            .onChange(of: codex.threadCompletionBanner) { _, banner in
                scheduleThreadCompletionBannerDismiss(for: banner)
            }
    }
}
