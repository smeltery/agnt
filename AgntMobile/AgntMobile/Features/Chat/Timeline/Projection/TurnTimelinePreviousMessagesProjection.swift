// FILE: TurnTimelinePreviousMessagesProjection.swift
// Purpose: Collapses completed-turn preamble rows behind previous-message disclosures.
// Layer: View Model / Projection
// Depends on: Foundation, CodexMessage, AssistantMarkdownImageReferenceParser

import Foundation

extension TurnTimelineRenderProjection {
    struct PreviousMessagesCollapse {
        let insertionIndex: Int
        let indices: [Int]
        let group: TurnTimelinePreviousMessagesGroup
        let replacementFinalMessage: CodexMessage?
    }


    // Finds completed final answers and the same-turn status/tool rows that should sit behind the disclosure.
    static func previousMessagesCollapsePlan(
        in messages: [CodexMessage],
        completedTurnIDs: Set<String>
    ) -> [Int: PreviousMessagesCollapse] {
        guard !completedTurnIDs.isEmpty else {
            return [:]
        }

        let resolvedFinalAssistantIndexByTurn = finalAssistantIndexByTurn(
            in: messages,
            completedTurnIDs: completedTurnIDs
        )
        var plan: [Int: PreviousMessagesCollapse] = [:]
        for (turnID, finalIndex) in resolvedFinalAssistantIndexByTurn {
            let lowerBound = lastUserIndexBefore(finalIndex, in: messages, turnID: turnID).map { $0 + 1 } ?? messages.startIndex
            let hiddenSelection = previousMessageSelection(
                in: messages,
                turnID: turnID,
                finalIndex: finalIndex,
                lowerBound: lowerBound
            )

            guard !hiddenSelection.hiddenIndices.isEmpty else {
                continue
            }

            let hiddenMessages = hiddenSelection.groupIndices
                .map { messages[$0] }
                .filter { !shouldSkipVisualRow($0) }
            let replacementFinalMessage = finalMessageReplacingCollapsedArtifacts(
                finalMessage: messages[finalIndex],
                collapsedMessages: hiddenMessages,
                generatedImageArtifacts: hiddenSelection.generatedImageArtifactIndices.map { messages[$0] }
            )
            plan[finalIndex] = PreviousMessagesCollapse(
                insertionIndex: lowerBound,
                indices: hiddenSelection.hiddenIndices,
                group: TurnTimelinePreviousMessagesGroup(
                    finalMessage: messages[finalIndex],
                    messages: hiddenMessages
                ),
                replacementFinalMessage: replacementFinalMessage
            )
        }

        return plan
    }

    static func finalAssistantIndexByTurn(
        in messages: [CodexMessage],
        completedTurnIDs: Set<String>
    ) -> [String: Int] {
        var preferredFinalIndexByTurn: [String: Int] = [:]
        var phasedFinalIndexByTurn: [String: Int] = [:]
        var fallbackFinalIndexByTurn: [String: Int] = [:]
        var turnsWithExplicitAssistantPhase = Set<String>()

        for index in messages.indices {
            let message = messages[index]
            guard message.role == .assistant,
                  !message.isStreaming,
                  !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let turnID = normalizedIdentifier(message.turnId),
                  completedTurnIDs.contains(turnID) else {
                continue
            }

            fallbackFinalIndexByTurn[turnID] = index
            if message.assistantPhase != nil {
                turnsWithExplicitAssistantPhase.insert(turnID)
            }
            if isFinalAnswerAssistantPhase(message.assistantPhase) {
                phasedFinalIndexByTurn[turnID] = index
            }
            if !isAssistantPriorityArtifactOnly(message) {
                preferredFinalIndexByTurn[turnID] = index
            }
        }

        var resolved = phasedFinalIndexByTurn
        for (turnID, index) in preferredFinalIndexByTurn where resolved[turnID] == nil {
            // If the stream carries explicit assistant phases, only a final_answer
            // phase is allowed to own the previous-message disclosure. Commentary
            // updates are live progress, not a final answer to collapse around.
            guard !turnsWithExplicitAssistantPhase.contains(turnID) else { continue }
            resolved[turnID] = index
        }
        for (turnID, index) in fallbackFinalIndexByTurn where resolved[turnID] == nil {
            guard !turnsWithExplicitAssistantPhase.contains(turnID) else { continue }
            resolved[turnID] = index
        }
        return resolved
    }

    struct PreviousMessageSelection {
        let hiddenIndices: [Int]
        let groupIndices: [Int]
        let generatedImageArtifactIndices: [Int]
    }

    static func previousMessageSelection(
        in messages: [CodexMessage],
        turnID: String,
        finalIndex: Int,
        lowerBound: Int
    ) -> PreviousMessageSelection {
        let finalMessage = messages[finalIndex]
        var hiddenIndices: [Int] = []
        var groupIndices: [Int] = []
        var generatedImageArtifactIndices: [Int] = []

        for index in messages.indices {
            guard index >= lowerBound, index != finalIndex else {
                continue
            }
            let candidate = messages[index]
            guard normalizedIdentifier(candidate.turnId) == turnID,
                  candidate.role != .user else {
                continue
            }

            if isGeneratedImageArtifactOnly(candidate) {
                hiddenIndices.append(index)
                generatedImageArtifactIndices.append(index)
                continue
            }

            if isReplayOfFinalAssistant(candidate, finalMessage: finalMessage) {
                hiddenIndices.append(index)
                if shouldPreserveReplayAsPreviousMessage(candidate, finalMessage: finalMessage) {
                    groupIndices.append(index)
                }
                continue
            }

            if !isPriorityVisibleMessage(candidate, finalMessage: finalMessage) {
                hiddenIndices.append(index)
                groupIndices.append(index)
            }
        }

        return PreviousMessageSelection(
            hiddenIndices: hiddenIndices,
            groupIndices: groupIndices,
            generatedImageArtifactIndices: generatedImageArtifactIndices
        )
    }

    static func lastUserIndexBefore(_ index: Int, in messages: [CodexMessage], turnID: String) -> Int? {
        messages.indices.reversed().first { candidateIndex in
            guard candidateIndex < index else {
                return false
            }
            let candidate = messages[candidateIndex]
            return candidate.role == .user
                && normalizedIdentifier(candidate.turnId) == turnID
        }
    }

    // Keeps user-critical artifacts visible beside the final answer instead of burying them in the disclosure.
    static func isPriorityVisibleMessage(_ message: CodexMessage, finalMessage: CodexMessage? = nil) -> Bool {
        if message.role == .system {
            switch message.kind {
            case .fileChange, .subagentAction, .userInputPrompt:
                return true
            case .autoApprovalReview:
                // Approved reviews are settled tool history. Keep reviews that
                // failed or may still need attention beside the final answer.
                return message.autoApprovalReview?.status != .approved
            case .plan:
                return message.shouldDisplayInlinePlanResult
            case .thinking, .toolActivity, .commandExecution, .chat:
                return false
            }
        }

        if let finalMessage,
           isGeneratedImageArtifactAlreadyInFinal(message, finalMessage: finalMessage) {
            return false
        }
        return isAssistantPriorityArtifactOnly(message)
    }

    static func isReplayOfFinalAssistant(_ message: CodexMessage, finalMessage: CodexMessage) -> Bool {
        guard message.role == .assistant,
              finalMessage.role == .assistant else {
            return false
        }

        if isCommentaryAssistantPhase(message.assistantPhase),
           isFinalAnswerAssistantPhase(finalMessage.assistantPhase) {
            return false
        }

        if isGeneratedImageArtifactAlreadyInFinal(message, finalMessage: finalMessage) {
            return true
        }

        let candidateText = normalizedVisibleAssistantText(message.text)
        let finalText = normalizedVisibleAssistantText(finalMessage.text)
        guard candidateText.count >= 24, finalText.count >= candidateText.count else {
            return false
        }
        return finalText == candidateText || finalText.contains(candidateText)
    }

    static func shouldPreserveReplayAsPreviousMessage(
        _ message: CodexMessage,
        finalMessage: CodexMessage
    ) -> Bool {
        if isCommentaryAssistantPhase(message.assistantPhase),
           isFinalAnswerAssistantPhase(finalMessage.assistantPhase) {
            return true
        }
        if isFinalAnswerAssistantPhase(message.assistantPhase) {
            return false
        }

        let candidateText = normalizedVisibleAssistantText(message.text)
        let finalText = normalizedVisibleAssistantText(finalMessage.text)
        guard candidateText.count >= 24,
              finalText.hasPrefix(candidateText),
              !looksLikeFinalAnswerText(candidateText) else {
            return false
        }
        return true
    }

    static func looksLikeFinalAnswerText(_ text: String) -> Bool {
        let lowered = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return lowered.hasPrefix("tldr")
            || lowered.hasPrefix("tl;dr")
            || lowered.hasPrefix("tl:dr")
            || lowered.hasPrefix("summary")
            || lowered.hasPrefix("final")
            || lowered.hasPrefix("done")
    }

    static func finalMessageReplacingCollapsedArtifacts(
        finalMessage: CodexMessage,
        collapsedMessages: [CodexMessage],
        generatedImageArtifacts: [CodexMessage]
    ) -> CodexMessage? {
        var replacement = finalMessage
        var replacementText = finalMessage.text.trimmingCharacters(in: .whitespacesAndNewlines)

        replacementText = collapsedMessages.reduce(replacementText) { text, collapsedMessage in
            guard collapsedMessage.role == .assistant else {
                return text
            }
            return textRemovingReplay(from: text, replayText: collapsedMessage.text)
        }

        var appendedImagePaths = Set(AssistantMarkdownImageReferenceParser.references(in: replacementText).map(\.path))
        let artifactTexts = generatedImageArtifacts.compactMap { artifact -> String? in
            let artifactText = artifact.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !artifactText.isEmpty else {
                return nil
            }

            let missingPaths = AssistantMarkdownImageReferenceParser.references(in: artifactText)
                .map(\.path)
                .filter { !appendedImagePaths.contains($0) }
            guard !missingPaths.isEmpty else {
                return nil
            }

            missingPaths.forEach { appendedImagePaths.insert($0) }
            return artifactText
        }

        if !artifactTexts.isEmpty {
            replacementText = ([replacementText] + artifactTexts)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
        }

        guard replacementText != finalMessage.text.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }

        replacement.text = replacementText
        return replacement
    }

    static func textRemovingReplay(from text: String, replayText: String) -> String {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedReplay = replayText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedReplay.count >= 24,
              trimmedText.count > trimmedReplay.count else {
            return text
        }

        let range: Range<String.Index>?
        if trimmedText.hasPrefix(trimmedReplay) {
            range = trimmedText.startIndex..<trimmedText.index(trimmedText.startIndex, offsetBy: trimmedReplay.count)
        } else {
            range = trimmedText.range(of: trimmedReplay)
        }

        guard let range else {
            return text
        }

        let remainder = (trimmedText[..<range.lowerBound] + trimmedText[range.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return remainder.isEmpty ? text : remainder
    }

    static func isGeneratedImageArtifactAlreadyInFinal(_ message: CodexMessage, finalMessage: CodexMessage) -> Bool {
        guard message.role == .assistant,
              finalMessage.role == .assistant,
              isGeneratedImageArtifactOnly(message) else {
            return false
        }

        let artifactPaths = Set(AssistantMarkdownImageReferenceParser.references(in: message.text).map(\.path))
        guard !artifactPaths.isEmpty,
              artifactPaths.allSatisfy({ AssistantMarkdownImageReferenceParser.isCodexGeneratedImagePath($0) }) else {
            return false
        }

        let finalPaths = Set(AssistantMarkdownImageReferenceParser.references(in: finalMessage.text).map(\.path))
        return artifactPaths.isSubset(of: finalPaths)
    }

    static func isGeneratedImageArtifactOnly(_ message: CodexMessage) -> Bool {
        guard message.role == .assistant,
              !message.isStreaming,
              isAssistantPriorityArtifactOnly(message) else {
            return false
        }

        let imageReferences = AssistantMarkdownImageReferenceParser.references(in: message.text)
        return !imageReferences.isEmpty
            && imageReferences.allSatisfy(\.isCodexGeneratedImage)
    }

    static func normalizedVisibleAssistantText(_ text: String) -> String {
        AssistantMarkdownImageReferenceParser
            .visibleTextRemovingImageSyntax(from: text)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func isAssistantPriorityArtifactOnly(_ message: CodexMessage) -> Bool {
        guard message.role == .assistant, !message.isStreaming else {
            return false
        }

        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return false
        }

        let imageReferences = AssistantMarkdownImageReferenceParser.references(in: text)
        if !imageReferences.isEmpty {
            let textWithoutImages = AssistantMarkdownImageReferenceParser
                .visibleTextRemovingImageSyntax(from: text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if textWithoutImages.isEmpty {
                return true
            }
        }

        let codeCommentContent = CodeCommentDirectiveParser.parse(from: text)
        return codeCommentContent.hasFindings
            && codeCommentContent.fallbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func isCommentaryAssistantPhase(_ phase: String?) -> Bool {
        phase == "commentary"
    }

    static func isFinalAnswerAssistantPhase(_ phase: String?) -> Bool {
        phase == "final_answer"
    }

}
