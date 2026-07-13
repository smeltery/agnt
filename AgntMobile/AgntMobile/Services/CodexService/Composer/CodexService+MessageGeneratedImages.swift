// FILE: CodexService+MessageGeneratedImages.swift
// Purpose: Owns generated-image assistant row merging and replay reconciliation.
// Layer: Service
// Exports: CodexService generated-image message helpers
// Depends on: CodexMessage

import Foundation

extension CodexService {
    func appendGeneratedImageReference(
        threadId: String,
        turnId: String?,
        itemId: String?,
        imagePath: String
    ) {
        let trimmedPath = imagePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            return
        }

        let resolvedTurnId = normalizedStreamingItemID(turnId) ?? activeTurnIdByThread[threadId]
        let resolvedItemId = normalizedStreamingItemID(itemId)
        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let markdown = "![Generated image](\(Self.markdownImagePath(trimmedPath)))"
        if var threadMessages = messagesByThread[threadId],
           let mergeTarget = generatedImageMergeTarget(
               in: threadMessages,
               turnId: resolvedTurnId,
               itemId: resolvedItemId,
               imagePath: trimmedPath,
               markdown: markdown
           ) {
            let existingIndex = mergeTarget.index
            var existing = threadMessages[existingIndex]
            if !existing.text.contains(trimmedPath) && !existing.text.contains(markdown) {
                existing.text = existing.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? markdown
                    : "\(existing.text)\n\n\(markdown)"
            }
            existing.isStreaming = false
            if existing.turnId == nil {
                existing.turnId = resolvedTurnId
            }
            if mergeTarget.canAdoptImageItemId, existing.itemId == nil {
                existing.itemId = resolvedItemId
            }
            threadMessages[existingIndex] = existing
            messagesByThread[threadId] = threadMessages
            refreshDerivedPlanMetadata(threadId: threadId, messageIndex: existingIndex)
        } else {
            let message = CodexMessage(
                id: Self.stableAssistantMessageID(threadId: threadId, turnId: resolvedTurnId, itemId: resolvedItemId)
                    ?? UUID().uuidString,
                threadId: threadId,
                role: .assistant,
                text: markdown,
                turnId: resolvedTurnId,
                itemId: resolvedItemId,
                isStreaming: false,
                deliveryState: .confirmed
            )
            appendMessage(message)
            return
        }

        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    private struct GeneratedImageMergeTarget {
        let index: Int
        let canAdoptImageItemId: Bool
    }

    private func generatedImageMergeTarget(
        in threadMessages: [CodexMessage],
        turnId: String?,
        itemId: String?,
        imagePath: String,
        markdown: String
    ) -> GeneratedImageMergeTarget? {
        if let sameItemIndex = threadMessages.indices.reversed().first(where: { index in
            let candidate = threadMessages[index]
            return candidate.role == .assistant && itemId != nil && candidate.itemId == itemId
        }) {
            return GeneratedImageMergeTarget(index: sameItemIndex, canAdoptImageItemId: true)
        }

        if let sameImageIndex = threadMessages.indices.reversed().first(where: { index in
            let candidate = threadMessages[index]
            return candidate.role == .assistant
                && (candidate.text.contains(imagePath) || candidate.text.contains(markdown))
        }) {
            return GeneratedImageMergeTarget(index: sameImageIndex, canAdoptImageItemId: false)
        }

        // Late image-generation events can arrive after the final prose item, so attach them
        // to the visible assistant answer without stealing that row's item-scoped identity.
        guard let turnId else {
            return nil
        }
        guard let fallbackIndex = threadMessages.indices.reversed().first(where: { index in
            let candidate = threadMessages[index]
            return candidate.role == .assistant
                && candidate.kind == .chat
                && candidate.turnId == turnId
                && Self.isFinalAnswerAssistantPhase(candidate.assistantPhase)
                && !candidate.isStreaming
                && !Self.isGeneratedImageArtifactOnly(candidate.text)
                && !candidate.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) else {
            return nil
        }
        return GeneratedImageMergeTarget(index: fallbackIndex, canAdoptImageItemId: false)
    }

    // Folds image-generation artifact rows into the final assistant text for the same turn.
    func mergeGeneratedImageArtifactsIntoAssistantMessage(
        threadId: String,
        turnId: String?,
        assistantMessageId: String
    ) -> Bool {
        guard let resolvedTurnId = turnId,
              var threadMessages = messagesByThread[threadId],
              let targetIndex = threadMessages.firstIndex(where: { $0.id == assistantMessageId }) else {
            return false
        }

        let artifactMessages = threadMessages.filter { candidate in
            candidate.id != assistantMessageId
                && candidate.role == .assistant
                && candidate.turnId == resolvedTurnId
                && Self.isGeneratedImageArtifactOnly(candidate.text)
        }
        guard !artifactMessages.isEmpty else {
            return false
        }

        var targetMessage = threadMessages[targetIndex]
        var mergedText = targetMessage.text.trimmingCharacters(in: .whitespacesAndNewlines)
        for artifact in artifactMessages {
            let artifactText = artifact.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !artifactText.isEmpty, !mergedText.contains(artifactText) else {
                continue
            }
            mergedText = mergedText.isEmpty ? artifactText : "\(mergedText)\n\n\(artifactText)"
        }
        targetMessage.text = mergedText
        targetMessage.isStreaming = false
        if targetMessage.turnId == nil {
            targetMessage.turnId = resolvedTurnId
        }

        let artifactIds = Set(artifactMessages.map(\.id))
        threadMessages.removeAll { artifactIds.contains($0.id) }
        guard let updatedTargetIndex = threadMessages.firstIndex(where: { $0.id == assistantMessageId }) else {
            return false
        }
        threadMessages[updatedTargetIndex] = targetMessage
        messagesByThread[threadId] = threadMessages
        refreshDerivedPlanMetadata(threadId: threadId, messageIndex: updatedTargetIndex)
        return true
    }

    private static func isGeneratedImageArtifactOnly(_ text: String) -> Bool {
        let imageReferences = AssistantMarkdownImageReferenceParser.references(in: text)
        guard !imageReferences.isEmpty,
              imageReferences.allSatisfy(\.isCodexGeneratedImage) else {
            return false
        }

        return AssistantMarkdownImageReferenceParser
            .visibleTextRemovingImageSyntax(from: text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
    }

    private static func isFinalAnswerAssistantPhase(_ phase: String?) -> Bool {
        phase == "final_answer"
    }

    @discardableResult
    func applyAssistantPhaseIfNeeded(
        threadId: String,
        messageId: String,
        assistantPhase: String?
    ) -> Bool {
        guard let messageIndex = findMessageIndex(threadId: threadId, messageId: messageId) else {
            return false
        }
        return applyAssistantPhaseIfNeeded(
            threadId: threadId,
            messageIndex: messageIndex,
            assistantPhase: assistantPhase
        )
    }

    @discardableResult
    func applyAssistantPhaseIfNeeded(
        threadId: String,
        messageIndex: Int,
        assistantPhase: String?
    ) -> Bool {
        guard let phase = normalizedAssistantPhase(assistantPhase),
              messagesByThread[threadId]?.indices.contains(messageIndex) == true,
              messagesByThread[threadId]?[messageIndex].role == .assistant else {
            return false
        }

        let currentPhase = messagesByThread[threadId]?[messageIndex].assistantPhase
        guard currentPhase == nil || Self.isFinalAnswerAssistantPhase(phase) else {
            return false
        }

        messagesByThread[threadId]?[messageIndex].assistantPhase = phase
        return true
    }

    // Canonical item completions replace prose, but turn-scoped image previews may
    // already be visible in the same bubble and must survive that replacement.
    static func assistantCompletionTextPreservingImages(
        existingText: String,
        canonicalText: String
    ) -> String {
        let trimmedCanonicalText = canonicalText.trimmingCharacters(in: .whitespacesAndNewlines)
        let existingImageReferences = AssistantMarkdownImageReferenceParser.references(in: existingText)
            .filter(\.isCodexGeneratedImage)
        guard !existingImageReferences.isEmpty else {
            return trimmedCanonicalText
        }

        var preservedText = trimmedCanonicalText
        let canonicalImagePaths = Set(
            AssistantMarkdownImageReferenceParser.references(in: trimmedCanonicalText).map(\.path)
        )
        var appendedImagePaths = canonicalImagePaths

        for reference in existingImageReferences where !appendedImagePaths.contains(reference.path) {
            let altText = reference.altText.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = altText.isEmpty ? "Generated image" : altText
            let markdown = "![\(label)](\(Self.markdownImagePath(reference.path)))"
            preservedText = preservedText.isEmpty ? markdown : "\(preservedText)\n\n\(markdown)"
            appendedImagePaths.insert(reference.path)
        }

        return preservedText
    }

    // Suppresses completion replays that resend the whole assistant block already shown around tool rows.
    func absorbAssistantBlockReplayCompletion(
        threadId: String,
        turnId: String?,
        text: String
    ) -> String? {
        guard var threadMessages = messagesByThread[threadId] else {
            return nil
        }

        if let exactReplayIndex = AssistantReplayDeduper.exactReplayMessageIndex(
            in: threadMessages,
            threadId: threadId,
            turnId: turnId,
            text: text
        ) {
            var didMutate = false
            if threadMessages[exactReplayIndex].isStreaming {
                threadMessages[exactReplayIndex].isStreaming = false
                didMutate = true
            }
            if threadMessages[exactReplayIndex].turnId == nil, let turnId {
                threadMessages[exactReplayIndex].turnId = turnId
                didMutate = true
            }
            if didMutate {
                messagesByThread[threadId] = threadMessages
            }
            return threadMessages[exactReplayIndex].id
        }

        if let imageMergedReplay = imageMergedReplayMessage(
            in: threadMessages,
            threadId: threadId,
            turnId: turnId,
            text: text
        ) {
            let existingText = threadMessages[imageMergedReplay.index].text
            let canonicalText = Self.canonicalTextRemovingReplayedImagePreview(
                text,
                previewText: imageMergedReplay.previewText
            )
            threadMessages[imageMergedReplay.index].text = Self.assistantCompletionTextPreservingImages(
                existingText: existingText,
                canonicalText: canonicalText
            )
            threadMessages[imageMergedReplay.index].isStreaming = false
            if threadMessages[imageMergedReplay.index].turnId == nil, let turnId {
                threadMessages[imageMergedReplay.index].turnId = turnId
            }
            messagesByThread[threadId] = threadMessages
            refreshDerivedPlanMetadata(threadId: threadId, messageIndex: imageMergedReplay.index)
            return threadMessages[imageMergedReplay.index].id
        }

        guard let assistantIndices = AssistantReplayDeduper.blockReplayMessageIndices(
            in: threadMessages,
            threadId: threadId,
            turnId: turnId,
            text: text
        ),
        let terminalIndex = assistantIndices.last else {
            return nil
        }

        var didMutate = false
        for index in assistantIndices where threadMessages[index].isStreaming {
            threadMessages[index].isStreaming = false
            didMutate = true
        }
        if threadMessages[terminalIndex].turnId == nil, let turnId {
            threadMessages[terminalIndex].turnId = turnId
            didMutate = true
        }
        if didMutate {
            messagesByThread[threadId] = threadMessages
        }
        return threadMessages[terminalIndex].id
    }

    // Image generation can finish on a preparatory assistant row before the final
    // completion replays that same prose plus the terminal answer.
    private func imageMergedReplayMessage(
        in messages: [CodexMessage],
        threadId: String,
        turnId: String?,
        text: String
    ) -> (index: Int, previewText: String)? {
        let replayText = Self.normalizedMessageText(text)
        guard !replayText.isEmpty else {
            return nil
        }

        let normalizedTurnId = normalizedStreamingItemID(turnId)
        for index in messages.indices.reversed() {
            let candidate = messages[index]
            let imageReferences = AssistantMarkdownImageReferenceParser.references(in: candidate.text)
            guard candidate.role == .assistant,
                  candidate.threadId == threadId,
                  !candidate.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !imageReferences.isEmpty,
                  imageReferences.allSatisfy(\.isCodexGeneratedImage) else {
                continue
            }

            if let normalizedTurnId,
               let candidateTurnId = normalizedStreamingItemID(candidate.turnId),
               candidateTurnId != normalizedTurnId {
                continue
            }

            let candidateTextWithoutImages = AssistantMarkdownImageReferenceParser
                .visibleTextRemovingImageSyntax(from: candidate.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard candidateTextWithoutImages.count >= 24 else {
                continue
            }

            if replayText.contains(Self.normalizedMessageText(candidateTextWithoutImages)) {
                return (index, candidateTextWithoutImages)
            }
        }
        return nil
    }

    private static func canonicalTextRemovingReplayedImagePreview(_ text: String, previewText: String) -> String {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPreview = previewText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty,
              !trimmedPreview.isEmpty,
              let range = trimmedText.range(of: trimmedPreview) else {
            return trimmedText
        }

        let prunedText = (trimmedText[..<range.lowerBound] + trimmedText[range.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return prunedText.isEmpty ? trimmedText : prunedText
    }

    func imagePreviewAssistantCompletionIndex(
        threadId: String,
        turnId: String,
        itemId: String?,
        text: String
    ) -> Int? {
        guard itemId == nil else {
            return nil
        }

        let normalizedText = Self.normalizedMessageText(text)
        guard !normalizedText.isEmpty,
              let threadMessages = messagesByThread[threadId] else {
            return nil
        }

        return threadMessages.indices.reversed().first { index in
            let candidate = threadMessages[index]
            let imageReferences = AssistantMarkdownImageReferenceParser.references(in: candidate.text)
            guard candidate.role == .assistant,
                  candidate.threadId == threadId,
                  candidate.turnId == turnId,
                  !candidate.isStreaming,
                  Self.normalizedMessageText(candidate.text) != normalizedText,
                  !imageReferences.isEmpty,
                  imageReferences.allSatisfy(\.isCodexGeneratedImage) else {
                return false
            }

            if let itemId,
               let candidateItemId = normalizedStreamingItemID(candidate.itemId),
               candidateItemId == itemId {
                return false
            }

            return true
        }
    }

    func removeAssistantStreamingLookups(messageId: String) {
        streamingAssistantFallbackMessageByTurnID = streamingAssistantFallbackMessageByTurnID.filter { $0.value != messageId }
        streamingAssistantMessageByItemKey = streamingAssistantMessageByItemKey.filter { $0.value != messageId }
    }

    func assistantReplayTargetMessageId(
        in messages: [CodexMessage],
        threadId: String,
        turnId: String?,
        text: String,
        excludingMessageID: String
    ) -> String? {
        if let exactReplayIndex = AssistantReplayDeduper.exactReplayMessageIndex(
            in: messages,
            threadId: threadId,
            turnId: turnId,
            text: text,
            excludingMessageID: excludingMessageID
        ) {
            return messages[exactReplayIndex].id
        }

        guard let replayIndices = AssistantReplayDeduper.blockReplayMessageIndices(
            in: messages,
            threadId: threadId,
            turnId: turnId,
            text: text,
            excludingMessageID: excludingMessageID
        ) else {
            return nil
        }
        return replayIndices.last.map { messages[$0].id }
    }

    func knownAssistantTurnId(threadId: String, itemId: String) -> String? {
        messagesByThread[threadId]?.reversed().first(where: { message in
            message.role == .assistant
                && message.itemId == itemId
                && !(message.turnId ?? "").isEmpty
        })?.turnId
    }
}
