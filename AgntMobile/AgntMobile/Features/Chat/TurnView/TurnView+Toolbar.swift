import SwiftUI

extension TurnView {
    @ToolbarContentBuilder
    func turnToolbarContent(
        resolvedThread: CodexThread,
        toolbarNavigationContext: TurnThreadNavigationContext?,
        isHandingOffToMac: Bool,
        isStartingSiblingChat: Bool,
        canHandOffToWorktree: Bool,
        toolbarWorktreeHandoffTitle: String,
        isGitActionEnabled: Bool,
        disabledGitActions: Set<TurnGitActionKind>,
        showsGitControls: Bool,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?,
        onTapMacHandoff: (() -> Void)?,
        onTapWorktreeHandoff: (() -> Void)?,
        onTapNewChat: (() -> Void)?,
        onTapRepoDiff: (() -> Void)?
    ) -> some ToolbarContent {
        TurnToolbarContent(
            displayTitle: resolvedThread.displayTitle,
            navigationContext: toolbarNavigationContext,
            showsThreadActions: codex.isConnected,
            isHandingOffToMac: isHandingOffToMac,
            isStartingNewChat: isStartingSiblingChat,
            canHandOffToWorktree: canHandOffToWorktree,
            worktreeHandoffTitle: toolbarWorktreeHandoffTitle,
            isCreatingGitWorktree: viewModel.isCreatingGitWorktree,
            repoDiffTotals: viewModel.gitRepoSync?.repoDiffTotals,
            isLoadingRepoDiff: isLoadingRepositoryDiff,
            showsGitActions: showsGitControls,
            isGitActionEnabled: isGitActionEnabled,
            disabledGitActions: disabledGitActions,
            isRunningGitAction: viewModel.isRunningGitAction,
            gitActionLoadingTitle: viewModel.gitActionLoadingTitle,
            showsDiscardRuntimeChangesAndSync: viewModel.shouldShowDiscardRuntimeChangesAndSync,
            gitSyncState: viewModel.gitSyncState,
            onTapMacHandoff: onTapMacHandoff,
            onTapWorktreeHandoff: onTapWorktreeHandoff,
            onTapNewChat: onTapNewChat,
            onTapTerminal: onOpenTerminal == nil ? nil : {
                onOpenTerminal?(gitWorkingDirectory)
            },
            onTapRepoDiff: onTapRepoDiff,
            onGitAction: { action in
                handleGitActionSelection(
                    action,
                    isThreadRunning: isThreadRunning,
                    gitWorkingDirectory: gitWorkingDirectory
                )
            },
            isShowingPathSheet: $isShowingThreadPathSheet
        )
    }
}
