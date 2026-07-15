// FILE: CodexService+AIChangeSetHelpers.swift
// Purpose: Implements AI change-set ledger mutation, persistence, and revert safety helpers.
// Layer: Service Extension
// Exports: CodexService AI change-set helper APIs
// Depends on: AIChangeSetModels, CodexService+AIChangeSets

import Foundation

extension CodexService {
    func recordChangeSetPatch(
        threadId: String,
        turnId: String,
        patch: String,
        source: AIChangeSetSource
    ) {
        guard let turnKey = AIChangeSetTurnKey(threadId: threadId, turnId: turnId),
              let normalizedPatch = normalizedUnifiedPatchPayload(patch) else {
            return
        }

        let analysis = AIUnifiedPatchParser.analyze(normalizedPatch)
        let changeSetId = aiChangeSetIDByTurnKey[turnKey] ?? UUID().uuidString
        var changeSet = aiChangeSetsByID[changeSetId] ?? AIChangeSet(
            id: changeSetId,
            repoRoot: gitWorkingDirectory(for: threadId),
            threadId: threadId,
            turnId: turnKey.turnId,
            assistantMessageId: latestAssistantMessageId(for: threadId, turnId: turnKey.turnId),
            source: source
        )

        guard shouldReplaceChangeSetPatch(source: source, existing: changeSet) else {
            return
        }

        changeSet.threadId = threadId
        changeSet.repoRoot = changeSet.repoRoot ?? gitWorkingDirectory(for: threadId)
        changeSet.assistantMessageId = changeSet.assistantMessageId ?? latestAssistantMessageId(
            for: threadId,
            turnId: turnKey.turnId
        )
        changeSet.source = source

        if source == .fileChangeFallback {
            appendFallbackPatchBatch(
                patch: normalizedPatch,
                analysis: analysis,
                to: &changeSet
            )
        } else {
            // Aggregate turn/checkpoint diffs stay authoritative; fallback batches remain only as audit breadcrumbs.
            changeSet.forwardUnifiedPatch = normalizedPatch
            changeSet.patchHash = AIUnifiedPatchParser.hash(for: normalizedPatch)
            changeSet.fileChanges = analysis.fileChanges
            changeSet.unsupportedReasons = analysis.unsupportedReasons
        }

        changeSet.status = .collecting

        aiChangeSetsByID[changeSetId] = changeSet
        aiChangeSetIDByTurnKey[turnKey] = changeSetId
        if let assistantMessageId = changeSet.assistantMessageId {
            aiChangeSetIDByAssistantMessageID[assistantMessageId] = changeSetId
        }

        finalizeChangeSetIfPossible(changeSetId: changeSetId)
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    // Prefers checkpoint-derived diffs when available, while runtime diffs cover turns without checkpoints.
    func shouldReplaceChangeSetPatch(
        source: AIChangeSetSource,
        existing changeSet: AIChangeSet
    ) -> Bool {
        if !hasRevertPatchPayload(changeSet) {
            return true
        }

        switch source {
        case .turnDiff:
            return changeSet.source != .workspaceCheckpoint
        case .workspaceCheckpoint:
            return true
        case .fileChangeFallback:
            return changeSet.source == .fileChangeFallback
        }
    }

    // Appends a patch_apply_end batch once; repeated lifecycle echoes share the same patch hash.
    func appendFallbackPatchBatch(
        patch: String,
        analysis: AIUnifiedPatchAnalysis,
        to changeSet: inout AIChangeSet
    ) {
        let patchHash = AIUnifiedPatchParser.hash(for: patch)
        if !changeSet.fallbackPatchBatches.contains(where: { $0.patchHash == patchHash }) {
            changeSet.fallbackPatchBatches.append(
                AIPatchBatch(
                    forwardUnifiedPatch: patch,
                    patchHash: patchHash,
                    fileChanges: analysis.fileChanges,
                    unsupportedReasons: analysis.unsupportedReasons
                )
            )
        }

        changeSet.fallbackPatchCount = changeSet.fallbackPatchBatches.count
        changeSet.forwardUnifiedPatch = fallbackPatchBatchesForwardPatch(changeSet.fallbackPatchBatches)
        changeSet.patchHash = AIUnifiedPatchParser.hash(for: fallbackPatchBatchesRevertPatch(changeSet.fallbackPatchBatches))
        changeSet.fileChanges = mergedFileChanges(from: changeSet.fallbackPatchBatches.flatMap(\.fileChanges))
        changeSet.unsupportedReasons = Array(Set(changeSet.fallbackPatchBatches.flatMap(\.unsupportedReasons))).sorted()
    }

    func hasRevertPatchPayload(_ changeSet: AIChangeSet) -> Bool {
        if changeSet.source == .fileChangeFallback, !changeSet.fallbackPatchBatches.isEmpty {
            return true
        }
        return !changeSet.forwardUnifiedPatch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func fallbackPatchBatchesForwardPatch(_ batches: [AIPatchBatch]) -> String {
        batches
            .map(\.forwardUnifiedPatch)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n")
    }

    func fallbackPatchBatchesRevertPatch(_ batches: [AIPatchBatch]) -> String {
        batches
            .reversed()
            .map(\.forwardUnifiedPatch)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n")
    }

    func mergedFileChanges(from fileChanges: [AIFileChange]) -> [AIFileChange] {
        var changesByPath: [String: AIFileChange] = [:]

        for change in fileChanges {
            guard let existing = changesByPath[change.path] else {
                changesByPath[change.path] = change
                continue
            }

            let mergedKind: AIFileChangeKind = existing.kind == change.kind ? existing.kind : .update
            changesByPath[change.path] = AIFileChange(
                path: change.path,
                kind: mergedKind,
                additions: existing.additions + change.additions,
                deletions: existing.deletions + change.deletions,
                isBinary: existing.isBinary || change.isBinary,
                isRenameOrModeOnly: existing.isRenameOrModeOnly || change.isRenameOrModeOnly,
                beforeContentHash: existing.beforeContentHash ?? change.beforeContentHash,
                afterContentHash: change.afterContentHash ?? existing.afterContentHash
            )
        }

        return changesByPath.values.sorted { $0.path < $1.path }
    }

    func finalizeChangeSetIfPossible(changeSetId: String) {
        guard var changeSet = aiChangeSetsByID[changeSetId] else {
            return
        }

        guard turnTerminalState(for: changeSet.turnId, threadId: changeSet.threadId) != nil else {
            aiChangeSetsByID[changeSetId] = changeSet
            return
        }

        guard changeSet.status != .reverted else {
            return
        }

        changeSet.repoRoot = changeSet.repoRoot ?? gitWorkingDirectory(for: changeSet.threadId)
        changeSet.assistantMessageId = changeSet.assistantMessageId ?? latestAssistantMessageId(
            for: changeSet.threadId,
            turnId: changeSet.turnId
        )

        if !hasRevertPatchPayload(changeSet) {
            changeSet.status = .notRevertable
            changeSet.unsupportedReasons = ["This response cannot be auto-reverted because no exact patch was captured."]
        } else if changeSet.source == .fileChangeFallback
                    && changeSet.fallbackPatchBatches.isEmpty
                    && changeSet.fallbackPatchCount > 1 {
            changeSet.status = .notRevertable
            changeSet.unsupportedReasons = ["This response was captured before ordered patch batches were stored, so it cannot be safely auto-reverted."]
        } else if !changeSet.unsupportedReasons.isEmpty || changeSet.fileChanges.isEmpty {
            changeSet.status = .notRevertable
        } else {
            changeSet.status = .ready
        }

        if changeSet.finalizedAt == nil {
            changeSet.finalizedAt = Date()
        }

        aiChangeSetsByID[changeSetId] = changeSet
        if let assistantMessageId = changeSet.assistantMessageId {
            aiChangeSetIDByAssistantMessageID[assistantMessageId] = changeSetId
        }
    }

    func persistAIChangeSets() {
        aiChangeSetPersistence.save(
            aiChangeSetsByID.values.sorted {
                if $0.createdAt != $1.createdAt {
                    return $0.createdAt < $1.createdAt
                }
                return $0.id < $1.id
            },
            macDeviceId: currentMacScopedPersistenceDeviceId
        )
    }

    func latestAssistantMessageId(for threadId: String, turnId: String) -> String? {
        messagesByThread[threadId]?.last(where: { message in
            message.role == .assistant && message.turnId == turnId
        })?.id
    }

    func persistedFileChangePatches(threadId: String, turnId: String) -> [String] {
        let messages = messagesByThread[threadId] ?? []
        return messages
            .filter { message in
                message.kind == .fileChange && message.turnId == turnId
            }
            .sorted { lhs, rhs in
                lhs.orderIndex < rhs.orderIndex
            }
            .flatMap { message in
                unifiedDiffCodeBlocks(in: message.text)
            }
    }

    func unifiedDiffCodeBlocks(in text: String) -> [String] {
        var blocks: [String] = []
        var currentLines: [String] = []
        var isCollectingDiff = false

        for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedLine.hasPrefix("```") {
                if isCollectingDiff {
                    let patch = currentLines.joined(separator: "\n")
                    if patch.contains("diff --git"),
                       let normalizedPatch = normalizedUnifiedPatchPayload(patch) {
                        blocks.append(normalizedPatch)
                    }
                    currentLines = []
                    isCollectingDiff = false
                    continue
                }

                let fenceLanguage = trimmedLine.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                isCollectingDiff = fenceLanguage == "diff" || fenceLanguage == "patch"
                continue
            }

            if isCollectingDiff {
                currentLines.append(line)
            }
        }

        return blocks
    }

    func normalizedWorkingDirectory(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func bridgeError(from error: CodexServiceError) -> AIChangeSetError {
        switch error {
        case .disconnected:
            return .bridgeError(code: "disconnected", message: "Not connected to bridge.")
        case .rpcError(let rpcError):
            let errorCode = rpcError.data?.objectValue?["errorCode"]?.stringValue
            return .bridgeError(code: errorCode, message: rpcError.message)
        default:
            return .bridgeError(code: nil, message: error.errorDescription)
        }
    }

    func markRevertAttempt(changeSetId: String) {
        guard var changeSet = aiChangeSetsByID[changeSetId] else { return }
        changeSet.revertMetadata.revertAttemptedAt = Date()
        changeSet.revertMetadata.lastRevertError = nil
        aiChangeSetsByID[changeSetId] = changeSet
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    func markChangeSetReverted(changeSetId: String) {
        guard var changeSet = aiChangeSetsByID[changeSetId] else { return }
        changeSet.status = .reverted
        changeSet.revertMetadata.revertedAt = Date()
        changeSet.revertMetadata.lastRevertError = nil
        aiChangeSetsByID[changeSetId] = changeSet
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    func recordChangeSetError(changeSetId: String, message: String) {
        guard var changeSet = aiChangeSetsByID[changeSetId] else { return }
        changeSet.revertMetadata.lastRevertError = message
        aiChangeSetsByID[changeSetId] = changeSet
        persistAIChangeSets()
        invalidateAssistantRevertStates()
    }

    // Computes file-level overlap for one change set against same-repo responses that are still active/revertable.
    func revertOverlapAnalysis(
        for changeSet: AIChangeSet,
        workingDirectory: String?
    ) -> AIRevertOverlapAnalysis {
        let affectedFiles = changeSet.fileChanges.map(\.path).sorted()
        guard let repoIdentifier = canonicalRepoIdentifier(for: changeSet.repoRoot ?? workingDirectory)
            ?? normalizedWorkingDirectory(changeSet.repoRoot ?? workingDirectory),
            !affectedFiles.isEmpty else {
            return AIRevertOverlapAnalysis(
                affectedFiles: affectedFiles,
                overlappingFiles: [],
                competingChangeSetIDs: []
            )
        }

        let affectedFileSet = Set(affectedFiles)
        var overlappingFiles: Set<String> = []
        var competingChangeSetIDs: [String] = []

        for candidate in aiChangeSetsByID.values {
            guard candidate.id != changeSet.id else { continue }
            guard candidate.status == .ready || candidate.status == .collecting else { continue }

            let candidateRepoIdentifier = canonicalRepoIdentifier(for: candidate.repoRoot ?? gitWorkingDirectory(for: candidate.threadId))
                ?? normalizedWorkingDirectory(candidate.repoRoot ?? gitWorkingDirectory(for: candidate.threadId))
            guard candidateRepoIdentifier == repoIdentifier else { continue }

            let overlap = Set(candidate.fileChanges.map(\.path)).intersection(affectedFileSet)
            guard !overlap.isEmpty else { continue }

            overlappingFiles.formUnion(overlap)
            competingChangeSetIDs.append(candidate.id)
        }

        return AIRevertOverlapAnalysis(
            affectedFiles: affectedFiles,
            overlappingFiles: overlappingFiles.sorted(),
            competingChangeSetIDs: competingChangeSetIDs.sorted()
        )
    }

    func firstNonEmptyCandidate(_ candidates: String?...) -> String? {
        for candidate in candidates {
            guard let candidate else { continue }
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }

    func repositoriesOverlap(_ lhs: String?, _ rhs: String?) -> Bool {
        guard let left = normalizedWorkingDirectory(lhs),
              let right = normalizedWorkingDirectory(rhs) else {
            return false
        }

        let canonicalLeft = canonicalRepoIdentifier(for: left) ?? left
        let canonicalRight = canonicalRepoIdentifier(for: right) ?? right
        if canonicalLeft == canonicalRight {
            return true
        }

        return isSameOrDescendantPath(left, root: right)
            || isSameOrDescendantPath(right, root: left)
            || isSameOrDescendantPath(canonicalLeft, root: canonicalRight)
            || isSameOrDescendantPath(canonicalRight, root: canonicalLeft)
    }

    func isSameOrDescendantPath(_ candidate: String, root: String) -> Bool {
        guard !candidate.isEmpty, !root.isEmpty else {
            return false
        }
        if candidate == root {
            return true
        }
        if root == "/" {
            return candidate.hasPrefix("/")
        }
        return candidate.hasPrefix(root + "/")
    }
}
