// FILE: ContentView+Recovery.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    var manualPairingErrorAlertIsPresented: Binding<Bool> {
        Binding(
            get: { manualPairingErrorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    manualPairingErrorMessage = nil
                }
            }
        )
    }

    var manualPairingErrorAlertMessage: String {
        manualPairingErrorMessage ?? "Could not resolve that pairing code."
    }

    // Offers a one-tap display wake for the best local-style relay we still know about, even if only the trusted record remains.
    var canWakeSavedMacDisplay: Bool {
        homeConnectionPhase == .offline && codex.canWakePreferredMacDisplay
    }

    // Keep the wake CTA visible whenever the pairing still knows enough to try a display pulse.
    var shouldOfferWakeSavedMacDisplayAction: Bool {
        canWakeSavedMacDisplay
            && codex.supportsDisplayWake
            && hasAttemptedAutomaticWakeSavedMacDisplay
            && !isWakingSavedMacDisplay
    }

    // Keeps the silent wake fallback automatic exactly once per offline cycle before the user taps manually again.
    var shouldAttemptAutomaticWakeSavedMacDisplay: Bool {
        scenePhase == .active
            && hasSeenOnboarding
            && !isShowingManualScanner
            && !isShowingManualPairingEntry
            && codex.shouldAutoReconnectOnForeground
            && canWakeSavedMacDisplay
            && codex.supportsDisplayWake
            && !hasAttemptedAutomaticWakeSavedMacDisplay
            && !isWakingSavedMacDisplay
    }

    var wakeMacDisplayRecoveryAction: (() -> Void)? {
        guard shouldOfferWakeSavedMacDisplayAction else {
            return nil
        }

        return {
            wakeSavedMacDisplay()
        }
    }

    // Gives the saved local Mac one silent wake attempt before exposing the manual wake affordance.
    func attemptAutomaticWakeSavedMacDisplayIfNeeded() async {
        guard shouldAttemptAutomaticWakeSavedMacDisplay else {
            return
        }

        hasAttemptedAutomaticWakeSavedMacDisplay = true
        await performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: false)
    }

    // Keeps foreground reconnect and the one-shot wake fallback in the same guarded path.
    func attemptSavedMacReconnectRecoveryIfNeeded() async {
        guard scenePhase == .active,
              hasSeenOnboarding,
              !isShowingManualScanner,
              !isShowingManualPairingEntry else {
            return
        }

        await attemptAutomaticWakeSavedMacDisplayIfNeeded()
        await viewModel.attemptAutoReconnectOnForegroundIfNeeded(codex: codex)
    }

    // Resets the once-per-cycle wake gate after a fresh connection, pairing change, or app background.
    func resetSavedMacWakeRecoveryState() {
        hasAttemptedAutomaticWakeSavedMacDisplay = false
    }

    // Uses a temporary bridge request to wake display sleep, then unlocks the manual button only if that fails.
    func wakeSavedMacDisplay() {
        Task { @MainActor in
            await performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: true)
        }
    }

    // Sends one wake pulse over the best remembered pairing path without hiding the manual wake affordance.
    func performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: Bool) async {
        guard codex.supportsDisplayWake, !isWakingSavedMacDisplay else { return }
        isWakingSavedMacDisplay = true

        defer { isWakingSavedMacDisplay = false }

        do {
            if cancelAutoReconnectBeforeWake {
                await viewModel.stopAutoReconnectForManualRetry(codex: codex)
            }
            let handoffService = DesktopHandoffService(codex: codex)
            try await handoffService.wakeDisplay()
            if codex.isConnected {
                codex.schedulePostConnectSyncPass(preferredThreadId: codex.activeThreadId)
            }
        } catch {
            // Wake failures are expected when the Mac has already gone past display sleep,
            // so keep automatic reconnect alive instead of surfacing sticky composer errors.
        }
    }
    // Keeps first-run installs in the scanner by default, while still letting users back out later.
    var shouldShowQRScanner: Bool {
        guard !codex.isConnected else {
            return false
        }

        if isShowingManualScanner {
            return true
        }

        if viewModel.isAttemptingAutoReconnect || shouldShowReconnectShell || isPreparingManualScanner {
            return false
        }

        return !codex.hasReconnectCandidate && !hasDismissedAutomaticScanner
    }

    // Shows the remembered pairing shell while a saved pairing can still be retried.
    var shouldShowReconnectShell: Bool {
        codex.hasReconnectCandidate
            && !isShowingManualScanner
            && (codex.isConnecting
                || viewModel.isAttemptingManualReconnect
                || viewModel.isAttemptingAutoReconnect
                || codex.shouldAutoReconnectOnForeground
                || isRetryingSavedPairing
                || hasIdleSavedPairingRecovery)
    }

    // Keeps home status honest during reconnect loops while letting post-connect sync show separately.
    var homeConnectionPhase: CodexConnectionPhase {
        // Only manual reconnect should force a busy shell here; background auto-retry can sit in backoff
        // while the Mac is asleep, and that should still read as offline until a real connect starts.
        if viewModel.isAttemptingManualReconnect && !codex.isConnected {
            return .connecting
        }
        return codex.connectionPhase
    }

    var isRetryingSavedPairing: Bool {
        if case .retrying = codex.connectionRecoveryState {
            return true
        }
        return false
    }

    // Keeps the reconnect CTA visible after retries stop, unless the pairing must be replaced.
    var hasIdleSavedPairingRecovery: Bool {
        guard codex.hasReconnectCandidate,
              !codex.isConnected,
              codex.secureConnectionState != .rePairRequired else {
            return false
        }

        return !codex.isConnecting
            && !viewModel.isAttemptingAutoReconnect
            && !codex.shouldAutoReconnectOnForeground
            && !isRetryingSavedPairing
    }
    // Switches the user back to the QR path when the old relay session is no longer useful.
    func presentManualScannerForBridgeRecovery() {
        guard !isShowingManualScanner else {
            return
        }

        hasDismissedAutomaticScanner = false
        scannerCanReturnToOnboarding = false
        isShowingManualScanner = true
        dismissPresentedRootSheet()

        Task {
            await viewModel.stopAutoReconnectForManualScan(codex: codex)
        }
    }

    // Shows pairing recovery immediately and tears down any stale reconnect in the background.
    func presentManualScannerAfterStoppingReconnect() {
        guard !isShowingManualScanner else {
            return
        }

        hasDismissedAutomaticScanner = false
        scannerCanReturnToOnboarding = false
        isShowingManualScanner = true

        Task {
            await viewModel.stopAutoReconnectForManualScan(codex: codex)
        }
    }

    // Re-opens the scanner after the user backed out to the empty state without a saved pairing.
    func presentAutomaticScanner() {
        withAnimation {
            hasDismissedAutomaticScanner = false
        }
    }

    // Hides the scanner without forcing the user straight back into the camera on the next render pass.
    func dismissScannerToHome() {
        withAnimation {
            isShowingManualScanner = false
            isShowingMyMacsScanner = false
            hasDismissedAutomaticScanner = true
            scannerCanReturnToOnboarding = false
        }
    }

    // Lets first-run pairing step back into onboarding without changing later recovery flows.
    func returnFromScannerToOnboarding() {
        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .idle
        codex.lastErrorMessage = nil

        withAnimation {
            isShowingManualScanner = false
            isShowingMyMacsScanner = false
            hasDismissedAutomaticScanner = false
            scannerCanReturnToOnboarding = false
            hasSeenOnboarding = false
        }
    }

    // Keeps QR and code recovery as one quiet secondary row under the main reconnect CTA.
    var reconnectSecondaryActions: some View {
        HStack(spacing: 10) {
            secondaryReconnectActionButton("New QR Code") {
                presentManualScannerAfterStoppingReconnect()
            }
            .disabled(isPreparingManualScanner)

            secondaryReconnectActionButton("Pair with Code") {
                presentManualPairingEntryAfterStoppingReconnect()
            }
            .disabled(isPreparingManualScanner || isResolvingManualPairingCode)
        }
    }

    // Keeps the destructive saved-pair action visually separate from the reconnect controls.
    var reconnectFooterAction: some View {
        Button("Forget Pair") {
            codex.forgetReconnectCandidate()
        }
        .font(AppFont.caption(weight: .semibold))
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
    }

    // Mirrors the reconnect button corner language in a lighter outline-only treatment.
    func secondaryReconnectActionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.subheadline(weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
        }
        .foregroundStyle(.primary)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.14), lineWidth: 1)
        )
        .buttonStyle(.plain)
    }

    // Opens manual code entry directly from the home state so the scanner stays QR-only.
    func presentManualPairingEntryAfterStoppingReconnect() {
        guard !isResolvingManualPairingCode else {
            return
        }

        manualPairingErrorMessage = nil
        let clipboardString = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !clipboardString.isEmpty {
            manualPairingCode = clipboardString
        }
        isShowingManualPairingEntry = true

        Task {
            await viewModel.stopAutoReconnectForManualScan(codex: codex)
        }
    }

    func submitManualPairingCode() {
        guard !isResolvingManualPairingCode else {
            return
        }

        let pendingCode = manualPairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pendingCode.isEmpty else {
            manualPairingErrorMessage = "Enter a valid pairing code."
            return
        }
        isResolvingManualPairingCode = true
        manualPairingErrorMessage = nil

        Task { @MainActor in
            defer { isResolvingManualPairingCode = false }

            await viewModel.stopAutoReconnectForManualScan(codex: codex)

            do {
                let pairingPayload = try await codex.resolvePairingCode(pendingCode)
                isShowingManualPairingEntry = false
                manualPairingCode = ""
                await viewModel.connectToRelay(
                    pairingPayload: pairingPayload,
                    codex: codex
                )
            } catch {
                manualPairingErrorMessage = error.localizedDescription
            }
        }
    }
}
