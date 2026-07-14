// FILE: ContentView+Presentations.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    var rootContentWithPresentations: some View {
        rootContentWithLifecycleObservers
            // Presents exactly one root-owned sheet at a time so onboarding, paywall, updates,
            // and delayed announcements cannot race each other into stacked presentations.
            .sheet(item: presentedRootSheetBinding) { route in
                switch route {
                case .bridgeUpdate(let prompt):
                    bridgeUpdateSheet(prompt: prompt)
                case .whatsNew(let version):
                    whatsNewSheet(version: version)
                }
            }
            .alert(
                "Chat Deleted",
                isPresented: missingNotificationThreadAlertIsPresented,
                presenting: codex.missingNotificationThreadPrompt
            ) { _ in
                Button("Not Now", role: .cancel) {
                    codex.missingNotificationThreadPrompt = nil
                }
                Button("Start New Chat") {
                    codex.missingNotificationThreadPrompt = nil
                    Task {
                        await startNewThreadFromMissingNotificationAlert()
                    }
                }
            } message: { _ in
                Text("This chat is no longer available. Start a new chat instead?")
            }
            .alert("Pairing Error", isPresented: manualPairingErrorAlertIsPresented) {
                Button("OK", role: .cancel) {
                    manualPairingErrorMessage = nil
                }
            } message: {
                Text(manualPairingErrorAlertMessage)
            }
            .alert("Enter Pairing Code", isPresented: $isShowingManualPairingEntry) {
                TextField("AB23CD34EF", text: $manualPairingCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()

                Button(isResolvingManualPairingCode ? "Connecting..." : "Enter") {
                    submitManualPairingCode()
                }

                Button("Cancel", role: .cancel) {
                    manualPairingCode = ""
                }
            } message: {
                Text("Paste the pairing code shown in the terminal on your computer or in your phone shell.")
            }
    }

    var rootContentWithBannerOverlay: some View {
        rootContentWithPresentations
            .overlay(alignment: .top) {
                if let banner = codex.threadCompletionBanner {
                    ThreadCompletionBannerView(
                        banner: banner,
                        onTap: {
                            openCompletedThreadFromBanner(banner)
                        },
                        onDismiss: {
                            dismissThreadCompletionBanner()
                        }
                    )
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.88), value: codex.threadCompletionBanner?.id)
    }
}
