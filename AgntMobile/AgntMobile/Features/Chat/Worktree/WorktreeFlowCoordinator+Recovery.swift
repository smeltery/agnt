// FILE: WorktreeFlowCoordinator+Recovery.swift
// Purpose: Recovery, cleanup, and path helpers for WorktreeFlowCoordinator.
// Layer: Service Coordination support
// Exports: WorktreeFlowError and WorktreeFlowCoordinator recovery helpers
// Depends on: Foundation, CodexService, GitActionsService

import Foundation

extension WorktreeFlowCoordinator {
    private static let forkReadinessRetryDelays: [UInt64] = [
        0,
        350_000_000,
        900_000_000,
    ]

    static func handoffThreadToProjectPath(
        threadID: String,
        sourceProjectPath: String,
        projectPath: String,
        transferTrackedChangesFromSource: Bool,
        didTransferTrackedChangesBeforeRebind: Bool,
        cleanupManagedWorktreeOnFailedRebind: Bool,
        createdManagedWorktree: Bool,
        codex: CodexService
    ) async throws -> WorktreeFlowHandoffOutcome {
        guard let normalizedProjectPath = CodexThreadStartProjectBinding.normalizedProjectPath(projectPath) else {
            throw WorktreeFlowError("Could not resolve the target project path.")
        }

        let resolvedProjectPath = canonicalProjectPath(normalizedProjectPath) ?? normalizedProjectPath
        var didTransferTrackedChanges = didTransferTrackedChangesBeforeRebind

        do {
            if transferTrackedChangesFromSource {
                let gitService = GitActionsService(codex: codex, workingDirectory: sourceProjectPath)
                let transferResult = try await gitService.transferManagedHandoff(
                    targetProjectPath: resolvedProjectPath
                )
                didTransferTrackedChanges = transferResult.transferredChanges
            }

            let movedThread = try await codex.moveThreadToProjectPath(
                threadId: threadID,
                projectPath: resolvedProjectPath
            )
            return .moved(
                WorktreeFlowHandoffMove(
                    thread: movedThread,
                    projectPath: resolvedProjectPath,
                    transferredChanges: didTransferTrackedChanges,
                    createdManagedWorktree: createdManagedWorktree
                )
            )
        } catch {
            if isMissingManagedWorktreeTargetError(error) {
                codex.rememberAssociatedManagedWorktreePath(nil, for: threadID)
                if didTransferTrackedChanges {
                    let recoveryDetail = await recoverFailedThreadRebind(
                        didTransferTrackedChanges: didTransferTrackedChanges,
                        sourceProjectPath: sourceProjectPath,
                        reboundProjectPath: resolvedProjectPath,
                        cleanupManagedWorktreeOnFailedRebind: cleanupManagedWorktreeOnFailedRebind,
                        codex: codex
                    )
                    throw WorktreeFlowError(
                        failedMessage(
                            fallback: "The managed worktree is no longer available on this computer.",
                            error: error,
                            recoveryDetail: recoveryDetail
                        )
                    )
                }
                return .missingAssociatedWorktree
            }

            let recoveryDetail = await recoverFailedThreadRebind(
                didTransferTrackedChanges: didTransferTrackedChanges,
                sourceProjectPath: sourceProjectPath,
                reboundProjectPath: resolvedProjectPath,
                cleanupManagedWorktreeOnFailedRebind: cleanupManagedWorktreeOnFailedRebind,
                codex: codex
            )
            throw WorktreeFlowError(
                failedMessage(
                    fallback: "Could not hand off the thread to the target worktree.",
                    error: error,
                    recoveryDetail: recoveryDetail
                )
            )
        }
    }

    static func awaitPreparedWorktreeForkReadiness(codex: CodexService) async throws {
        for (index, delay) in forkReadinessRetryDelays.enumerated() {
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay)
            }

            if codex.isConnected && codex.isInitialized {
                return
            }

            let hasMoreAttempts = index < (forkReadinessRetryDelays.count - 1)
            guard hasMoreAttempts else { break }
        }

        if !codex.isConnected {
            throw CodexServiceError.invalidInput("Connect to runtime first.")
        }

        throw CodexServiceError.invalidInput("Runtime is still initializing. Wait a moment and retry.")
    }

    static func recoverFailedThreadRebind(
        didTransferTrackedChanges: Bool,
        sourceProjectPath: String?,
        reboundProjectPath: String?,
        cleanupManagedWorktreeOnFailedRebind: Bool,
        codex: CodexService
    ) async -> String? {
        var notices: [String] = []
        var canSafelyCleanupManagedWorktree = true

        if didTransferTrackedChanges {
            guard let reboundProjectPath,
                  let sourceProjectPath,
                  reboundProjectPath != sourceProjectPath else {
                notices.append("The moved changes were kept in the temporary worktree because the original checkout could not be restored automatically.")
                notices.append("The temporary worktree was kept so the moved changes stay available.")
                return notices.joined(separator: "\n\n")
            }

            let rollbackService = GitActionsService(codex: codex, workingDirectory: reboundProjectPath)
            do {
                _ = try await rollbackService.transferManagedHandoff(targetProjectPath: sourceProjectPath)
            } catch {
                canSafelyCleanupManagedWorktree = false
                notices.append("Tracked changes could not be moved back automatically: \(rollbackFailureMessage(error)).")
            }
        }

        if cleanupManagedWorktreeOnFailedRebind,
           canSafelyCleanupManagedWorktree,
           let reboundProjectPath {
            let cleanupService = GitActionsService(codex: codex, workingDirectory: reboundProjectPath)
            do {
                try await cleanupService.removeManagedWorktree(branch: nil)
            } catch {
                notices.append("The temporary worktree could not be removed automatically: \(cleanupFailureMessage(error)).")
            }
        } else if cleanupManagedWorktreeOnFailedRebind && !canSafelyCleanupManagedWorktree {
            notices.append("The temporary worktree was kept so the moved changes stay available.")
        }

        guard !notices.isEmpty else {
            return nil
        }

        return notices.joined(separator: "\n\n")
    }

    static func cleanupResultForFailedNewWorktreeChat(
        _ result: GitCreateManagedWorktreeResult,
        error: Error,
        codex: CodexService
    ) async -> WorktreeFlowCleanupResult {
        switch failedNewWorktreeChatDisposition(for: error) {
        case .cleanupSafe:
            guard !result.alreadyExisted else {
                return .notNeeded
            }

            let cleanupService = GitActionsService(codex: codex, workingDirectory: result.worktreePath)
            do {
                try await cleanupService.removeManagedWorktree(branch: nil)
                return .removed
            } catch {
                return .failed(error.localizedDescription)
            }
        case .preserveWorktree(let detail):
            return .preserved(detail)
        }
    }

    static func failedNewWorktreeChatDisposition(for error: Error) -> WorktreeFlowCleanupDisposition {
        guard let serviceError = error as? CodexServiceError else {
            return .preserveWorktree("The runtime may have created the new chat before the error reached the app.")
        }

        switch serviceError {
        case .disconnected, .invalidResponse:
            return .preserveWorktree(
                "The connection dropped after the chat request was sent, so the new worktree was kept in case the chat still appears after sync."
            )
        case .invalidServerURL:
            return .cleanupSafe
        case .rpcError(let rpcError):
            let normalizedMessage = rpcError.message.lowercased()
            if normalizedMessage.contains("timeout")
                || normalizedMessage.contains("temporarily unavailable")
                || normalizedMessage.contains("connection")
                || normalizedMessage.contains("network") {
                return .preserveWorktree(
                    "The runtime may still be finalizing the new chat. The worktree was kept so we do not delete a chat that may already exist."
                )
            }
            return .cleanupSafe
        case .invalidInput, .encodingFailed, .noPendingApproval:
            return .cleanupSafe
        }
    }

    static func failedNewWorktreeChatMessage(
        for error: Error,
        cleanupResult: WorktreeFlowCleanupResult
    ) -> String {
        let baseMessage = error.localizedDescription.isEmpty
            ? "Unable to create a worktree chat right now."
            : error.localizedDescription

        switch cleanupResult {
        case .notNeeded:
            return baseMessage
        case .removed:
            return "\(baseMessage)\n\nThe temporary worktree was removed automatically."
        case .preserved(let detail):
            let trimmedDetail = detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let suffix = trimmedDetail.isEmpty
                ? "The new worktree was kept in case the chat was already created. Wait a moment, then check your thread list."
                : trimmedDetail
            return "\(baseMessage)\n\n\(suffix)"
        case .failed(let cleanupMessage):
            let trimmedDetail = cleanupMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            let suffix = trimmedDetail.isEmpty
                ? "We could not remove the temporary worktree automatically."
                : "We could not remove the temporary worktree automatically: \(trimmedDetail)"
            return "\(baseMessage)\n\n\(suffix)"
        }
    }

    static func cleanupResultForFailedWorktreeFork(
        _ result: GitCreateManagedWorktreeResult,
        error: Error,
        codex: CodexService
    ) async -> WorktreeFlowCleanupResult {
        switch failedWorktreeForkDisposition(for: error) {
        case .cleanupSafe:
            guard !result.alreadyExisted else {
                return .notNeeded
            }

            let cleanupService = GitActionsService(codex: codex, workingDirectory: result.worktreePath)
            do {
                try await cleanupService.removeManagedWorktree(branch: nil)
                return .removed
            } catch {
                return .failed(error.localizedDescription)
            }
        case .preserveWorktree(let detail):
            return .preserved(detail)
        }
    }

    static func cleanupResultForAbortedPreparedWorktreeFork(
        _ result: GitCreateManagedWorktreeResult,
        codex: CodexService
    ) async -> WorktreeFlowCleanupResult {
        guard !result.alreadyExisted else {
            return .notNeeded
        }

        let cleanupService = GitActionsService(codex: codex, workingDirectory: result.worktreePath)
        do {
            try await cleanupService.removeManagedWorktree(branch: nil)
            return .removed
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    static func failedWorktreeForkDisposition(for error: Error) -> WorktreeFlowCleanupDisposition {
        guard let serviceError = error as? CodexServiceError else {
            return .preserveWorktree("The runtime may have created the fork before the error reached the app.")
        }

        switch serviceError {
        case .disconnected, .invalidResponse:
            return .preserveWorktree(
                "The connection dropped after the fork request was sent, so the new thread may still appear once the runtime syncs."
            )
        case .invalidServerURL:
            return .cleanupSafe
        case .rpcError:
            return .preserveWorktree(
                "The runtime may still be finalizing the fork. The new worktree was kept so we do not discard a thread that may already exist."
            )
        case .invalidInput(let reason):
            let normalizedReason = reason.lowercased()
            if normalizedReason.contains("does not support native thread forks yet")
                || normalizedReason.contains("update agnt on your mac")
                || normalizedReason.contains("thread not found")
                || normalizedReason.contains("source thread id is required") {
                return .cleanupSafe
            }
            return .preserveWorktree(
                "The fork request may already have reached the runtime. The new worktree was kept until sync confirms whether the new chat exists."
            )
        case .encodingFailed, .noPendingApproval:
            return .cleanupSafe
        }
    }

    static func failedWorktreeForkMessage(
        for error: Error,
        cleanupResult: WorktreeFlowCleanupResult
    ) -> String {
        let baseMessage = error.localizedDescription.isEmpty
            ? "Could not fork the thread into the new worktree."
            : error.localizedDescription

        switch cleanupResult {
        case .notNeeded:
            return baseMessage
        case .removed:
            return "\(baseMessage)\n\nThe temporary worktree was removed automatically."
        case .preserved(let detail):
            let trimmedDetail = detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let suffix = trimmedDetail.isEmpty
                ? "The new worktree was kept in case the fork already exists. Wait a moment for sync, then check your thread list."
                : trimmedDetail
            return "\(baseMessage)\n\n\(suffix)"
        case .failed(let cleanupMessage):
            let detail = cleanupMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            let suffix = detail.isEmpty
                ? "We could not remove the temporary worktree automatically."
                : "We could not remove the temporary worktree automatically: \(detail)"
            return "\(baseMessage)\n\n\(suffix)"
        }
    }

    static func failedMessage(
        fallback: String,
        error: Error,
        recoveryDetail: String?
    ) -> String {
        let baseMessage = error.localizedDescription.isEmpty
            ? fallback
            : error.localizedDescription

        guard let recoveryDetail,
              !recoveryDetail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return baseMessage
        }

        return "\(baseMessage)\n\n\(recoveryDetail)"
    }

    static func rollbackFailureMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "check the original checkout before retrying" : message
    }

    static func cleanupFailureMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "remove it manually before retrying" : message
    }

    static func isMissingManagedWorktreeTargetError(_ error: Error) -> Bool {
        guard let gitError = error as? GitActionsError,
              case .bridgeError(let code, _) = gitError else {
            return false
        }

        return code == "missing_handoff_target"
    }

    static func requiredProjectPath(_ rawPath: String?, message: String) throws -> String {
        guard let normalizedPath = CodexThreadStartProjectBinding.normalizedProjectPath(rawPath) else {
            throw WorktreeFlowError(message)
        }

        return normalizedPath
    }

    static func canonicalProjectPath(_ rawPath: String) -> String? {
        guard let normalizedPath = CodexThreadStartProjectBinding.normalizedProjectPath(rawPath) else {
            return nil
        }

        return URL(fileURLWithPath: normalizedPath)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    static func comparableProjectPath(_ rawPath: String?) -> String? {
        guard let rawPath else {
            return nil
        }

        return canonicalProjectPath(rawPath) ?? CodexThreadStartProjectBinding.normalizedProjectPath(rawPath)
    }

    static func matchingLiveThread(
        in threads: [CodexThread],
        projectPath: String,
        sort: ([CodexThread]) -> [CodexThread]
    ) -> CodexThread? {
        let matchingLiveThreads = threads.filter { thread in
            thread.syncState == .live
                && comparableProjectPath(thread.normalizedProjectPath) == projectPath
        }

        return sort(matchingLiveThreads).first
    }

    static func normalizedForkProjectPath(_ rawPath: String?) -> String? {
        guard let rawPath else {
            return nil
        }

        let trimmedPath = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            return nil
        }

        return trimmedPath
    }
}

struct WorktreeFlowError: LocalizedError {
    enum Code {
        case generic
        case localForkUnavailable
        case missingBaseBranch
    }

    let code: Code
    let message: String

    init(_ message: String, code: Code = .generic) {
        self.code = code
        self.message = message
    }

    var errorDescription: String? { message }
}

enum WorktreeFlowCleanupDisposition {
    case cleanupSafe
    case preserveWorktree(String?)
}

enum WorktreeFlowCleanupResult {
    case notNeeded
    case removed
    case preserved(String?)
    case failed(String)
}
