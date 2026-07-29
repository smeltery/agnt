// FILE: WorktreeFlowCoordinator.swift
// Purpose: Centralizes Local/Worktree chat start, handoff, and fork flows behind one domain coordinator.
// Layer: Service Coordination
// Exports: WorktreeFlowCoordinator, WorktreeFlowHandoffMove, WorktreeFlowHandoffOutcome
// Depends on: Foundation, CodexService, GitActionsService

import Foundation

struct WorktreeFlowHandoffMove: Sendable {
    let thread: CodexThread
    let projectPath: String
    let transferredChanges: Bool
    let createdManagedWorktree: Bool
}

enum WorktreeFlowHandoffOutcome: Sendable {
    case moved(WorktreeFlowHandoffMove)
    case missingAssociatedWorktree
}

enum WorktreeFlowCoordinator {
    // Input: optional Local checkout path chosen by the user.
    // Output: a brand-new chat in Local or Cloud.
    // Side effects: issues only `thread/start`.
    // Rollback: none.
    // Errors: runtime readiness and `thread/start` failures.
    static func startNewLocalChat(
        preferredProjectPath: String? = nil,
        codex: CodexService
    ) async throws -> CodexThread {
        try await codex.startThreadIfReady(preferredProjectPath: preferredProjectPath)
    }

    // Input: Local checkout path for the repo that should host the new worktree chat,
    //   plus an optional explicit base branch (defaults to the repo default branch).
    // Output: a brand-new chat opened in a clean managed detached worktree.
    // Side effects: creates a managed worktree, then issues `thread/start` inside it.
    // Rollback: removes the temporary worktree only when chat creation failed before a durable thread exists.
    // Errors: base-branch resolution, Git worktree creation, or `thread/start` failures.
    static func startNewWorktreeChat(
        preferredProjectPath: String,
        baseBranch requestedBaseBranch: String? = nil,
        codex: CodexService
    ) async throws -> CodexThread {
        let normalizedPreferredProjectPath = try requiredProjectPath(
            preferredProjectPath,
            message: "A valid local project path is required."
        )
        let gitService = GitActionsService(codex: codex, workingDirectory: normalizedPreferredProjectPath)
        let baseBranch: String
        if let requestedBaseBranch = requestedBaseBranch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !requestedBaseBranch.isEmpty {
            baseBranch = requestedBaseBranch
        } else {
            let branches = try await gitService.branchesWithStatus()
            baseBranch = branches.defaultBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        guard !baseBranch.isEmpty else {
            throw WorktreeFlowError(
                "Could not determine a base branch for the new worktree chat.",
                code: .missingBaseBranch
            )
        }

        let result = try await gitService.createManagedWorktree(
            baseBranch: baseBranch,
            changeTransfer: .none
        )

        do {
            let thread = try await codex.startThreadIfReady(preferredProjectPath: result.worktreePath)
            codex.rememberAssociatedManagedWorktreePath(result.worktreePath, for: thread.id)
            return thread
        } catch {
            let cleanupResult = await cleanupResultForFailedNewWorktreeChat(result, error: error, codex: codex)
            throw WorktreeFlowError(
                failedNewWorktreeChatMessage(for: error, cleanupResult: cleanupResult)
            )
        }
    }

    // Input: same thread id, the Local checkout that currently owns the chat, and either an associated worktree path
    //   or the base branch used to create the first managed worktree.
    // Output: the same chat rebound into the associated/new managed worktree.
    // Side effects: optionally creates a managed worktree, moves local changes except ignored files, and issues `thread/resume`.
    // Rollback: best-effort local-change rollback and safe worktree cleanup if rebind fails after a move.
    // Errors: `missing_handoff_source`, `missing_handoff_target`, `handoff_target_dirty`,
    //   `handoff_target_mismatch`, `missing_base_branch`, and runtime rebind failures.
    static func handoffThreadToWorktree(
        threadID: String,
        sourceProjectPath: String?,
        associatedWorktreePath: String?,
        baseBranchForNewWorktree: String? = nil,
        codex: CodexService
    ) async throws -> WorktreeFlowHandoffOutcome {
        let normalizedSourceProjectPath = try requiredProjectPath(
            sourceProjectPath,
            message: "The current handoff source is not available on this computer."
        )

        if let associatedWorktreePath,
           !associatedWorktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return try await handoffThreadToProjectPath(
                threadID: threadID,
                sourceProjectPath: normalizedSourceProjectPath,
                projectPath: associatedWorktreePath,
                transferTrackedChangesFromSource: true,
                didTransferTrackedChangesBeforeRebind: false,
                cleanupManagedWorktreeOnFailedRebind: false,
                createdManagedWorktree: false,
                codex: codex
            )
        }

        let baseBranch = baseBranchForNewWorktree?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !baseBranch.isEmpty else {
            throw WorktreeFlowError(
                "A base branch is required to create the managed worktree.",
                code: .missingBaseBranch
            )
        }

        let gitService = GitActionsService(codex: codex, workingDirectory: normalizedSourceProjectPath)
        let result = try await gitService.createManagedWorktree(
            baseBranch: baseBranch,
            changeTransfer: .move
        )

        return try await handoffThreadToProjectPath(
            threadID: threadID,
            sourceProjectPath: normalizedSourceProjectPath,
            projectPath: result.worktreePath,
            transferTrackedChangesFromSource: false,
            didTransferTrackedChangesBeforeRebind: result.transferredChanges,
            cleanupManagedWorktreeOnFailedRebind: !result.alreadyExisted,
            createdManagedWorktree: !result.alreadyExisted,
            codex: codex
        )
    }

    // Input: the current managed-worktree thread.
    // Output: the same chat rebound back into the paired Local checkout.
    // Side effects: moves local changes except ignored files into Local, then issues `thread/resume`.
    // Rollback: best-effort local-change rollback if the rebind fails after the move.
    // Errors: Local checkout lookup, handoff transfer, or runtime rebind failures.
    static func handoffThreadToLocal(
        thread: CodexThread,
        codex: CodexService
    ) async throws -> WorktreeFlowHandoffMove {
        let sourceProjectPath = try requiredProjectPath(
            thread.gitWorkingDirectory,
            message: "The current handoff source is not available on this computer."
        )

        let gitService = GitActionsService(codex: codex, workingDirectory: sourceProjectPath)
        var localCheckoutPath: String?
        var didTransferTrackedChanges = false

        do {
            let branches = try await gitService.branchesWithStatus()
            guard let normalizedLocalCheckoutPath = CodexThreadStartProjectBinding.normalizedProjectPath(
                branches.localCheckoutPath
            ) else {
                throw WorktreeFlowError("Could not resolve the paired Local checkout for this worktree.")
            }

            localCheckoutPath = normalizedLocalCheckoutPath
            let transferResult = try await gitService.transferManagedHandoff(
                targetProjectPath: normalizedLocalCheckoutPath
            )
            didTransferTrackedChanges = transferResult.transferredChanges
            let movedThread = try await codex.moveThreadToProjectPath(
                threadId: thread.id,
                projectPath: normalizedLocalCheckoutPath
            )
            return WorktreeFlowHandoffMove(
                thread: movedThread,
                projectPath: normalizedLocalCheckoutPath,
                transferredChanges: didTransferTrackedChanges,
                createdManagedWorktree: false
            )
        } catch {
            let recoveryDetail = await recoverFailedThreadRebind(
                didTransferTrackedChanges: didTransferTrackedChanges,
                sourceProjectPath: sourceProjectPath,
                reboundProjectPath: localCheckoutPath,
                cleanupManagedWorktreeOnFailedRebind: false,
                codex: codex
            )
            throw WorktreeFlowError(
                failedMessage(
                    fallback: "Could not hand off the thread back to Local.",
                    error: error,
                    recoveryDetail: recoveryDetail
                )
            )
        }
    }

    // Input: source chat plus the Local checkout paired with its repo.
    // Output: a brand-new forked chat opened in Local.
    // Side effects: issues only `thread/fork` + fork hydration.
    // Rollback: none, because fork never moves files.
    // Errors: clear failure when Local cannot be resolved, plus runtime fork failures.
    static func forkThreadToLocal(
        sourceThread: CodexThread,
        localCheckoutPath: String?,
        codex: CodexService
    ) async throws -> CodexThread {
        guard let targetProjectPath = localForkProjectPath(
            for: sourceThread,
            localCheckoutPath: localCheckoutPath
        ) else {
            throw WorktreeFlowError(
                sourceThread.isManagedWorktreeProject
                    ? "Could not resolve the Local checkout for this worktree thread."
                    : "Could not resolve the local project path for this thread.",
                code: .localForkUnavailable
            )
        }

        return try await codex.forkThreadIfReady(
            from: sourceThread.id,
            target: .projectPath(targetProjectPath)
        )
    }

    // Input: source chat id, Local checkout path, and the base branch for the new worktree.
    // Output: a brand-new forked chat opened in a clean managed detached worktree.
    // Side effects: creates a managed worktree, then issues `thread/fork` inside it.
    // Rollback: removes the temporary worktree only when the fork is aborted before the runtime request is sent.
    // Errors: base-branch lookup, Git worktree creation, or runtime fork failures.
    static func forkThreadToWorktree(
        sourceThreadId: String,
        sourceProjectPath: String?,
        baseBranch: String,
        codex: CodexService
    ) async throws -> CodexThread {
        let normalizedSourceProjectPath = try requiredProjectPath(
            sourceProjectPath,
            message: "A valid local project path is required."
        )
        let trimmedBaseBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBaseBranch.isEmpty else {
            throw WorktreeFlowError(
                "A base branch is required to create the managed worktree.",
                code: .missingBaseBranch
            )
        }

        let gitService = GitActionsService(codex: codex, workingDirectory: normalizedSourceProjectPath)
        let result = try await gitService.createManagedWorktree(
            baseBranch: trimmedBaseBranch,
            changeTransfer: .none
        )

        do {
            try await awaitPreparedWorktreeForkReadiness(codex: codex)
        } catch {
            let cleanupResult = await cleanupResultForAbortedPreparedWorktreeFork(result, codex: codex)
            throw WorktreeFlowError(
                failedWorktreeForkMessage(for: error, cleanupResult: cleanupResult)
            )
        }

        do {
            return try await codex.forkThread(
                from: sourceThreadId,
                target: .projectPath(result.worktreePath)
            )
        } catch {
            let cleanupResult = await cleanupResultForFailedWorktreeFork(result, error: error, codex: codex)
            throw WorktreeFlowError(
                failedWorktreeForkMessage(for: error, cleanupResult: cleanupResult)
            )
        }
    }

    // Prefers reopening the live thread already bound to a checked-out worktree instead of spawning another chat.
    static func liveThreadForCheckedOutElsewhereBranch(
        projectPath: String,
        codex: CodexService,
        currentThread: CodexThread
    ) -> CodexThread? {
        guard let normalizedProjectPath = CodexThreadStartProjectBinding.normalizedProjectPath(projectPath) else {
            return nil
        }

        let resolvedProjectPath = canonicalProjectPath(normalizedProjectPath) ?? normalizedProjectPath
        let currentComparablePath = comparableProjectPath(currentThread.normalizedProjectPath)
        guard currentComparablePath != resolvedProjectPath else {
            return nil
        }

        return matchingLiveThread(
            in: codex.threads,
            projectPath: resolvedProjectPath,
            sort: codex.sortThreads
        )
    }

    // Resolves the real Local fork target without silently falling back to the current worktree.
    static func localForkProjectPath(
        for thread: CodexThread,
        localCheckoutPath: String?
    ) -> String? {
        if !thread.isManagedWorktreeProject {
            return normalizedForkProjectPath(thread.normalizedProjectPath)
        }

        return normalizedForkProjectPath(localCheckoutPath)
    }
}
