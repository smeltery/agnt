// FILE: ContentView+MacSwitching.swift
// Purpose: Coordinates trusted-Mac navigation, scanner handoff, and context switching.
// Layer: View Coordination
// Exports: ContentView Mac switching helpers
// Depends on: SwiftUI, CodexService, ContentViewModel

import SwiftUI

extension ContentView {
    func openMyMacsFromSidebar() {
        hasDismissedAutomaticScanner = true
        let route = MyMacsNavigationRoute()
        closeSidebar()
        navigationPath.append(route)
        topNavigationRouteIsTerminal = false
    }

    func presentMyMacsScanner() {
        hasDismissedAutomaticScanner = true
        isShowingMyMacsScanner = true
        presentManualScannerAfterStoppingReconnect()
    }

    func prepareForMacContextTransition() {
        hasDismissedAutomaticScanner = true
        suppressAutomaticThreadSelection = true
        selectedThread = nil
        codex.activeThreadId = nil
        if isSidebarOpen {
            closeSidebar()
        }
    }

    func captureMacContextTransitionSnapshot() -> MacContextTransitionSnapshot {
        MacContextTransitionSnapshot(
            selectedThread: selectedThread,
            activeThreadId: codex.activeThreadId,
            suppressAutomaticThreadSelection: suppressAutomaticThreadSelection
        )
    }

    // Restores the chat selection only when the service kept an existing Mac alive after a failed saved-device switch.
    func restoreMacContextTransitionSnapshotIfStillConnected(_ snapshot: MacContextTransitionSnapshot) {
        guard codex.isConnected || codex.isInitialized else {
            return
        }

        if let selectedThread = snapshot.selectedThread {
            self.selectedThread = codex.threads.first(where: { $0.id == selectedThread.id }) ?? selectedThread
        } else {
            self.selectedThread = nil
        }
        codex.activeThreadId = snapshot.activeThreadId
        suppressAutomaticThreadSelection = snapshot.suppressAutomaticThreadSelection
    }

    func switchToTrustedMac(_ deviceId: String) {
        guard !viewModel.isSwitchingMac else {
            return
        }
        let contextTransitionSnapshot = captureMacContextTransitionSnapshot()
        prepareForMacContextTransition()
        macSwitchTask = Task {
            do {
                try await viewModel.switchToTrustedMac(deviceId: deviceId, codex: codex)
                await MainActor.run {
                    navigationPath = NavigationPath()
                }
            } catch {
                await MainActor.run {
                    restoreMacContextTransitionSnapshotIfStillConnected(contextTransitionSnapshot)
                }
            }
            await MainActor.run {
                macSwitchTask = nil
            }
        }
    }

    func startScannedMacSwitch(_ pairingPayload: CodexPairingQRPayload) {
        guard !viewModel.isSwitchingMac else {
            return
        }

        macSwitchTask = Task {
            do {
                try await viewModel.switchToScannedMac(
                    pairingPayload: pairingPayload,
                    codex: codex
                )
                await MainActor.run {
                    navigationPath = NavigationPath()
                }
            } catch {
                // Error is already exposed through CodexService state.
            }
            await MainActor.run {
                macSwitchTask = nil
            }
        }
    }

    func cancelMacSwitch() {
        guard let macSwitchTask else {
            return
        }

        macSwitchTask.cancel()
        Task {
            await viewModel.requestMacSwitchCancellation(codex: codex)
        }
    }

    func forgetTrustedMac(_ deviceId: String) {
        let isCurrentTrustedMac = codex.normalizedCurrentTrustedMacDeviceId == deviceId
        if isCurrentTrustedMac {
            prepareForMacContextTransition()
            Task {
                await codex.disconnect()
                codex.forgetTrustedMac(deviceId: deviceId)
            }
            return
        }

        codex.forgetTrustedMac(deviceId: deviceId)
    }
}
