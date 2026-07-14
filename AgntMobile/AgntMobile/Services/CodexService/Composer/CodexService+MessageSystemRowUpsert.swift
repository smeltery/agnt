// FILE: CodexService+MessageSystemRowUpsert.swift
// Purpose: Streaming system row upsert and live-row reuse routing.
// Layer: Service

import Foundation

extension CodexService {
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

    func commandExecutionPreviewKey(from text: String) -> String? {
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
    func toolActivityPreviewKey(from text: String) -> String? {
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

}
