// FILE: ContentView+RootLayout.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    @ViewBuilder
    var rootContent: some View {
        if !hasSeenOnboarding {
            OnboardingView {
                finishOnboardingAndShowScanner()
            }
        } else if shouldShowQRScanner {
            qrScannerBody
        } else {
            mainAppBody
        }
    }

    func finishOnboardingAndShowScanner() {
        codex.shouldAutoReconnectOnForeground = false
        codex.connectionRecoveryState = .idle
        codex.lastErrorMessage = nil
        withAnimation {
            hasSeenOnboarding = true
            isShowingManualScanner = true
            hasDismissedAutomaticScanner = false
            scannerCanReturnToOnboarding = true
        }
    }

    // Lets the scanner step back into onboarding on first run, or into the empty state later on.
    var scannerBackAction: (() -> Void)? {
        if scannerCanReturnToOnboarding {
            return { returnFromScannerToOnboarding() }
        }
        return { dismissScannerToHome() }
    }

    var qrScannerBody: some View {
        QRScannerView(
            onBack: scannerBackAction,
            onScan: { pairingPayload in
                Task {
                    isShowingManualScanner = false
                    hasDismissedAutomaticScanner = false
                    scannerCanReturnToOnboarding = false
                    if isShowingMyMacsScanner {
                        isShowingMyMacsScanner = false
                        prepareForMacContextTransition()
                        startScannedMacSwitch(pairingPayload)
                    } else {
                        await viewModel.connectToRelay(
                            pairingPayload: pairingPayload,
                            codex: codex
                        )
                    }
                }
            }
        )
    }

    // Expands the drawer to the full container width on compact layouts so the sidebar
    // can comfortably host longer titles, paths, and search results.
    var shouldUseFullWidthSidebar: Bool {
        horizontalSizeClass == .compact || isSearchActive
    }

    func effectiveSidebarWidth(for availableWidth: CGFloat) -> CGFloat {
        shouldUseFullWidthSidebar ? availableWidth : min(sidebarWidth, availableWidth)
    }

    var mainAppBody: some View {
        GeometryReader { proxy in
            let currentSidebarWidth = effectiveSidebarWidth(for: proxy.size.width)
            let currentSidebarRevealWidth = sidebarRevealWidth(for: currentSidebarWidth)

            ZStack(alignment: .leading) {
                if sidebarVisible || isSidebarPrewarmed {
                    SidebarView(
                        selectedThread: $selectedThread,
                        showSettings: $showSettings,
                        isSearchActive: $isSearchActive,
                        showsInlineCloseButton: shouldUseFullWidthSidebar,
                        isVisible: sidebarVisible,
                        isSwitchingMac: viewModel.isSwitchingMac,
                        switchingMacDeviceId: viewModel.switchingMacDeviceId,
                        macSwitchNotice: viewModel.macSwitchNotice,
                        onClose: { closeSidebar() },
                        onOpenTerminal: {
                            openTerminal(preferredWorkingDirectory: nil)
                        },
                        onOpenMyMacs: {
                            openMyMacsFromSidebar()
                        },
                        onSwitchTrustedMac: { deviceId in
                            switchToTrustedMac(deviceId)
                        },
                        onForgetTrustedMac: { deviceId in
                            forgetTrustedMac(deviceId)
                        },
                        onScanTrustedMac: {
                            presentMyMacsScanner()
                        },
                        onCancelMacSwitch: {
                            cancelMacSwitch()
                        },
                        onOpenNewChatDraft: { source, preferredProjectPath in
                            openNewChatDraftFromSidebar(source: source, preferredProjectPath: preferredProjectPath)
                        },
                        onNewChatCreationStateChange: { isCreating in
                            setNewChatOpeningState(isCreating)
                        },
                        onOpenThread: { thread in
                            openThreadFromSidebar(thread)
                        }
                    )
                    .frame(width: currentSidebarWidth)
                    .animation(.easeInOut(duration: 0.25), value: shouldUseFullWidthSidebar)
                }

                ZStack(alignment: .leading) {
                    mainNavigationLayer
                        .frame(width: proxy.size.width, alignment: .leading)

                    PetCompanionStatusSyncView()

                    PetCompanionOverlay(
                        isInteractionEnabled: !sidebarVisible,
                        bottomExclusionHeight: 16
                    )
                    .frame(width: proxy.size.width, height: proxy.size.height)

                    if sidebarVisible {
                        (colorScheme == .dark ? Color.white : Color.black)
                            .opacity(contentDimOpacity(for: currentSidebarWidth))
                            .frame(width: proxy.size.width)
                            .ignoresSafeArea()
                            .allowsHitTesting(isSidebarOpen)
                            .onTapGesture { closeSidebar() }
                    }
                }
                .frame(width: proxy.size.width, alignment: .leading)
                .clipShape(
                    HorizontalRevealViewportShape(
                        verticalOverflow: max(proxy.size.height, 400)
                    )
                )
                .offset(x: currentSidebarRevealWidth)
            }
        }
        .simultaneousGesture(edgeDragGesture)
    }
}
