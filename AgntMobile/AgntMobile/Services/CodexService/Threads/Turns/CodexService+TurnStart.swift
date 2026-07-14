// FILE: CodexService+TurnStart.swift
// Purpose: turn/start request flow and automatic title generation.
// Layer: Service

import Foundation

extension CodexService {
    func sendTurnStart(
        _ userInput: String,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = [],
        to threadId: String,
        shouldAppendUserMessage: Bool = true,
        collaborationMode: CodexCollaborationModeKind? = nil,
        preAppendedUserMessageID: String? = nil,
        automaticTitleSeedOverride: String? = nil
    ) async throws {
        let outgoingDisplayText = displayTextForOutgoingTurn(
            userInput: userInput,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions
        )
        let automaticTitleSeed = automaticTitleSeedOverride ?? (shouldAppendUserMessage
            ? automaticThreadTitleSeedIfNeeded(
                userInput: outgoingDisplayText,
                attachments: attachments,
                threadId: threadId
            )
            : nil)
        let pendingMessageId: String
        if let preAppendedUserMessageID,
           !preAppendedUserMessageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pendingMessageId = preAppendedUserMessageID
        } else if shouldAppendUserMessage {
            pendingMessageId = appendUserMessage(
                threadId: threadId,
                text: outgoingDisplayText,
                attachments: attachments,
                fileMentions: fileMentions,
                skillMentions: skillMentions.compactMap {
                    let rawName = $0.name ?? $0.id
                    let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                },
                pluginMentions: mentionMentions.compactMap {
                    let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                }
            )
        } else {
            pendingMessageId = ""
        }
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        setProtectedRunningFallback(true, for: threadId)
        let messageStartCheckpointTask = scheduleMessageStartWorkspaceCheckpointIfPossible(
            threadId: threadId,
            messageId: pendingMessageId
        )

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var includeStructuredMentionItems = supportsStructuredMentionInput && !mentionMentions.isEmpty
        var imageURLKey = "url"
        var effectiveCollaborationMode = supportsTurnCollaborationMode ? collaborationMode : nil
        var didDowngradePlanModeForRuntime = false
        var includesServiceTier = runtimeServiceTierForTurn(threadId: threadId) != nil

        if collaborationMode != nil, effectiveCollaborationMode == nil {
            debugRuntimeLog(
                "turn/start dropping collaborationMode requested=\(collaborationMode?.rawValue ?? "") thread=\(threadId) supportsTurnCollaborationMode=\(supportsTurnCollaborationMode)"
            )
        }

        while true {
            do {
                let requestParams = try buildTurnStartRequestParams(
                    threadId: threadId,
                    userInput: userInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions,
                    imageURLKey: imageURLKey,
                    includeStructuredSkillItems: includeStructuredSkillItems,
                    includeStructuredMentionItems: includeStructuredMentionItems,
                    collaborationMode: effectiveCollaborationMode,
                    includeServiceTier: includesServiceTier
                )
                // The pre-turn snapshot must settle before the runtime can mutate files.
                if let messageStartCheckpointTask {
                    await messageStartCheckpointTask.value
                }
                let response = try await sendRequestWithSandboxFallback(
                    method: "turn/start",
                    baseParams: requestParams
                )
                let resolvedTurnID = handleSuccessfulTurnStartResponse(
                    response,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                if let resolvedTurnID {
                    scheduleMessageStartWorkspaceCheckpointCopyIfPossible(
                        threadId: threadId,
                        messageId: pendingMessageId,
                        turnId: resolvedTurnID
                    )
                }
                scheduleAutomaticThreadTitleGenerationIfNeeded(
                    seed: automaticTitleSeed,
                    threadId: threadId,
                    attachments: attachments
                )
                if didDowngradePlanModeForRuntime {
                    appendSystemMessage(
                        threadId: threadId,
                        text: "Plan mode is not supported by this runtime. Sent as a normal turn instead."
                    )
                }
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    // Disable structured skill input for this runtime after first incompatibility signal.
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if includeStructuredMentionItems,
                   shouldRetryTurnStartWithoutMentionItems(error) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if effectiveCollaborationMode != nil,
                   shouldRetryTurnStartWithoutCollaborationMode(error) {
                    // Remember the runtime limitation so future plan-mode sends skip the rejected field.
                    supportsTurnCollaborationMode = false
                    clearPlanSessionIfRuntimeDowngraded(
                        threadId: threadId,
                        collaborationMode: effectiveCollaborationMode
                    )
                    effectiveCollaborationMode = nil
                    didDowngradePlanModeForRuntime = true
                    continue
                }

                if consumeUnsupportedServiceTier(error, includesServiceTier: &includesServiceTier) {
                    continue
                }

                try handleTurnStartFailure(
                    error,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                return
            }
        }
    }

    // Generates a compact first-turn title without blocking turn/start or overwriting user renames.
    private func scheduleAutomaticThreadTitleGenerationIfNeeded(
        seed: String?,
        threadId: String,
        attachments: [CodexImageAttachment]
    ) {
        guard let seed,
              !seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        let fallbackTitle = fallbackThreadTitle(from: seed)
        let allowedTitles: Set<String> = [
            CodexThread.defaultDisplayTitle,
            "Conversation",
            fallbackTitle,
        ]
        applyAutomaticThreadTitle(fallbackTitle, for: threadId, replacing: allowedTitles)

        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let generatedTitle = await self.generatedThreadTitleOrNil(
                seed: seed,
                threadId: threadId,
                attachmentCount: attachments.count
            ) else {
                return
            }

            self.applyAutomaticThreadTitle(
                generatedTitle,
                for: threadId,
                replacing: allowedTitles
            )
        }
    }

    private func generatedThreadTitleOrNil(
        seed: String,
        threadId: String,
        attachmentCount: Int
    ) async -> String? {
        var params: [String: JSONValue] = [
            "message": .string(seed),
            "attachmentCount": .integer(attachmentCount),
        ]
        if let model = gitWriterModelIdentifier(),
           !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["model"] = .string(model)
        }
        if let workingDirectory = thread(for: threadId)?.gitWorkingDirectory,
           !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["cwd"] = .string(workingDirectory)
        }

        do {
            let response = try await sendRequest(method: "thread/generateTitle", params: .object(params))
            let title = response.result?.objectValue?["title"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return title?.isEmpty == false ? title : nil
        } catch {
            return nil
        }
    }

    func automaticThreadTitleSeedIfNeeded(
        userInput: String,
        attachments: [CodexImageAttachment],
        threadId: String
    ) -> String? {
        guard persistedThreadRename(for: threadId) == nil,
              let thread = thread(for: threadId),
              CodexThread.isGenericPlaceholderTitle(thread.title) || thread.displayTitle == CodexThread.defaultDisplayTitle,
              !hasExistingUserChatMessage(threadId: threadId) else {
            return nil
        }

        let trimmedInput = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInput.isEmpty {
            return trimmedInput
        }
        return attachments.isEmpty ? nil : "Image request"
    }

    private func hasExistingUserChatMessage(threadId: String) -> Bool {
        (messagesByThread[threadId] ?? []).contains { message in
            message.role == .user && message.kind == .chat
        }
    }

    private func fallbackThreadTitle(from seed: String) -> String {
        let words = seed
            .components(separatedBy: .whitespacesAndNewlines)
            .map { word in
                word.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            }
            .filter { !$0.isEmpty }
            .prefix(4)
        let title = words.joined(separator: " ")
        guard !title.isEmpty else {
            return CodexThread.defaultDisplayTitle
        }
        return title.prefix(1).uppercased() + title.dropFirst()
    }
}
