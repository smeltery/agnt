// FILE: TurnViewModel+QueueStorage.swift
// Purpose: Isolates queued-turn draft storage and optimistic row helpers.
// Layer: View Model
// Exports: TurnViewModel queue storage helpers
// Depends on: Foundation, CodexService

import Foundation

@MainActor
extension TurnViewModel {
    // Carries only autocomplete-confirmed file selections into the timeline renderer.
    func confirmedFileMentionPaths(from mentions: [TurnComposerMentionedFile]) -> [String] {
        var uniquePaths: [String] = []
        var seenPaths: Set<String> = []

        for mention in mentions {
            let path = mention.path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty, seenPaths.insert(path).inserted else {
                continue
            }
            uniquePaths.append(path)
        }

        return uniquePaths
    }

    func queuedDrafts(codex: CodexService, threadID: String) -> [QueuedTurnDraft] {
        codex.queuedTurnDraftsByThread[threadID] ?? []
    }

    func setQueuedDrafts(_ drafts: [QueuedTurnDraft], codex: CodexService, threadID: String) {
        if drafts.isEmpty {
            codex.queuedTurnDraftsByThread.removeValue(forKey: threadID)
            return
        }
        codex.queuedTurnDraftsByThread[threadID] = drafts
    }

    func appendQueuedDraft(_ draft: QueuedTurnDraft, codex: CodexService, threadID: String) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        drafts.append(draft)
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    // Shows queued follow-ups in the transcript immediately, then reuses the same row
    // when the queue flushes so the bubble does not duplicate at assistant completion.
    func preAppendQueuedDraftMessageIfNeeded(
        _ draft: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) -> QueuedTurnDraft {
        guard draft.preAppendedMessageID == nil else {
            return draft
        }

        let messageID = codex.appendUserMessage(
            threadId: threadID,
            text: draft.text,
            attachments: draft.attachments,
            fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
            skillMentions: draft.skillMentions.compactMap {
                let rawName = $0.name ?? $0.id
                let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            },
            pluginMentions: draft.mentionMentions.compactMap {
                let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            }
        )

        return messageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? draft
            : draft.withPreAppendedMessageID(messageID)
    }

    func removeQueuedDraftOptimisticMessageIfNeeded(
        _ draft: QueuedTurnDraft?,
        codex: CodexService,
        threadID: String
    ) {
        guard let messageID = draft?.preAppendedMessageID else {
            return
        }
        _ = codex.removeUserMessage(threadId: threadID, messageId: messageID)
    }

    func clearQueuedDraftOptimisticMessage(
        id: String,
        draft: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) {
        if let messageID = draft.preAppendedMessageID {
            _ = codex.removeUserMessage(threadId: threadID, messageId: messageID)
            replaceQueuedDraft(id: id, with: draft.withPreAppendedMessageID(nil), codex: codex, threadID: threadID)
            return
        }

        codex.removeLatestFailedUserMessage(
            threadId: threadID,
            matchingText: draft.text,
            matchingAttachments: draft.attachments
        )
    }

    func prependQueuedDraft(_ draft: QueuedTurnDraft, codex: CodexService, threadID: String) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        drafts.insert(draft, at: 0)
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    func replaceQueuedDraft(
        id: String,
        with replacement: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        guard let index = drafts.firstIndex(where: { $0.id == id }) else {
            return
        }
        drafts[index] = replacement
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    func dequeueQueuedDraft(codex: CodexService, threadID: String) -> QueuedTurnDraft? {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        guard !drafts.isEmpty else { return nil }
        let nextDraft = drafts.removeFirst()
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
        return nextDraft
    }

    func queuePauseState(codex: CodexService, threadID: String) -> QueuePauseState {
        codex.queuePauseStateByThread[threadID] ?? .active
    }

    func setQueuePauseState(_ state: QueuePauseState, codex: CodexService, threadID: String) {
        switch state {
        case .active:
            codex.queuePauseStateByThread.removeValue(forKey: threadID)
        case .paused:
            codex.queuePauseStateByThread[threadID] = state
        }
    }
}
