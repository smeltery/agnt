// FILE: SidebarView.swift
// Purpose: Orchestrates the sidebar experience with modular presentation components.
// Layer: View
// Exports: SidebarView
// Depends on: CodexService, Sidebar* components/helpers

import SwiftUI

struct SidebarView: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.colorScheme) private var colorScheme

    @Binding var selectedThread: CodexThread?
    @Binding var showSettings: Bool
    @Binding var isSearchActive: Bool
    var showsInlineCloseButton: Bool = false
    var isVisible: Bool = true

    let onClose: () -> Void
    let onOpenTerminal: () -> Void
    let onOpenMyMacs: () -> Void
    let onOpenNewChatDraft: (NewChatDraftSource, String?) -> Void
    let onNewChatCreationStateChange: (Bool) -> Void
    let onOpenThread: (CodexThread) -> Void

    @State private var searchText = ""
    @State private var isCreatingThread = false
    @State private var pendingTopAction: SidebarTopAction? = nil
    @State private var groupedThreads: [SidebarThreadGroup] = []
    @State private var activeSidebarSheet: SidebarPresentedSheet?
    @State private var projectGroupPendingArchive: SidebarThreadGroup? = nil
    @State private var projectGroupPendingDeletion: SidebarThreadGroup? = nil
    @State private var threadPendingDeletion: CodexThread? = nil
    @State private var createThreadErrorMessage: String? = nil
    @State private var cachedDiffTotals: [String: TurnSessionDiffTotals] = [:]
    @State private var cachedDiffRevisionByThreadID: [String: Int] = [:]
    @State private var cachedRunBadges: [String: CodexThreadRunBadgeState] = [:]
    @State private var lastGroupedThreadsFingerprint: Int = 0
    @State private var lastDiffFingerprint: Int = 0
    @State private var lastBadgeFingerprint: Int = 0
    @State private var projectlessChatRootPaths: [String] = []

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

    private func confirmArchivePendingProjectGroup() {
        archivePendingProjectGroup()
    }

    private func cancelPendingArchive() {
        projectGroupPendingArchive = nil
    }

    private func confirmDeletePendingProjectGroup() {
        deletePendingProjectGroupLocally()
    }

    private func cancelPendingDeleteProject() {
        projectGroupPendingDeletion = nil
    }

    private func confirmDeletePendingThread() {
        if let thread = threadPendingDeletion {
            if selectedThread?.id == thread.id {
                selectedThread = nil
            }
            codex.deleteThreadLocally(thread.id)
        }
        threadPendingDeletion = nil
    }

    private func cancelPendingDeleteThread() {
        threadPendingDeletion = nil
    }

    private func dismissActionFailedAlert() {
        createThreadErrorMessage = nil
    }

    // MARK: - Actions

    private func refreshThreads() async {
        guard codex.isConnected else { return }
        let startedAt = Date()
        debugSidebarLog("refreshThreads start threadCount=\(codex.threads.count)")
        do {
            try await codex.listThreads()
            debugSidebarLog(
                "refreshThreads success durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                    + "threadCount=\(codex.threads.count)"
            )
        } catch {
            debugSidebarLog(
                "refreshThreads failed durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                    + "error=\(error.localizedDescription)"
            )
            // Error stored in CodexService.
        }
    }

    // Opens a draft composer first; the real thread is created only after the first send.
    private func handleNewChatButtonTap() {
        prepareSidebarForChatNavigation()
        onOpenNewChatDraft(.generalChat, defaultNewChatProjectPath)
    }

    // Quick Chat skips the picker and opens an unscoped draft so the user can
    // start typing without committing to a project up front.
    private func handleQuickChatTap() {
        prepareSidebarForChatNavigation()
        onOpenNewChatDraft(.generalChat, nil)
    }

    private var defaultNewChatProjectPath: String? {
        newChatProjectChoices.first?.projectPath
    }

    // Opens the local folder browser so the user can register a new project root.
    private func handleNewProjectTap() {
        presentLocalFolderBrowser()
    }

    private func presentLocalFolderBrowser() {
        activeSidebarSheet = .localFolderBrowser
    }

    private func handleNewChatTap(preferredProjectPath: String?) {
        createThreadErrorMessage = nil
        isCreatingThread = true
        onNewChatCreationStateChange(true)
        prepareSidebarForChatNavigation()
        Task { @MainActor in
            defer {
                isCreatingThread = false
                pendingTopAction = nil
                onNewChatCreationStateChange(false)
            }

            do {
                let thread = try await WorktreeFlowCoordinator.startNewLocalChat(
                    preferredProjectPath: preferredProjectPath,
                    codex: codex
                )
                onOpenThread(thread)
            } catch {
                guard let message = codex.userFacingTurnErrorMessageForFooter(from: error) else { return }
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a chat right now." : message
            }
        }
    }

    private func handleNewWorktreeChatTap(preferredProjectPath: String) {
        createThreadErrorMessage = nil
        isCreatingThread = true
        onNewChatCreationStateChange(true)
        prepareSidebarForChatNavigation()
        Task { @MainActor in
            defer {
                isCreatingThread = false
                pendingTopAction = nil
                onNewChatCreationStateChange(false)
            }

            do {
                let thread = try await WorktreeFlowCoordinator.startNewWorktreeChat(
                    preferredProjectPath: preferredProjectPath,
                    codex: codex
                )
                onOpenThread(thread)
            } catch {
                guard let message = codex.userFacingTurnErrorMessageForFooter(from: error) else { return }
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a worktree chat right now." : message
            }
        }
    }

    private func selectThread(_ thread: CodexThread) {
        debugSidebarLog("selectThread id=\(thread.id) title=\(thread.displayTitle)")
        prepareSidebarForChatNavigation()
        onOpenThread(thread)
    }

    private func openSettings() {
        searchText = ""
        isSearchActive = false
        showSettings = true
        onClose()
    }

    private func openTerminal() {
        searchText = ""
        isSearchActive = false
        onOpenTerminal()
        onClose()
    }

    private func openMyMacs() {
        searchText = ""
        isSearchActive = false
        onOpenMyMacs()
        onClose()
    }

    // Clears sidebar-only input state before navigation so full-width search mode cannot hold the drawer open.
    private func prepareSidebarForChatNavigation() {
        searchText = ""
        isSearchActive = false
        onClose()
    }

    // Archives every live chat in the selected project group and clears the current selection if needed.
    private func archivePendingProjectGroup() {
        guard let group = projectGroupPendingArchive else { return }

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(
            group,
            in: codex.threads,
            projectlessRootPaths: projectlessChatRootPaths
        )
        let selectedThreadWasArchived = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.archiveThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasArchived {
            selectedThread = codex.threads.first(where: { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            })
        }

        projectGroupPendingArchive = nil
    }

    // Removes every local chat for the selected project while leaving the desktop runtime untouched.
    private func deletePendingProjectGroupLocally() {
        guard let group = projectGroupPendingDeletion else { return }

        let threadIDs = SidebarThreadGrouping.allThreadIDsForProjectGroup(
            group,
            in: codex.threads,
            projectlessRootPaths: projectlessChatRootPaths
        )
        let selectedThreadWasDeleted = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.deleteLocalThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasDeleted {
            selectedThread = codex.threads.first { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            }
        }

        projectGroupPendingDeletion = nil
    }

    // Rebuilds sidebar sections only when the source thread array changes.
    private func rebuildGroupedThreads() {
        let startedAt = Date()
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let source: [CodexThread]
        if query.isEmpty {
            source = codex.threads
        } else {
            source = codex.threads.filter {
                $0.displayTitle.localizedCaseInsensitiveContains(query)
                || ($0.preview?.localizedCaseInsensitiveContains(query) ?? false)
                || $0.projectDisplayName.localizedCaseInsensitiveContains(query)
                || ($0.normalizedProjectPath?.localizedCaseInsensitiveContains(query) ?? false)
            }
        }
        let fingerprint = groupingFingerprint(query: query, source: source)
        guard fingerprint != lastGroupedThreadsFingerprint else { return }
        lastGroupedThreadsFingerprint = fingerprint
        groupedThreads = SidebarThreadGrouping.makeGroups(
            from: source,
            pinnedThreadIDs: codex.pinnedThreadIDs,
            projectlessRootPaths: projectlessChatRootPaths
        )
        debugSidebarLog(
            "rebuildGroupedThreads durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "queryLength=\(query.count) sourceCount=\(source.count) groupCount=\(groupedThreads.count)"
        )
    }

    private func groupingFingerprint(query: String, source: [CodexThread]) -> Int {
        var hasher = Hasher()
        hasher.combine(query)
        hasher.combine(codex.pinnedThreadIDs)
        hasher.combine(projectlessChatRootPaths)
        for thread in source {
            hasher.combine(thread)
        }
        return hasher.finalize()
    }

    // Cheap fingerprint: hashes thread IDs + message revisions (O(n) integer work, no message access).
    private var diffFingerprint: Int {
        var hasher = Hasher()
        let hasRunningTurn = codex.hasAnyRunningTurn
        hasher.combine(hasRunningTurn)
        guard !hasRunningTurn else {
            return hasher.finalize()
        }
        for thread in codex.threads {
            hasher.combine(thread.id)
            hasher.combine(codex.messageRevision(for: thread.id))
        }
        return hasher.finalize()
    }

    // Cheap fingerprint for run badge state — changes when running/ready/failed sets change.
    private var badgeFingerprint: Int {
        var hasher = Hasher()
        for thread in codex.threads {
            hasher.combine(thread.id)
            if let badge = codex.threadRunBadgeState(for: thread.id) {
                hasher.combine(badge)
            }
        }
        return hasher.finalize()
    }

    private func rebuildCachedSidebarState() {
        let startedAt = Date()
        rebuildCachedDiffTotals()
        rebuildCachedRunBadges()
        debugSidebarLog(
            "rebuildCachedSidebarState durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "diffTotals=\(cachedDiffTotals.count) runBadges=\(cachedRunBadges.count)"
        )
    }

    private func rebuildCachedDiffTotals() {
        let fp = diffFingerprint
        guard fp != lastDiffFingerprint else { return }
        // Keep streaming smooth: diff totals are sidebar-only and can wait until active runs settle.
        guard !codex.hasAnyRunningTurn else {
            debugSidebarLog("rebuildCachedDiffTotals skipped runningTurn=true")
            return
        }
        let startedAt = Date()
        lastDiffFingerprint = fp

        let currentThreadIDs = Set(codex.threads.map(\.id))
        cachedDiffTotals = cachedDiffTotals.filter { currentThreadIDs.contains($0.key) }
        cachedDiffRevisionByThreadID = cachedDiffRevisionByThreadID.filter { currentThreadIDs.contains($0.key) }

        for thread in codex.threads {
            let revision = codex.messageRevision(for: thread.id)
            guard cachedDiffRevisionByThreadID[thread.id] != revision else { continue }

            let messages = codex.messages(for: thread.id)
            cachedDiffTotals[thread.id] = TurnSessionDiffSummaryCalculator.totals(
                from: messages,
                scope: .unpushedSession
            )
            cachedDiffRevisionByThreadID[thread.id] = revision
        }
        debugSidebarLog(
            "rebuildCachedDiffTotals durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "threadCount=\(codex.threads.count) cached=\(cachedDiffTotals.count)"
        )
    }

    private func rebuildCachedRunBadges() {
        let fp = badgeFingerprint
        guard fp != lastBadgeFingerprint else { return }
        let startedAt = Date()
        lastBadgeFingerprint = fp

        var byThreadID: [String: CodexThreadRunBadgeState] = [:]
        for thread in codex.threads {
            if let state = codex.threadRunBadgeState(for: thread.id) {
                byThreadID[thread.id] = state
            }
        }
        cachedRunBadges = byThreadID
        debugSidebarLog(
            "rebuildCachedRunBadges durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "threadCount=\(codex.threads.count) cached=\(cachedRunBadges.count)"
        )
    }

    // Keeps the chooser in sync with the same project buckets shown in the sidebar.
    private var newChatProjectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(
            from: codex.threads,
            projectlessRootPaths: projectlessChatRootPaths
        )
    }

    private func refreshProjectlessChatRoots() async {
        guard codex.isConnected, codex.isInitialized else { return }
        do {
            let roots = try await codex.fetchProjectlessChatRoots().roots
            if roots != projectlessChatRootPaths {
                projectlessChatRootPaths = roots
                lastGroupedThreadsFingerprint = 0
                rebuildGroupedThreads()
            }
        } catch {
            debugSidebarLog("projectless roots refresh failed: \(error.localizedDescription)")
        }
    }

    private var canCreateThread: Bool {
        codex.isConnected && codex.isInitialized
    }

    // Sidebar refresh and search events can fire during gestures; logs must not mutate view state.
    private func debugSidebarLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isSidebarDebugLoggingEnabled else { return }
        print("[SidebarData] \(message())")
        #endif
    }
}

private extension SidebarView {
    static var isSidebarDebugLoggingEnabled: Bool { false }
}

private enum SidebarPresentedSheet: String, Identifiable {
    case newChatProjectPicker
    case localFolderBrowser

    var id: String { rawValue }
}

private extension SidebarView {
    @ViewBuilder
    func sidebarSheetContent(_ sheet: SidebarPresentedSheet) -> some View {
        switch sheet {
        case .newChatProjectPicker:
            SidebarNewChatProjectPickerSheet(
                choices: newChatProjectChoices,
                onSelectProject: { projectPath in
                    activeSidebarSheet = nil
                    handleNewChatTap(preferredProjectPath: projectPath)
                },
                onSelectWorktreeProject: { projectPath in
                    activeSidebarSheet = nil
                    handleNewWorktreeChatTap(preferredProjectPath: projectPath)
                },
                onSelectWithoutProject: {
                    activeSidebarSheet = nil
                    handleNewChatTap(preferredProjectPath: nil)
                },
                onBrowseLocalFolder: {
                    presentLocalFolderBrowser()
                }
            )
        case .localFolderBrowser:
            SidebarLocalFolderBrowserSheet { projectPath in
                activeSidebarSheet = nil
                handleNewChatTap(preferredProjectPath: projectPath)
            }
        }
    }
}

enum SidebarThreadsLoadingPresentation {
    // Keeps pull-to-refresh from stacking a second spinner over an already populated sidebar.
    static func shouldShowOverlay(isLoadingThreads: Bool, threadCount: Int) -> Bool {
        isLoadingThreads && threadCount == 0
    }
}

// SidebarNewChatProjectPickerSheet lives in SidebarNewChatProjectPickerSheet.swift
// so it can carry its own SwiftUI #Preview without dragging in the rest of the sidebar.
