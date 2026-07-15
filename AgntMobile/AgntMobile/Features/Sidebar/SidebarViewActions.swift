// FILE: SidebarViewActions.swift
// Purpose: Handles sidebar actions, grouping/cache rebuilds, and sheet routing.
// Layer: View Support
// Exports: SidebarView action helpers

import SwiftUI

extension SidebarView {
    func refreshThreads() async {
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
    func handleNewChatButtonTap() {
        prepareSidebarForChatNavigation()
        onOpenNewChatDraft(.generalChat, defaultNewChatProjectPath)
    }

    // Quick Chat skips the picker and opens an unscoped draft so the user can
    // start typing without committing to a project up front.
    func handleQuickChatTap() {
        prepareSidebarForChatNavigation()
        onOpenNewChatDraft(.generalChat, nil)
    }

    var defaultNewChatProjectPath: String? {
        newChatProjectChoices.first?.projectPath
    }

    // Opens the local folder browser so the user can register a new project root.
    func handleNewProjectTap() {
        presentLocalFolderBrowser()
    }

    func presentLocalFolderBrowser() {
        activeSidebarSheet = .localFolderBrowser
    }

    func handleNewChatTap(preferredProjectPath: String?) {
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

    func handleNewWorktreeChatTap(preferredProjectPath: String) {
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

    func selectThread(_ thread: CodexThread) {
        debugSidebarLog("selectThread id=\(thread.id) title=\(thread.displayTitle)")
        prepareSidebarForChatNavigation()
        onOpenThread(thread)
    }

    func openSettings() {
        searchText = ""
        isSearchActive = false
        showSettings = true
        onClose()
    }

    func openTerminal() {
        searchText = ""
        isSearchActive = false
        onOpenTerminal()
        onClose()
    }

    func openMyMacs() {
        searchText = ""
        isSearchActive = false
        onOpenMyMacs()
        onClose()
    }

    // Quick-switch from the sidebar switcher closes the drawer so the switch overlay reads cleanly.
    func handleSwitcherSelectDevice(_ deviceId: String) {
        searchText = ""
        isSearchActive = false
        onClose()
        onSwitchTrustedMac(deviceId)
    }

    func openDevicesSettings() {
        activeSidebarSheet = .devicesSettings
    }

    // Clears sidebar-only input state before navigation so full-width search mode cannot hold the drawer open.
    func prepareSidebarForChatNavigation() {
        searchText = ""
        isSearchActive = false
        onClose()
    }

    // Archives every live chat in the selected project group and clears the current selection if needed.
    func archivePendingProjectGroup() {
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
    func deletePendingProjectGroupLocally() {
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
    func rebuildGroupedThreads() {
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
            scope: groupingScope,
            projectlessRootPaths: projectlessChatRootPaths
        )
        debugSidebarLog(
            "rebuildGroupedThreads durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "queryLength=\(query.count) sourceCount=\(source.count) groupCount=\(groupedThreads.count)"
        )
    }

    func groupingFingerprint(query: String, source: [CodexThread]) -> Int {
        var hasher = Hasher()
        hasher.combine(query)
        hasher.combine(contentScopeRawValue)
        hasher.combine(codex.pinnedThreadIDs)
        hasher.combine(projectlessChatRootPaths)
        for thread in source {
            hasher.combine(thread)
        }
        return hasher.finalize()
    }

    // Cheap fingerprint: hashes thread IDs + message revisions (O(n) integer work, no message access).
    var diffFingerprint: Int {
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
    var badgeFingerprint: Int {
        var hasher = Hasher()
        for thread in codex.threads {
            hasher.combine(thread.id)
            if let badge = codex.threadRunBadgeState(for: thread.id) {
                hasher.combine(badge)
            }
        }
        return hasher.finalize()
    }

    func rebuildCachedSidebarState() {
        let startedAt = Date()
        rebuildCachedDiffTotals()
        rebuildCachedRunBadges()
        debugSidebarLog(
            "rebuildCachedSidebarState durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "diffTotals=\(cachedDiffTotals.count) runBadges=\(cachedRunBadges.count)"
        )
    }

    func rebuildCachedDiffTotals() {
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

    func rebuildCachedRunBadges() {
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
    var newChatProjectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(
            from: codex.threads,
            projectlessRootPaths: projectlessChatRootPaths
        )
    }

    func refreshProjectlessChatRoots() async {
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

    var canCreateThread: Bool {
        codex.isConnected && codex.isInitialized
    }

    // Sidebar refresh and search events can fire during gestures; logs must not mutate view state.
    func debugSidebarLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isSidebarDebugLoggingEnabled else { return }
        print("[SidebarData] \(message())")
        #endif
    }
}

extension SidebarView {
    static var isSidebarDebugLoggingEnabled: Bool { false }
}

enum SidebarPresentedSheet: String, Identifiable {
    case newChatProjectPicker
    case localFolderBrowser
    case devicesSettings

    var id: String { rawValue }
}

extension SidebarView {
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
        case .devicesSettings:
            MyDevicesSettingsSheet(
                isSwitchingMac: isSwitchingMac,
                switchingDeviceId: switchingMacDeviceId,
                switchNotice: macSwitchNotice,
                onSelectDevice: { deviceId in
                    activeSidebarSheet = nil
                    onSwitchTrustedMac(deviceId)
                },
                onForgetDevice: { deviceId in
                    onForgetTrustedMac(deviceId)
                },
                onAddConnection: {
                    activeSidebarSheet = nil
                    onScanTrustedMac()
                },
                onCancelSwitch: {
                    onCancelMacSwitch()
                }
            )
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
