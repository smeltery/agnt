// FILE: CodexService+AIChangeSets.swift
// Purpose: Tracks assistant-scoped patch ledgers and executes safe reverse-patch previews/applies.
// Layer: Service
// Exports: CodexService AI change-set APIs
// Depends on: AIChangeSetModels, CodexService transport, GitActionModels

import Foundation

enum AIChangeSetError: LocalizedError {
    case missingWorkingDirectory
    case missingPatch
    case bridgeError(code: String?, message: String?)

    var errorDescription: String? {
        switch self {
        case .missingWorkingDirectory:
            return "The selected local folder is not available on this computer."
        case .missingPatch:
            return "This response cannot be auto-reverted because no exact patch was captured."
        case .bridgeError(let code, let message):
            switch code {
            case "missing_patch":
                return "This response cannot be auto-reverted because no exact patch was captured."
            case "missing_working_directory":
                return "The selected local folder is not available on this computer."
            default:
                return message ?? "Patch revert failed."
            }
        }
    }
}

struct AIRevertOverlapAnalysis {
    let affectedFiles: [String]
    let overlappingFiles: [String]
    let competingChangeSetIDs: [String]

    var hasOverlap: Bool {
        !overlappingFiles.isEmpty
    }
}

struct AIRevertBridgeRequest {
    let previewMethod: String
    let applyMethod: String
    let params: JSONValue
}

extension CodexService {
    // Returns the change set associated with a specific assistant response, falling back to turn scope while streaming.
    func aiChangeSet(forAssistantMessage message: CodexMessage) -> AIChangeSet? {
        if let assistantMessageId = normalizedIdentifier(message.id),
           let changeSetId = aiChangeSetIDByAssistantMessageID[assistantMessageId],
           let changeSet = aiChangeSetsByID[changeSetId] {
            return changeSet
        }

        if let turnKey = AIChangeSetTurnKey(threadId: message.threadId, turnId: message.turnId),
           let changeSetId = aiChangeSetIDByTurnKey[turnKey] {
            return aiChangeSetsByID[changeSetId]
        }

        return nil
    }

    // Builds assistant-row button state from response-local patch data plus same-repo safety checks.
    func assistantRevertPresentation(
        for message: CodexMessage,
        workingDirectory: String?
    ) -> AssistantRevertPresentation? {
        guard message.role == .assistant else {
            return nil
        }

        guard let changeSet = aiChangeSet(forAssistantMessage: message) else {
            return nil
        }

        let hasWorkingDirectory = normalizedWorkingDirectory(workingDirectory) != nil
        let repoBusy = hasActiveRun(in: changeSet.repoRoot ?? workingDirectory)
        let overlapAnalysis = revertOverlapAnalysis(for: changeSet, workingDirectory: workingDirectory)

        switch changeSet.status {
        case .ready:
            if !hasWorkingDirectory {
                return AssistantRevertPresentation(
                    title: "Cannot undo",
                    isEnabled: false,
                    helperText: "The selected local folder is not available on this computer.",
                    riskLevel: .blocked
                )
            }
            // Keep undo blocked while the repo is still live so preview/apply cannot race new writes.
            if repoBusy {
                return AssistantRevertPresentation(
                    title: "Cannot undo",
                    isEnabled: false,
                    helperText: "Finish the active run in this repo before undoing this response.",
                    riskLevel: .blocked
                )
            }
            if overlapAnalysis.hasOverlap {
                let warningText = "Other chats also changed \(overlapAnalysis.overlappingFiles.count) of these file\(overlapAnalysis.overlappingFiles.count == 1 ? "" : "s")."
                return AssistantRevertPresentation(
                    title: "Undo changes",
                    isEnabled: true,
                    helperText: "Review overlapping files before undoing this response.",
                    riskLevel: .warning,
                    warningText: warningText,
                    overlappingFiles: overlapAnalysis.overlappingFiles
                )
            }
            return AssistantRevertPresentation(
                title: "Undo changes",
                isEnabled: true,
                helperText: "Only changes from this response will be reverted unless later edits overlap.",
                riskLevel: .safe
            )
        case .collecting:
            return AssistantRevertPresentation(
                title: "Undo changes",
                isEnabled: false,
                helperText: "This response is still collecting its final patch.",
                riskLevel: .blocked
            )
        case .reverted:
            return AssistantRevertPresentation(
                title: "Already undone",
                isEnabled: false,
                helperText: nil,
                riskLevel: .blocked
            )
        case .failed, .notRevertable:
            return AssistantRevertPresentation(
                title: "Cannot undo",
                isEnabled: false,
                helperText: changeSet.unsupportedReasons.first,
                riskLevel: .blocked
            )
        }
    }

    // Reuses the shared busy-repo snapshot so undo stays disabled during in-flight sibling runs.
    func hasActiveRun(in workingDirectory: String?) -> Bool {
        guard let normalizedWorkingDirectory = normalizedWorkingDirectory(workingDirectory) else {
            return false
        }

        let repoIdentifier = canonicalRepoIdentifier(for: normalizedWorkingDirectory) ?? normalizedWorkingDirectory
        return busyRepoRoots.contains(repoIdentifier)
    }

    // Provides the latest finalized patch metadata for UI sheets and action handlers.
    func readyChangeSet(forAssistantMessage message: CodexMessage) -> AIChangeSet? {
        guard let changeSet = aiChangeSet(forAssistantMessage: message),
              changeSet.status == .ready else {
            return nil
        }
        return changeSet
    }

    // Asks the bridge to dry-run the reverse patch against the current working tree.
    func previewRevert(
        changeSet: AIChangeSet,
        workingDirectory: String
    ) async throws -> RevertPreviewResult {
        let normalizedWorkingDirectory = normalizedWorkingDirectory(workingDirectory)
        guard let normalizedWorkingDirectory else {
            throw AIChangeSetError.missingWorkingDirectory
        }
        let request = try revertBridgeRequest(for: changeSet, normalizedWorkingDirectory: normalizedWorkingDirectory)

        do {
            let response = try await sendRequest(method: request.previewMethod, params: request.params)
            guard let result = response.result?.objectValue else {
                throw AIChangeSetError.bridgeError(code: nil, message: "Invalid response from bridge.")
            }
            return RevertPreviewResult(from: result)
        } catch let error as CodexServiceError {
            throw bridgeError(from: error)
        }
    }

    // Reverse-applies the stored patch, then marks the change set as reverted only after success.
    func applyRevert(
        changeSet: AIChangeSet,
        workingDirectory: String
    ) async throws -> RevertApplyResult {
        let normalizedWorkingDirectory = normalizedWorkingDirectory(workingDirectory)
        guard let normalizedWorkingDirectory else {
            throw AIChangeSetError.missingWorkingDirectory
        }
        let request = try revertBridgeRequest(for: changeSet, normalizedWorkingDirectory: normalizedWorkingDirectory)

        markRevertAttempt(changeSetId: changeSet.id)

        do {
            let response = try await sendRequest(method: request.applyMethod, params: request.params)
            guard let result = response.result?.objectValue else {
                throw AIChangeSetError.bridgeError(code: nil, message: "Invalid response from bridge.")
            }

            let applyResult = RevertApplyResult(from: result)
            rememberRepoRoot(applyResult.status?.repoRoot, forWorkingDirectory: normalizedWorkingDirectory)
            if applyResult.success {
                markChangeSetReverted(changeSetId: changeSet.id)
                appendSystemMessage(
                    threadId: changeSet.threadId,
                    text: "Reverted changes from this response.",
                    turnId: changeSet.turnId,
                    kind: .chat
                )
            } else {
                recordChangeSetError(
                    changeSetId: changeSet.id,
                    message: firstNonEmptyCandidate(
                        applyResult.unsupportedReasons.first,
                        applyResult.conflicts.first?.message,
                        applyResult.stagedFiles.isEmpty ? nil : "Some targeted files have staged changes. Unstage them first to keep revert predictable."
                    ) ?? "Patch revert failed."
                )
            }

            return applyResult
        } catch let error as CodexServiceError {
            let mapped = bridgeError(from: error)
            recordChangeSetError(changeSetId: changeSet.id, message: mapped.localizedDescription)
            throw mapped
        }
    }

    // Chooses the bridge method: aggregate diffs use the legacy single-patch path, fallback batches stay ordered.
    fileprivate func revertBridgeRequest(
        for changeSet: AIChangeSet,
        normalizedWorkingDirectory: String
    ) throws -> AIRevertBridgeRequest {
        if changeSet.source == .fileChangeFallback, !changeSet.fallbackPatchBatches.isEmpty {
            let patches = changeSet.fallbackPatchBatches.reversed().map { batch in
                JSONValue.object([
                    "id": .string(batch.id),
                    "forwardPatch": .string(batch.forwardUnifiedPatch),
                ])
            }
            return AIRevertBridgeRequest(
                previewMethod: "workspace/revertPatchBatchPreview",
                applyMethod: "workspace/revertPatchBatchApply",
                params: .object([
                    "cwd": .string(normalizedWorkingDirectory),
                    "patches": .array(Array(patches)),
                ])
            )
        }

        guard !changeSet.forwardUnifiedPatch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AIChangeSetError.missingPatch
        }

        return AIRevertBridgeRequest(
            previewMethod: "workspace/revertPatchPreview",
            applyMethod: "workspace/revertPatchApply",
            params: .object([
                "cwd": .string(normalizedWorkingDirectory),
                "forwardPatch": .string(changeSet.forwardUnifiedPatch),
            ])
        )
    }
}

// ─── Ledger mutation helpers ───────────────────────────────────────

extension CodexService {
    // Tracks the authoritative turn-level unified diff for a response and upgrades fallback patches when possible.
    func recordTurnDiffChangeSet(threadId: String, turnId: String, diff: String) {
        recordChangeSetPatch(
            threadId: threadId,
            turnId: turnId,
            patch: diff,
            source: .turnDiff
        )
    }

    // Tracks the Git checkpoint diff when available, without losing runtime diff fallback coverage.
    func recordWorkspaceCheckpointChangeSet(threadId: String, turnId: String, diff: String) {
        recordChangeSetPatch(
            threadId: threadId,
            turnId: turnId,
            patch: diff,
            source: .workspaceCheckpoint
        )
    }

    // Tracks a conservative single-patch fallback when no final turn diff is available.
    func recordFallbackFileChangePatch(threadId: String, turnId: String, patch: String) {
        recordChangeSetPatch(
            threadId: threadId,
            turnId: turnId,
            patch: patch,
            source: .fileChangeFallback
        )
    }

    // Links an assistant row to the turn-scoped change set once the canonical response message exists.
    func noteAssistantMessage(
        threadId: String,
        turnId: String?,
        assistantMessageId: String
    ) {
        guard let turnKey = AIChangeSetTurnKey(threadId: threadId, turnId: turnId),
              let normalizedAssistantMessageId = normalizedIdentifier(assistantMessageId),
              let changeSetId = aiChangeSetIDByTurnKey[turnKey],
              var changeSet = aiChangeSetsByID[changeSetId] else {
            return
        }

        changeSet.assistantMessageId = normalizedAssistantMessageId
        changeSet.repoRoot = changeSet.repoRoot ?? gitWorkingDirectory(for: threadId)
        aiChangeSetsByID[changeSetId] = changeSet
        aiChangeSetIDByAssistantMessageID[normalizedAssistantMessageId] = changeSetId
        finalizeChangeSetIfPossible(changeSetId: changeSetId)
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    // Finalizes the change set once the turn has finished, even if the diff arrives slightly later.
    func noteTurnFinished(threadId: String, turnId: String?) {
        guard let turnKey = AIChangeSetTurnKey(threadId: threadId, turnId: turnId),
              let changeSetId = aiChangeSetIDByTurnKey[turnKey] else {
            return
        }

        finalizeChangeSetIfPossible(changeSetId: changeSetId)
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    // Remembers canonical repo roots so repo-scoped safety checks stay consistent across sibling chat folders.
    func rememberRepoRoot(_ repoRoot: String?, forWorkingDirectory workingDirectory: String?) {
        guard let normalizedRepoRoot = normalizedWorkingDirectory(repoRoot) else {
            return
        }

        var didChange = false

        knownRepoRoots.insert(normalizedRepoRoot)
        if repoRootByWorkingDirectory[normalizedRepoRoot] != normalizedRepoRoot {
            repoRootByWorkingDirectory[normalizedRepoRoot] = normalizedRepoRoot
            didChange = true
        }

        if let normalizedWorkingDirectory = normalizedWorkingDirectory(workingDirectory) {
            if repoRootByWorkingDirectory[normalizedWorkingDirectory] != normalizedRepoRoot {
                repoRootByWorkingDirectory[normalizedWorkingDirectory] = normalizedRepoRoot
                didChange = true
            }
        }

        // Rebuild repo-busy state immediately so sibling threads pick up the canonical root mid-run.
        // Use the no-refresh variant to avoid a double full-thread refresh:
        // refreshBusyRepoRoots already refreshes affected threads, and the revert cache is invalidated.
        if didChange {
            invalidateAssistantRevertStatesWithoutRefresh()
            if !refreshBusyRepoRootsAndDependentTimelineStates() {
                refreshAllThreadTimelineStates()
            }
        }
    }

    // Preserves the exact diff body while guaranteeing the trailing newline git apply expects.
    func normalizedUnifiedPatchPayload(_ rawPatch: String) -> String? {
        guard !rawPatch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        return rawPatch.hasSuffix("\n") ? rawPatch : rawPatch + "\n"
    }
}

// ─── Private helpers ───────────────────────────────────────────────

extension CodexService {
    // Shares the thread-bound working directory with timeline/revert UI without exposing the full change-set helper surface.
    func gitWorkingDirectory(for threadId: String) -> String? {
        let workingDirectory = thread(for: threadId)?.gitWorkingDirectory
        return canonicalRepoIdentifier(for: workingDirectory) ?? workingDirectory
    }

    // Resolves sibling subdirectories to one canonical repo id once the bridge reports a repo root.
    func canonicalRepoIdentifier(for workingDirectory: String?) -> String? {
        guard let normalizedWorkingDirectory = normalizedWorkingDirectory(workingDirectory) else {
            return nil
        }

        if let knownRoot = repoRootByWorkingDirectory[normalizedWorkingDirectory] {
            return knownRoot
        }

        let matchingRoot = knownRepoRoots
            .sorted { $0.count > $1.count }
            .first { isSameOrDescendantPath(normalizedWorkingDirectory, root: $0) }
        return matchingRoot ?? normalizedWorkingDirectory
    }

    // Recovers legacy fallback change-set ledgers from persisted file-change message diff fences.
    func rehydrateLegacyFallbackChangeSetsFromPersistedMessages() {
        var didChange = false

        for changeSetId in Array(aiChangeSetsByID.keys) {
            guard var changeSet = aiChangeSetsByID[changeSetId],
                  changeSet.source == .fileChangeFallback,
                  changeSet.fallbackPatchBatches.isEmpty,
                  changeSet.status != .reverted else {
                continue
            }

            let patches = persistedFileChangePatches(threadId: changeSet.threadId, turnId: changeSet.turnId)
            guard !patches.isEmpty else { continue }

            for patch in patches {
                let analysis = AIUnifiedPatchParser.analyze(patch)
                appendFallbackPatchBatch(
                    patch: patch,
                    analysis: analysis,
                    to: &changeSet
                )
            }

            changeSet.status = .collecting
            aiChangeSetsByID[changeSetId] = changeSet
            finalizeChangeSetIfPossible(changeSetId: changeSetId)
            didChange = true
        }

        if didChange {
            persistAIChangeSets()
            invalidateAssistantRevertStatesWithoutRefresh()
        }
    }
}
