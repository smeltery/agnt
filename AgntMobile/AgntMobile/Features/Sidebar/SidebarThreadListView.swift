// FILE: SidebarThreadListView.swift
// Purpose: Renders sidebar thread groups and empty states.
// Layer: View Component
// Exports: SidebarThreadListView

import SwiftUI

struct SidebarThreadListView: View {
    var showsActivity = false
    var isVisible = true
    var activityRefreshGeneration = 0
    var isFiltering: Bool = false
    let isConnected: Bool
    let isCreatingThread: Bool
    let threads: [CodexThread]
    let groups: [SidebarThreadGroup]
    let selectedThread: CodexThread?
    let bottomContentInset: CGFloat
    let timingLabelProvider: (CodexThread) -> String?
    let diffTotalsByThreadID: [String: TurnSessionDiffTotals]
    let runBadgeStateByThreadID: [String: CodexThreadRunBadgeState]
    let onSelectThread: (CodexThread) -> Void
    let onCreateThreadInProjectGroup: (SidebarThreadGroup) -> Void
    var onArchiveProjectGroup: ((SidebarThreadGroup) -> Void)? = nil
    var onManageProjectWorktrees: ((SidebarThreadGroup) -> Void)? = nil
    var onDeleteProjectGroup: ((SidebarThreadGroup) -> Void)? = nil
    var onRenameThread: ((CodexThread, String) -> Void)? = nil
    var onPinToggleThread: ((CodexThread) -> Void)? = nil
    var onArchiveToggleThread: ((CodexThread) -> Void)? = nil
    var onDeleteThread: ((CodexThread) -> Void)? = nil
    @Environment(CodexService.self) var codex
    @AppStorage(SidebarProjectExpansionState.collapsedProjectGroupIDsStorageKey) private var collapsedProjectGroupIDsStorage = ""
    @State var expandedProjectGroupIDs: Set<String> = []
    @State private var knownProjectGroupIDs: Set<String> = []
    @State private var hasInitializedProjectGroupExpansion = false
    @State var isArchivedExpanded = false
    @State var expandedSubagentParentIDs: Set<String> = []
    // Tracks project sections whose preview cap was manually lifted with Show more.
    @State var revealedProjectGroupIDs: Set<String> = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {

                if threads.isEmpty && !isFiltering {
                    Text(isConnected ? "No conversations" : "Connect to view conversations")
                        .foregroundStyle(.secondary)
                        .font(AppFont.subheadline())
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                } else if groups.flatMap(\.threads).isEmpty && isFiltering {
                    Text("No matching conversations")
                        .foregroundStyle(.secondary)
                        .font(AppFont.subheadline())
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                } else if showsActivity {
                    SidebarActivityListView(
                        threads: activityThreads, isVisible: isVisible,
                        refreshGeneration: activityRefreshGeneration
                    ) { thread, totals in
                        threadRow(thread, activityDiffTotals: totals)
                    }
                } else {
                    ForEach(groups) { group in
                        groupSection(group)
                    }
                }
            }
            // Keeps the last rows reachable above the floating settings control.
            .padding(.bottom, bottomContentInset)
        }
        .scrollDismissesKeyboard(.interactively)
        .task(id: visibleSubagentThreadIDs) {
            await codex.loadSubagentThreadMetadataIfNeeded(threadIds: visibleSubagentThreadIDs)
        }
        .onAppear {
            syncExpandedProjectGroupState()
            syncRevealedProjectGroupState()
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
        .onChange(of: groups.map(\.id)) { _, _ in
            syncExpandedProjectGroupState()
            syncRevealedProjectGroupState()
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
        .onChange(of: collapsedProjectGroupIDsStorage) { _, _ in
            withAnimation(.snappy(duration: 0.22)) {
                applyPersistedProjectGroupExpansionState()
            }
        }
        .onChange(of: selectedThread?.id) { _, _ in
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
        .onChange(of: selectedSubagentAncestorIDs) { _, _ in
            revealSelectedThreadProjectGroup()
            revealSelectedSubagentAncestors()
        }
    }

    private var activityThreads: [CodexThread] {
        // Groups already apply the current search; flatten once to retain global
        // project coverage without duplicating pinned threads.
        var seen: Set<String> = []
        return groups.flatMap(\.threads).filter { seen.insert($0.id).inserted && $0.syncState != .archivedLocal }
    }

    @ViewBuilder
    private func groupSection(_ group: SidebarThreadGroup) -> some View {
        switch group.kind {
        case .pinned:
            pinnedGroupSection(group)
        case .project:
            projectGroupSection(group)
        case .chat:
            chatGroupSection(group)
        case .archived:
            archivedGroupSection(group)
        }
    }

    private func pinnedGroupSection(_ group: SidebarThreadGroup) -> some View {
        let hierarchy = SidebarSubagentHierarchy(groupThreads: group.threads)

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "pin")
                    .font(AppFont.body(weight: .medium))
                    .foregroundStyle(.primary)
                Text(group.label)
                    .font(AppFont.body(weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 10)

            VStack(spacing: 4) {
                ForEach(hierarchy.rootThreads) { thread in
                    threadRowTree(
                        thread,
                        childrenByParentID: hierarchy.childrenByParentID,
                        pinnedRootThreadIDs: Set(hierarchy.rootThreads.map(\.id))
                    )
                }
            }
            .padding(.bottom, 10)
        }
    }

    // Rootless "quick" chats render as a flat tree (subagents still nest) with no
    // project header or project-scoped archive/delete affordances.
    private func chatGroupSection(_ group: SidebarThreadGroup) -> some View {
        let hierarchy = SidebarSubagentHierarchy(groupThreads: group.threads)

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: group.iconSystemName)
                    .font(AppFont.body(weight: .medium))
                    .foregroundStyle(.primary)
                Text(group.label)
                    .font(AppFont.body(weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 10)

            VStack(spacing: 4) {
                ForEach(hierarchy.rootThreads) { thread in
                    threadRowTree(
                        thread,
                        childrenByParentID: hierarchy.childrenByParentID
                    )
                }
            }
            .padding(.bottom, 10)
        }
    }

    private func projectGroupSection(_ group: SidebarThreadGroup) -> some View {
        let hierarchy = SidebarSubagentHierarchy(groupThreads: group.threads)
        let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
            for: group,
            selectedThread: selectedThread,
            isFiltering: isFiltering,
            manuallyExpandedGroupIDs: revealedProjectGroupIDs
        )
        let shouldShowMoreButton = SidebarProjectThreadPreviewState.shouldShowMoreButton(
            for: group,
            selectedThread: selectedThread,
            isFiltering: isFiltering,
            manuallyExpandedGroupIDs: revealedProjectGroupIDs
        )

        return VStack(alignment: .leading, spacing: 0) {
            projectHeader(group)

            if expandedProjectGroupIDs.contains(group.id) {
                VStack(spacing: 2) {
                    ForEach(visibleRootThreads) { thread in
                        threadRowTree(
                            thread,
                            childrenByParentID: hierarchy.childrenByParentID
                        )
                    }

                    if shouldShowMoreButton {
                        let totalRootCount = SidebarProjectThreadPreviewState.rootThreads(in: group.threads).count
                        let hiddenCount = totalRootCount - visibleRootThreads.count
                        projectGroupShowMoreButton(group, hiddenCount: hiddenCount)
                    }
                }
                .padding(.leading, -8)
                .padding(.bottom, 14)
                .transition(.opacity)
            }
        }
    }

    @State private var showMoreChevronRotated = false

    private func projectGroupShowMoreButton(_ group: SidebarThreadGroup, hiddenCount: Int) -> some View {
        HStack {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                withAnimation(.easeInOut(duration: 0.2)) {
                    showMoreChevronRotated = true
                    revealedProjectGroupIDs.insert(group.id)
                }
            } label: {
                HStack(spacing: 6) {
                    Text(hiddenCount > 0 ? "Show \(hiddenCount) more" : "Show more")
                    Image(systemName: "chevron.down")
                        .font(AppFont.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(showMoreChevronRotated ? 180 : 0))
                }
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.leading, 48)
        .padding(.top, 6)
        .onAppear { showMoreChevronRotated = false }
    }

    private func projectHeader(_ group: SidebarThreadGroup) -> some View {
        let isExpanded = expandedProjectGroupIDs.contains(group.id)

        return HStack(spacing: 12) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                toggleProjectGroupExpansion(group.id)
            } label: {
                HStack(spacing: 8) {
                    if group.iconSystemName == "arrow.triangle.branch" {
                        CodexWorktreeIcon(pointSize: 16, weight: .medium)
                            .foregroundStyle(.primary)
                    } else {
                        Image(systemName: group.iconSystemName)
                            .font(AppFont.body(weight: .medium))
                            .foregroundStyle(.primary)
                    }
                    Text(group.label)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                if group.kind == .project, group.iconSystemName != "arrow.triangle.branch",
                   let onManageProjectWorktrees {
                    Button { onManageProjectWorktrees(group) } label: {
                        Label("Manage Worktrees", systemImage: "square.stack.3d.up")
                    }
                }
                if let onArchiveProjectGroup {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onArchiveProjectGroup(group)
                    } label: {
                        Label("Archive Project", systemImage: "archivebox")
                    }
                }

                if let onDeleteProjectGroup {
                    Button(role: .destructive) {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onDeleteProjectGroup(group)
                    } label: {
                        Label("Remove from Phone", systemImage: "trash")
                    }
                }
            }

            HStack(spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, height: 14)
                    .animation(.easeInOut(duration: 0.2), value: isExpanded)

                Button {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onCreateThreadInProjectGroup(group)
                } label: {
                    Image(systemName: "plus")
                        .font(AppFont.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 30, height: 30)
                        .background(Color.primary.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!isConnected || isCreatingThread)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private func archivedGroupSection(_ group: SidebarThreadGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                withAnimation(.easeInOut(duration: 0.2)) {
                    isArchivedExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "archivebox")
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                    Text(group.label)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isArchivedExpanded ? 90 : 0))
                        .animation(.easeInOut(duration: 0.2), value: isArchivedExpanded)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 10)

            if isArchivedExpanded {
                VStack(spacing: 4) {
                    ForEach(group.threads) { thread in
                        threadRow(thread)
                    }
                }
                .padding(.bottom, 14)
                .transition(.opacity)
            }
        }
    }

    func collectVisibleSubagentThreadIDs(
        from thread: CodexThread,
        childrenByParentID: [String: [CodexThread]],
        ancestorThreadIDs: Set<String>,
        into visibleThreadIDs: inout [String]
    ) {
        if thread.isSubagent {
            visibleThreadIDs.append(thread.id)
        }

        guard expandedSubagentParentIDs.contains(thread.id) else {
            return
        }

        let nextAncestorThreadIDs = ancestorThreadIDs.union([thread.id])
        for childThread in childrenByParentID[thread.id] ?? [] {
            guard !nextAncestorThreadIDs.contains(childThread.id) else { continue }
            collectVisibleSubagentThreadIDs(
                from: childThread,
                childrenByParentID: childrenByParentID,
                ancestorThreadIDs: nextAncestorThreadIDs,
                into: &visibleThreadIDs
            )
        }
    }

    private func toggleProjectGroupExpansion(_ groupID: String) {
        var persistedCollapsedGroupIDs = SidebarProjectExpansionState.decodePersistedGroupIDs(
            collapsedProjectGroupIDsStorage
        )
        if expandedProjectGroupIDs.contains(groupID) {
            expandedProjectGroupIDs.remove(groupID)
            revealedProjectGroupIDs.remove(groupID)
            persistedCollapsedGroupIDs.insert(groupID)
        } else {
            expandedProjectGroupIDs.insert(groupID)
            persistedCollapsedGroupIDs.remove(groupID)
        }
        collapsedProjectGroupIDsStorage = SidebarProjectExpansionState.encodePersistedGroupIDs(
            persistedCollapsedGroupIDs
        )
    }

    // Keep project sections expanded after regrouping so live updates do not collapse the sidebar.
    private func syncExpandedProjectGroupState() {
        let nextState = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: expandedProjectGroupIDs,
            knownGroupIDs: knownProjectGroupIDs,
            visibleGroups: groups,
            hasInitialized: hasInitializedProjectGroupExpansion,
            persistedCollapsedGroupIDs: SidebarProjectExpansionState.decodePersistedGroupIDs(
                collapsedProjectGroupIDsStorage
            )
        )
        expandedProjectGroupIDs = nextState.expandedGroupIDs
        knownProjectGroupIDs = nextState.knownGroupIDs
        hasInitializedProjectGroupExpansion = true
    }

    // Applies bulk changes from the chip-row control immediately; regular sync
    // preserves in-memory folds, while this treats AppStorage as the source of truth.
    private func applyPersistedProjectGroupExpansionState() {
        let visibleProjectGroupIDs = SidebarProjectExpansionState.projectGroupIDs(in: groups)
        let persistedCollapsedGroupIDs = SidebarProjectExpansionState.decodePersistedGroupIDs(
            collapsedProjectGroupIDsStorage
        )

        expandedProjectGroupIDs = visibleProjectGroupIDs.subtracting(persistedCollapsedGroupIDs)
        knownProjectGroupIDs = visibleProjectGroupIDs
        hasInitializedProjectGroupExpansion = true
        revealedProjectGroupIDs = revealedProjectGroupIDs.intersection(expandedProjectGroupIDs)
    }

    // Keeps Show more expansion state only for project groups that still exist on screen.
    private func syncRevealedProjectGroupState() {
        let visibleProjectGroupIDs = SidebarProjectExpansionState.projectGroupIDs(in: groups)
        revealedProjectGroupIDs = revealedProjectGroupIDs.intersection(visibleProjectGroupIDs)
    }

    // Keeps an externally selected thread visible without re-opening unrelated project groups.
    private func revealSelectedThreadProjectGroup() {
        if let selectedGroupID = SidebarProjectExpansionState.groupIDContainingSelectedThread(
            selectedThread,
            in: groups
        ),
           SidebarProjectExpansionState.shouldAutoRevealSelectedGroup(
               selectedGroupID,
               persistedCollapsedGroupIDs: SidebarProjectExpansionState.decodePersistedGroupIDs(
                   collapsedProjectGroupIDsStorage
               )
        ) {
            expandedProjectGroupIDs.insert(selectedGroupID)
        }
    }

    func toggleSubagentExpansion(parentThreadID: String) {
        if expandedSubagentParentIDs.contains(parentThreadID) {
            expandedSubagentParentIDs.remove(parentThreadID)
        } else {
            expandedSubagentParentIDs.insert(parentThreadID)
        }
    }

    // Expands every visible ancestor so a selected child thread is never hidden in the tree.
    private func revealSelectedSubagentAncestors() {
        guard let selectedThread else { return }
        expandedSubagentParentIDs.formUnion(subagentAncestorIDs(for: selectedThread))
    }

    func subagentAncestorIDs(for thread: CodexThread) -> Set<String> {
        let threadsByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        var ancestorIDs: Set<String> = []
        var currentParentID = thread.parentThreadId

        while let parentID = currentParentID, !ancestorIDs.contains(parentID) {
            ancestorIDs.insert(parentID)
            currentParentID = threadsByID[parentID]?.parentThreadId
        }

        return ancestorIDs
    }
}
