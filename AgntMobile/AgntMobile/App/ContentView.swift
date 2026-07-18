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

struct TerminalNavigationRoute: Hashable {
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
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.horizontalSizeClass) var horizontalSizeClass

    @State var viewModel = ContentViewModel()
    @State var isSidebarOpen = false
    @State var sidebarDragOffset: CGFloat = 0
    @State var isSidebarPrewarmed = false
    @State var selectedThread: CodexThread?
    @State var navigationPath = NavigationPath()
    // Tracks whether the top of `navigationPath` is a terminal route so that
    // re-opening the terminal from a different surface replaces the active page
    // instead of stacking a near-identical one. Kept in sync with `navigationPath`
    // pushes and decreases observed via `onChange(of: navigationPath)`.
    @State var topNavigationRouteIsTerminal = false
    @State var showSettings = false
    @State var isShowingManualScanner = false
    @State var isShowingMyMacsScanner = false
    @State var hasDismissedAutomaticScanner = false
    @State var scannerCanReturnToOnboarding = false
    @State var isShowingManualPairingEntry = false
    @State var manualPairingCode = ""
    @State var manualPairingErrorMessage: String?
    @State var isResolvingManualPairingCode = false
    @State var isSearchActive = false
    @State var isRetryingBridgeUpdate = false
    @State var isUpdatingBridgePackage = false
    @State var isPreparingManualScanner = false
    @State var macSwitchTask: Task<Void, Never>?
    @State var suppressAutomaticThreadSelection = false
    @State var isWakingSavedMacDisplay = false
    @State var hasAttemptedAutomaticWakeSavedMacDisplay = false
    @State var threadCompletionBannerDismissTask: Task<Void, Never>?
    @State var whatsNewPresentationTask: Task<Void, Never>?
    @State var sidebarPrewarmTask: Task<Void, Never>?
    @State var presentedRootSheet: RootSheetRoute?
    @State var isWhatsNewPresentationReady = false
    @State var sidebarGestureDebugSequence = 0
    @State var activeSidebarGestureDebugID: Int?
    @State var lastSidebarGestureLogBucket: Int?
    @State var sidebarGestureAutoCommitted = false
    @State var sidebarSelectionSuppressedUntil: Date?
    @State var isOpeningNewChatFromSidebar = false
    @State var activeNewChatDraftRoute: NewChatDraftRoute?
    @State var pendingQuickAction: AgntQuickAction?
    @State var threadIDsPendingInitialAssistantAnchor: Set<String> = []
    @AppStorage("codex.hasSeenOnboarding") var hasSeenOnboarding = false
    @AppStorage("codex.whatsNew.lastPresentedVersion") var lastPresentedWhatsNewVersion = ""

    let sidebarWidth: CGFloat = 330
    // Lets the drawer gesture start a bit inside the content instead of only on the bezel edge.
    let sidebarOpenActivationWidth: CGFloat = 80
    let sidebarPrewarmDelayNanoseconds: UInt64 = 700_000_000
    let whatsNewPresentationDelayNanoseconds: UInt64 = 30_000_000_000
    let sidebarGestureLogBucketWidth: CGFloat = 40
    let sidebarSwipeCommitDistance: CGFloat = 30
    let sidebarSelectionSuppressionDuration: TimeInterval = 0.35
    let whatsNewReleaseVersion = "1.1"
    static let sidebarSpring = Animation.spring(response: 0.35, dampingFraction: 0.85)
    static var isSidebarDebugLoggingEnabled: Bool { false }

    var body: some View {
        rootContentWithBannerOverlay
    }
}

struct NewChatOpeningStateView: View {
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

struct HorizontalRevealViewportShape: Shape {
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
