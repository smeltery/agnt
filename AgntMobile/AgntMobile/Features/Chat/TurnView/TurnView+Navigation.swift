import SwiftUI

extension TurnView {
    // Re-resolves the active thread so handoff/reconnect UI always uses the freshest cwd + title.
    var currentResolvedThread: CodexThread {
        codex.thread(for: thread.id) ?? thread
    }

    // Keep top-bar Git visibility tied to the active repo, not to background thread-list refreshes.
    func repoGitControlsVisible(
        for resolvedThread: CodexThread,
        gitWorkingDirectory: String?
    ) -> Bool {
        CodexThread.gitControlsVisible(
            for: resolvedThread,
            workingDirectory: gitWorkingDirectory,
            isConnected: codex.isConnected
        )
    }
    var parentThread: CodexThread? {
        guard let parentThreadId = thread.parentThreadId else {
            return nil
        }

        return codex.thread(for: parentThreadId)
    }

    func threadNavigationContext(for thread: CodexThread) -> TurnThreadNavigationContext? {
        guard let path = thread.gitWorkingDirectory,
              !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let fullPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let folderName = fullPath.pathDisplayName
        return TurnThreadNavigationContext(
            folderName: folderName,
            subtitle: fullPath,
            fullPath: fullPath
        )
    }
    func openThread(_ threadId: String) {
        codex.activeThreadId = threadId
        codex.markThreadAsViewed(threadId)
        codex.requestImmediateActiveThreadSync(threadId: threadId)
    }

    // MARK: - Empty State

    var loadingState: some View {
        ChatEmptyStatePlaceholder(
            title: Text("Loading chat..."),
            subtitle: "Fetching the latest messages for this conversation."
        )
    }

    func resolvedEmptyState(for phase: CodexService.ThreadDisplayPhase) -> AnyView {
        switch phase {
        case .loading:
            return AnyView(loadingState)
        case .empty, .ready:
            return AnyView(emptyState)
        }
    }

    var emptyState: some View {
        ChatEmptyStatePlaceholder(
            title: ChatEmptyStateTitleBuilder.makeTitle(for: emptyStateFolderName),
            subtitle: "Chats are End-to-end encrypted"
        )
    }

    var emptyStateFolderName: String? {
        guard let cwd = currentResolvedThread.gitWorkingDirectory else { return nil }
        let display = cwd.pathDisplayName
        // Defensive: pathDisplayName falls back to the input, so only nil out
        // when there's no usable folder portion at all (empty cwd after split).
        return display.isEmpty ? nil : display
    }
}
