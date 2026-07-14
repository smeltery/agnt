// FILE: CodexService+IncomingDeltas.swift
// Purpose: Incoming streaming deltas and turn diff updates.
// Layer: Service
// Exports: CodexService incoming delta handlers

import Foundation

extension CodexService {
    func appendReasoningDelta(
        from paramsObject: IncomingParamsObject?,
        method: String
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        let delta: String
        if method == "item/reasoning/summaryPartAdded" {
            let summaryIndex = paramsObject["summaryIndex"]?.intValue
                ?? paramsObject["summary_index"]?.intValue
                ?? eventObject?["summaryIndex"]?.intValue
                ?? eventObject?["summary_index"]?.intValue
                ?? 0
            let embeddedDelta = extractTextDelta(from: paramsObject)
            delta = "\(summaryIndex > 0 ? "\n\n" : "")\(embeddedDelta)"
        } else {
            delta = extractTextDelta(from: paramsObject)
        }
        guard !delta.isEmpty else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let isReasoningTurnActive: Bool
        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            if activeTurnIdByThread[threadId] == resolvedTurnId {
                isReasoningTurnActive = true
            } else {
                isReasoningTurnActive = activeTurnIdByThread[threadId] == nil
                    && runningThreadIDs.contains(threadId)
            }
        } else {
            isReasoningTurnActive = activeTurnIdByThread[threadId] != nil
                || runningThreadIDs.contains(threadId)
        }
        if !isReasoningTurnActive {
            let lateItemId = extractItemID(from: paramsObject, eventObject: eventObject)
            _ = mergeLateReasoningDeltaIfPossible(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: lateItemId,
                delta: delta
            )
            return
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .thinking,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .thinking,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .thinking
        )
    }

    func appendFileChangeDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        let delta = extractTextDelta(from: paramsObject)
        guard !delta.isEmpty else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .fileChange
        )
    }

    func appendToolCallDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)
        let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject)

        let delta = extractTextDelta(from: paramsObject)
        guard !delta.isEmpty else { return }
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        guard isLikelyFileChangeToolCall(itemObject: itemObject, fallbackText: delta) else {
            let activityLines = extractToolCallActivityLines(from: delta)
            guard !activityLines.isEmpty else {
                return
            }
            let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)
            let activityText = activityLines.joined(separator: "\n")
            if let itemId, !itemId.isEmpty {
                appendStreamingSystemItemDelta(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    itemId: itemId,
                    kind: .toolActivity,
                    delta: activityText
                )
                return
            }
            if let resolvedTurnId, !resolvedTurnId.isEmpty {
                appendStreamingSystemTurnDelta(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    kind: .toolActivity,
                    delta: activityText
                )
                return
            }
            appendSystemMessage(
                threadId: threadId,
                text: activityText,
                turnId: resolvedTurnId,
                kind: .toolActivity
            )
            return
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .fileChange
        )
    }

    func handleTurnDiffUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject["event"]?.objectValue
        let diffCandidate = firstStringValue(in: paramsObject, keys: ["diff", "unified_diff"])
            ?? firstStringValue(in: eventObject, keys: ["diff", "unified_diff"])
            ?? firstStringValue(in: nestedEventObject, keys: ["diff", "unified_diff"])
        guard let diffText = normalizedUnifiedPatchPayload(diffCandidate ?? "") else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
            if shouldRecordTurnDiffChangeSet(threadId: threadId, turnId: turnId, diff: diffText) {
                recordTurnDiffChangeSet(threadId: threadId, turnId: turnId, diff: diffText)
            }
        }
    }

    func shouldRecordTurnDiffChangeSet(threadId: String, turnId: String, diff: String) -> Bool {
        let diffPaths = normalizedPatchPaths(from: diff)
        guard !diffPaths.isEmpty else {
            return false
        }

        let fileChangePaths = normalizedFileChangeEvidencePaths(threadId: threadId, turnId: turnId)
        guard !fileChangePaths.isEmpty else {
            return false
        }

        return diffPaths.isSubset(of: fileChangePaths)
    }

    func normalizedPatchPaths(from diff: String) -> Set<String> {
        Set(AIUnifiedPatchParser.analyze(diff).fileChanges.compactMap {
            normalizedTurnDiffPath($0.path)
        })
    }

    func normalizedFileChangeEvidencePaths(threadId: String, turnId: String) -> Set<String> {
        let fileChangeMessages = messagesByThread[threadId] ?? []
        return fileChangeMessages.reduce(into: Set<String>()) { paths, message in
            guard message.role == .system,
                  message.kind == .fileChange,
                  message.turnId == turnId else {
                return
            }

            for line in message.text.split(separator: "\n", omittingEmptySubsequences: false) {
                let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmedLine.lowercased().hasPrefix("path:") else { continue }
                let rawPath = String(trimmedLine.dropFirst("Path:".count))
                if let normalizedPath = normalizedTurnDiffPath(rawPath) {
                    paths.insert(normalizedPath)
                }
            }
        }
    }

    func normalizedTurnDiffPath(_ rawPath: String) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized != "/dev/null" else {
            return nil
        }

        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }

        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized.lowercased()
    }
}
