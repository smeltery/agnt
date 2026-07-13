// FILE: TurnComposerSecondaryBar.swift
// Purpose: Owns the compact context controls shown above the main input card.
// Layer: View Component
// Exports: TurnComposerSecondaryBar
// Depends on: SwiftUI, UIKit, TurnGitBranchSelector, CodexWorktreeIcon, PlanAccessoryCard, QueuedStatusCapsule

import SwiftUI
import UIKit

struct TurnComposerSecondaryBar: View {
    let isInputFocused: Bool
    let isEmptyThread: Bool
    let hasWorkingDirectory: Bool
    let isWorktreeProject: Bool
    var activeFileChangeStatus: FileChangeStatusSnapshot? = nil
    var threadGoal: CodexThreadGoal? = nil
    var isThreadRunning = false
    var onResumeGoal: () -> Void = {}
    var onPauseGoal: () -> Void = {}
    var onRemoveGoal: () -> Void = {}
    var queuedDraftCount: Int = 0
    var onTapQueuedDrafts: () -> Void = {}

    let showsGitBranchSelector: Bool
    let isGitBranchSelectorEnabled: Bool
    let availableGitBranchTargets: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedGitBaseBranch: String
    let currentGitBranch: String
    let gitDefaultBranch: String
    let isLoadingGitBranchTargets: Bool
    let isSwitchingGitBranch: Bool
    let isCreatingGitWorktree: Bool

    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onSelectGitBaseBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void
    let canHandOffToWorktree: Bool
    let onTapCreateWorktree: () -> Void

    @Environment(\.pinnedPlanAccessory) private var pinnedPlanAccessory

    private let branchLabelColor = Color(.secondaryLabel)
    private var branchTextFont: Font { AppFont.footnote() }
    private var branchChevronFont: Font { AppFont.system(size: 9, weight: .regular) }
    private var hasContextContent: Bool {
        hasWorkingDirectory || threadGoal != nil || pinnedPlanAccessory != nil || queuedDraftCount > 0
    }

    private var runtimeLabelTitle: String {
        if !hasWorkingDirectory {
            return "Quick Chat"
        }
        return isWorktreeProject ? "Worktree" : "Local"
    }

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        if !isInputFocused, hasContextContent || activeFileChangeStatus != nil {
            VStack(spacing: 8) {
                if let activeFileChangeStatus {
                    FileChangeStatusCapsule(snapshot: activeFileChangeStatus)
                        .transition(.opacity.combined(with: .scale(scale: 0.94)))
                }

                if hasContextContent {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            if hasWorkingDirectory {
                                runtimePicker

                                if showsGitBranchSelector {
                                    TurnGitBranchSelector(
                                        isEnabled: isGitBranchSelectorEnabled,
                                        availableGitBranchTargets: availableGitBranchTargets,
                                        gitBranchesCheckedOutElsewhere: gitBranchesCheckedOutElsewhere,
                                        gitWorktreePathsByBranch: gitWorktreePathsByBranch,
                                        selectedGitBaseBranch: selectedGitBaseBranch,
                                        currentGitBranch: currentGitBranch,
                                        defaultBranch: gitDefaultBranch,
                                        isLoadingGitBranchTargets: isLoadingGitBranchTargets,
                                        isSwitchingGitBranch: isSwitchingGitBranch,
                                        onSelectGitBranch: onSelectGitBranch,
                                        onCreateGitBranch: onCreateGitBranch,
                                        onSelectGitBaseBranch: onSelectGitBaseBranch,
                                        onRefreshGitBranches: onRefreshGitBranches
                                    )
                                    .equatable()
                                }
                            }

                            if let pinnedPlanAccessory {
                                PlanAccessoryCard(
                                    snapshot: pinnedPlanAccessory.snapshot,
                                    onTap: pinnedPlanAccessory.onTap
                                )
                                .transition(.opacity.combined(with: .scale(scale: 0.94)))
                            }

                            if let threadGoal {
                                GoalStatusChip(
                                    goal: threadGoal,
                                    isThreadRunning: isThreadRunning,
                                    onResume: onResumeGoal,
                                    onPause: onPauseGoal,
                                    onRemove: onRemoveGoal
                                )
                                .transition(.opacity.combined(with: .scale(scale: 0.94)))
                            }

                            if queuedDraftCount > 0 {
                                QueuedStatusCapsule(count: queuedDraftCount, onTap: onTapQueuedDrafts)
                                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
                            }
                        }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .scrollClipDisabled()
                }
            }
            .frame(maxWidth: .infinity)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(.spring(response: 0.28, dampingFraction: 0.88), value: activeFileChangeStatus)
            .animation(.spring(response: 0.28, dampingFraction: 0.88), value: threadGoal != nil)
            .animation(.spring(response: 0.28, dampingFraction: 0.88), value: queuedDraftCount > 0)
        }
    }

    // ─── Menus ───────────────────────────────────────────────────

    private var runtimePicker: some View {
        Menu {
            Section("Continue in") {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    if let url = URL(string: "https://chatgpt.com/codex") {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Cloud", systemImage: "cloud")
                }

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTapCreateWorktree()
                } label: {
                    CodexWorktreeMenuLabelRow(
                        title: isCreatingGitWorktree
                            ? "Preparing worktree..."
                            : isWorktreeProject ? "Hand off to Local" : isEmptyThread ? "New worktree" : "Hand off to Worktree",
                        pointSize: 12,
                        weight: .regular
                    )
                }
                .disabled(!canHandOffToWorktree || isCreatingGitWorktree || isSwitchingGitBranch)

                Button {
                    // Returning to Local is intentionally disabled until it can move code + branch safely.
                } label: {
                    TurnComposerRuntimeMenuRow(title: "Local") {
                        Image(systemName: "laptopcomputer")
                    }
                }
                .disabled(true)
            }
        } label: {
            HStack(spacing: 6) {
                if !hasWorkingDirectory {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(branchTextFont)
                } else if isWorktreeProject {
                    CodexWorktreeIcon(pointSize: 12, weight: .regular)
                } else {
                    Image(systemName: "laptopcomputer")
                        .font(branchTextFont)
                }

                Text(runtimeLabelTitle)
                    .font(branchTextFont)
                    .fontWeight(.regular)
                    .lineLimit(1)

                Image(systemName: "chevron.down")
                    .font(branchChevronFont)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .adaptiveGlass(.regular, in: Capsule())
            .foregroundStyle(branchLabelColor)
            .contentShape(Capsule())
        }
        .tint(branchLabelColor)
    }
}

private struct TurnComposerRuntimeMenuRow<Icon: View>: View {
    let title: String
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(spacing: 10) {
            icon()
                .frame(width: 16, height: 16)

            Text(title)
        }
    }
}
