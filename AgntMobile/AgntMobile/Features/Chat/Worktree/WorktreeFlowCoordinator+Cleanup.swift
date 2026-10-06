import Foundation

extension WorktreeFlowCoordinator {
    @MainActor
    static func removeManagedWorktree(at path: String, branch: String?, codex: CodexService) async throws {
        let root = URL(fileURLWithPath: path).standardizedFileURL.path
        let inUse = codex.threads.contains { thread in
            guard let cwd = thread.cwd else { return false }
            let folder = URL(fileURLWithPath: cwd).standardizedFileURL.path
            return folder == root || folder.hasPrefix(root + "/")
        }
        guard !inUse else {
            throw GitActionsError.bridgeError(code: "worktree_in_use", message: "A chat still uses this worktree. Move it to the local checkout before removal.")
        }
        let service = GitActionsService(codex: codex, workingDirectory: root)
        try await service.removeManagedWorktreeSafely(branch: branch)
    }
}
