// FILE: ContentView+RootSheets.swift
// Purpose: Owns root sheet routing for bridge updates and What's New presentation.
// Layer: View Extension
// Exports: ContentView root sheet helpers
// Depends on: SwiftUI, CodexService, ContentViewModel

import SwiftUI

extension ContentView {
    // Keeps SwiftUI's sheet binding in sync with the route we last chose to present.
    var presentedRootSheetBinding: Binding<RootSheetRoute?> {
        Binding(
            get: { presentedRootSheet },
            set: { nextValue in
                guard nextValue?.id != presentedRootSheet?.id else {
                    presentedRootSheet = nextValue
                    return
                }

                if nextValue == nil {
                    dismissPresentedRootSheet()
                } else {
                    presentedRootSheet = nextValue
                }
            }
        )
    }

    // Serializes root-owned sheets under one priority list instead of letting each feature present itself.
    func syncRootSheetPresentationIfNeeded() {
        if case .bridgeUpdate = presentedRootSheet,
           codex.bridgeUpdatePrompt == nil {
            dismissPresentedRootSheet()
            return
        }

        guard let desiredRoute = desiredRootSheetRoute else {
            return
        }

        // Let bridge recovery take over immediately without marking What's New as already seen.
        if case .whatsNew = presentedRootSheet,
           case .bridgeUpdate = desiredRoute {
            presentedRootSheet = desiredRoute
            return
        }

        // Refresh an already-visible bridge sheet when the prompt changes underneath it.
        if case .bridgeUpdate = presentedRootSheet,
           case .bridgeUpdate = desiredRoute,
           presentedRootSheet?.id != desiredRoute.id {
            presentedRootSheet = desiredRoute
            return
        }

        guard presentedRootSheet == nil else {
            return
        }

        presentedRootSheet = desiredRoute
    }

    var desiredRootSheetRoute: RootSheetRoute? {
        guard canPresentDeferredRootSheet else {
            return nil
        }

        if let prompt = codex.bridgeUpdatePrompt {
            return .bridgeUpdate(prompt)
        }

        if let whatsNewVersion = pendingWhatsNewVersion {
            return .whatsNew(version: whatsNewVersion)
        }

        return nil
    }

    // Blocks lower-priority sheets while onboarding, pairing, or root alerts own the screen.
    var canPresentDeferredRootSheet: Bool {
        scenePhase == .active
            && hasSeenOnboarding
            && !isShowingManualScanner
            && !shouldShowQRScanner
            && !isShowingManualPairingEntry
            && manualPairingErrorMessage == nil
            && codex.missingNotificationThreadPrompt == nil
    }

    // Shows What's New only once per version and only after the root has been calm for a while.
    var pendingWhatsNewVersion: String? {
        guard isWhatsNewPresentationReady,
              lastPresentedWhatsNewVersion != whatsNewReleaseVersion else {
            return nil
        }

        return whatsNewReleaseVersion
    }

    var whatsNewPresentationScheduleFingerprint: String {
        [
            String(scenePhase == .active),
            String(hasSeenOnboarding),
            String(isShowingManualScanner),
            String(shouldShowQRScanner),
            String(isShowingManualPairingEntry),
            String(manualPairingErrorMessage != nil),
            String(codex.missingNotificationThreadPrompt != nil),
            String(codex.bridgeUpdatePrompt != nil),
            whatsNewReleaseVersion,
            lastPresentedWhatsNewVersion,
        ].joined(separator: "|")
    }

    var rootSheetPresentationFingerprint: String {
        [
            String(canPresentDeferredRootSheet),
            codex.bridgeUpdatePrompt?.id.uuidString ?? "nil",
            pendingWhatsNewVersion ?? "nil",
            presentedRootSheet?.id ?? "nil",
        ].joined(separator: "|")
    }

    func scheduleWhatsNewPresentationIfNeeded() async {
        whatsNewPresentationTask?.cancel()
        whatsNewPresentationTask = nil
        isWhatsNewPresentationReady = false

        guard shouldScheduleWhatsNewPresentation else {
            return
        }

        let task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: whatsNewPresentationDelayNanoseconds)
            guard !Task.isCancelled,
                  shouldScheduleWhatsNewPresentation else {
                return
            }

            isWhatsNewPresentationReady = true
            syncRootSheetPresentationIfNeeded()
        }

        whatsNewPresentationTask = task
    }

    var shouldScheduleWhatsNewPresentation: Bool {
        canPresentDeferredRootSheet
            && codex.bridgeUpdatePrompt == nil
            && pendingWhatsNewVersion == nil
    }

    func handleDismissedRootSheet(_ route: RootSheetRoute) {
        switch route {
        case .bridgeUpdate:
            dismissBridgeUpdatePrompt()
        case .whatsNew(let version):
            dismissWhatsNewSheet(version: version)
        }

        syncRootSheetPresentationIfNeeded()
    }

    func dismissPresentedRootSheet() {
        guard let dismissedRoute = presentedRootSheet else {
            return
        }

        presentedRootSheet = nil
        handleDismissedRootSheet(dismissedRoute)
    }

    func dismissBridgeUpdatePrompt() {
        codex.bridgeUpdatePrompt = nil
        isRetryingBridgeUpdate = false
        isUpdatingBridgePackage = false
    }

    func dismissWhatsNewSheet(version: String) {
        lastPresentedWhatsNewVersion = version
        isWhatsNewPresentationReady = false
    }

    func bridgeUpdateSheet(prompt: CodexBridgeUpdatePrompt) -> some View {
        BridgeUpdateSheet(
            prompt: prompt,
            isRetrying: isRetryingBridgeUpdate,
            isUpdatingBridge: isUpdatingBridgePackage,
            onUpdateBridge: codex.isConnected && codex.supportsBridgeSelfUpdate ? {
                updateBridgePackageAndRestart()
            } : nil,
            onRetry: {
                retryBridgeConnectionAfterUpdate()
            },
            onScanNewQR: {
                presentManualScannerForBridgeRecovery()
            },
            onDismiss: {
                dismissPresentedRootSheet()
            }
        )
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    func whatsNewSheet(version: String) -> some View {
        WhatsNewSheet(
            version: version,
            onDismiss: {
                dismissPresentedRootSheet()
            }
        )
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    func updateBridgePackageAndRestart() {
        guard !isUpdatingBridgePackage else {
            return
        }

        isUpdatingBridgePackage = true

        Task {
            do {
                let handoffService = DesktopHandoffService(codex: codex)
                try await handoffService.updateBridgePackageAndRestart()
                await MainActor.run {
                    isUpdatingBridgePackage = false
                    isRetryingBridgeUpdate = true
                }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await viewModel.toggleConnection(codex: codex)
                await MainActor.run {
                    isRetryingBridgeUpdate = false
                }
            } catch {
                await MainActor.run {
                    isUpdatingBridgePackage = false
                    codex.lastErrorMessage = error.localizedDescription
                }
            }
        }
    }

    // Re-tries the saved relay session after the user updates the Mac package.
    func retryBridgeConnectionAfterUpdate() {
        guard !isRetryingBridgeUpdate, !isUpdatingBridgePackage else {
            return
        }

        isRetryingBridgeUpdate = true

        Task {
            await viewModel.toggleConnection(codex: codex)
            await MainActor.run {
                isRetryingBridgeUpdate = false
            }
        }
    }
}
