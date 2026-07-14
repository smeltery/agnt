// FILE: ContentView.swift
// Purpose: Root layout orchestrator — navigation shell, sidebar drawer, and top-level state wiring.
// Layer: View
// Exports: ContentView
// Depends on: SidebarView, TurnView, SettingsView, CodexService, ContentViewModel

import SwiftUI
import UIKit

enum RootSheetRoute: Identifiable, Equatable {
    case bridgeUpdate(CodexBridgeUpdatePrompt)
    case whatsNew(version: String)

    var id: String {
        switch self {
        case .bridgeUpdate(let prompt):
            return "bridge-update-\(prompt.id.uuidString)"
        case .whatsNew(let version):
            return "whats-new-\(version)"
        }
    }
}

private struct TerminalNavigationRoute: Hashable {
    let preferredWorkingDirectory: String?
}

struct MyMacsNavigationRoute: Hashable {}

struct MacContextTransitionSnapshot {
    let selectedThread: CodexThread?
    let activeThreadId: String?
    let suppressAutomaticThreadSelection: Bool
}

struct ContentView: View {
    @Environment(CodexService.self) var codex
    @Environment(\.scenePhase) var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State var viewModel = ContentViewModel()
    @State var isSidebarOpen = false
    @State private var sidebarDragOffset: CGFloat = 0
    @State private var isSidebarPrewarmed = false
    @State var selectedThread: CodexThread?
    @State var navigationPath = NavigationPath()
    // Tracks whether the top of `navigationPath` is a terminal route so that
    // re-opening the terminal from a different surface replaces the active page
    // instead of stacking a near-identical one. Kept in sync with `navigationPath`
    // pushes and decreases observed via `onChange(of: navigationPath)`.
    @State var topNavigationRouteIsTerminal = false
    @State private var showSettings = false
    @State var isShowingManualScanner = false
    @State var isShowingMyMacsScanner = false
    @State var hasDismissedAutomaticScanner = false
    @State var scannerCanReturnToOnboarding = false
    @State var isShowingManualPairingEntry = false
    @State private var manualPairingCode = ""
    @State var manualPairingErrorMessage: String?
    @State private var isResolvingManualPairingCode = false
    @State private var isSearchActive = false
    @State var isRetryingBridgeUpdate = false
    @State var isUpdatingBridgePackage = false
    @State private var isPreparingManualScanner = false
    @State var macSwitchTask: Task<Void, Never>?
    @State var suppressAutomaticThreadSelection = false
    @State private var isWakingSavedMacDisplay = false
    @State private var hasAttemptedAutomaticWakeSavedMacDisplay = false
    @State private var threadCompletionBannerDismissTask: Task<Void, Never>?
    @State var whatsNewPresentationTask: Task<Void, Never>?
    @State private var sidebarPrewarmTask: Task<Void, Never>?
    @State var presentedRootSheet: RootSheetRoute?
    @State var isWhatsNewPresentationReady = false
    @State private var sidebarGestureDebugSequence = 0
    @State private var activeSidebarGestureDebugID: Int?
    @State private var lastSidebarGestureLogBucket: Int?
    @State private var sidebarGestureAutoCommitted = false
    @State private var sidebarSelectionSuppressedUntil: Date?
    @State private var isOpeningNewChatFromSidebar = false
    @State private var activeNewChatDraftRoute: NewChatDraftRoute?
    @State private var pendingQuickAction: AgntQuickAction?
    @State private var threadIDsPendingInitialAssistantAnchor: Set<String> = []
    @AppStorage("codex.hasSeenOnboarding") var hasSeenOnboarding = false
    @AppStorage("codex.whatsNew.lastPresentedVersion") var lastPresentedWhatsNewVersion = ""

    private let sidebarWidth: CGFloat = 330
    // Lets the drawer gesture start a bit inside the content instead of only on the bezel edge.
    private let sidebarOpenActivationWidth: CGFloat = 80
    private let sidebarPrewarmDelayNanoseconds: UInt64 = 700_000_000
    let whatsNewPresentationDelayNanoseconds: UInt64 = 30_000_000_000
    private let sidebarGestureLogBucketWidth: CGFloat = 40
    private let sidebarSwipeCommitDistance: CGFloat = 30
    private let sidebarSelectionSuppressionDuration: TimeInterval = 0.35
    let whatsNewReleaseVersion = "1.1"
    private static let sidebarSpring = Animation.spring(response: 0.35, dampingFraction: 0.85)
    private static var isSidebarDebugLoggingEnabled: Bool { false }

    var body: some View {
        rootContentWithBannerOverlay
    }

    // Splits lifecycle wiring from presentation modifiers so SwiftUI does not have to type-check one giant body chain.
    private var rootContentWithLifecycleObservers: some View {
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

    // Keeps sheets and alerts out of the lifecycle chain so the compiler can reason about each stage separately.
    private var rootContentWithPresentations: some View {
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

    private var rootContentWithBannerOverlay: some View {
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

    @ViewBuilder
    private var rootContent: some View {
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

    private func finishOnboardingAndShowScanner() {
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
    private var scannerBackAction: (() -> Void)? {
        if scannerCanReturnToOnboarding {
            return { returnFromScannerToOnboarding() }
        }
        return { dismissScannerToHome() }
    }

    private var qrScannerBody: some View {
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
    private var shouldUseFullWidthSidebar: Bool {
        horizontalSizeClass == .compact || isSearchActive
    }

    private func effectiveSidebarWidth(for availableWidth: CGFloat) -> CGFloat {
        shouldUseFullWidthSidebar ? availableWidth : min(sidebarWidth, availableWidth)
    }

    private var mainAppBody: some View {
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

    // MARK: - Layers

    private var mainNavigationLayer: some View {
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
    private var mainContent: some View {
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

    private var hamburgerButton: some View {
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

    private var manualPairingErrorAlertIsPresented: Binding<Bool> {
        Binding(
            get: { manualPairingErrorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    manualPairingErrorMessage = nil
                }
            }
        )
    }

    private var manualPairingErrorAlertMessage: String {
        manualPairingErrorMessage ?? "Could not resolve that pairing code."
    }

    // Offers a one-tap display wake for the best local-style relay we still know about, even if only the trusted record remains.
    private var canWakeSavedMacDisplay: Bool {
        homeConnectionPhase == .offline && codex.canWakePreferredMacDisplay
    }

    // Keep the wake CTA visible whenever the pairing still knows enough to try a display pulse.
    private var shouldOfferWakeSavedMacDisplayAction: Bool {
        canWakeSavedMacDisplay
            && codex.supportsDisplayWake
            && hasAttemptedAutomaticWakeSavedMacDisplay
            && !isWakingSavedMacDisplay
    }

    // Keeps the silent wake fallback automatic exactly once per offline cycle before the user taps manually again.
    private var shouldAttemptAutomaticWakeSavedMacDisplay: Bool {
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

    private var wakeMacDisplayRecoveryAction: (() -> Void)? {
        guard shouldOfferWakeSavedMacDisplayAction else {
            return nil
        }

        return {
            wakeSavedMacDisplay()
        }
    }

    // Gives the saved local Mac one silent wake attempt before exposing the manual wake affordance.
    private func attemptAutomaticWakeSavedMacDisplayIfNeeded() async {
        guard shouldAttemptAutomaticWakeSavedMacDisplay else {
            return
        }

        hasAttemptedAutomaticWakeSavedMacDisplay = true
        await performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: false)
    }

    // Keeps foreground reconnect and the one-shot wake fallback in the same guarded path.
    private func attemptSavedMacReconnectRecoveryIfNeeded() async {
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
    private func resetSavedMacWakeRecoveryState() {
        hasAttemptedAutomaticWakeSavedMacDisplay = false
    }

    // Uses a temporary bridge request to wake display sleep, then unlocks the manual button only if that fails.
    private func wakeSavedMacDisplay() {
        Task { @MainActor in
            await performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: true)
        }
    }

    // Sends one wake pulse over the best remembered pairing path without hiding the manual wake affordance.
    private func performSavedMacDisplayWakeAttempt(cancelAutoReconnectBeforeWake: Bool) async {
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

    // MARK: - Sidebar Geometry

    private var sidebarVisible: Bool {
        isSidebarOpen || sidebarDragOffset > 0
    }

    private var sidebarRevealWidth: CGFloat {
        sidebarRevealWidth(for: fallbackSidebarWidth)
    }

    private var fallbackSidebarWidth: CGFloat {
        effectiveSidebarWidth(for: UIScreen.main.bounds.width)
    }

    private func sidebarRevealWidth(for targetWidth: CGFloat) -> CGFloat {
        if isSidebarOpen {
            return max(0, targetWidth + sidebarDragOffset)
        } else {
            return max(0, sidebarDragOffset)
        }
    }

    private func contentDimOpacity(for targetWidth: CGFloat) -> Double {
        guard targetWidth > 0 else { return 0 }
        let progress = min(1, sidebarRevealWidth(for: targetWidth) / targetWidth)
        return 0.08 * progress
    }

    // MARK: - Gestures

    private var edgeDragGesture: some Gesture {
        DragGesture(minimumDistance: 15, coordinateSpace: .global)
            .onChanged { value in
                guard navigationPath.isEmpty else { return }
                guard !sidebarGestureAutoCommitted else { return }

                if !isSidebarOpen {
                    guard value.startLocation.x < sidebarOpenActivationWidth,
                          isOpeningSidebarGesture(value) else { return }
                    beginSidebarGestureDebugIfNeeded(kind: "open", startX: value.startLocation.x)
                    logSidebarGestureProgressIfNeeded(translation: value.translation.width)
                    guard value.translation.width >= sidebarSwipeCommitDistance else { return }
                    sidebarGestureAutoCommitted = true
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) auto-commit kind=open "
                            + "translation=\(Int(value.translation.width)) commit=\(Int(sidebarSwipeCommitDistance))"
                    )
                    finishGesture(open: true)
                } else {
                    guard isClosingSidebarGesture(value) else { return }
                    suppressSidebarSelectionBriefly()
                    beginSidebarGestureDebugIfNeeded(kind: "close", startX: value.startLocation.x)
                    logSidebarGestureProgressIfNeeded(translation: -value.translation.width)
                    guard -value.translation.width >= sidebarSwipeCommitDistance else { return }
                    sidebarGestureAutoCommitted = true
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) auto-commit kind=close "
                            + "translation=\(Int(-value.translation.width)) commit=\(Int(sidebarSwipeCommitDistance))"
                    )
                    finishGesture(open: false)
                }
            }
            .onEnded { value in
                guard navigationPath.isEmpty else { return }
                if sidebarGestureAutoCommitted {
                    sidebarGestureAutoCommitted = false
                    return
                }

                if !isSidebarOpen {
                    guard value.startLocation.x < sidebarOpenActivationWidth,
                          isOpeningSidebarGesture(value) else {
                        debugSidebarLog("gesture cancelled before open")
                        sidebarDragOffset = 0
                        sidebarGestureAutoCommitted = false
                        resetSidebarGestureDebug()
                        return
                    }
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) end kind=open "
                            + "translation=\(Int(value.translation.width)) predicted=\(Int(value.predictedEndTranslation.width)) "
                            + "commit=\(Int(sidebarSwipeCommitDistance)) decision=snap-close"
                    )
                    sidebarDragOffset = 0
                    resetSidebarGestureDebug()
                } else {
                    guard isClosingSidebarGesture(value) else {
                        debugSidebarLog("gesture cancelled before close")
                        sidebarDragOffset = 0
                        sidebarGestureAutoCommitted = false
                        resetSidebarGestureDebug()
                        return
                    }
                    suppressSidebarSelectionBriefly()
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) end kind=close "
                            + "translation=\(Int(-value.translation.width)) predicted=\(Int(-value.predictedEndTranslation.width)) "
                            + "commit=\(Int(sidebarSwipeCommitDistance)) decision=snap-open"
                    )
                    sidebarDragOffset = 0
                    resetSidebarGestureDebug()
                }
            }
    }

    // Keeps the sidebar swipe from claiming mostly vertical drags near the screen edge.
    private func isOpeningSidebarGesture(_ value: DragGesture.Value) -> Bool {
        let horizontal = value.translation.width
        let vertical = value.translation.height
        return horizontal > 0 && abs(horizontal) > abs(vertical) * 1.15
    }

    private func isClosingSidebarGesture(_ value: DragGesture.Value) -> Bool {
        let horizontal = value.translation.width
        let vertical = value.translation.height
        return horizontal < 0 && abs(horizontal) > abs(vertical) * 1.15
    }

    // MARK: - Sidebar Actions

    private func toggleSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        let shouldOpenSidebar = !isSidebarOpen
        setSidebar(open: shouldOpenSidebar)
    }

    func closeSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        setSidebar(open: false)
    }

    private func openThreadFromSidebar(_ thread: CodexThread) {
        guard !shouldSuppressSidebarSelection() else {
            debugSidebarLog("openThread suppressed by close swipe id=\(thread.id)")
            return
        }

        activeNewChatDraftRoute = nil
        isOpeningNewChatFromSidebar = false
        if isSidebarOpen || sidebarDragOffset > 0 {
            closeSidebar()
        }

        selectedThread = thread
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)
        Task { @MainActor in
            do {
                let restoredThread = try await codex.restorePinnedThreadIfNeeded(threadId: thread.id)
                if let restoredThread {
                    selectedThread = restoredThread
                    codex.activeThreadId = restoredThread.id
                }
            } catch {
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }

            codex.requestImmediateActiveThreadSync(threadId: thread.id)
        }
    }

    // MARK: - Home Screen quick actions

    private func routePendingQuickActionIfNeeded() {
        if pendingQuickAction == nil {
            pendingQuickAction = AgntQuickActionCenter.consumePendingAction()
        }

        guard let action = pendingQuickAction else {
            return
        }

        // Shortcut callbacks can arrive before SwiftUI has resolved the size class.
        // Routing too early chooses drawer mode on iPhone and leaves the user at the sidebar root.
        guard horizontalSizeClass != nil else {
            return
        }

        pendingQuickAction = nil
        handleQuickAction(action)
    }

    private func handleQuickAction(_ action: AgntQuickAction) {
        switch action {
        case .newChat:
            openNewChatDraftFromSidebar(source: .generalChat, preferredProjectPath: nil)
        case .thread(let threadId):
            if let thread = codex.threads.first(where: { $0.id == threadId && $0.syncState == .live }) {
                sidebarSelectionSuppressedUntil = nil
                openThreadFromSidebar(thread)
            } else {
                routeQuickActionThreadPlaceholder(threadId: threadId)
            }
        }
    }

    private func routeQuickActionThreadPlaceholder(threadId: String) {
        let normalizedThreadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadId.isEmpty else {
            return
        }

        let thread = codex.threads.first(where: { $0.id == normalizedThreadId })
            ?? CodexThread(id: normalizedThreadId, title: CodexThread.defaultDisplayTitle)
        codex.upsertThread(thread)
        sidebarSelectionSuppressedUntil = nil
        openThreadFromSidebar(thread)
    }

    // Terminal can be opened from several surfaces with different cwd payloads;
    // replace the active terminal route instead of stacking near-identical pages.
    private func openTerminal(preferredWorkingDirectory: String?) {
        if topNavigationRouteIsTerminal, !navigationPath.isEmpty {
            navigationPath.removeLast()
        }
        navigationPath.append(TerminalNavigationRoute(preferredWorkingDirectory: preferredWorkingDirectory))
        topNavigationRouteIsTerminal = true
    }

    // Prevents a close-swipe release from also activating whichever sidebar row was under the finger.
    private func suppressSidebarSelectionBriefly() {
        sidebarSelectionSuppressedUntil = Date().addingTimeInterval(sidebarSelectionSuppressionDuration)
    }

    private func shouldSuppressSidebarSelection() -> Bool {
        guard let suppressedUntil = sidebarSelectionSuppressedUntil else { return false }
        if Date() < suppressedUntil {
            return true
        }
        sidebarSelectionSuppressedUntil = nil
        return false
    }

    private func setNewChatOpeningState(_ isOpening: Bool) {
        isOpeningNewChatFromSidebar = isOpening
        if isOpening {
            activeNewChatDraftRoute = nil
            selectedThread = nil
            codex.activeThreadId = nil
        }
    }

    // Keeps sidebar chat creation compose-first while preserving which affordance
    // opened it, so the draft UI can distinguish general Chat from folder Chat.
    private func openNewChatDraftFromSidebar(
        source: NewChatDraftSource,
        preferredProjectPath: String?
    ) {
        let route = NewChatDraftRoute(
            id: "new-chat-draft-\(UUID().uuidString)",
            preferredProjectPath: preferredProjectPath,
            source: source
        )
        activeNewChatDraftRoute = route
        isOpeningNewChatFromSidebar = false
        selectedThread = nil
        codex.activeThreadId = nil

        if isSidebarOpen || sidebarDragOffset > 0 {
            closeSidebar()
        }
    }

    private func openThreadFromNewChatDraft(_ thread: CodexThread) {
        isOpeningNewChatFromSidebar = false
        threadIDsPendingInitialAssistantAnchor.insert(thread.id)
        selectedThread = thread
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)

        // We always render the thread inline (no nested NavigationStack split locally),
        // so drop the legacy `activeNewChatDraftRoute` here rather than waiting for a
        // navigationPath append. Matches upstream `else` branch in ba5c596.
        activeNewChatDraftRoute = nil
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
    private var shouldShowReconnectShell: Bool {
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
    private var homeConnectionPhase: CodexConnectionPhase {
        // Only manual reconnect should force a busy shell here; background auto-retry can sit in backoff
        // while the Mac is asleep, and that should still read as offline until a real connect starts.
        if viewModel.isAttemptingManualReconnect && !codex.isConnected {
            return .connecting
        }
        return codex.connectionPhase
    }

    private var isRetryingSavedPairing: Bool {
        if case .retrying = codex.connectionRecoveryState {
            return true
        }
        return false
    }

    // Keeps the reconnect CTA visible after retries stop, unless the pairing must be replaced.
    private var hasIdleSavedPairingRecovery: Bool {
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

    private func finishGesture(open: Bool) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        debugSidebarLog("finishGesture open=\(open)")
        setSidebar(open: open)
    }

    // Forces UIKit-backed inputs like the composer/search text views to resign before the drawer moves.
    private func setSidebar(open: Bool) {
        debugSidebarLog(
            "setSidebar open=\(open) prewarmed=\(isSidebarPrewarmed) "
                + "visible=\(sidebarVisible) revealWidth=\(Int(sidebarRevealWidth))"
        )
        if !open {
            isSearchActive = false
        }
        dismissActiveKeyboard()
        withAnimation(Self.sidebarSpring) {
            isSidebarOpen = open
            sidebarDragOffset = 0
        }
        sidebarGestureAutoCommitted = false
        resetSidebarGestureDebug()
    }

    // Warms the sidebar view tree offscreen after launch/reconnect so the first drawer gesture
    // doesn't pay the full mount/grouping cost in the animation frame budget.
    private func scheduleSidebarPrewarmIfNeeded() {
        guard scenePhase == .active,
              hasSeenOnboarding,
              !isShowingManualScanner,
              !isSidebarPrewarmed,
              sidebarPrewarmTask == nil,
              (codex.isConnected || !codex.threads.isEmpty) else {
            debugSidebarLog(
                "prewarm skipped phase=\(String(describing: scenePhase)) onboarding=\(hasSeenOnboarding) "
                    + "scanner=\(isShowingManualScanner) "
                    + "prewarmed=\(isSidebarPrewarmed) taskActive=\(sidebarPrewarmTask != nil) "
                    + "connected=\(codex.isConnected) threadCount=\(codex.threads.count)"
            )
            return
        }

        debugSidebarLog("prewarm scheduled delayMs=\(sidebarPrewarmDelayNanoseconds / 1_000_000)")
        sidebarPrewarmTask = Task { @MainActor in
            defer { sidebarPrewarmTask = nil }
            try? await Task.sleep(nanoseconds: sidebarPrewarmDelayNanoseconds)
            guard !Task.isCancelled,
                  scenePhase == .active,
                  hasSeenOnboarding,
                  !isShowingManualScanner,
                  !isSidebarOpen,
                  sidebarDragOffset == 0,
                  (codex.isConnected || !codex.threads.isEmpty) else {
                debugSidebarLog("prewarm cancelled before completion")
                return
            }
            isSidebarPrewarmed = true
            debugSidebarLog("prewarm completed threadCount=\(codex.threads.count)")
        }
    }

    private func teardownSidebarPrewarm() {
        debugSidebarLog("prewarm teardown requested sidebarOpen=\(isSidebarOpen) dragOffset=\(Int(sidebarDragOffset))")
        sidebarPrewarmTask?.cancel()
        sidebarPrewarmTask = nil
        if !isSidebarOpen, sidebarDragOffset == 0 {
            isSidebarPrewarmed = false
            debugSidebarLog("prewarm cleared")
        }
    }

    private func beginSidebarGestureDebugIfNeeded(kind: String, startX: CGFloat) {
        guard Self.isSidebarDebugLoggingEnabled else { return }
        guard activeSidebarGestureDebugID == nil else { return }
        sidebarGestureDebugSequence += 1
        activeSidebarGestureDebugID = sidebarGestureDebugSequence
        lastSidebarGestureLogBucket = nil
        debugSidebarLog(
            "gesture #\(sidebarGestureDebugSequence) begin kind=\(kind) "
                + "startX=\(Int(startX)) sidebarOpen=\(isSidebarOpen) prewarmed=\(isSidebarPrewarmed)"
        )
    }

    private func logSidebarGestureProgressIfNeeded(translation: CGFloat) {
        guard Self.isSidebarDebugLoggingEnabled else { return }
        guard let gestureID = activeSidebarGestureDebugID else { return }
        let bucket = max(0, Int(translation / sidebarGestureLogBucketWidth))
        guard bucket != lastSidebarGestureLogBucket else { return }
        lastSidebarGestureLogBucket = bucket
        debugSidebarLog(
            "gesture #\(gestureID) progress translation=\(Int(translation)) "
                + "bucket=\(bucket) revealWidth=\(Int(sidebarRevealWidth))"
        )
    }

    private func resetSidebarGestureDebug() {
        activeSidebarGestureDebugID = nil
        lastSidebarGestureLogBucket = nil
    }

    // Gesture and lifecycle logs are lazy so release builds do not build strings on hot paths.
    private func debugSidebarLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isSidebarDebugLoggingEnabled else { return }
        print("[SidebarDebug] \(message())")
        #endif
    }

    // Uses the responder chain instead of per-view bindings so mixed SwiftUI/UIKit inputs all close together.
    private func dismissActiveKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private var missingNotificationThreadAlertIsPresented: Binding<Bool> {
        Binding(
            get: { codex.missingNotificationThreadPrompt != nil },
            set: { isPresented in
                if !isPresented {
                    codex.missingNotificationThreadPrompt = nil
                }
            }
        )
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
    private func presentAutomaticScanner() {
        withAnimation {
            hasDismissedAutomaticScanner = false
        }
    }

    // Hides the scanner without forcing the user straight back into the camera on the next render pass.
    private func dismissScannerToHome() {
        withAnimation {
            isShowingManualScanner = false
            isShowingMyMacsScanner = false
            hasDismissedAutomaticScanner = true
            scannerCanReturnToOnboarding = false
        }
    }

    // Lets first-run pairing step back into onboarding without changing later recovery flows.
    private func returnFromScannerToOnboarding() {
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
    private var reconnectSecondaryActions: some View {
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
    private var reconnectFooterAction: some View {
        Button("Forget Pair") {
            codex.forgetReconnectCandidate()
        }
        .font(AppFont.caption(weight: .semibold))
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
    }

    // Mirrors the reconnect button corner language in a lighter outline-only treatment.
    private func secondaryReconnectActionButton(_ title: String, action: @escaping () -> Void) -> some View {
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
    private func presentManualPairingEntryAfterStoppingReconnect() {
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

    private func submitManualPairingCode() {
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

    private func startNewThreadFromMissingNotificationAlert() async {
        do {
            let thread = try await codex.startThread()
            selectedThread = thread
        } catch {
            codex.lastErrorMessage = codex.userFacingTurnErrorMessage(from: error)
        }
    }

    // Auto-hides the banner unless the user taps through to the finished chat first.
    private func scheduleThreadCompletionBannerDismiss(for banner: CodexThreadCompletionBanner?) {
        threadCompletionBannerDismissTask?.cancel()

        guard let banner else {
            threadCompletionBannerDismissTask = nil
            return
        }

        threadCompletionBannerDismissTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                if codex.threadCompletionBanner?.id == banner.id {
                    codex.threadCompletionBanner = nil
                }
            }
        }
    }

    // Lets the user jump straight to the chat that produced the ready sidebar badge.
    private func openCompletedThreadFromBanner(_ banner: CodexThreadCompletionBanner) {
        threadCompletionBannerDismissTask?.cancel()
        codex.threadCompletionBanner = nil

        guard let thread = codex.threads.first(where: { $0.id == banner.threadId }) else {
            return
        }

        openThreadFromSidebar(thread)
    }

    private func dismissThreadCompletionBanner() {
        threadCompletionBannerDismissTask?.cancel()
        codex.threadCompletionBanner = nil
    }

    // Keeps selected thread coherent with server list updates.
    private func syncSelectedThread(with threads: [CodexThread]) {
        guard !isOpeningNewChatFromSidebar else { return }

        if let selected = selectedThread,
           !threads.contains(where: { $0.id == selected.id }) {
            if codex.activeThreadId == selected.id {
                return
            }
            selectedThread = codex.pendingNotificationOpenThreadID == nil ? threads.first : nil
            return
        }

        if let selected = selectedThread,
           let refreshed = threads.first(where: { $0.id == selected.id }) {
            selectedThread = refreshed
            return
        }

        if selectedThread == nil,
           codex.activeThreadId == nil,
           !suppressAutomaticThreadSelection,
           codex.pendingNotificationOpenThreadID == nil,
           let first = threads.first {
            selectedThread = first
        }
    }

}

private struct NewChatOpeningStateView: View {
    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.regular)

            VStack(spacing: 4) {
                Text("Starting new chat...")
                    .font(AppFont.headline())
                    .foregroundStyle(.primary)

                Text("Preparing an empty conversation.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct TwoLineHamburgerIcon: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            RoundedRectangle(cornerRadius: 1)
                .frame(width: 20, height: 2)

            RoundedRectangle(cornerRadius: 1)
                .frame(width: 10, height: 2)
        }
        .frame(width: 20, height: 14, alignment: .leading)
    }
}

private struct HorizontalRevealViewportShape: Shape {
    let verticalOverflow: CGFloat

    func path(in rect: CGRect) -> Path {
        let expandedRect = CGRect(
            x: rect.minX,
            y: rect.minY - verticalOverflow,
            width: rect.width,
            height: rect.height + (verticalOverflow * 2)
        )
        return Path(expandedRect)
    }
}

#Preview {
    ContentView()
        .environment(CodexService())
}
