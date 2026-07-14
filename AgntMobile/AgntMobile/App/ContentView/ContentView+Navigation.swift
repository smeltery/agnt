// FILE: ContentView+Navigation.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    var mainNavigationLayer: some View {
        NavigationStack(path: $navigationPath) {
            mainContent
                .adaptiveNavigationBar()
                .navigationDestination(for: String.self) { destination in
                    if destination == "settings" {
                        SettingsView()
                            .adaptiveNavigationBar()
                    }
                }
                .navigationDestination(for: TerminalNavigationRoute.self) { route in
                    TerminalScreen(preferredWorkingDirectory: route.preferredWorkingDirectory)
                        .adaptiveNavigationBar()
                }
                .navigationDestination(for: MyMacsNavigationRoute.self) { _ in
                    MyMacsView(
                        onScanQRCode: presentMyMacsScanner,
                        onSwitchMac: switchToTrustedMac,
                        onForgetMac: forgetTrustedMac,
                        onCancelSwitch: cancelMacSwitch,
                        isSwitchingMac: viewModel.isSwitchingMac,
                        isCancellingMacSwitch: viewModel.isCancellingMacSwitch,
                        switchingMacDeviceId: viewModel.switchingMacDeviceId,
                        switchNotice: viewModel.macSwitchNotice
                    )
                    .adaptiveNavigationBar()
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    var mainContent: some View {
        if let activeNewChatDraftRoute {
            NewChatDraftView(
                route: activeNewChatDraftRoute,
                leadingControl: .hamburger(action: { setSidebar(open: true) }),
                onOpenTerminal: { workingDirectory in
                    openTerminal(preferredWorkingDirectory: workingDirectory)
                },
                onOpenThread: { thread in
                    openThreadFromNewChatDraft(thread)
                }
            )
            .id(activeNewChatDraftRoute.id)
        } else if isOpeningNewChatFromSidebar {
            NewChatOpeningStateView()
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        hamburgerButton
                    }
                }
        } else if let thread = selectedThread {
            TurnView(
                thread: thread,
                isWakingMacDisplayRecovery: isWakingSavedMacDisplay,
                initialShouldAnchorToAssistantResponse: threadIDsPendingInitialAssistantAnchor.contains(thread.id),
                onInitialAssistantAnchorConsumed: {
                    threadIDsPendingInitialAssistantAnchor.remove(thread.id)
                },
                onOpenTerminal: { workingDirectory in
                    openTerminal(preferredWorkingDirectory: workingDirectory)
                }
            )
                .id(thread.id)
                .environment(\.reconnectAction, {
                    Task {
                        await viewModel.toggleConnection(codex: codex)
                    }
                })
                .environment(\.wakeMacDisplayAction, wakeMacDisplayRecoveryAction)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        hamburgerButton
                    }
                }
        } else {
            HomeEmptyStateView(
                connectionPhase: homeConnectionPhase,
                statusMessage: codex.lastErrorMessage,
                securityLabel: codex.secureConnectionState.statusLabel,
                trustedPairPresentation: codex.trustedPairPresentation,
                offlinePrimaryButtonTitle: codex.hasReconnectCandidate ? "Reconnect" : "Scan QR Code",
                onPrimaryAction: {
                    if homeConnectionPhase == .offline && !codex.hasReconnectCandidate {
                        presentAutomaticScanner()
                        return
                    }

                    Task {
                        await viewModel.toggleConnection(codex: codex)
                    }
                }
            ) {
                if homeConnectionPhase == .connecting || (codex.hasReconnectCandidate && !codex.isConnected) {
                    if shouldOfferWakeSavedMacDisplayAction {
                        Button(isWakingSavedMacDisplay ? "Waking Screen..." : "Wake Screen") {
                            wakeSavedMacDisplay()
                        }
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                        .buttonStyle(.plain)
                        .disabled(isPreparingManualScanner || isWakingSavedMacDisplay)
                    }

                    if codex.hasReconnectCandidate {
                        reconnectSecondaryActions
                    }
                }
            } footer: {
                if codex.hasReconnectCandidate && !codex.isConnected {
                    reconnectFooterAction
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    hamburgerButton
                }
            }
        }
    }

    var hamburgerButton: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            toggleSidebar()
        } label: {
            TwoLineHamburgerIcon()
                .foregroundStyle(colorScheme == .dark ? Color.white : Color.black)
                .padding(8)
                .contentShape(Circle())
                .adaptiveToolbarItem(in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Menu")
    }
}
