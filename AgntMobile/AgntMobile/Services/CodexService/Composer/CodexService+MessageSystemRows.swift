// FILE: CodexService+MessageSystemRows.swift
// Purpose: Owns system, tool, plan, subagent, and structured-input timeline rows.
// Layer: Service
// Exports: CodexService system row helpers
// Depends on: CodexMessage, JSONValue

import Foundation

extension CodexService {

    func appendHiddenPushResetMarkers(
        threadId: String,
        workingDirectory: String?,
        branch: String,
        remote: String?
    ) {
        let normalizedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadID.isEmpty else {
            return
        }

        let normalizedWorkingDirectory = normalizeWorkingDirectoryForPushReset(workingDirectory)
        let relatedThreadIDs: [String]
        if let normalizedWorkingDirectory {
            relatedThreadIDs = threads
                .filter { normalizeWorkingDirectoryForPushReset($0.gitWorkingDirectory) == normalizedWorkingDirectory }
                .map(\.id)
        } else {
            relatedThreadIDs = []
        }

        let targetThreadIDs = Set(relatedThreadIDs + [normalizedThreadID])
        for targetThreadID in targetThreadIDs {
            appendSystemMessage(
                threadId: targetThreadID,
                text: TurnSessionDiffResetMarker.text(branch: branch, remote: remote),
                itemId: TurnSessionDiffResetMarker.manualPushItemID
            )
        }
    }

    // Appends one concise activity line into the active thinking row for a turn.
    func appendThinkingActivityLine(
        threadId: String,
        turnId: String?,
        line: String
    ) {
        let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLine.isEmpty else {
            return
        }
        let isTurnActive = isTurnActiveForThinkingActivity(threadId: threadId, turnId: turnId)

        let existingMessages = messagesByThread[threadId] ?? []
        let targetIndex = thinkingActivityTargetIndex(
            in: existingMessages,
            turnId: turnId
        )

        // Late activity lines can arrive after turn/completed without turnId.
        // If there is no existing thinking row to merge into, ignore them instead
        // of creating a new trailing thinking block below the final assistant reply.
        let hasExplicitTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        if !isTurnActive, targetIndex == nil, !hasExplicitTurnId {
            return
        }

        if let targetIndex {
            var threadMessages = existingMessages
            let existingText = threadMessages[targetIndex].text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !containsCaseInsensitiveLine(trimmedLine, in: existingText) else {
                return
            }

            let updatedText = existingText.isEmpty
                ? trimmedLine
                : "\(existingText)\n\(trimmedLine)"
            threadMessages[targetIndex].text = updatedText
            threadMessages[targetIndex].isStreaming = threadMessages[targetIndex].isStreaming || isTurnActive
            if threadMessages[targetIndex].turnId == nil, let turnId, !turnId.isEmpty {
                threadMessages[targetIndex].turnId = turnId
            }
            messagesByThread[threadId] = threadMessages
            persistMessages()
            updateStreamingSystemOutput(
                for: threadId,
                messageId: threadMessages[targetIndex].id,
                rawMessageIndex: targetIndex
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: trimmedLine,
            turnId: turnId,
            kind: .thinking,
            isStreaming: isTurnActive
        )
    }

    // Routes generic technical activity through its own compact system row instead of thinking.
    func appendToolActivityLine(
        threadId: String,
        turnId: String?,
        line: String
    ) {
        let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLine.isEmpty else {
            return
        }

        let isTurnActive = isTurnActiveForThinkingActivity(threadId: threadId, turnId: turnId)
        let existingMessages = messagesByThread[threadId] ?? []
        let targetIndex = toolActivityTargetIndex(in: existingMessages, turnId: turnId)

        let hasExplicitTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        if !isTurnActive, targetIndex == nil, !hasExplicitTurnId {
            return
        }

        if let targetIndex {
            var threadMessages = existingMessages
            let existingText = threadMessages[targetIndex].text
            let mergedText = mergeToolActivityText(
                existing: existingText,
                incoming: trimmedLine,
                isStreaming: isTurnActive
            )
            guard mergedText != existingText else {
                return
            }

            threadMessages[targetIndex].text = mergedText
            threadMessages[targetIndex].isStreaming = threadMessages[targetIndex].isStreaming || isTurnActive
            if threadMessages[targetIndex].turnId == nil, let turnId, !turnId.isEmpty {
                threadMessages[targetIndex].turnId = turnId
            }
            messagesByThread[threadId] = threadMessages
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: trimmedLine,
            turnId: turnId,
            kind: .toolActivity,
            isStreaming: isTurnActive
        )
    }

    // Reuses only the latest tool-activity row inside the current system segment so
    // late legacy events do not rewrite rows that now sit above assistant content.
    func toolActivityTargetIndex(in messages: [CodexMessage], turnId: String?) -> Int? {
        for index in messages.indices.reversed() {
            let candidate = messages[index]
            if candidate.role == .assistant || candidate.role == .user {
                break
            }

            guard candidate.role == .system, candidate.kind == .toolActivity else {
                continue
            }

            if let turnId, !turnId.isEmpty {
                if candidate.turnId == turnId || candidate.turnId == nil {
                    return index
                }
                continue
            }

            if candidate.isStreaming {
                return index
            }
        }

        return nil
    }

    private func normalizeWorkingDirectoryForPushReset(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        if trimmed == "/" {
            return trimmed
        }

        var normalized = trimmed
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }

        return normalized.isEmpty ? "/" : normalized
    }

    // Creates/updates a streaming system item message (thinking/toolActivity/fileChange/commandExecution).
    func upsertStreamingSystemItemMessage(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        text: String,
        isStreaming: Bool
    ) {
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        let syntheticItemId = resolvedTurnId.map { syntheticStreamingItemId(turnId: $0, kind: kind) }
        let syntheticKey = syntheticItemId.map { streamingItemMessageKey(threadId: threadId, itemId: $0) }
        let incomingFileChangePathKeys = kind == .fileChange
            ? normalizedFileChangePathKeys(from: text)
            : Set<String>()
        let incomingCommandKey = kind == .commandExecution
            ? commandExecutionPreviewKey(from: text)
            : nil
        let incomingToolActivityKey = kind == .toolActivity
            ? toolActivityPreviewKey(from: text)
            : nil
        let messageID: String?
        if let existingMessageID = streamingSystemMessageByItemID[key] {
            messageID = existingMessageID
        } else if let syntheticKey,
                  let migratedMessageID = streamingSystemMessageByItemID[syntheticKey] {
            // Rebind the synthetic turn key to the real item id once the server starts sending it.
            streamingSystemMessageByItemID[key] = migratedMessageID
            streamingSystemMessageByItemID.removeValue(forKey: syntheticKey)
            messageID = migratedMessageID
        } else if kind == .thinking,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  let existingMessageID = reusableProvisionalThinkingRowID(
                      threadId: threadId,
                      turnId: resolvedTurnId,
                      incomingItemId: itemId
                  ) {
            // Rollout mirrors aggregate a turn's reasoning under one synthetic
            // "rollout-thinking:" id while IPC mirrors stream real per-item ids.
            // When the live sources alternate mid-turn, rebind instead of
            // stacking a second "Thinking..." row for the same turn.
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else if kind == .commandExecution,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  let incomingCommandKey,
                  let existingMessageID = messagesByThread[threadId]?.reversed().first(where: { candidate in
                      guard candidate.role == .system,
                            candidate.kind == .commandExecution,
                            candidate.turnId == resolvedTurnId,
                            let candidateKey = commandExecutionPreviewKey(from: candidate.text) else {
                          return false
                      }
                      return candidateKey == incomingCommandKey
                  })?.id {
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else if kind == .toolActivity,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  let incomingToolActivityKey {
            let matchingRows = (messagesByThread[threadId] ?? []).filter { candidate in
                guard candidate.role == .system,
                      candidate.kind == .toolActivity,
                      candidate.turnId == resolvedTurnId,
                      let candidateKey = toolActivityPreviewKey(from: candidate.text),
                      canReuseLiveToolActivityRow(candidate, incomingItemId: itemId) else {
                    return false
                }
                return candidateKey == incomingToolActivityKey
            }

            if matchingRows.count == 1, let existingMessageID = matchingRows.first?.id {
                streamingSystemMessageByItemID[key] = existingMessageID
                if let syntheticKey {
                    streamingSystemMessageByItemID[syntheticKey] = existingMessageID
                }
                messageID = existingMessageID
            } else {
                messageID = nil
            }
        } else if kind == .fileChange,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  !incomingFileChangePathKeys.isEmpty,
                  let existingMessageID = messagesByThread[threadId]?.reversed().first(where: { candidate in
                      guard candidate.role == .system,
                            candidate.kind == .fileChange,
                            (candidate.turnId == resolvedTurnId
                                || (candidate.turnId == nil
                                    && turnlessFileChangeRowBelongsToTurn(candidate, threadId: threadId, turnId: resolvedTurnId))) else {
                          return false
                      }
                      let candidateKeys = normalizedFileChangePathKeys(from: candidate.text)
                      return !candidateKeys.isDisjoint(with: incomingFileChangePathKeys)
                  })?.id {
            // Some runtimes emit multiple file-change item ids for the same file in one turn.
            // Rebind them to one UI row keyed by path to avoid duplicate "Edited/Diff/Push" cards.
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else if kind == .fileChange,
                  let resolvedTurnId, !resolvedTurnId.isEmpty,
                  incomingFileChangePathKeys.isEmpty,
                  isFileChangeSnapshotPayload(text),
                  let existingMessageID = uniqueFileChangeMessageIDForTurn(
                      threadId: threadId,
                      turnId: resolvedTurnId,
                      allowsTurnlessFallback: true
                  ) {
            // Fallback: if payload has no extractable path and there's only one file-change row
            // in this turn, treat it as the same row instead of creating duplicates.
            streamingSystemMessageByItemID[key] = existingMessageID
            if let syntheticKey {
                streamingSystemMessageByItemID[syntheticKey] = existingMessageID
            }
            messageID = existingMessageID
        } else {
            messageID = nil
        }

        if let messageID,
           let index = findMessageIndex(threadId: threadId, messageId: messageID) {
            let incoming = text
            let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
            let isFileChangeSnapshot = kind == .fileChange
                && isFileChangeSnapshotPayload(incomingTrimmed)
            if !incomingTrimmed.isEmpty {
                let existing = messagesByThread[threadId]?[index].text ?? ""
                let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
                if kind == .commandExecution {
                    // Command status rows are snapshots ("running" -> "completed"), not deltas.
                    messagesByThread[threadId]?[index].text = incomingTrimmed
                } else if kind == .toolActivity {
                    messagesByThread[threadId]?[index].text = mergeToolActivityText(
                        existing: existing,
                        incoming: incoming,
                        isStreaming: isStreaming
                    )
                } else {
                    if isStreamingPlaceholder(incomingTrimmed, for: kind)
                        && !existingTrimmed.isEmpty
                        && !isStreamingPlaceholder(existingTrimmed, for: kind) {
                        // Ignore completion placeholders when we already have real streamed content.
                    } else if isStreamingPlaceholder(existingTrimmed, for: kind) {
                        // Replace placeholder labels with real content.
                        messagesByThread[threadId]?[index].text = incoming
                    } else if !isStreaming || isFileChangeSnapshot {
                        // Completed item payloads are authoritative snapshots; replace streamed deltas.
                        messagesByThread[threadId]?[index].text = incoming
                    } else {
                        let merged = mergeAssistantDelta(existingText: existing, incomingDelta: incoming)
                        messagesByThread[threadId]?[index].text = merged
                    }
                }
            }

            messagesByThread[threadId]?[index].kind = kind
            messagesByThread[threadId]?[index].isStreaming = isStreaming
            if let resolvedTurnId, messagesByThread[threadId]?[index].turnId == nil {
                messagesByThread[threadId]?[index].turnId = resolvedTurnId
            }
            if let syntheticItemId,
               messagesByThread[threadId]?[index].itemId == syntheticItemId {
                messagesByThread[threadId]?[index].itemId = itemId
            } else if messagesByThread[threadId]?[index].itemId == nil {
                messagesByThread[threadId]?[index].itemId = itemId
            } else if kind == .thinking,
                      Self.isProvisionalThinkingIdentifier(messagesByThread[threadId]?[index].itemId),
                      !Self.isProvisionalThinkingIdentifier(itemId) {
                // Adopt the real reasoning identity so a later real section opens
                // its own row instead of overwriting this one through the fallback.
                messagesByThread[threadId]?[index].itemId = itemId
            }
            if var threadMessages = messagesByThread[threadId],
               let refreshedIndex = threadMessages.indices.first(where: { threadMessages[$0].id == messageID }) {
                let keepID = threadMessages[refreshedIndex].id
                var finalRawIndex: Int?
                if let resolvedTurnId {
                    if kind == .fileChange {
                        pruneDuplicateSystemRows(
                            in: &threadMessages,
                            keepIndex: refreshedIndex,
                            kind: .fileChange,
                            turnId: resolvedTurnId,
                            fileChangePathKeys: incomingFileChangePathKeys,
                            isAuthoritativeFileChangeSnapshot: isFileChangeSnapshot
                        )
                    } else if kind == .commandExecution,
                              let incomingCommandKey {
                        pruneDuplicateSystemRows(
                            in: &threadMessages,
                            keepIndex: refreshedIndex,
                            kind: .commandExecution,
                            turnId: resolvedTurnId,
                            commandKey: incomingCommandKey
                        )
                    } else if kind == .toolActivity,
                              let incomingToolActivityKey {
                        pruneDuplicateSystemRows(
                            in: &threadMessages,
                            keepIndex: refreshedIndex,
                            kind: .toolActivity,
                            turnId: resolvedTurnId,
                            toolActivityKey: incomingToolActivityKey
                        )
                    }
                }
                if let finalIndex = threadMessages.indices.first(where: { threadMessages[$0].id == keepID }) {
                    if kind == .fileChange {
                        // File-change cards are intentionally trailed; other activity keeps
                        // its original slot so late completion refreshes do not jump below the answer.
                        threadMessages[finalIndex].orderIndex = CodexMessageOrderCounter.next()
                    }
                    finalRawIndex = finalIndex
                }
                threadMessages.sort(by: { $0.orderIndex < $1.orderIndex })
                finalRawIndex = threadMessages.indices.first(where: { threadMessages[$0].id == keepID }) ?? finalRawIndex
                messagesByThread[threadId] = threadMessages
                persistMessages()
                if kind == .thinking, isStreaming, let finalRawIndex {
                    updateStreamingSystemOutput(for: threadId, messageId: keepID, rawMessageIndex: finalRawIndex)
                } else {
                    updateCurrentOutput(for: threadId)
                }
                return
            }
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let initialText = text
        let initialTrimmed = initialText.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackText: String
        if !initialTrimmed.isEmpty {
            fallbackText = initialText
        } else {
            fallbackText = streamingPlaceholderText(for: kind)
        }

        let message = CodexMessage(
            threadId: threadId,
            role: .system,
            kind: kind,
            text: fallbackText,
            turnId: resolvedTurnId,
            itemId: itemId,
            isStreaming: isStreaming,
            deliveryState: .confirmed
        )

        streamingSystemMessageByItemID[key] = message.id
        appendMessage(message)
    }

    func normalizedFileChangePathKeys(from text: String) -> Set<String> {
        let inlineTotalsRegex = try? NSRegularExpression(
            pattern: #"\s*[+\u{FF0B}]\s*\d+\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*\d+\s*$"#
        )
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var keys: Set<String> = []

        for line in lines {
            var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                trimmed = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if trimmed.lowercased().hasPrefix("path:") {
                let rawPath = trimmed.dropFirst("Path:".count).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("+++ ") || trimmed.hasPrefix("--- ") {
                let rawPath = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("diff --git ") {
                let components = trimmed.split(separator: " ", omittingEmptySubsequences: true)
                if components.count >= 4 {
                    keys.formUnion(normalizedFileChangePathAliases(from: String(components[3])))
                }
                continue
            }

            let lowercased = trimmed.lowercased()
            let actionVerbs = [
                "edited ",
                "updated ",
                "added ",
                "created ",
                "deleted ",
                "removed ",
                "renamed ",
                "moved ",
            ]
            if let verb = actionVerbs.first(where: { lowercased.hasPrefix($0) }) {
                var rawPath = String(trimmed.dropFirst(verb.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let inlineTotalsRegex {
                    let range = NSRange(location: 0, length: (rawPath as NSString).length)
                    rawPath = inlineTotalsRegex.stringByReplacingMatches(
                        in: rawPath,
                        range: range,
                        withTemplate: ""
                    ).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
            }
        }

        return keys
    }

    private func normalizedFileChangePathAliases(from rawPath: String) -> Set<String> {
        guard let normalized = normalizeFileChangePathKey(rawPath) else {
            return Set<String>()
        }

        var aliases: Set<String> = [normalized]
        let components = normalized.split(separator: "/", omittingEmptySubsequences: true)
        if let workspaceIndex = components.firstIndex(where: { $0 == "workspace" }),
           components.count > workspaceIndex + 2 {
            let relative = components[(workspaceIndex + 2)...].joined(separator: "/")
            if !relative.isEmpty {
                aliases.insert(relative)
            }
        }
        return aliases
    }

    private func normalizeFileChangePathKey(_ rawPath: String) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty { return nil }
        if normalized == "/dev/null" { return nil }

        normalized = normalized.replacingOccurrences(of: "`", with: "")
        normalized = normalized.replacingOccurrences(of: "\"", with: "")
        normalized = normalized.replacingOccurrences(of: "'", with: "")
        if normalized.hasPrefix("("), normalized.hasSuffix(")"), normalized.count > 2 {
            normalized = String(normalized.dropFirst().dropLast())
        }

        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        if let range = normalized.range(
            of: #":\d+(?::\d+)?$"#,
            options: .regularExpression
        ) {
            normalized.removeSubrange(range)
        }

        while let last = normalized.last, ",.;".contains(last) {
            normalized.removeLast()
        }

        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        return normalized.lowercased()
    }

    private func commandExecutionPreviewKey(from text: String) -> String? {
        let tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard tokens.count >= 2 else {
            return nil
        }
        let phase = tokens[0].lowercased()
        guard phase == "running"
            || phase == "completed"
            || phase == "failed"
            || phase == "stopped" else {
            return nil
        }
        let command = tokens.dropFirst().joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return command.isEmpty ? nil : command
    }

    // Uses normalized visible lines so live/history tool rows can rebind without
    // relying on fragile placeholder text or raw item ids.
    private func toolActivityPreviewKey(from text: String) -> String? {
        let lines = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter {
                !$0.isEmpty
                    && !isStreamingPlaceholder($0, for: .toolActivity)
            }
            .map { $0.lowercased() }

        guard !lines.isEmpty else {
            return nil
        }

        return lines.joined(separator: "\n")
    }

    // Desktop mirrors can race two reasoning identities for one turn: the IPC
    // follower streams real per-item ids while the rollout tail aggregates the
    // turn under one synthetic "rollout-thinking:" id. Rebinding is only safe
    // when one side is provisional; two distinct real ids stay separate sections.
    private func reusableProvisionalThinkingRowID(
        threadId: String,
        turnId: String,
        incomingItemId: String
    ) -> String? {
        guard let candidate = messagesByThread[threadId]?.last(where: { message in
            message.role == .system
                && message.kind == .thinking
                && message.turnId == turnId
        }) else {
            return nil
        }
        guard Self.isProvisionalThinkingIdentifier(incomingItemId)
                || Self.isProvisionalThinkingIdentifier(candidate.itemId) else {
            return nil
        }
        return candidate.id
    }

    // Allows text-based reuse only for provisional rows; stable item ids must stay distinct.
    private func canReuseLiveToolActivityRow(_ candidate: CodexMessage, incomingItemId: String) -> Bool {
        let candidateItemId = normalizedStreamingItemID(candidate.itemId)
        let incomingItemId = normalizedStreamingItemID(incomingItemId)

        if let candidateItemId, let incomingItemId, candidateItemId == incomingItemId {
            return true
        }

        return !Self.hasStableToolActivityIdentity(candidateItemId)
    }

    func isFileChangeSnapshotPayload(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let lowered = trimmed.lowercased()
        if lowered.hasPrefix("status:") {
            return true
        }

        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var hasPath = false
        var hasKind = false
        var hasTotals = false
        var hasDiffFence = false
        var hasDiffHeader = false

        for line in lines {
            let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = candidate.lowercased()
            if lower.hasPrefix("path:") { hasPath = true }
            if lower.hasPrefix("kind:") { hasKind = true }
            if lower.hasPrefix("totals:") { hasTotals = true }
            if candidate.hasPrefix("`@agnt``diff") || candidate == "`@agnt``" { hasDiffFence = true }
            if candidate.hasPrefix("diff --git ")
                || candidate.hasPrefix("+++ ")
                || candidate.hasPrefix("--- ")
                || candidate.hasPrefix("@@ ") {
                hasDiffHeader = true
            }
        }

        if hasPath && hasKind {
            return true
        }
        if hasPath && (hasTotals || hasDiffFence || hasDiffHeader) {
            return true
        }
        if hasDiffFence && hasDiffHeader {
            return true
        }

        return false
    }

    // Coalesces generic tool activity lines so the timeline keeps one stable row per tool item.
    func mergeToolActivityText(existing: String, incoming: String, isStreaming: Bool) -> String {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)

        if incomingTrimmed.isEmpty {
            return existingTrimmed
        }
        if existingTrimmed.isEmpty || isStreamingPlaceholder(existingTrimmed, for: .toolActivity) {
            return incomingTrimmed
        }
        if isStreamingPlaceholder(incomingTrimmed, for: .toolActivity) {
            return existingTrimmed
        }

        let incomingLines = incomingTrimmed
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !incomingLines.isEmpty else {
            return existingTrimmed
        }

        var mergedLines = existingTrimmed
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for line in incomingLines where !mergedLines.contains(where: {
            $0.caseInsensitiveCompare(line) == .orderedSame
        }) {
            if !isStreaming,
               let existingIndex = mergedLines.firstIndex(where: { candidate in
                   let existingTokens = candidate.split(whereSeparator: \.isWhitespace)
                   let incomingTokens = line.split(whereSeparator: \.isWhitespace)
                   guard existingTokens.count >= 2, incomingTokens.count >= 2 else {
                       return false
                   }
                   return existingTokens.dropFirst().joined(separator: " ")
                       .caseInsensitiveCompare(incomingTokens.dropFirst().joined(separator: " ")) == .orderedSame
               }) {
                mergedLines[existingIndex] = line
            } else {
                mergedLines.append(line)
            }
        }

        return mergedLines.isEmpty ? incomingTrimmed : mergedLines.joined(separator: "\n")
    }

    func uniqueFileChangeMessageIDForTurn(
        threadId: String,
        turnId: String,
        allowsTurnlessFallback: Bool = false
    ) -> String? {
        let candidates = (messagesByThread[threadId] ?? []).filter { candidate in
            candidate.role == .system
                && candidate.kind == .fileChange
                && (
                    candidate.turnId == turnId
                        || (allowsTurnlessFallback
                            && candidate.turnId == nil
                            && turnlessFileChangeRowBelongsToTurn(candidate, threadId: threadId, turnId: turnId))
                )
        }
        guard candidates.count == 1 else {
            return nil
        }
        return candidates[0].id
    }

    func turnlessFileChangeRowBelongsToTurn(
        _ candidate: CodexMessage,
        threadId: String,
        turnId: String
    ) -> Bool {
        guard let messages = messagesByThread[threadId],
              let candidateIndex = messages.firstIndex(where: { $0.id == candidate.id }) else {
            return false
        }
        return Self.turnlessFileChangeRowIsClaimable(
            in: messages,
            candidateIndex: candidateIndex,
            turnId: turnId,
            turnBlockRange: Self.contiguousTurnBlockRange(in: messages, turnId: turnId)
        )
    }

    func pruneDuplicateSystemRows(
        in threadMessages: inout [CodexMessage],
        keepIndex: Int,
        kind: CodexMessageKind,
        turnId: String,
        fileChangePathKeys: Set<String> = Set<String>(),
        isAuthoritativeFileChangeSnapshot: Bool = false,
        commandKey: String? = nil,
        toolActivityKey: String? = nil
    ) {
        guard threadMessages.indices.contains(keepIndex) else { return }
        let keepID = threadMessages[keepIndex].id
        let keepText = threadMessages[keepIndex].text.trimmingCharacters(in: .whitespacesAndNewlines)
        let turnBlockRange = Self.contiguousTurnBlockRange(in: threadMessages, turnId: turnId)
        let prunableTurnlessIDs = Set(threadMessages.indices.compactMap { index -> String? in
            guard let turnBlockRange,
                  turnBlockRange.contains(index),
                  threadMessages[index].turnId == nil else {
                return nil
            }
            return threadMessages[index].id
        })

        threadMessages.removeAll { candidate in
            guard candidate.id != keepID,
                  candidate.role == .system,
                  candidate.kind == kind else {
                return false
            }

            if kind == .fileChange {
                let sameTurn = candidate.turnId == turnId
                let canPruneTurnlessFallback = isAuthoritativeFileChangeSnapshot
                    && candidate.turnId == nil
                    && prunableTurnlessIDs.contains(candidate.id)
                guard sameTurn || canPruneTurnlessFallback else {
                    return false
                }

                if !fileChangePathKeys.isEmpty {
                    let candidateKeys = normalizedFileChangePathKeys(from: candidate.text)
                    if isAuthoritativeFileChangeSnapshot {
                        return candidateKeys.isSubset(of: fileChangePathKeys)
                    }
                    return !candidateKeys.isDisjoint(with: fileChangePathKeys)
                }
                return candidate.text.trimmingCharacters(in: .whitespacesAndNewlines) == keepText
            }

            guard candidate.turnId == turnId else {
                return false
            }

            if kind == .commandExecution, let commandKey {
                return commandExecutionPreviewKey(from: candidate.text) == commandKey
            }

            if kind == .toolActivity, let toolActivityKey {
                return toolActivityPreviewKey(from: candidate.text) == toolActivityKey
            }

            return false
        }
    }

    // Appends deltas to an existing system item message.
    func appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        // Preserve token-leading spaces from server deltas (for example Markdown words split by stream).
        guard !delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        enqueueStreamingSystemItemDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            delta: delta
        )
    }

    // Buffers reasoning/system deltas so thinking rows do not force one UI refresh per token.
    private func enqueueStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        if pendingSystemDeltasByKey[key] == nil {
            pendingSystemDeltasByKey[key] = PendingSystemStreamingDeltas(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                kind: kind,
                deltas: []
            )
        }
        pendingSystemDeltasByKey[key]?.deltas.append(delta)

        guard systemDeltaFlushTasksByKey[key] == nil else { return }
        systemDeltaFlushTasksByKey[key] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: StreamingDeltaCoalescingPolicy.flushDelayNanoseconds)
            guard !Task.isCancelled else { return }
            self?.flushPendingSystemDeltas(forKey: key)
        }
    }

    private func applyStreamingSystemDeltas(_ pending: PendingSystemStreamingDeltas) {
        upsertStreamingSystemItemMessage(
            threadId: pending.threadId,
            turnId: pending.turnId,
            itemId: pending.itemId,
            kind: pending.kind,
            text: pending.deltas.joined(),
            isStreaming: true
        )
    }

    func flushPendingSystemDeltas(threadId: String, itemId: String) {
        flushPendingSystemDeltas(forKey: streamingItemMessageKey(threadId: threadId, itemId: itemId))
    }

    func flushPendingSystemDeltasForTurn(threadId: String, turnId: String?) {
        let keys = pendingSystemDeltasByKey
            .filter { _, pending in
                guard pending.threadId == threadId else { return false }
                guard let turnId else { return true }
                return pending.turnId == turnId
            }
            .map(\.key)
        for key in keys {
            flushPendingSystemDeltas(forKey: key)
        }
    }

    private func flushPendingSystemDeltas(forKey key: String) {
        systemDeltaFlushTasksByKey[key]?.cancel()
        systemDeltaFlushTasksByKey.removeValue(forKey: key)
        guard let pending = pendingSystemDeltasByKey.removeValue(forKey: key) else {
            return
        }
        applyStreamingSystemDeltas(pending)
    }

    func flushAllPendingStreamingDeltas() {
        flushPendingAssistantDeltas()
        for key in Array(pendingSystemDeltasByKey.keys) {
            flushPendingSystemDeltas(forKey: key)
        }
    }

    func cancelPendingStreamingDeltaFlushes(for threadId: String) {
        let assistantStreamIDs = pendingAssistantDeltaContextByStreamID
            .filter { $0.value.threadId == threadId }
            .map(\.key)
        for streamID in assistantStreamIDs {
            pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
            pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
            pendingAssistantDeltaStreamOrder.removeAll { $0 == streamID }
        }
        if pendingAssistantDeltaByStreamID.isEmpty {
            pendingAssistantDeltaFlushTask?.cancel()
            pendingAssistantDeltaFlushTask = nil
        }

        let systemKeys = pendingSystemDeltasByKey
            .filter { $0.value.threadId == threadId }
            .map(\.key)
        for key in systemKeys {
            systemDeltaFlushTasksByKey[key]?.cancel()
            systemDeltaFlushTasksByKey.removeValue(forKey: key)
            pendingSystemDeltasByKey.removeValue(forKey: key)
        }
    }

    func cancelAllPendingStreamingDeltaFlushes() {
        pendingAssistantDeltaFlushTask?.cancel()
        pendingAssistantDeltaFlushTask = nil
        pendingAssistantDeltaByStreamID.removeAll()
        pendingAssistantDeltaContextByStreamID.removeAll()
        pendingAssistantDeltaStreamOrder.removeAll()
        systemDeltaFlushTasksByKey.values.forEach { $0.cancel() }
        systemDeltaFlushTasksByKey.removeAll()
        pendingSystemDeltasByKey.removeAll()
    }

    // Merges a late reasoning delta into an existing thinking row without reopening streaming state.
    // Returns true when a matching row was found and updated.
    func mergeLateReasoningDeltaIfPossible(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String
    ) -> Bool {
        let trimmedDelta = delta.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDelta.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return false
        }

        let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)

        let targetIndex: Int? = {
            if let normalizedItemId, !normalizedItemId.isEmpty {
                if let index = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.itemId == normalizedItemId
                }) {
                    return index
                }
            }

            if let normalizedTurnId, !normalizedTurnId.isEmpty {
                return threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.turnId == normalizedTurnId
                })
            }

            return nil
        }()

        guard let targetIndex else {
            return false
        }

        let existingText = threadMessages[targetIndex].text
        threadMessages[targetIndex].text = mergeAssistantDelta(
            existingText: existingText,
            incomingDelta: delta
        )
        threadMessages[targetIndex].isStreaming = false
        if threadMessages[targetIndex].turnId == nil,
           let normalizedTurnId, !normalizedTurnId.isEmpty {
            threadMessages[targetIndex].turnId = normalizedTurnId
        }
        if threadMessages[targetIndex].itemId == nil,
           let normalizedItemId, !normalizedItemId.isEmpty {
            threadMessages[targetIndex].itemId = normalizedItemId
        }

        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Uses a stable synthetic item id when server deltas miss itemId.
    func appendStreamingSystemTurnDelta(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        appendStreamingSystemItemDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            delta: delta
        )
    }

    // Upserts synthetic turn-based stream entries when no itemId exists.
    func upsertStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        text: String,
        isStreaming: Bool
    ) {
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text,
            isStreaming: isStreaming
        )
    }

    // Finalizes a system item message when the item completes.
    func completeStreamingSystemItemMessage(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        text: String?
    ) {
        flushPendingSystemDeltas(threadId: threadId, itemId: itemId)
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        let completedMessageID = streamingSystemMessageByItemID[key]
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            text: text ?? "",
            isStreaming: false
        )

        if let messageID = completedMessageID ?? streamingSystemMessageByItemID[key],
           let index = findMessageIndex(threadId: threadId, messageId: messageID) {
            messagesByThread[threadId]?[index].isStreaming = false
            messagesByThread[threadId]?[index].kind = kind

            if kind == .toolActivity,
               let finalText = messagesByThread[threadId]?[index].text,
               isStreamingPlaceholder(finalText, for: .toolActivity) {
                messagesByThread[threadId]?.removeAll { $0.id == messageID }
                updateCurrentOutput(for: threadId)
            }

            persistMessages()
        }

        if let completedMessageID = completedMessageID ?? streamingSystemMessageByItemID[key] {
            streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, value in
                value != completedMessageID
            }
        } else {
            streamingSystemMessageByItemID.removeValue(forKey: key)
        }
    }

    // Completes synthetic turn-based stream entries when no itemId exists.
    func completeStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        text: String?
    ) {
        completeStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text
        )
    }
}
