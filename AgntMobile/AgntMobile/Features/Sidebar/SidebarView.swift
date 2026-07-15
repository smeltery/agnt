// FILE: SidebarView.swift
// Purpose: Orchestrates the sidebar experience with modular presentation components.
// Layer: View
// Exports: SidebarView
// Depends on: CodexService, Sidebar* components/helpers

import SwiftUI

struct SidebarView: View {
    @Environment(CodexService.self) var codex
    @Environment(\.colorScheme) var colorScheme

    @Binding var selectedThread: CodexThread?
    @Binding var showSettings: Bool
    @Binding var isSearchActive: Bool
    var showsInlineCloseButton: Bool = false
    var isVisible: Bool = true
    var isSwitchingMac: Bool = false
    var switchingMacDeviceId: String? = nil
    var macSwitchNotice: String? = nil

    let onClose: () -> Void
    let onOpenTerminal: () -> Void
    let onOpenMyMacs: () -> Void
    let onSwitchTrustedMac: (String) -> Void
    let onForgetTrustedMac: (String) -> Void
    let onScanTrustedMac: () -> Void
    let onCancelMacSwitch: () -> Void
    let onOpenNewChatDraft: (NewChatDraftSource, String?) -> Void
    let onNewChatCreationStateChange: (Bool) -> Void
    let onOpenThread: (CodexThread) -> Void

    @State var searchText = ""
    @State var isCreatingThread = false
    @State var pendingTopAction: SidebarTopAction? = nil
    @State var groupedThreads: [SidebarThreadGroup] = []
    @State var activeSidebarSheet: SidebarPresentedSheet?
    @State var projectGroupPendingArchive: SidebarThreadGroup? = nil
    @State var projectGroupPendingDeletion: SidebarThreadGroup? = nil
    @State var threadPendingDeletion: CodexThread? = nil
    @State var createThreadErrorMessage: String? = nil
    @State var cachedDiffTotals: [String: TurnSessionDiffTotals] = [:]
    @State var cachedDiffRevisionByThreadID: [String: Int] = [:]
    @State var cachedRunBadges: [String: CodexThreadRunBadgeState] = [:]
    @State var lastGroupedThreadsFingerprint: Int = 0
    @State var lastDiffFingerprint: Int = 0
    @State var lastBadgeFingerprint: Int = 0
    @State var projectlessChatRootPaths: [String] = []
    @AppStorage("agnt.sidebarContentScope")
    var contentScopeRawValue = SidebarContentScope.projects.rawValue

    var contentScope: SidebarContentScope {
        SidebarContentScope(rawValue: contentScopeRawValue) ?? .projects
    }

    var groupingScope: SidebarThreadGroupingScope {
        switch contentScope {
        case .projects:
            return .projects
        case .chats:
            return .chats
        }
    }

    var body: some View {
        mainStack
            .frame(maxHeight: .infinity)
            .background(Color(.systemBackground))
            .task { await runInitialSidebarTask() }
            .onChange(of: codex.threads) { _, _ in handleThreadsChanged() }
            .onChange(of: searchText) { _, _ in handleSearchTextChanged() }
            .onChange(of: codex.pinnedThreadIDs) { _, _ in handlePinnedThreadsChanged() }
            .onChange(of: diffFingerprint) { _, _ in handleDiffFingerprintChanged() }
            .onChange(of: badgeFingerprint) { _, _ in handleBadgeFingerprintChanged() }
            .onChange(of: isVisible) { _, visible in handleVisibilityChanged(to: visible) }
            .onChange(of: codex.isConnected) { _, connected in handleConnectionChanged(connected: connected) }
            .overlay { loadingOverlay }
            .sheet(item: $activeSidebarSheet) { sheet in sidebarSheetContent(sheet) }
            .confirmationDialog(
                "Archive \"\(pendingArchiveProjectLabel)\"?",
                isPresented: archiveProjectDialogBinding,
                titleVisibility: .visible
            ) {
                Button("Archive Project") { confirmArchivePendingProjectGroup() }
                Button("Cancel", role: .cancel) { cancelPendingArchive() }
            } message: {
                Text("All active chats in this project will be archived.")
            }
            .alert(
                "Remove \"\(pendingDeleteProjectLabel)\" from this phone?",
                isPresented: deleteProjectAlertBinding
            ) {
                Button("Remove from Phone", role: .destructive) { confirmDeletePendingProjectGroup() }
                Button("Cancel", role: .cancel) { cancelPendingDeleteProject() }
            } message: {
                Text("Chats for this project will be deleted only from agnt on this phone. Nothing is removed from your computer or Codex observer.")
            }
            .alert(
                "Remove \"\(pendingDeleteThreadLabel)\" from this phone?",
                isPresented: deleteThreadAlertBinding
            ) {
                Button("Remove from Phone", role: .destructive) { confirmDeletePendingThread() }
                Button("Cancel", role: .cancel) { cancelPendingDeleteThread() }
            } message: {
                Text("This only removes the chat from agnt on this phone. Nothing is removed from your computer or Codex observer.")
            }
            .alert(
                "Action failed",
                isPresented: actionFailedAlertBinding,
                actions: {
                    Button("OK", role: .cancel) { dismissActionFailedAlert() }
                },
                message: {
                    Text(actionFailedMessage)
                }
            )
    }

    @ViewBuilder
    private var mainStack: some View {
        VStack(alignment: .leading, spacing: 0) {
            SidebarHeaderView(
                showsCloseButton: showsInlineCloseButton,
                onClose: onClose
            )

            SidebarSearchField(text: $searchText, isActive: $isSearchActive)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 6)

            SidebarTopActionsRow(
                isEnabled: canCreateThread,
                pendingAction: pendingTopAction,
                onNewChat: handleNewChatButtonTap,
                onQuickChat: handleQuickChatTap,
                onNewProject: handleNewProjectTap
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            SidebarContentScopePicker(
                selection: Binding(
                    get: { contentScope },
                    set: { contentScopeRawValue = $0.rawValue }
                )
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
            .onChange(of: contentScopeRawValue) { _, _ in rebuildGroupedThreads() }

            threadListView

            sidebarFooter
        }
    }

    @ViewBuilder
    private var threadListView: some View {
        SidebarThreadListView(
            isFiltering: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isConnected: codex.isConnected,
            isCreatingThread: isCreatingThread,
            threads: codex.threads,
            groups: groupedThreads,
            selectedThread: selectedThread,
            bottomContentInset: 0,
            timingLabelProvider: { SidebarRelativeTimeFormatter.compactLabel(for: $0) },
            diffTotalsByThreadID: cachedDiffTotals,
            runBadgeStateByThreadID: cachedRunBadges,
            onSelectThread: selectThread,
            onCreateThreadInProjectGroup: { group in
                prepareSidebarForChatNavigation()
                onOpenNewChatDraft(.folderChat, group.projectPath)
            },
            onArchiveProjectGroup: { group in
                projectGroupPendingArchive = group
            },
            onDeleteProjectGroup: { group in
                projectGroupPendingDeletion = group
            },
            onRenameThread: { thread, newName in
                codex.renameThread(thread.id, name: newName)
            },
            onPinToggleThread: { thread in
                togglePinnedState(for: thread)
            },
            onArchiveToggleThread: { thread in
                toggleArchivedState(for: thread)
            },
            onDeleteThread: { thread in
                threadPendingDeletion = thread
            }
        )
        .refreshable {
            await refreshThreads()
        }
    }

    @ViewBuilder
    private var sidebarFooter: some View {
        HStack(spacing: 10) {
            SidebarFloatingSettingsButton(colorScheme: colorScheme, action: openSettings)
            SidebarFloatingMacsButton(colorScheme: colorScheme, action: openMyMacs)
            SidebarFloatingTerminalButton(colorScheme: colorScheme, action: openTerminal)
            SidebarDevicesMenuButton(
                colorScheme: colorScheme,
                isSwitchingMac: isSwitchingMac,
                switchingMacDeviceId: switchingMacDeviceId,
                onSelectDevice: handleSwitcherSelectDevice,
                onOpenDevicesSettings: openDevicesSettings
            )
            Spacer(minLength: 0)
            if let trustedPairPresentation = codex.trustedPairPresentation {
                SidebarComputerConnectionStatusView(
                    name: trustedPairPresentation.name,
                    systemName: trustedPairPresentation.systemName,
                    isConnected: codex.isConnected
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
    }

    @ViewBuilder
    private var loadingOverlay: some View {
        if SidebarThreadsLoadingPresentation.shouldShowOverlay(
            isLoadingThreads: codex.isLoadingThreads,
            threadCount: codex.threads.count
        ) {
            ProgressView()
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    // MARK: - Lifecycle handlers

    private func runInitialSidebarTask() async {
        debugSidebarLog("task start visible=\(isVisible) threadCount=\(codex.threads.count)")
        rebuildGroupedThreads()
        rebuildCachedSidebarState()
        await refreshProjectlessChatRoots()
        if codex.isConnected, codex.threads.isEmpty {
            await refreshThreads()
        }
    }

    private func handleThreadsChanged() {
        debugSidebarLog(
            "threads changed while \(isVisible ? "visible" : "hidden-prewarmed") "
                + "threadCount=\(codex.threads.count)"
        )
        rebuildGroupedThreads()
        rebuildCachedSidebarState()
    }

    private func handleSearchTextChanged() {
        debugSidebarLog("search changed queryLength=\(searchText.count)")
        rebuildGroupedThreads()
    }

    private func handlePinnedThreadsChanged() {
        debugSidebarLog("pinned threads changed count=\(codex.pinnedThreadIDs.count)")
        rebuildGroupedThreads()
    }

    private func handleDiffFingerprintChanged() {
        debugSidebarLog("diff fingerprint changed visible=\(isVisible)")
        rebuildCachedDiffTotals()
    }

    private func handleBadgeFingerprintChanged() {
        debugSidebarLog("badge fingerprint changed visible=\(isVisible)")
        rebuildCachedRunBadges()
    }

    private func handleVisibilityChanged(to visible: Bool) {
        debugSidebarLog("visibility changed visible=\(visible)")
    }

    private func handleConnectionChanged(connected: Bool) {
        guard connected else { return }
        Task { await refreshProjectlessChatRoots() }
    }

    private func togglePinnedState(for thread: CodexThread) {
        if codex.isThreadPinned(thread.id) {
            codex.unpinThread(thread.id)
        } else {
            codex.pinThread(thread.id)
        }
        rebuildGroupedThreads()
    }

    private func toggleArchivedState(for thread: CodexThread) {
        if thread.syncState == .archivedLocal {
            codex.unarchiveThread(thread.id)
        } else {
            codex.archiveThread(thread.id)
            if selectedThread?.id == thread.id {
                selectedThread = nil
            }
        }
    }

    // MARK: - Dialog / alert bindings

    private var archiveProjectDialogBinding: Binding<Bool> {
        Binding(
            get: { projectGroupPendingArchive != nil },
            set: { if !$0 { projectGroupPendingArchive = nil } }
        )
    }

    private var deleteProjectAlertBinding: Binding<Bool> {
        Binding(
            get: { projectGroupPendingDeletion != nil },
            set: { if !$0 { projectGroupPendingDeletion = nil } }
        )
    }

    private var deleteThreadAlertBinding: Binding<Bool> {
        Binding(
            get: { threadPendingDeletion != nil },
            set: { if !$0 { threadPendingDeletion = nil } }
        )
    }

    private var actionFailedAlertBinding: Binding<Bool> {
        Binding(
            get: { createThreadErrorMessage != nil },
            set: { if !$0 { createThreadErrorMessage = nil } }
        )
    }

    private var pendingArchiveProjectLabel: String { projectGroupPendingArchive?.label ?? "project" }
    private var pendingDeleteProjectLabel: String { projectGroupPendingDeletion?.label ?? "project" }
    private var pendingDeleteThreadLabel: String { threadPendingDeletion?.displayTitle ?? "conversation" }
    private var actionFailedMessage: String { createThreadErrorMessage ?? "Please try again." }

    func confirmArchivePendingProjectGroup() {
        archivePendingProjectGroup()
    }

    func cancelPendingArchive() {
        projectGroupPendingArchive = nil
    }

    func confirmDeletePendingProjectGroup() {
        deletePendingProjectGroupLocally()
    }

    func cancelPendingDeleteProject() {
        projectGroupPendingDeletion = nil
    }

    func confirmDeletePendingThread() {
        if let thread = threadPendingDeletion {
            if selectedThread?.id == thread.id {
                selectedThread = nil
            }
            codex.deleteThreadLocally(thread.id)
        }
        threadPendingDeletion = nil
    }

    func cancelPendingDeleteThread() {
        threadPendingDeletion = nil
    }

    func dismissActionFailedAlert() {
        createThreadErrorMessage = nil
    }

    // MARK: - Actions

}
